import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// A cancelled (rather than ended) gesture means libinput is handing over to
// another one: a 3-finger hold turning into a swipe, or a 4th finger being
// added for a workspace switch. libinput needs up to ~180 ms to report the
// next gesture, so keep holding this long before giving up. Lifting all
// fingers ends the gesture instead and drops immediately.
const HANDOVER_GRACE_MS = 300;

// Owns the virtual pointer that holds the primary button down for exactly as
// long as three fingers are on the touchpad.
export const DragManager = GObject.registerClass({
}, class DragManager extends GObject.Object {
    _init(configManager) {
        super._init();
        this._configManager = configManager;
        this._buttonHeld = false;
        this._fingersLifted = false;
        this._dropTimeoutId = 0;

        // Read settings once here instead of on every motion event.
        this._speed = configManager.drag_speed;
        this._dropDelay = configManager.drop_delay;
        configManager.connectObject(
            'notify::drag-speed', () => (this._speed = configManager.drag_speed),
            'notify::drop-delay', () => (this._dropDelay = configManager.drop_delay),
            this);

        const seat = global.stage.context.get_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }

    isDragging() {
        return this._buttonHeld;
    }

    hasPendingDrop() {
        return this._dropTimeoutId !== 0;
    }

    // The fingers were lifted and the button is still held waiting for them
    // to come back, as opposed to libinput handing over between gestures.
    isWaitingForFingers() {
        return this._fingersLifted && this.hasPendingDrop();
    }

    // Fingers are on the pad but not dragging (e.g. a 4-finger workspace
    // swipe): keep the button held without moving.
    hold() {
        this._cancelPendingDrop();
    }

    // Three fingers are on the pad: press, or keep holding if a drop was
    // pending.
    begin(timeUs) {
        this._cancelPendingDrop();
        if (this._buttonHeld)
            return;

        this._virtualDevice.notify_button(timeUs,
            Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this._buttonHeld = true;
    }

    // Uses the original event timestamp so applications see the real finger
    // timing rather than main-loop jitter.
    move(timeUs, dx, dy) {
        if (this._buttonHeld)
            this._virtualDevice.notify_relative_motion(timeUs, dx * this._speed, dy * this._speed);
    }

    // Fingers lifted: drop now, or after the optional drop delay. Any other
    // input in the meantime drops immediately (see GestureHandler).
    release() {
        this._scheduleDrop(this._dropDelay, true);
    }

    // The gesture was cancelled rather than ended: libinput is probably
    // handing over to another gesture, which may continue the drag.
    releaseSoon() {
        this._scheduleDrop(Math.max(this._dropDelay, HANDOVER_GRACE_MS), false);
    }

    drop() {
        this._cancelPendingDrop();
        if (!this._buttonHeld)
            return;

        this._virtualDevice.notify_button(Clutter.CURRENT_TIME,
            Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        this._buttonHeld = false;
    }

    _scheduleDrop(delay, fingersLifted) {
        if (!this._buttonHeld)
            return;

        this._cancelPendingDrop();
        this._fingersLifted = fingersLifted;
        if (delay <= 0) {
            this.drop();
            return;
        }

        this._dropTimeoutId = GLib.timeout_add(GLib.PRIORITY_HIGH, delay, () => {
            this._dropTimeoutId = 0;
            this.drop();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPendingDrop() {
        this._fingersLifted = false;
        if (this._dropTimeoutId) {
            GLib.source_remove(this._dropTimeoutId);
            this._dropTimeoutId = 0;
        }
    }

    destroy() {
        this.drop();
        this._configManager.disconnectObject(this);
        this._virtualDevice = null;
    }
});
