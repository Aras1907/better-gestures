#!/bin/bash
set -e

UUID=gnome-3-finger-drag@extension.org
EXT_DIR=~/.local/share/gnome-shell/extensions/$UUID

echo "Packing extension..."
rm -f ${UUID}.shell-extension.zip
gnome-extensions pack . --extra-source=lib --extra-source=schemas

echo "Installing..."
gnome-extensions install ${UUID}.shell-extension.zip --force

echo "Compiling schemas..."
mkdir -p $EXT_DIR/schemas
cp schemas/org.gnome.shell.extensions.3-finger-drag.gschema.xml $EXT_DIR/schemas/
glib-compile-schemas $EXT_DIR/schemas/

echo "Enabling extension..."
gnome-extensions enable $UUID 2>/dev/null || true
gsettings set org.gnome.shell enabled-extensions "$(python3 -c "
import subprocess, json
out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'])
exts = eval(out.decode())
if '$UUID' not in exts:
    exts.append('$UUID')
print(json.dumps(exts))
")" 2>/dev/null || true

echo "Done. Restart GNOME Shell to apply:"
echo "  Wayland: log out and back in"
echo "  X11: Alt+F2, r, Enter"
echo "  Or disable/enable the extension in Extensions app"
