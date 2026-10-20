import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DRAG_FINGER_COUNT = 3;

// How long after a 4-finger swipe ends to still carry the dragged window to
// the newly activated workspace (covers the switch animation).
const CARRY_WINDOW_TIMEOUT_MS = 1000;

// A tap that drops the drag can report its click after the touch itself;
// swallow a click arriving this soon after such a drop.
const TAP_CLICK_WINDOW_US = 300 * 1000;

const {
    TOUCHPAD_SWIPE, TOUCHPAD_PINCH, TOUCHPAD_HOLD, MOTION, SCROLL,
    BUTTON_PRESS, BUTTON_RELEASE, KEY_PRESS, TOUCH_BEGIN,
} = Clutter.EventType;
const {BEGIN, UPDATE, END, CANCEL} = Clutter.TouchpadGesturePhase;

function isFromTouchpad(event) {
    const device = event.get_source_device();
    return device !== null &&
        device.get_device_type() === Clutter.InputDeviceType.TOUCHPAD_DEVICE;
}

// Virtual pointers (ours included) have no device node, unlike real mice and
// touchpads.
function isFromVirtualPointer(event) {
    const device = event.get_source_device();
    return device !== null && device.get_device_node() === null &&
        device.get_device_type() === Clutter.InputDeviceType.POINTER_DEVICE;
}

