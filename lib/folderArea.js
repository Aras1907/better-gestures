import Atspi from 'gi://Atspi';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const REGISTRY_BUS_NAME = 'org.a11y.atspi.Registry';
const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE_IFACE = 'org.a11y.atspi.Accessible';
const COMPONENT_IFACE = 'org.a11y.atspi.Component';
const NAUTILUS_APP_NAME = 'org.gnome.Nautilus';

// A busy Files should not keep a lookup hanging.
const CALL_TIMEOUT_MS = 500;

// Files lays itself out again after the window is resized or maximized; look
// once it has settled.
const RESIZE_SETTLE_MS = 250;

// Folder views lie about ten levels under the window; anything with more
// children than this is a list of files or places, not part of the layout.
const MAX_DEPTH = 16;
const MAX_CHILDREN = 64;

// Atspi.StateType.ACTIVE and SENSITIVE, in the first word of the state set.
const STATE_ACTIVE = 1 << Atspi.StateType.ACTIVE;
const STATE_SENSITIVE = 1 << Atspi.StateType.SENSITIVE;

// The header bar's back and forward buttons, greyed out at either end of
// the history. They are found by name (or, for icon buttons, their tooltip),
// so only in English; elsewhere whether Files can navigate stays unknown.
const BACK_BUTTON_NAME = 'Back';
const FORWARD_BUTTON_NAME = 'Forward';

