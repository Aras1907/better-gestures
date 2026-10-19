import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FolderArea} from './folderArea.js';
import {FolderHistory} from './folderHistory.js';

const NAUTILUS_WM_CLASS = 'org.gnome.Nautilus';

// Horizontal finger travel, in smooth-scroll units, that slides the page
// across the whole window.
const FULL_SWIPE_DISTANCE = 30;

// Travel before deciding whether the swipe is a sideways swipe or an
// ordinary scroll.
const DIRECTION_LOCK_DISTANCE = 1.5;

// libinput can report the first two fingers of a three-finger drag as a
// scroll until the third one lands, and the last two as one after the others
// lift. So a scroll only turns the page once it has gone on this long, is
// called off if more fingers join, and is not taken as a swipe at all this
// soon after a gesture of three or more fingers.
const SCROLL_SETTLE_MS = 80;
const AFTER_GESTURE_MS = 300;
const {TOUCHPAD_SWIPE, TOUCHPAD_PINCH, TOUCHPAD_HOLD} = Clutter.EventType;

// Lifting the fingers past this much of the window turns the page; so does
// a flick faster than FLING_VELOCITY (units per ms) the right way.
const COMMIT_PROGRESS = 0.4;
const FLING_VELOCITY = 0.08;
const VELOCITY_WINDOW_MS = 100;

// On a touchscreen, a swipe starts from an edge of the folder view: the left
// one goes back, the right one forward. The finger has to move sideways
// before Files would start dragging a file (8 px), and the page follows it
// from there. A flick (px per ms) only turns the page once it is partly
// turned, so an ordinary swipe can still be taken back.
const TOUCH_EDGE_PX = 32;
const TOUCH_THRESHOLD_PX = 8;
const TOUCH_SIDEWAYS_RATIO = 2;
const TOUCH_FLING_VELOCITY = 1.2;
const TOUCH_MIN_FLING_PROGRESS = 0.15;

// With nothing to go back or forward to, the page stretches like Safari's: it
// follows the fingers at first, then gives less and less, up to this much
// of the width, over a blank page, and springs back. Where the history knows
// the folder it goes to, it is taken to be there until Files says otherwise.
const NO_HISTORY_STRETCH = 0.15;
const BLANK_STYLE_LIGHT = 'background-color: #ffffff;';
const BLANK_STYLE_DARK = 'background-color: #1e1e1e;';

// When the page has to catch up with the fingers (it appears, or Files turns
// out to navigate after all), it glides there rather than jumping.
const CATCH_UP_MS = 120;

// Files goes back and forward on the side buttons of a mouse.
const BACK_BUTTON = 8;
const FORWARD_BUTTON = 9;

// Only the page on top moves, like in Safari; the one underneath stays put
// and is dimmed while covered, by a shade of black over it (cheaper to draw
// than an effect).
const MAX_DIM = 0.3;
const DIM_STYLE = 'background-color: black;';

// Only the folder view slides. Files is asked where it is (see FolderArea);
// until it answers, it is taken to be where nautilus-window.ui lays it out:
// under a header bar, right of a sidebar of a fifth of the window, within
// 180-240 px. Below 682 sp wide the sidebar folds away and an action bar
// shows at the bottom instead.
const HEADER_BAR_HEIGHT = 46;
const ACTION_BAR_HEIGHT = 46;
const SIDEBAR_WIDTH_FRACTION = 0.2;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 240;
const COLLAPSE_WIDTH_SP = 682;

const SHADOW_WIDTH = 24;
const SHADOW_STYLE =
    'background-gradient-direction: horizontal;' +
    'background-gradient-start: rgba(0, 0, 0, 0);' +
    'background-gradient-end: rgba(0, 0, 0, 0.2);';

const SLIDE_DURATION_MS = 450;
const MIN_SLIDE_DURATION_MS = 250;

// The cover over the window fades away once Files shows the folder, so any
// difference between its picture and the live window does not pop.
const FADE_OUT_MS = 150;

// A folder is pictured for the history once Files has had time to draw it.
const SNAPSHOT_DELAY_MS = 500;

