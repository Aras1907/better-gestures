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
const {
    TOUCHPAD_SWIPE, TOUCHPAD_PINCH, TOUCHPAD_HOLD,
    KEY_PRESS, BUTTON_PRESS, TOUCH_BEGIN,
} = Clutter.EventType;

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

// Until there is a picture of the folder being gone to, a blank page stands
// in for it.
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

// If Files has not navigated this long after being sent the button, it had
// nothing that way after all, and the page slides back.
const NAVIGATE_TIMEOUT_MS = 400;

// Going back or forward with Files' buttons, the keyboard or a mouse's side
// buttons turns the page too, in this long.
const NAVIGATION_SLIDE_MS = 300;

// Files is taken to have done what it was told (by us, or by a key or
// button) if it navigates this soon after; later, it is taken not to.
const EXPECT_MS = 1000;

// Keys that only modify others, which leave a pending back or forward be.
const MODIFIER_KEYS = new Set([
    Clutter.KEY_Alt_L, Clutter.KEY_Alt_R, Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
    Clutter.KEY_Control_L, Clutter.KEY_Control_R, Clutter.KEY_Super_L, Clutter.KEY_Super_R,
    Clutter.KEY_Meta_L, Clutter.KEY_Meta_R, Clutter.KEY_ISO_Level3_Shift,
]);

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
// when it was last shown, if there is one (see FolderHistory). Lifting the
// fingers early slides the page back and sends the opposite button. Whether
// Files actually navigated is told by its window title, which names the
// folder.
//
// At either end of Files' history there is nothing to swipe to, so no page
// turns at all: the swipe is left to Files as an ordinary scroll or touch.
//
// Going back or forward any other way (Files' back and forward buttons,
// Alt+Left and Alt+Right, a mouse's side buttons) turns the page the same
// way once Files navigates, without fingers to follow.
//
// Going back and forward quickly can get ahead of Files. So each window
// keeps a queue of the navigations Files has been told to make and has yet
// to (see _expect), and a new page turn starts from where Files will be once
// it has caught up, rather than waiting for it.
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
        this._animateEnabled = configManager.nautilus_navigation_animation;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._inputWatchId = 0;
        this._swipe = null;
        this._page = null;
        // The window a touch may swipe in, and which way.
        this._touchWindow = null;
        this._touchBack = false;
        // When the last touchpad gesture of three or more fingers was seen.
        this._multiFingerMs = -Infinity;
        this._folderArea = new FolderArea(window => this._syncHistory(window));
        // Files windows seen with the focus: {history, expected, snapshotId}.
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
            'notify::nautilus-navigation-animation', () => {
                this._animateEnabled = configManager.nautilus_navigation_animation;
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
        if (!this._anyEnabled())
            this._untrackWindows();
        this._onFocusChanged();
    }

    _anyEnabled() {
        return this._enabled || this._touchEnabled || this._animateEnabled;
    }

    _onFocusChanged() {
        const window = global.display.focus_window;
        if (this._anyEnabled() && isNautilus(window)) {
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
            // Navigations Files is yet to make, oldest first: {step (-1
            // back, 1 forward), page (the page turn that asked for it, if
            // any), hint (asked for by a key or button), undo (to be undone
            // as soon as it is made), time}.
            expected: [],
            snapshotId: 0,
        });
        window.connectObject(
            'notify::title', () => this._onWindowTitleChanged(window),
            'unmanaged', () => this._untrackWindow(window),
            this);
        this._scheduleSnapshot(window);
    }

    _onWindowTitleChanged(window) {
        const state = this._windows.get(window);
        const {history} = state;
        const title = window.get_title();

        // The oldest navigation Files was told to make is the one it made.
        const entry = this._expected(state).shift() ?? null;
        const step = entry ? entry.step : this._guessStep(window, history, title);
        const page = entry?.page;
        if (page && page.state !== 'destroyed') {
            this._onTitleChanged(page);
        } else if ((!entry || entry.hint) && step && this._animateEnabled &&
                   window === global.display.focus_window) {
            // Files went back or forward by itself: turn the page.
            this._animateNavigation(window, step < 0, history.peek(step));
        }

        history.navigated(title, step);
        if (entry?.undo)
            this._navigate(window, step > 0, null);
        this._scheduleSnapshot(window);
        // Whether Files can go back and forward from here.
        if (window === global.display.focus_window)
            this._folderArea.update(window);
    }

    // Which way Files went to the folder with this title, untold, if it
    // went back (-1) or forward (1) at all. When the back and forward
    // buttons are known, it did not, as pressing them would have told;
    // otherwise the history guesses.
    _guessStep(window, history, title) {
        if (this._folderArea.knowsButtons(window))
            return 0;
        if (history.peek(-1)?.title === title)
            return -1;
        if (history.peek(1)?.title === title)
            return 1;
        return 0;
    }

    // The navigations Files is yet to make in the window, less those it
    // has taken too long to.
    _expected(state) {
        const now = GLib.get_monotonic_time() / 1000;
        state.expected = state.expected.filter(e => now - e.time < EXPECT_MS);
        return state.expected;
    }

    // Files is about to be told to go back (or forward).
    _expect(window, back, {page = null, hint = false} = {}) {
        const state = this._windows.get(window);
        if (!state)
            return;
        state.expected.push({
            step: back ? -1 : 1,
            page,
            hint,
            undo: false,
            time: GLib.get_monotonic_time() / 1000,
        });
    }

    // Tell Files to go back (or forward).
    _navigate(window, back, page) {
        this._expect(window, back, {page});
        this._click(back ? BACK_BUTTON : FORWARD_BUTTON);
    }

    // How many folders forward (or back, if negative) of the one in the
    // history Files will show once it has caught up, and any page turn
    // under way has been undone or not.
    _pendingOffset(window) {
        const state = this._windows.get(window);
        if (!state)
            return 0;

        const undone = page => page &&
            (page.state === 'cancelling' || page.state === 'waiting');
        let offset = 0;
        for (const entry of this._expected(state)) {
            if (!entry.undo && !undone(entry.page))
                offset += entry.step;
        }
        const page = this._page;
        if (page?.window === window && page.navigated && undone(page))
            offset -= page.back ? -1 : 1;
        return offset;
    }

    // Files has said whether it can go back and forward: forget the guesses
    // that way if it cannot.
    _syncHistory(window) {
        const history = this._windows.get(window)?.history;
        if (!history)
            return;
        if (this._folderArea.canNavigate(window, true) === false)
            history.forget(-1);
        if (this._folderArea.canNavigate(window, false) === false)
            history.forget(1);
    }

    _untrackWindow(window) {
        if (this._page?.window === window)
            this._destroyPage(this._page);
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
            state.history.settle();
            const windowActor = window.get_compositor_private();
            if (!windowActor)
                return GLib.SOURCE_REMOVE;
            try {
                state.history.current.snapshot =
                    this._snapshot(windowActor, this._folderAreaOf(window));
            } catch (e) {
                console.warn(`better-gestures: could not snapshot Files window: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Every input event costs a JS call while watched, so only watch while
    // Files has the focus (or a touchpad swipe is still in progress).
    _updateWatch() {
        const wanted = (this._enabled || this._animateEnabled) &&
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
            event.get_scroll_source() === Clutter.ScrollSource.FINGER) {
            if (this._enabled)
                this._handleScroll(event);
        } else if (type === TOUCHPAD_SWIPE || type === TOUCHPAD_PINCH || type === TOUCHPAD_HOLD) {
            this._handleTouchpadGesture(event);
        } else if (event && this._swipe?.touch === false && !isFromVirtualPointer(event)) {
            this._endSwipe('finish');
        }

        if (type === KEY_PRESS || type === BUTTON_PRESS || type === TOUCH_BEGIN)
            this._noteHint(event);

        this._updateWatch();
    }

    // Remember a key or button telling Files to go back or forward, so the
    // page turns if Files does; any other one forgets those Files has not
    // acted on, as it was not going to.
    _noteHint(event) {
        const window = global.display.focus_window;
        const state = this._windows.get(window);
        if (!state || isFromVirtualPointer(event))
            return;

        let back = null;
        const type = event.type();
        if (type === KEY_PRESS) {
            const key = event.get_key_symbol();
            if (MODIFIER_KEYS.has(key))
                return;
            const alt = (event.get_state() & Clutter.ModifierType.MOD1_MASK) !== 0;
            if (key === Clutter.KEY_Back || (alt && key === Clutter.KEY_Left))
                back = true;
            else if (key === Clutter.KEY_Forward || (alt && key === Clutter.KEY_Right))
                back = false;
        } else if (type === BUTTON_PRESS && event.get_button() === BACK_BUTTON) {
            back = true;
        } else if (type === BUTTON_PRESS && event.get_button() === FORWARD_BUTTON) {
            back = false;
        } else if (type === TOUCH_BEGIN || event.get_button() === Clutter.BUTTON_PRIMARY) {
            const [x, y] = event.get_coords();
            back = this._folderArea.buttonAt(window, x, y);
        }

        if (back === null)
            state.expected = state.expected.filter(e => !e.hint);
        else if (this._canGo(window, back))
            this._expect(window, back, {hint: true});
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
            // Nothing that way: an ordinary scroll for Files.
            if (swipe.direction && !this._canGo(swipe.window, swipe.direction > 0))
                swipe.direction = 0;
            // In case the window changed since it got the focus, such as
            // the sidebar being hidden. Only for sideways swipes, as each
            // lookup is a round of D-Bus calls.
            if (swipe.direction)
                this._folderArea.update(swipe.window);
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
        global.stage.add_action_full('better-gestures-files-swipe',
            Clutter.EventPhase.CAPTURE, gesture);
        return gesture;
    }

    _mayRecognizeTouch(gesture) {
        this._touchWindow = null;
        if (!this._touchEnabled || this._swipe || Main.actionMode !== Shell.ActionMode.NORMAL)
            return false;
        if (this._page?.state === 'tracking')
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

        // Nothing that way: Files keeps the touch.
        this._trackWindow(window);
        if (!this._canGo(window, back))
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
            this._undo(page);
            this._destroyPage(page);
            return;
        }

        const progress = this._swipeProgress(swipe);
        const velocity = this._swipeVelocity(swipe);
        const commit = outcome === 'finish' &&
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
        if (speed > 0)
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

    // The page has turned: uncover the window once Files shows the folder.
    // Until then, the title change or _onNoNavigation picks it up.
    _settle(page) {
        page.slid = true;
        if (!page.navigated)
            return;
        this._clearTimeout(page);
        page.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DELAY_MS, () => {
            page.timeoutId = 0;
            this._fadeOut(page);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Files was sent the button but did not navigate: there was nothing that
    // way after all. Forget the guess and slide the page back, wherever it
    // has got to; the rest of the swipe is left alone.
    _onNoNavigation(page) {
        const state = this._windows.get(page.window);
        if (state) {
            state.expected = state.expected.filter(e => e.page !== page);
            if (page.offset === 0)
                state.history.forget(page.back ? -1 : 1);
        }
        if (this._swipe?.page === page) {
            this._swipe.page = null;
            this._swipe.direction = 0;
        }
        if (page.state === 'waiting') {
            this._destroyPage(page);
            return;
        }

        page.state = 'cancelling';
        this._clearTimeout(page);
        page.adjustment.ease(0, {
            duration: MIN_SLIDE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (page.state !== 'destroyed')
                    this._revert(page);
            },
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

    // Whether Files can go back (or forward) in the window: its back or
    // forward button says so, or failing that, the history knows a folder
    // there.
    // there. While Files is catching up, its buttons are out of date, and
    // the history is asked about where it will be.
    _canGo(window, back) {
        const offset = this._pendingOffset(window);
        if (offset === 0) {
            const canNavigate = this._folderArea.canNavigate(window, back);
            if (canNavigate !== null)
                return canNavigate;
        }
        return !!this._windows.get(window)?.history.peek(offset + (back ? -1 : 1));
    }

    // Make way for a new page turn. A page sliding into place is done; one
    // sliding back, or yet to, is undone at once. One the fingers still
    // hold stays.
    _makeWay() {
        const page = this._page;
        if (!page)
            return true;
        if (page.state === 'tracking')
            return false;
        if (page.state === 'cancelling' || page.state === 'waiting')
            this._undo(page);
        this._destroyPage(page);
        return true;
    }

    // Undo the navigation of a page turn that is not going ahead: now, if
    // Files has made it, or else as soon as it does.
    _undo(page) {
        if (page.navigated) {
            this._navigate(page.window, !page.back, null);
            return;
        }
        const entry = this._windows.get(page.window)?.expected.find(e => e.page === page);
        if (entry)
            entry.undo = true;
    }

    // Freeze the current folder over the window and navigate underneath it.
    _turnPage(window, back) {
        if (!this._canGo(window, back))
            return null;

        // Where Files will be: take the picture there, not of a folder it
        // is passing through.
        const offset = this._pendingOffset(window);
        if (!this._makeWay())
            return null;
        const destination =
            this._windows.get(window)?.history.peek(offset + (back ? -1 : 1)) ?? null;
        const page = this._createPage(window, back, destination, offset);
        if (!page)
            return null;

        this._navigate(window, back, page);
        page.navigateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NAVIGATE_TIMEOUT_MS, () => {
            page.navigateTimeoutId = 0;
            this._onNoNavigation(page);
            return GLib.SOURCE_REMOVE;
        });
        return page;
    }

    // Files has just gone back or forward by itself, and is yet to show the
    // folder: freeze the one it left over the window and turn the page.
    _animateNavigation(window, back, destination) {
        // Not over a page the fingers hold, or one being undone.
        if (this._page) {
            if (this._page.state !== 'committing')
                return;
            this._destroyPage(this._page);
        }
        const page = this._createPage(window, back, destination, 0);
        if (!page)
            return;

        page.navigated = true;
        page.state = 'committing';
        this._refreshNext(page);
        page.adjustment.ease(1, {
            duration: NAVIGATION_SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (page.state !== 'destroyed')
                    this._settle(page);
            },
        });
    }

    // Cover the folder view with a picture of the folder `offset` steps from
    // the current one in the history, and the folder `back` (or forward) of
    // it to turn to, at progress 0.
    _createPage(window, back, destination, offset) {
        const history = this._windows.get(window)?.history;
        const windowActor = window.get_compositor_private();
        if (!windowActor)
            return null;

        // The window shows the current folder; for any other, its picture
        // from the history, if there is one that fits.
        const area = this._folderAreaOf(window);
        const shown = offset !== 0 ? history?.peek(offset)?.snapshot : null;
        let snapshot;
        if (shown && this._fits(shown, windowActor, area)) {
            snapshot = shown;
        } else {
            try {
                snapshot = this._snapshot(windowActor, area);
            } catch (e) {
                console.warn(`better-gestures: could not snapshot Files window: ${e.message}`);
                return null;
            }
            if (history && offset === 0)
                history.current.snapshot = snapshot;
        }
        const current = new Clutter.Actor();
        this._show(current, snapshot);

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
            offset,
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
            navigated: false,
            slid: false,
            catchUpUntil: GLib.get_monotonic_time() / 1000 + CATCH_UP_MS,
            state: 'tracking',
            adjustment: new St.Adjustment({actor: container, lower: 0, upper: 1, value: 0}),
            timeoutId: 0,
            navigateTimeoutId: 0,
        };
        this._page = page;

        page.adjustment.connect('notify::value', () => this._layout(page));
        page.actorDestroyId = windowActor.connect('destroy', () => {
            page.actorDestroyId = 0;
            this._destroyPage(page);
        });

        this._layout(page);
        return page;
    }

    // Files has made the navigation the page asked for (see
    // _onWindowTitleChanged).
    _onTitleChanged(page) {
        this._clearNavigateTimeout(page);

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

        page.navigated = true;
        this._refreshNext(page);

        if (page.slid) {
            this._settle(page);
        } else if (this._swipe?.page === page) {
            page.catchUpUntil = GLib.get_monotonic_time() / 1000 + CATCH_UP_MS;
            this._setProgress(page, this._swipeProgress(this._swipe));
        }
    }

    // Keep capturing the new folder for a while as it loads, starting once
    // Files has had a moment to draw it: a capture taken at once can still
    // show the folder it left.
    _refreshNext(page) {
        const settle = page.hasPicture && page.window.get_title() === page.expectedTitle
            ? Math.ceil(PAGE_SETTLE_MS / PAGE_REFRESH_MS) : 1;
        let ticks = 0;
        this._clearTimeout(page);
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
    }

    _captureNext(page) {
        try {
            if (!page.next) {
                page.next = new Clutter.Actor();
                (page.back ? page.bottom : page.topPage).add_child(page.next);
            }
            this._show(page.next, this._snapshot(page.windowActor, page.area));
        } catch (e) {
            console.warn(`better-gestures: could not snapshot Files window: ${e.message}`);
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

    _setProgress(page, value) {
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
        // Files may still navigate from the button sent when the swipe
        // began; wait to undo it rather than let it jump there afterwards.
        // If it never does (see _onNoNavigation), there was nothing that way
        // after all.
        if (!page.navigated) {
            if (!page.navigateTimeoutId) {
                this._destroyPage(page);
                return;
            }
            page.state = 'waiting';
            this._clearTimeout(page);
            return;
        }

        page.state = 'reverting';
        this._clearTimeout(page);
        this._navigate(page.window, !page.back, page);
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

    _clearNavigateTimeout(page) {
        if (page.navigateTimeoutId) {
            GLib.source_remove(page.navigateTimeoutId);
            page.navigateTimeoutId = 0;
        }
    }

    _destroyPage(page) {
        if (page.state === 'destroyed')
            return;
        page.state = 'destroyed';

        this._clearTimeout(page);
        this._clearNavigateTimeout(page);
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
