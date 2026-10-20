import GObject from 'gi://GObject';

export const ConfigManager = GObject.registerClass({
    Properties: {
        'three-finger-drag': GObject.ParamSpec.boolean(
            'three-finger-drag', 'Three-Finger Drag', '',
            GObject.ParamFlags.READWRITE,
            true
        ),
        'drag-speed': GObject.ParamSpec.double(
            'drag-speed', 'Drag Speed', '',
            GObject.ParamFlags.READWRITE,
            0.25, 4.0, 1.0
        ),
        'drop-delay': GObject.ParamSpec.int(
            'drop-delay', 'Drop Delay', '',
            GObject.ParamFlags.READWRITE,
            0, 10000, 5000
        ),
        'nautilus-swipe-back': GObject.ParamSpec.boolean(
            'nautilus-swipe-back', 'Swipe Back in Files', '',
            GObject.ParamFlags.READWRITE,
            true
        ),
        'nautilus-touch-swipe': GObject.ParamSpec.boolean(
            'nautilus-touch-swipe', 'Touchscreen Swipe in Files', '',
            GObject.ParamFlags.READWRITE,
            true
        )
    }
}, class ConfigManager extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._connectSettings();
    }

    _connectSettings() {
        this._settings.connectObject(
            'changed::three-finger-drag', () => this.notify('three-finger-drag'),
            'changed::drag-speed', () => this.notify('drag-speed'),
            'changed::drop-delay', () => this.notify('drop-delay'),
            'changed::nautilus-swipe-back', () => this.notify('nautilus-swipe-back'),
            'changed::nautilus-touch-swipe', () => this.notify('nautilus-touch-swipe'),
            this);
    }

    get three_finger_drag() {
        return this._settings.get_boolean('three-finger-drag');
    }
    set three_finger_drag(value) {
        this._settings.set_boolean('three-finger-drag', value);
    }

    get drag_speed() {
        return this._settings.get_double('drag-speed');
    }
    set drag_speed(value) {
        this._settings.set_double('drag-speed', value);
    }

    get drop_delay() {
        return this._settings.get_int('drop-delay');
    }
    set drop_delay(value) {
        this._settings.set_int('drop-delay', value);
    }

    get nautilus_swipe_back() {
        return this._settings.get_boolean('nautilus-swipe-back');
    }
    set nautilus_swipe_back(value) {
        this._settings.set_boolean('nautilus-swipe-back', value);
    }

    get nautilus_touch_swipe() {
        return this._settings.get_boolean('nautilus-touch-swipe');
    }
    set nautilus_touch_swipe(value) {
        this._settings.set_boolean('nautilus-touch-swipe', value);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._settings = null;
    }
});