// How often, and how many times, to re-capture the page being navigated to
// while it loads. A picture from the history is shown instead until Files
// has had time to draw the folder, rather than a half-drawn one.
const PAGE_REFRESH_MS = 80;
const PAGE_REFRESH_COUNT = 8;
const PAGE_SETTLE_MS = 240;

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
// view is frozen into a snapshot covering it, Files is sent the mouse
// back/forward button underneath it, and the newly shown folder is captured
// as the other page. Until then, the other page is the folder's picture from
// when it was last shown, if there is one (see FolderHistory). Lifting the fingers early slides the page back and
// sends the opposite button. Whether Files actually navigated (it cannot at
// either end of its history) is told by its window title, which names the
// folder.
//
// Two-finger swipes are plain scroll events, which Mutter hands to the
// window before any Shell event filter sees them, so they are watched
// through the core idle monitor instead (see GestureHandler). Files still
// receives the scroll; it has nothing to scroll horizontally in most views.
//
// On a touchscreen, one finger swiped sideways anywhere in the folder view
// does the same, recognised by a pan gesture on the stage (GNOME 49 and
// later). Once it is recognised, Mutter cancels the touch for Files, so the
// folder neither scrolls nor selects under it.
export const SwipeBack = GObject.registerClass({
}, class SwipeBack extends GObject.Object {
    _init(configManager) {
        super._init();
        this._configManager = configManager;
        this._enabled = configManager.nautilus_swipe_back;
        this._touchEnabled = configManager.nautilus_touch_swipe;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._inputWatchId = 0;
        this._swipe = null;
        this._page = null;
        // The window a touch may swipe in, and which way.
        this._touchWindow = null;
        this._touchBack = false;
        // When the last touchpad gesture of three or more fingers was seen.
        this._multiFingerMs = -Infinity;
        this._folderArea = new FolderArea();
        // Files windows seen with the focus: {history, snapshotId}.
        this._windows = new Map();
        this._touchpadSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        const seat = global.stage.context.get_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        configManager.connectObject(
            'notify::nautilus-swipe-back', () => {
                this._enabled = configManager.nautilus_swipe_back;
                this._onSettingChanged();
            },
            'notify::nautilus-touch-swipe', () => {
                this._touchEnabled = configManager.nautilus_touch_swipe;
                this._onSettingChanged();
            },
            this);
        global.display.connectObject(
            'notify::focus-window', () => this._onFocusChanged(),
            this);

        this._touchGesture = this._createTouchGesture();

        this._onFocusChanged();
    }

    _onSettingChanged() {
        if (this._swipe && !(this._swipe.touch ? this._touchEnabled : this._enabled))
            this._endSwipe('abort');
        if (!this._enabled && !this._touchEnabled)
            this._untrackWindows();
        this._onFocusChanged();
    }

    _onFocusChanged() {
        const window = global.display.focus_window;
        if ((this._enabled || this._touchEnabled) && isNautilus(window)) {
            this._folderArea.track(window);
            this._trackWindow(window);
        }
        this._updateWatch();
    }

    // Follow the folders the window shows, picturing each for the history.
    _trackWindow(window) {
        if (this._windows.has(window))
            return;

        this._windows.set(window, {
            history: new FolderHistory(window.get_title()),
            snapshotId: 0,
        });
        window.connectObject(
            'notify::title', () => {
                this._windows.get(window).history.navigated(window.get_title());
                this._scheduleSnapshot(window);
                // Whether Files can go back and forward from here.
                if (window === global.display.focus_window)
                    this._folderArea.update(window);
            },
            'unmanaged', () => this._untrackWindow(window),
            this);
        this._scheduleSnapshot(window);
    }

    _untrackWindow(window) {
        const state = this._windows.get(window);
        if (state.snapshotId)
            GLib.source_remove(state.snapshotId);
        window.disconnectObject(this);
        this._windows.delete(window);
    }

    _untrackWindows() {
        for (const window of [...this._windows.keys()])
            this._untrackWindow(window);
    }

    _scheduleSnapshot(window) {
        const state = this._windows.get(window);
        if (state.snapshotId)
            GLib.source_remove(state.snapshotId);
        state.snapshotId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SNAPSHOT_DELAY_MS, () => {
            state.snapshotId = 0;
            const windowActor = window.get_compositor_private();
            if (!windowActor)
                return GLib.SOURCE_REMOVE;
            try {
                state.history.current.snapshot =
                    this._snapshot(windowActor, this._folderAreaOf(window));
            } catch (e) {
                console.warn(`3-finger-drag: could not snapshot Files window: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Every input event costs a JS call while watched, so only watch while
    // Files has the focus (or a touchpad swipe is still in progress).
    _updateWatch() {
        const wanted = this._enabled &&
            (this._swipe?.touch === false || isNautilus(global.display.focus_window));

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
        const type = event?.type();
        if (type === Clutter.EventType.SCROLL &&
            event.get_scroll_source() === Clutter.ScrollSource.FINGER)
            this._handleScroll(event);
        else if (type === TOUCHPAD_SWIPE || type === TOUCHPAD_PINCH || type === TOUCHPAD_HOLD)
            this._handleTouchpadGesture(event);
        else if (event && this._swipe?.touch === false && !isFromVirtualPointer(event))
            this._endSwipe('finish');

        this._updateWatch();
    }

    // More fingers came down: the scroll was the start of a three-finger drag
    // or a four-finger gesture, not a swipe.
    _handleTouchpadGesture(event) {
        if (event.get_touchpad_gesture_finger_count() < 3)
            return;

        this._multiFingerMs = event.get_time();
        if (this._swipe?.touch === false) {
            if (this._swipe.page)
                this._endSwipe('cancel');
            else
                this._swipe.direction = 0;
        }
    }

    _handleScroll(event) {
        // libinput ends every finger scroll with a stop event once the
        // fingers lift.
        const finished =
            event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE;

        if (this._swipe?.touch)
            return;

        if (!this._swipe) {
            if (finished)
                return;

            const window = global.display.focus_window;
            const [x, y] = event.get_coords();
            if (!isNautilus(window) || !containsPoint(window.get_frame_rect(), x, y))
                return;

            // In case the window changed since it got the focus, such as
            // the sidebar being hidden.
            this._folderArea.update(window);
            this._trackWindow(window);
            this._swipe = {
                window,
                touch: false,
                distance: FULL_SWIPE_DISTANCE,
                flingVelocity: FLING_VELOCITY,
                minFlingProgress: 0,
                dx: 0,
                dy: 0,
                // +1 for back (fingers to the right), -1 for forward, 0 for
                // an ordinary scroll; null until decided.
                direction: event.get_time() - this._multiFingerMs < AFTER_GESTURE_MS
                    ? 0 : null,
                startTime: event.get_time(),
                samples: [],
                naturalScroll: this._touchpadSettings.get_boolean('natural-scroll'),
                page: null,
            };
        }

        if (finished) {
            this._endSwipe('finish');
            return;
        }

        const swipe = this._swipe;
        const [dx, dy] = event.get_scroll_delta();
        // Track the fingers' physical direction, whatever the scroll setting.
        const sign = swipe.naturalScroll ? -1 : 1;
        swipe.dx += sign * dx;
        swipe.dy += sign * dy;

        this._addSample(swipe, event.get_time());

        if (swipe.direction === null) {
            if (Math.hypot(swipe.dx, swipe.dy) < DIRECTION_LOCK_DISTANCE)
                return;
            swipe.direction = Math.abs(swipe.dx) > 2 * Math.abs(swipe.dy)
                ? Math.sign(swipe.dx) : 0;
        }

        if (swipe.direction && !swipe.page &&
            event.get_time() - swipe.startTime >= SCROLL_SETTLE_MS) {
            swipe.page = this._turnPage(swipe.window, swipe.direction > 0);
            if (!swipe.page)
                swipe.direction = 0;
        }

        if (swipe.page)
            this._setProgress(swipe.page, this._swipeProgress(swipe));
    }

    _createTouchGesture() {
        if (!Clutter.PanGesture)
            return null;

        const gesture = new Clutter.PanGesture({
            min_n_points: 1,
            max_n_points: 1,
            pan_axis: Clutter.PanAxis.X,
            begin_threshold: TOUCH_THRESHOLD_PX,
        });
        gesture.connect('may-recognize', () => this._mayRecognizeTouch(gesture));
        gesture.connect('recognize', () => this._beginTouchSwipe(gesture));
        gesture.connect('pan-update', () => this._updateTouchSwipe(gesture));
        gesture.connect('end', () => this._endTouchSwipe('finish'));
        gesture.connect('cancel', () => this._endTouchSwipe('cancel'));
        global.stage.add_action_full('3-finger-drag-files-swipe',
            Clutter.EventPhase.CAPTURE, gesture);
        return gesture;
    }

    _mayRecognizeTouch(gesture) {
        this._touchWindow = null;
        if (!this._touchEnabled || this._swipe || Main.actionMode !== Shell.ActionMode.NORMAL)
            return false;
        if (this._page && this._page.state !== 'committing')
            return false;

        const device = gesture.get_point_event(0)?.get_source_device();
        if (device?.get_device_type() !== Clutter.InputDeviceType.TOUCHSCREEN_DEVICE)
            return false;

        // Mostly sideways, like on the touchpad; Files scrolls up and down.
        // The pan restarts its begin centroid where it is recognised, so
        // the finger came down that far back from it.
        const begin = gesture.get_begin_centroid_abs();
        const now = gesture.get_centroid_abs();
        const dx = now.x - begin.x;
        if (Math.abs(dx) <= TOUCH_SIDEWAYS_RATIO * Math.abs(now.y - begin.y))
            return false;
        const downX = begin.x - dx;
        const downY = begin.y - (now.y - begin.y);

        const window = this._windowAt(downX, downY);
        if (!window)
            return false;
        const area = this._folderAreaOf(window);
        if (!containsPoint(area, downX, downY))
            return false;

        // Away from an edge, or towards it: an ordinary touch for Files.
        const back = downX < area.x + TOUCH_EDGE_PX && dx > 0;
        const forward = downX >= area.x + area.width - TOUCH_EDGE_PX && dx < 0;
        if (!back && !forward)
            return false;

        this._touchWindow = window;
        this._touchBack = back;
        return true;
    }

    // The Files window shown at a point on the stage, if any.
    _windowAt(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor && !(actor instanceof Meta.WindowActor))
            actor = actor.get_parent();
        const window = actor?.get_meta_window() ?? null;
        return isNautilus(window) ? window : null;
    }

    _beginTouchSwipe(gesture) {
        const window = this._touchWindow;
        if (!window)
            return;

        this._folderArea.update(window);
        this._trackWindow(window);
        const travelled = gesture.get_centroid_abs().x - gesture.get_begin_centroid_abs().x;
        const swipe = {
            window,
            touch: true,
            distance: this._folderAreaOf(window).width,
            flingVelocity: TOUCH_FLING_VELOCITY,
            minFlingProgress: TOUCH_MIN_FLING_PROGRESS,
            // The page starts turning here rather than jumping ahead by the
            // distance it took to recognise the swipe.
            origin: travelled,
            dx: 0,
            direction: this._touchBack ? 1 : -1,
            samples: [{time: GLib.get_monotonic_time() / 1000, dx: 0}],
            page: null,
        };
        this._swipe = swipe;
        swipe.page = this._turnPage(window, swipe.direction > 0);
        if (!swipe.page) {
            this._swipe = null;
            gesture.cancel();
            return;
        }
        this._setProgress(swipe.page, this._swipeProgress(swipe));
    }

    _updateTouchSwipe(gesture) {
        const swipe = this._swipe;
        if (!swipe?.touch)
            return;

        swipe.dx = gesture.get_centroid_abs().x - gesture.get_begin_centroid_abs().x -
            swipe.origin;
        this._addSample(swipe, GLib.get_monotonic_time() / 1000);
        if (swipe.page)
            this._setProgress(swipe.page, this._swipeProgress(swipe));
    }

    _endTouchSwipe(outcome) {
        if (!this._swipe?.touch)
            return;

        // A finger that rested before lifting is not flicking.
        this._addSample(this._swipe, GLib.get_monotonic_time() / 1000);
        this._endSwipe(outcome);
    }

    _addSample(swipe, time) {
        swipe.samples.push({time, dx: swipe.dx});
        while (swipe.samples.length > 2 && time - swipe.samples[0].time > VELOCITY_WINDOW_MS)
            swipe.samples.shift();
    }

    _swipeProgress(swipe) {
        return Math.clamp(swipe.direction * swipe.dx / swipe.distance, 0, 1);
    }

    // Finger speed in the swipe's direction, in its units per ms.
    _swipeVelocity(swipe) {
        const first = swipe.samples[0];
        const last = swipe.samples[swipe.samples.length - 1];
        const dt = last ? last.time - first.time : 0;
        return dt > 0 ? swipe.direction * (last.dx - first.dx) / dt : 0;
    }

    // The fingers lifted ('finish'), the gesture was taken over ('cancel'),
    // or the swipe has to stop on the spot ('abort').
    _endSwipe(outcome) {
        const swipe = this._swipe;
        this._swipe = null;
        const page = swipe?.page;
        if (!page || page.state !== 'tracking')
            return;

        if (outcome === 'abort') {
            if (page.navigated)
                this._click(page.back ? FORWARD_BUTTON : BACK_BUTTON);
            this._destroyPage(page);
            return;
        }

        const progress = this._swipeProgress(swipe);
        const velocity = this._swipeVelocity(swipe);
        const commit = outcome === 'finish' && this._willNavigate(page) &&
            velocity > -swipe.flingVelocity &&
            (progress >= COMMIT_PROGRESS ||
             (velocity > swipe.flingVelocity && progress >= swipe.minFlingProgress));

        page.state = commit ? 'committing' : 'cancelling';
        const target = commit ? 1 : 0;
        const distance = Math.abs(target - page.adjustment.value);
        let duration = SLIDE_DURATION_MS * distance;
        // Carry on at the fingers' speed if they were moving that way: an
        // ease-out cubic starts at three times its average speed.
        const speed = velocity / swipe.distance * (commit ? 1 : -1);
        if (this._willNavigate(page) && speed > 0)
            duration = Math.min(duration, 3 * distance / speed);
        page.adjustment.ease(target, {
            duration: Math.max(MIN_SLIDE_DURATION_MS, duration),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (page.state === 'destroyed')
                    return;
                if (commit)
                    this._settle(page);
                else
                    this._revert(page);
            },
        });
    }

    // Whether Files has navigated under the page, or is expected to.
    _willNavigate(page) {
        return page.navigated || page.expectedTitle !== null;
    }

    // The page has turned: uncover the window once Files shows the folder,
    // or gives up on it.
    _settle(page) {
        page.slid = true;
        this._clearTimeout(page);
        page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            page.navigated ? REVEAL_DELAY_MS : REVERT_TIMEOUT_MS, () => {
                page.timeoutId = 0;
                if (!page.navigated)
                    this._windows.get(page.window)?.history.forget(page.back ? -1 : 1);
                this._fadeOut(page);
                return GLib.SOURCE_REMOVE;
            });
    }

    _fadeOut(page) {
        // Only the page in view fades; the one it covers must not show
        // through it on the way.
        const progress = page.adjustment.value;
        if ((page.back ? 1 - progress : progress) >= 0.5) {
            page.bottom.hide();
            page.dim.hide();
        } else {
            page.top.hide();
        }
        page.container.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._destroyPage(page),
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

        const area = this._folderAreaOf(window);
        let snapshot;
        try {
            snapshot = this._snapshot(windowActor, area);
        } catch (e) {
            console.warn(`3-finger-drag: could not snapshot Files window: ${e.message}`);
            return null;
        }
        const current = new Clutter.Actor();
        this._show(current, snapshot);

        // Files is only sent the button if it may be able to go that way.
        const history = this._windows.get(window)?.history;
        const canNavigate = this._folderArea.canNavigate(window, back) !== false;
        if (history) {
            history.current.snapshot = snapshot;
            if (!canNavigate)
                history.forget(back ? -1 : 1);
        }
        const destination = canNavigate ? history?.peek(back ? -1 : 1) ?? null : null;

        // The page being turned lies on top: the current folder going back,
        // the next one going forward. A shadow runs along its left edge.
        const container = new Clutter.Actor({
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height,
            clip_to_allocation: true,
        });
        const bottom = new Clutter.Actor({width: area.width, height: area.height});
        const dim = new St.Widget({style: DIM_STYLE, width: area.width, height: area.height});
        const top = new Clutter.Actor({width: area.width, height: area.height});
        // The snapshots are of the whole window; clip the sliding one to the
        // folder view so the rest of the window does not slide in with it.
        const topPage = new Clutter.Actor({
            width: area.width,
            height: area.height,
            clip_to_allocation: true,
        });
        const shadow = new St.Widget({
            style: SHADOW_STYLE,
            x: -SHADOW_WIDTH,
            width: SHADOW_WIDTH,
            height: area.height,
        });
        top.add_child(shadow);
        top.add_child(topPage);
        container.add_child(bottom);
        container.add_child(dim);
        container.add_child(top);
        (back ? topPage : bottom).add_child(current);

        // Until there is a picture of the other folder, a blank page stands
        // in for it, rather than the window under the cover showing through.
        const nextSlot = back ? bottom : topPage;
        let next = null;
        if (destination?.snapshot && this._fits(destination.snapshot, windowActor, area)) {
            next = new Clutter.Actor();
            this._show(next, destination.snapshot);
            nextSlot.add_child(next);
        } else {
            const dark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
            nextSlot.add_child(new St.Widget({
                style: dark ? BLANK_STYLE_DARK : BLANK_STYLE_LIGHT,
                width: area.width,
                height: area.height,
            }));
        }

        global.window_group.insert_child_above(container, windowActor);

        const page = {
            window,
            windowActor,
            area,
            back,
            container,
            top,
            topPage,
            bottom,
            shadow,
            dim,
            // The other folder, captured once Files shows it.
            next,
            hasPicture: next !== null,
            expectedTitle: destination?.title ?? null,
            clicked: canNavigate,
            navigated: false,
            slid: false,
            catchUpUntil: GLib.get_monotonic_time() / 1000 + CATCH_UP_MS,
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

        if (page.clicked)
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
                this._fadeOut(page);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (page.navigated)
            return;

        // The page slid back before Files got there; undo it.
        if (page.state === 'waiting') {
            page.navigated = true;
            this._revert(page);
            return;
        }

        // Keep capturing the new folder for a while as it loads, starting
        // once Files has had a moment to draw it: a capture taken at once
        // can still show the folder it left.
        page.navigated = true;
        const settle = page.hasPicture && page.window.get_title() === page.expectedTitle
            ? Math.ceil(PAGE_SETTLE_MS / PAGE_REFRESH_MS) : 1;
        let ticks = 0;
        page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAGE_REFRESH_MS, () => {
            if (page.state === 'reverting' || page.state === 'destroyed') {
                page.timeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
            ticks++;
            if (ticks >= settle)
                this._captureNext(page);
            if (ticks < settle + PAGE_REFRESH_COUNT)
                return GLib.SOURCE_CONTINUE;
            page.timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });

        if (page.slid) {
            this._settle(page);
        } else if (this._swipe?.page === page) {
            page.catchUpUntil = GLib.get_monotonic_time() / 1000 + CATCH_UP_MS;
            this._setProgress(page, this._swipeProgress(this._swipe));
        }
    }

    _captureNext(page) {
        try {
            if (!page.next) {
                page.next = new Clutter.Actor();
                (page.back ? page.bottom : page.topPage).add_child(page.next);
            }
            this._show(page.next, this._snapshot(page.windowActor, page.area));
        } catch (e) {
            console.warn(`3-finger-drag: could not snapshot Files window: ${e.message}`);
        }
    }

    // Where the folder view of the window is on the stage.
    _folderAreaOf(window) {
        return this._folderArea.get(window) ??
            this._estimateFolderArea(window.get_frame_rect());
    }

    // Where the folder view of a Files window with the given frame usually
    // is on the stage.
    _estimateFolderArea(frame) {
        const textScale = this._interfaceSettings.get_double('text-scaling-factor');
        const collapsed = frame.width <= COLLAPSE_WIDTH_SP * textScale;
        const sidebar = collapsed ? 0 : Math.round(Math.clamp(
            SIDEBAR_WIDTH_FRACTION * frame.width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
        const bottomBar = collapsed ? ACTION_BAR_HEIGHT : 0;

        return {
            x: frame.x + sidebar,
            y: frame.y + HEADER_BAR_HEIGHT,
            width: frame.width - sidebar,
            height: frame.height - HEADER_BAR_HEIGHT - bottomBar,
        };
    }

    // A picture of the whole window, placed relative to its folder view.
    _snapshot(windowActor, area) {
        return {
            content: windowActor.paint_to_content(null),
            x: windowActor.x - area.x,
            y: windowActor.y - area.y,
            width: windowActor.width,
            height: windowActor.height,
            areaWidth: area.width,
            areaHeight: area.height,
        };
    }

    // Whether a snapshot was taken with the window laid out as it is now,
    // not before it was resized.
    _fits(snapshot, windowActor, area) {
        return snapshot.x === windowActor.x - area.x &&
            snapshot.y === windowActor.y - area.y &&
            snapshot.width === windowActor.width &&
            snapshot.height === windowActor.height &&
            snapshot.areaWidth === area.width &&
            snapshot.areaHeight === area.height;
    }

    _show(actor, snapshot) {
        const {content, x, y, width, height} = snapshot;
        actor.set({content, x, y, width, height});
    }

    _setProgress(page, progress) {
        const value = this._willNavigate(page)
            ? progress : NO_HISTORY_STRETCH * (1 - Math.exp(-progress / NO_HISTORY_STRETCH));
        const catchUpMs = page.catchUpUntil - GLib.get_monotonic_time() / 1000;
        if (catchUpMs > 0) {
            page.adjustment.ease(value, {
                duration: catchUpMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            page.adjustment.remove_transition('value');
            page.adjustment.value = value;
        }
    }

    // Progress 0 shows the folder the swipe started on, 1 the one it goes to.
    _layout(page) {
        const progress = page.adjustment.value;
        const covered = page.back ? 1 - progress : progress;
        const {width} = page.area;

        page.top.translation_x = Math.round((1 - covered) * width);
        page.shadow.opacity = Math.round(255 * Math.min(1, 5 * covered));
        page.dim.opacity = Math.round(255 * MAX_DIM * covered);
    }

    // The page slid back to where it started: undo the navigation, and keep
    // covering the window until Files shows that folder again.
    _revert(page) {
        if (!page.clicked) {
            this._destroyPage(page);
            return;
        }

        // Files may still navigate from the button sent when the swipe
        // began; wait to undo it rather than let it jump there afterwards.
        // If it never does, there was nothing that way after all.
        if (!page.navigated) {
            page.state = 'waiting';
            this._clearTimeout(page);
            page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVERT_TIMEOUT_MS, () => {
                page.timeoutId = 0;
                this._windows.get(page.window)?.history.forget(page.back ? -1 : 1);
                this._destroyPage(page);
                return GLib.SOURCE_REMOVE;
            });
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
        page.container.remove_all_transitions();
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
        if (this._touchGesture) {
            global.stage.remove_action(this._touchGesture);
            this._touchGesture = null;
        }
        if (this._inputWatchId) {
            this._idleMonitor.remove_watch(this._inputWatchId);
            this._inputWatchId = 0;
        }
        this._swipe = null;
        if (this._page)
            this._destroyPage(this._page);
        this._untrackWindows();
        this._folderArea.destroy();
        this._folderArea = null;
        this._configManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._touchpadSettings = null;
        this._interfaceSettings = null;
        this._virtualDevice = null;
    }
});
