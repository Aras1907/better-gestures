# CLAUDE.md

Better Gestures, a GNOME Shell extension (GJS, ES modules) for GNOME Shell 46–50: macOS-style
three-finger drag, GNOME's own gestures moved to four fingers, and
Safari-style two-finger back/forward swipes in Files (Nautilus).

## Layout

- `extension.js`: entry point; creates the managers in `enable()` and destroys them in `disable()`.
- `prefs.js`: preferences window.
- `schemas/`: GSettings schema `org.gnome.shell.extensions.better-gestures`.
- `lib/configManager.js`: wraps the settings.
- `lib/gestureHandler.js`: touchpad gesture recognition (three-finger drag, four-finger remapping).
- `lib/dragManager.js`: holds and releases the virtual pointer drag, including the drop delay.
- `lib/swipeBack.js`: back/forward swipes in Files, from two-finger touchpad scrolls and one-finger touchscreen pans from the folder view's edges (`Clutter.PanGesture`, GNOME 49+ only). It snapshots the window, sends the mouse back/forward button (8/9) through a virtual pointer, and animates the snapshots over the window.
- `lib/folderHistory.js`: tracks each Files window's back/forward history from its title, with a snapshot per folder, so a swipe can show the destination folder before Files gets there.
- `lib/folderArea.js`: finds the Files folder view's rectangle through the AT-SPI accessibility bus, so that only that area slides. It looks the area up again after the window is resized. `swipeBack.js` falls back to estimating it from Files' layout.

## Building and testing

- `./build.sh` or `make install` packs the extension and installs it into
  `~/.local/share/gnome-shell/extensions/better-gestures@extension.org/`.
- **GNOME Shell runs that installed copy, not this folder.** After editing,
  reinstall it (or copy the changed files there). On Wayland, also log out
  and back in, because GNOME Shell does not reload extension code otherwise.
- There are no automated tests. Check changes by hand on a real touchpad.
  Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. Messages are prefixed
  with `better-gestures:`.

## Conventions

- Match the existing style: 4-space indent, single quotes, `GObject.registerClass`
  for classes that need signals, `connectObject`/`disconnectObject` for
  signal handling.
- Comments explain why, in plain sentences. Named constants with a comment sit
  at the top of each module.
- Everything created in `enable()` must be torn down in `disable()`/`destroy()`:
  signals, timeouts (`GLib.Source.remove`), actors and D-Bus connections.
- Never block the compositor: D-Bus calls are asynchronous and have timeouts.
- Keep `README.md` in sync with behaviour users can see.
