import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const NAUTILUS_WM_CLASS = 'org.gnome.Nautilus';

// Horizontal finger travel, in smooth-scroll units, that slides the page
// across the whole window.
const FULL_SWIPE_DISTANCE = 30;

// Travel before deciding whether the swipe is a sideways swipe or an
// ordinary scroll.
const DIRECTION_LOCK_DISTANCE = 1.5;

// Lifting the fingers past this much of the window turns the page; so does
// a flick faster than FLING_VELOCITY (units per ms) the right way.
const COMMIT_PROGRESS = 0.4;
const FLING_VELOCITY = 0.08;
const VELOCITY_WINDOW_MS = 100;

// With nothing to go back or forward to, the page only gives a little.
const NO_HISTORY_RESISTANCE = 0.1;

// Files goes back and forward on the side buttons of a mouse.
const BACK_BUTTON = 8;
const FORWARD_BUTTON = 9;

// The page underneath trails behind the one on top and is dimmed while
// covered, like Safari and GNOME's own navigation views.
const PARALLAX = 0.25;
const MAX_DIM = 0.3;

const SHADOW_WIDTH = 24;
const SHADOW_STYLE =
    'background-gradient-direction: horizontal;' +
    'background-gradient-start: rgba(0, 0, 0, 0);' +
    'background-gradient-end: rgba(0, 0, 0, 0.2);';

const SLIDE_DURATION_MS = 350;
const MIN_SLIDE_DURATION_MS = 120;

// How often to re-capture the page being navigated to while it loads.
const PAGE_REFRESH_MS = 80;

// After going back to where the swipe started, how long to wait for Files to
// repaint before revealing the window again.
const REVEAL_DELAY_MS = 60;
const REVERT_TIMEOUT_MS = 400;

function isNautilus(window) {
    return window !== null && window.get_wm_class() === NAUTILUS_WM_CLASS;
}

function containsPoint(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height;
}

// Virtual pointers (ours included) have no device node, unlike real mice and
// touchpads.
function isFromVirtualPointer(event) {
    const device = event.get_source_device();
    return device !== null && device.get_device_node() === null &&
        device.get_device_type() === Clutter.InputDeviceType.POINTER_DEVICE;
}