// Uses a Clutter event filter rather than a stage signal: filters run before
// any grab is honoured, so we keep receiving touchpad events while a window
// move or a Wayland drag-and-drop holds an input grab. They also run before
// GNOME Shell's own swipe trackers, so consuming 3-finger gestures here leaves
// the Shell's gestures (which accept 3 or more fingers) on 4 fingers only.
//
// The drag is tied to the fingers 1:1. libinput reports three resting fingers
// as a hold gesture and moving ones as a swipe (or pinch, if they spread), so
// the button goes down on whichever starts first and comes up when the
// fingers lift.
//
// Adding a 4th finger mid-drag switches workspaces without dropping; going
// back to three fingers continues the drag.
//
// After the fingers lift, the button stays held for the drop delay so three
// fingers can come back and carry on. Any other input (pointer motion,
// scrolling, a tap or click, a 1/2/4/5-finger gesture, a key press) drops
// right away.
//
// With the drag turned off in the settings, three-finger gestures are left
// to GNOME Shell.
//
// Mutter's own event filter runs before ours and stops pointer, button and
// key events that it delivers to an application window, so the filter only
// sees gestures reliably. Everything else is watched through the core idle
// monitor: its user-active watch fires synchronously for every real input
// event, before Mutter routes it, and is only armed while the button is held.
export const GestureHandler = GObject.registerClass({
}, class GestureHandler extends GObject.Object {
    _init(dragManager, configManager) {
        super._init();
        this._dragManager = dragManager;
        this._configManager = configManager;
        this._enabled = configManager.three_finger_drag;
        this._swallowedButtons = new Set();
        this._movingWindow = null;
        this._carryWindow = null;
        this._carryTimeoutId = 0;
        this._touchDropUs = 0;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._inputWatchId = 0;

        configManager.connectObject(
            'notify::three-finger-drag', () => {
                this._enabled = configManager.three_finger_drag;
                if (!this._enabled)
                    this._dragManager.drop();
            },
            this);
        global.display.connectObject(
            'grab-op-begin', (display, window, op) => {
                if (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.MOVING_UNCONSTRAINED)
                    this._movingWindow = window;
            },
            'grab-op-end', () => (this._movingWindow = null),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._carryWindowToActiveWorkspace(),
            this);

        this._filterId = Clutter.Event.add_filter(global.stage,
            event => this._handleEvent(event));
    }

    // Runs for every input event in the session, so keep the common path to
    // a couple of cheap checks.
    _handleEvent(event) {
        const type = event.type();

        if (type === TOUCHPAD_SWIPE || type === TOUCHPAD_PINCH || type === TOUCHPAD_HOLD)
            return this._handleGesture(event, type !== TOUCHPAD_HOLD);

        if (type === BUTTON_PRESS || type === BUTTON_RELEASE)
            return this._handleButton(event, type === BUTTON_PRESS);

        return Clutter.EVENT_PROPAGATE;
    }

    _watchInput() {
        if (!this._inputWatchId)
            this._inputWatchId = this._idleMonitor.add_user_active_watch(() => this._onInput());
    }

    _unwatchInput() {
        if (this._inputWatchId) {
            this._idleMonitor.remove_watch(this._inputWatchId);
            this._inputWatchId = 0;
        }
    }

    // The watch is one-shot: re-arm it for as long as the button is held.
    _onInput() {
        this._inputWatchId = 0;
        if (!this._dragManager.isDragging())
            return;

        const event = Clutter.get_current_event();
        if (!event || !this._interruptsDrag(event)) {
            this._watchInput();
            return;
        }

        this._dragManager.drop();
        // Let _handleButton swallow the tap if the event reaches our filter.
        if (event.type() === BUTTON_PRESS && isFromTouchpad(event))
            this._touchDropUs = GLib.get_monotonic_time();
    }

    // Gestures are left to the event filter, which always sees them. While
    // the fingers are on the pad only a click or Escape drops; once they have
    // lifted, any input does.
    _interruptsDrag(event) {
        const type = event.type();
        const waiting = this._dragManager.hasPendingDrop();

        if (type === KEY_PRESS)
            return waiting || event.get_key_symbol() === Clutter.KEY_Escape;
        if (type === BUTTON_PRESS)
            return !isFromVirtualPointer(event);
        if (type === MOTION || type === SCROLL || type === TOUCH_BEGIN)
            return waiting && !isFromVirtualPointer(event);
        return false;
    }

    _handleGesture(event, hasMotion) {
        const fingers = event.get_touchpad_gesture_finger_count();

        if (fingers === DRAG_FINGER_COUNT) {
            return this._enabled
                ? this._handleDragGesture(event, hasMotion) : Clutter.EVENT_PROPAGATE;
        }

        if (!this._dragManager.isDragging())
            return Clutter.EVENT_PROPAGATE;

        // Fewer fingers, or 4 fingers after the drag's fingers were lifted:
        // the user has moved on to something else, so drop and let the
        // gesture through. A resting finger (a hold) is only a new touch once
        // all fingers were lifted; otherwise it is a finger left behind while
        // lifting the others.
        const waiting = this._dragManager.isWaitingForFingers();
        if (fingers < DRAG_FINGER_COUNT || waiting) {
            if (event.get_gesture_phase() === BEGIN && (hasMotion || waiting)) {
                this._dragManager.drop();
                this._touchDropUs = GLib.get_monotonic_time();
            }
            return Clutter.EVENT_PROPAGATE;
        }

        return this._handleWorkspaceGesture(event);
    }

    _handleDragGesture(event, hasMotion) {
        switch (event.get_gesture_phase()) {
        case BEGIN:
            this._dragManager.begin(event.get_time_us());
            this._watchInput();
            break;
        case UPDATE:
            if (hasMotion) {
                const timeUs = event.get_time_us();
                const [dx, dy] = event.get_gesture_motion_delta();
                this._dragManager.begin(timeUs);
                this._dragManager.move(timeUs, dx, dy);
                this._watchInput();
            }
            break;
        case END:
            this._dragManager.release();
            break;
        case CANCEL:
            this._dragManager.releaseSoon();
            break;
        }

        return Clutter.EVENT_STOP;
    }

    // 4 fingers during a drag: keep the button held and switch workspaces.
    // The drag's input grab keeps these events from reaching the Shell's
    // workspace swipe tracker, so hand them to it directly.
    _handleWorkspaceGesture(event) {
        switch (event.get_gesture_phase()) {
        case BEGIN:
            this._dragManager.hold();
            this._startCarryingWindow();
            break;
        case END:
            this._dragManager.release();
            this._stopCarryingWindowSoon();
            break;
        case CANCEL:
            this._dragManager.releaseSoon();
            this._stopCarryingWindowSoon();
            break;
        }

        if (event.type() === TOUCHPAD_SWIPE)
            Main.wm._workspaceAnimation?._swipeTracker?._touchpadGesture?._handleEvent(global.stage, event);

        return Clutter.EVENT_STOP;
    }

    // Keep the window being dragged on screen during the switch animation and
    // move it to the new workspace, like dragging a window across Spaces.
    _startCarryingWindow() {
        this._clearCarryTimeout();
        this._carryWindow = this._movingWindow;
        if (this._carryWindow && Main.wm._workspaceAnimation)
            Main.wm._workspaceAnimation.movingWindow = this._carryWindow;
    }

    _stopCarryingWindowSoon() {
        this._clearCarryTimeout();
        this._carryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CARRY_WINDOW_TIMEOUT_MS, () => {
            this._carryTimeoutId = 0;
            this._carryWindow = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _carryWindowToActiveWorkspace() {
        const window = this._carryWindow;
        if (!window || window.is_on_all_workspaces())
            return;

        const workspace = global.workspace_manager.get_active_workspace();
        if (window.get_workspace() !== workspace)
            window.change_workspace(workspace);
    }

    _clearCarryTimeout() {
        if (this._carryTimeoutId) {
            GLib.source_remove(this._carryTimeoutId);
            this._carryTimeoutId = 0;
        }
    }

    // A tap or click on the touchpad during a drag drops immediately and is
    // swallowed, like on macOS.
    _handleButton(event, isPress) {
        if (!isFromTouchpad(event))
            return Clutter.EVENT_PROPAGATE;

        const button = event.get_button();

        if (!isPress)
            return this._swallowedButtons.delete(button)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;

        const tapAfterTouchDrop =
            GLib.get_monotonic_time() - this._touchDropUs < TAP_CLICK_WINDOW_US;
        if (!this._dragManager.isDragging() && !tapAfterTouchDrop)
            return Clutter.EVENT_PROPAGATE;

        this._dragManager.drop();
        this._touchDropUs = 0;
        this._swallowedButtons.add(button);
        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._filterId) {
            Clutter.Event.remove_filter(this._filterId);
            this._filterId = 0;
        }
        this._unwatchInput();
        this._clearCarryTimeout();
        this._carryWindow = null;
        this._movingWindow = null;
        this._configManager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
    }
});