function call(connection, busName, path, iface, method, params, replyType) {
    return new Promise((resolve, reject) => {
        connection.call(busName, path, iface, method, params,
            new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS, null, (conn, result) => {
                try {
                    resolve(conn.call_finish(result).recursiveUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Where Files shows the folder, read from its accessibility tree (the one
// screen readers use): the panel named after the folder, which is also the
// window's title, inside the window's frame.
//
// Asking is a round of D-Bus calls, too slow to make while a swipe is being
// recognised, so the area is looked up in advance (when a Files window gets
// the focus, after it is resized, and as each swipe begins) and kept until
// asked for.
export class FolderArea {
    constructor() {
        this._connection = null;
        this._connecting = null;
        this._cached = null;
        this._pending = null;
        this._again = false;
        this._tracked = null;
        this._resizeTimeoutId = 0;
        this._destroyed = false;
    }

    // The folder view of the window on the stage, or null if not known.
    get(window) {
        const cached = this._cached;
        if (cached?.window !== window || !cached.rect)
            return null;

        // Looked up at another size, the folder view has moved since.
        const frame = window.get_frame_rect();
        if (frame.width !== cached.frameWidth || frame.height !== cached.frameHeight)
            return null;

        const [x, y, width, height] = cached.rect;
        if (width <= 0 || height <= 0 || x < 0 || y < 0 ||
            x + width > frame.width || y + height > frame.height)
            return null;

        return {x: frame.x + x, y: frame.y + y, width, height};
    }

    // Whether Files can go back (or forward) in the window: true, false, or
    // null if not known.
    canNavigate(window, back) {
        const cached = this._cached;
        if (cached?.window !== window)
            return null;
        return (back ? cached.canGoBack : cached.canGoForward) ?? null;
    }

    // Look the folder view of the window up now, and again whenever it is
    // resized, until another window is tracked.
    track(window) {
        if (this._tracked !== window) {
            this._untrack();
            this._tracked = window;
            window.connectObject(
                'size-changed', () => {
                    this._clearResizeTimeout();
                    this._resizeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                        RESIZE_SETTLE_MS, () => {
                            this._resizeTimeoutId = 0;
                            this.update(window);
                            return GLib.SOURCE_REMOVE;
                        });
                },
                'unmanaged', () => this._untrack(),
                this);
        }
        this.update(window);
    }

    _untrack() {
        this._clearResizeTimeout();
        this._tracked?.disconnectObject(this);
        this._tracked = null;
    }

    _clearResizeTimeout() {
        if (this._resizeTimeoutId) {
            GLib.source_remove(this._resizeTimeoutId);
            this._resizeTimeoutId = 0;
        }
    }

    // Look the folder view of the window up again, in the background.
    update(window) {
        // The answer on its way may be out of date; ask again once it is in.
        if (this._pending === window) {
            this._again = true;
            return;
        }
        this._pending = window;
        this._again = false;

        this._update(window).catch(e => {
            if (this._cached?.window === window)
                this._cached = null;
            console.debug(`3-finger-drag: could not find the Files folder view: ${e.message}`);
        }).finally(() => {
            if (this._pending !== window)
                return;
            this._pending = null;
            if (this._again && !this._destroyed)
                this.update(window);
        });
    }

    async _update(window) {
        const connection = await this._connect();
        const title = window.get_title();
        const {width: frameWidth, height: frameHeight} = window.get_frame_rect();

        // The same folder view, unless the window has switched tabs.
        let cached = this._cached?.window === window ? this._cached : null;
        if (cached) {
            const [[name], [rect]] = await Promise.all([
                this._name(connection, cached.busName, cached.path),
                call(connection, cached.busName, cached.path, COMPONENT_IFACE,
                    'GetExtents', new GLib.Variant('(u)', [Atspi.CoordType.WINDOW]), '((iiii))'),
            ]);
            if (name !== title)
                cached = null;
            else
                cached = {...cached, rect};
        }

        if (!cached) {
            const found = await this._find(connection, title);
            const [rect] = await call(connection, found.busName, found.path,
                COMPONENT_IFACE, 'GetExtents',
                new GLib.Variant('(u)', [Atspi.CoordType.WINDOW]), '((iiii))');
            cached = {window, ...found, rect};
        }

        const [canGoBack, canGoForward] = await Promise.all(
            [cached.backButton, cached.forwardButton].map(button => button
                ? call(connection, ...button, ACCESSIBLE_IFACE, 'GetState', null, '(au)')
                    .then(([state]) => (state[0] & STATE_SENSITIVE) !== 0, () => null)
                : null));

        if (!this._destroyed)
            this._cached = {...cached, frameWidth, frameHeight, canGoBack, canGoForward};
    }

    async _connect() {
        if (this._destroyed)
            throw new Error('destroyed');
        if (this._connection)
            return this._connection;

        this._connecting ??= (async () => {
            const [address] = await call(Gio.DBus.session, 'org.a11y.Bus',
                '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', null, '(s)');
            return new Promise((resolve, reject) => {
                Gio.DBusConnection.new_for_address(address,
                    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
                    Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                    null, null, (source, result) => {
                        try {
                            resolve(Gio.DBusConnection.new_for_address_finish(result));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
        })();

        try {
            const connection = await this._connecting;
            if (this._destroyed) {
                connection.close(null, null);
                throw new Error('destroyed');
            }
            this._connection = connection;
            return connection;
        } finally {
            this._connecting = null;
        }
    }

    _name(connection, busName, path) {
        return call(connection, busName, path, 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', [ACCESSIBLE_IFACE, 'Name']), '(v)');
    }

    _children(connection, busName, path) {
        return call(connection, busName, path, ACCESSIBLE_IFACE,
            'GetChildren', null, '(a(so))').then(([children]) => children);
    }

    async _find(connection, title) {
        // Files' application, then its focused window.
        const apps = await this._children(connection, REGISTRY_BUS_NAME, ROOT_PATH);
        const appNames = await Promise.all(apps.map(([busName, path]) =>
            this._name(connection, busName, path).then(([name]) => name, () => null)));
        const app = apps[appNames.indexOf(NAUTILUS_APP_NAME)];
        if (!app)
            throw new Error('Files is not on the accessibility bus');

        const frames = await this._children(connection, ...app);
        const frameInfo = await Promise.all(frames.map(([busName, path]) => Promise.all([
            this._name(connection, busName, path),
            call(connection, busName, path, ACCESSIBLE_IFACE, 'GetState', null, '(au)'),
        ]).then(([[name], [state]]) => ({name, active: (state[0] & STATE_ACTIVE) !== 0}))));
        let index = frameInfo.findIndex(f => f.active && f.name === title);
        if (index < 0 && frameInfo.filter(f => f.name === title).length === 1)
            index = frameInfo.findIndex(f => f.name === title);
        if (index < 0)
            throw new Error('no Files window is named after the folder');

        // Breadth first, a level at a time: the folder view is the first
        // panel found named after the folder. Places in the sidebar can be
        // named after it too, but are list items. The back and forward
        // buttons are picked up on the way.
        let panel = null;
        let backButton = null;
        let forwardButton = null;
        let level = [frames[index]];
        for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
            const children = (await Promise.all(level.map(node =>
                this._children(connection, ...node).catch(() => []))))
                .filter(c => c.length <= MAX_CHILDREN)
                .flat();

            const names = await Promise.all(children.map(node =>
                this._name(connection, ...node).then(([name]) => name, () => null)));
            // Icon buttons are named by their tooltip, which may only be
            // their description.
            const wanted = name => (name === title && !panel) ||
                (!(backButton && forwardButton) && (name === '' ||
                    name === BACK_BUTTON_NAME || name === FORWARD_BUTTON_NAME));
            const candidates = children.filter((node, i) => wanted(names[i]));
            const candidateNames = names.filter(name => wanted(name));
            const roles = await Promise.all(candidates.map(node =>
                call(connection, ...node, ACCESSIBLE_IFACE, 'GetRole', null, '(u)')
                    .then(([role]) => role, () => null)));
            for (const [i, node] of candidates.entries()) {
                const name = candidateNames[i];
                if (roles[i] === Atspi.Role.PANEL && name === title && !panel) {
                    panel = node;
                } else if (roles[i] === Atspi.Role.PUSH_BUTTON) {
                    const label = name || await this._description(connection, node);
                    if (label === BACK_BUTTON_NAME)
                        backButton ??= node;
                    else if (label === FORWARD_BUTTON_NAME)
                        forwardButton ??= node;
                }
            }

            if (panel && backButton && forwardButton)
                break;
            level = children;
        }

        if (!panel)
            throw new Error('no panel is named after the folder');
        return {busName: panel[0], path: panel[1], backButton, forwardButton};
    }

    _description(connection, node) {
        return call(connection, ...node, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [ACCESSIBLE_IFACE, 'Description']), '(v)')
            .then(([description]) => description, () => null);
    }

    destroy() {
        this._destroyed = true;
        this._untrack();
        this._cached = null;
        this._connection?.close(null, null);
        this._connection = null;
    }
}