// Two fingers swiped sideways in Files go back (to the right) or forward (to
// the left), and the folder slides with the fingers like a page in Safari.
//
// Files does not keep pictures of the folders in its history, so the
// navigation happens as soon as the swipe is recognised: the current folder
// is frozen into a snapshot covering the window, Files is sent the mouse
// back/forward button underneath it, and the newly shown folder is captured
// as the other page. Lifting the fingers early slides the page back and
// sends the opposite button. Whether Files actually navigated (it cannot at
// either end of its history) is told by its window title, which names the
// folder.
//
// Two-finger swipes are plain scroll events, which Mutter hands to the
// window before any Shell event filter sees them, so they are watched
// through the core idle monitor instead (see GestureHandler). Files still
// receives the scroll; it has nothing to scroll horizontally in most views.
export const SwipeBack = GObject.registerClass({
}, class SwipeBack extends GObject.Object {
    _init(configManager) {
        super._init();
        this._configManager = configManager;
        this._enabled = configManager.nautilus_swipe_back;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._inputWatchId = 0;
        this._swipe = null;
        this._page = null;
        this._touchpadSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });

        const seat = global.stage.context.get_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        configManager.connectObject(
            'notify::nautilus-swipe-back', () => {
                this._enabled = configManager.nautilus_swipe_back;
                if (!this._enabled)
                    this._endSwipe(false);
                this._updateWatch();
            },
            this);
        global.display.connectObject(
            'notify::focus-window', () => this._updateWatch(),
            this);

        this._updateWatch();
    }

    // Every input event costs a JS call while watched, so only watch while
    // Files has the focus (or a swipe is still in progress).
    _updateWatch() {
        const wanted = this._enabled &&
            (this._swipe !== null || isNautilus(global.display.focus_window));

        if (wanted && !this._inputWatchId) {
            this._inputWatchId = this._idleMonitor.add_user_active_watch(() => this._onInput());
        } else if (!wanted && this._inputWatchId) {
            this._idleMonitor.remove_watch(this._inputWatchId);
            this._inputWatchId = 0;
        }
    }

    // The watch is one-shot: re-arm it after every event.
    _onInput() {
        this._inputWatchId = 0;

        const event = Clutter.get_current_event();
        if (event?.type() === Clutter.EventType.SCROLL &&
            event.get_scroll_source() === Clutter.ScrollSource.FINGER)
            this._handleScroll(event);
        else if (event && this._swipe && !isFromVirtualPointer(event))
            this._endSwipe(true);

        this._updateWatch();
    }

    _handleScroll(event) {
        // libinput ends every finger scroll with a stop event once the
        // fingers lift.
        const finished =
            event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE;

        if (!this._swipe) {
            if (finished)
                return;

            const window = global.display.focus_window;
            const [x, y] = event.get_coords();
            if (!isNautilus(window) || !containsPoint(window.get_frame_rect(), x, y))
                return;

            this._swipe = {
                window,
                dx: 0,
                dy: 0,
                // +1 for back (fingers to the right), -1 for forward, 0 for
                // an ordinary scroll; null until decided.
                direction: null,
                samples: [],
                naturalScroll: this._touchpadSettings.get_boolean('natural-scroll'),
                page: null,
            };
        }

        if (finished) {
            this._endSwipe(true);
            return;
        }

        const swipe = this._swipe;
        const [dx, dy] = event.get_scroll_delta();
        // Track the fingers' physical direction, whatever the scroll setting.
        const sign = swipe.naturalScroll ? -1 : 1;
        swipe.dx += sign * dx;
        swipe.dy += sign * dy;

        const time = event.get_time();
        swipe.samples.push({time, dx: swipe.dx});
        while (swipe.samples.length > 2 && time - swipe.samples[0].time > VELOCITY_WINDOW_MS)
            swipe.samples.shift();

        if (swipe.direction === null) {
            if (Math.hypot(swipe.dx, swipe.dy) < DIRECTION_LOCK_DISTANCE)
                return;
            swipe.direction = Math.abs(swipe.dx) > 2 * Math.abs(swipe.dy)
                ? Math.sign(swipe.dx) : 0;
            if (swipe.direction !== 0) {
                swipe.page = this._turnPage(swipe.window, swipe.direction > 0);
                if (!swipe.page)
                    swipe.direction = 0;
            }
        }

        if (swipe.page)
            this._setProgress(swipe.page, this._swipeProgress(swipe));
    }

    _swipeProgress(swipe) {
        return Math.clamp(swipe.direction * swipe.dx / FULL_SWIPE_DISTANCE, 0, 1);
    }

    // Finger speed in the swipe's direction, in units per ms.
    _swipeVelocity(swipe) {
        const first = swipe.samples[0];
        const last = swipe.samples[swipe.samples.length - 1];
        const dt = last ? last.time - first.time : 0;
        return dt > 0 ? swipe.direction * (last.dx - first.dx) / dt : 0;
    }

    _endSwipe(allowCommit) {
        const swipe = this._swipe;
        this._swipe = null;
        const page = swipe?.page;
        if (!page || page.state !== 'tracking')
            return;

        if (!allowCommit) {
            if (page.navigated)
                this._click(page.back ? FORWARD_BUTTON : BACK_BUTTON);
            this._destroyPage(page);
            return;
        }

        const progress = this._swipeProgress(swipe);
        const velocity = this._swipeVelocity(swipe);
        const commit = page.navigated && velocity > -FLING_VELOCITY &&
            (progress >= COMMIT_PROGRESS || velocity > FLING_VELOCITY);

        page.state = commit ? 'committing' : 'cancelling';
        const target = commit ? 1 : 0;
        page.adjustment.ease(target, {
            duration: Math.max(MIN_SLIDE_DURATION_MS,
                SLIDE_DURATION_MS * Math.abs(target - page.adjustment.value)),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (page.state === 'destroyed')
                    return;
                if (commit)
                    this._destroyPage(page);
                else
                    this._revert(page);
            },
        });
    }

    // Freeze the current folder over the window and navigate underneath it.
    _turnPage(window, back) {
        // A page still sliding into place is done; one sliding back is not
        // yet where it started, so wait for it.
        if (this._page) {
            if (this._page.state !== 'committing')
                return null;
            this._destroyPage(this._page);
        }

        const windowActor = window.get_compositor_private();
        if (!windowActor)
            return null;

        const frame = window.get_frame_rect();
        let current;
        try {
            current = new Clutter.Actor();
            this._capture(current, windowActor, frame);
        } catch (e) {
            console.warn(`3-finger-drag: could not snapshot Files window: ${e.message}`);
            return null;
        }

        // The page being turned lies on top: the current folder going back,
        // the next one going forward. A shadow runs along its left edge.
        const container = new Clutter.Actor({
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            clip_to_allocation: true,
        });
        const dim = new Clutter.BrightnessContrastEffect();
        const bottom = new Clutter.Actor({width: frame.width, height: frame.height});
        bottom.add_effect(dim);
        const top = new Clutter.Actor({width: frame.width, height: frame.height});
        const shadow = new St.Widget({
            style: SHADOW_STYLE,
            x: -SHADOW_WIDTH,
            width: SHADOW_WIDTH,
            height: frame.height,
        });
        top.add_child(shadow);
        container.add_child(bottom);
        container.add_child(top);
        (back ? top : bottom).add_child(current);

        global.window_group.insert_child_above(container, windowActor);

        const page = {
            window,
            windowActor,
            frame,
            back,
            container,
            top,
            bottom,
            shadow,
            dim,
            next: null,
            navigated: false,
            state: 'tracking',
            adjustment: new St.Adjustment({actor: container, lower: 0, upper: 1, value: 0}),
            timeoutId: 0,
        };
        this._page = page;

        page.adjustment.connect('notify::value', () => this._layout(page));
        page.titleId = window.connect('notify::title', () => this._onTitleChanged(page));
        page.actorDestroyId = windowActor.connect('destroy', () => {
            page.actorDestroyId = 0;
            this._destroyPage(page);
        });

        this._click(back ? BACK_BUTTON : FORWARD_BUTTON);
        this._layout(page);
        return page;
    }

    _onTitleChanged(page) {
        if (page.state === 'reverting') {
            // Back where the swipe started; reveal it once Files has
            // repainted.
            this._clearTimeout(page);
            page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DELAY_MS, () => {
                page.timeoutId = 0;
                this._destroyPage(page);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (page.navigated)
            return;

        // Keep capturing the new folder while it loads, until the page has
        // settled.
        page.navigated = true;
        page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAGE_REFRESH_MS, () => {
            if (page.state === 'reverting' || page.state === 'destroyed') {
                page.timeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._captureNext(page);
            return GLib.SOURCE_CONTINUE;
        });
        this._captureNext(page);

        if (this._swipe?.page === page)
            this._setProgress(page, this._swipeProgress(this._swipe));
    }

    _captureNext(page) {
        try {
            if (!page.next) {
                page.next = new Clutter.Actor();
                (page.back ? page.bottom : page.top).add_child(page.next);
            }
            this._capture(page.next, page.windowActor, page.frame);
        } catch (e) {
            console.warn(`3-finger-drag: could not snapshot Files window: ${e.message}`);
        }
    }

    _capture(actor, windowActor, frame) {
        actor.set({
            content: windowActor.paint_to_content(null),
            x: windowActor.x - frame.x,
            y: windowActor.y - frame.y,
            width: windowActor.width,
            height: windowActor.height,
        });
    }

    _setProgress(page, progress) {
        page.adjustment.value = page.navigated
            ? progress : progress * NO_HISTORY_RESISTANCE;
    }

    // Progress 0 shows the folder the swipe started on, 1 the one it goes to.
    _layout(page) {
        const progress = page.adjustment.value;
        const covered = page.back ? 1 - progress : progress;
        const {width} = page.frame;

        page.top.translation_x = Math.round((1 - covered) * width);
        page.bottom.translation_x = Math.round(-PARALLAX * (1 - covered) * width);
        page.shadow.opacity = Math.round(255 * Math.min(1, 5 * covered));
        page.dim.set_brightness(-MAX_DIM * covered);
    }

    // The page slid back to where it started: undo the navigation, and keep
    // covering the window until Files shows that folder again.
    _revert(page) {
        if (!page.navigated) {
            this._destroyPage(page);
            return;
        }

        page.state = 'reverting';
        this._clearTimeout(page);
        this._click(page.back ? FORWARD_BUTTON : BACK_BUTTON);
        page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVERT_TIMEOUT_MS, () => {
            page.timeoutId = 0;
            this._destroyPage(page);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout(page) {
        if (page.timeoutId) {
            GLib.source_remove(page.timeoutId);
            page.timeoutId = 0;
        }
    }

    _destroyPage(page) {
        if (page.state === 'destroyed')
            return;
        page.state = 'destroyed';

        this._clearTimeout(page);
        page.window.disconnect(page.titleId);
        if (page.actorDestroyId)
            page.windowActor.disconnect(page.actorDestroyId);
        page.adjustment.remove_transition('value');
        page.container.destroy();

        if (this._page === page)
            this._page = null;
        if (this._swipe?.page === page)
            this._swipe.page = null;
    }

    _click(button) {
        this._virtualDevice.notify_button(Clutter.CURRENT_TIME,
            button, Clutter.ButtonState.PRESSED);
        this._virtualDevice.notify_button(Clutter.CURRENT_TIME,
            button, Clutter.ButtonState.RELEASED);
    }

    destroy() {
        if (this._inputWatchId) {
            this._idleMonitor.remove_watch(this._inputWatchId);
            this._inputWatchId = 0;
        }
        this._swipe = null;
        if (this._page)
            this._destroyPage(this._page);
        this._configManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._touchpadSettings = null;
        this._virtualDevice = null;
    }
});
