#!/bin/sh
# Packs the extension, installs it for the current user and enables it.
# Needs only what every GNOME desktop ships: gnome-extensions (part of
# GNOME Shell) and gsettings (part of GLib). The extension itself is
# JavaScript, so it runs on any distribution and CPU architecture.
set -e

UUID=better-gestures@extension.org

for tool in gnome-extensions gsettings; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Error: '$tool' was not found. Install GNOME Shell (it provides gnome-extensions) and GLib (gsettings)." >&2
        exit 1
    fi
done

cd "$(dirname "$0")"

echo "Packing extension..."
rm -f "$UUID.shell-extension.zip"
# Also compiles the schemas into the zip.
gnome-extensions pack . --force --extra-source=lib --extra-source=schemas

echo "Installing..."
gnome-extensions install --force "$UUID.shell-extension.zip"

# GNOME Shell only notices a newly installed extension after it restarts,
# so `gnome-extensions enable` cannot enable it yet; add it to the list of
# enabled extensions instead.
echo "Enabling extension..."
enabled=$(gsettings get org.gnome.shell enabled-extensions)
case "$enabled" in
    *"'$UUID'"*) ;;
    "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
    *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']" ;;
esac

echo "Done. Restart GNOME Shell to apply:"
echo "  Wayland: log out and back in"
echo "  X11: Alt+F2, r, Enter"
