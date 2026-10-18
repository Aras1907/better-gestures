import GObject from 'gi://GObject';

export const ConfigManager = GObject.registerClass({
    Properties: {
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
            'changed::drag-speed', () => this.notify('drag-speed'),
            'changed::drop-delay', () => this.notify('drop-delay'),
            'changed::nautilus-swipe-back', () => this.notify('nautilus-swipe-back'),
            this);
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

    destroy() {
        this._settings.disconnectObject(this);
        this._settings = null;
    }
});
