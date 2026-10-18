# macOS-style 3-Finger Drag & 4-Finger Gestures for GNOME

A GNOME Shell extension that brings the macOS **three-finger drag** to GNOME. Move windows, select text, and drag and drop files by sliding three fingers on the touchpad. No click is needed.

GNOME's own three-finger gestures (workspace switching, overview) move to **four fingers**, so the two don't clash.

## Features

- **Three-finger drag** works everywhere: window moves, text selection, drag and drop.
- **Four-finger swipes** switch workspaces and open the overview.
- **Drop delay:** after you lift your fingers, the drag stays held for a short time (5 seconds by default). You can reposition your fingers and keep dragging, like on macOS. Any other input drops it immediately.
- **Drag speed:** a multiplier on pointer speed while dragging.
- **Swipe back and forward in Files (Nautilus):** swipe two fingers right to go back and left to go forward, with the folder sliding like a page in Safari.

## Gestures

| Gesture | Action |
|---|---|
| Three fingers, slide | Drag (move windows, select text, drag and drop) |
| Four fingers, swipe left/right | Switch workspace |
| Four fingers, swipe up | Open the overview |
| Two fingers, swipe right in Files | Go back to the previous folder |
| Two fingers, swipe left in Files | Go forward to the next folder |

In Files, the page follows your fingers. Lift past about 40% of the window, or flick, to turn the page. Lift earlier and it slides back. If there is no folder to go back or forward to, the page only moves a little.

## Settings

Open the extension's preferences (Extension Manager or the Extensions app):

| Setting | Range | Default | Description |
|---|---|---|---|
| Drag Speed | 0.25 – 4.0 | 1.0 | Pointer speed multiplier while dragging |
| Drop Delay (ms) | 0 – 10000 | 5000 | How long to keep holding after fingers lift (0 drops at once) |
| Swipe Back in Files | on/off | on | Two-finger back and forward swipes in Nautilus |

## Requirements

- GNOME Shell 46, 47, 48, 49 or 50
- A touchpad with multi-touch support

## Installation

1. Download `gnome-3-finger-drag@extension.org.shell-extension.zip` from the [latest release](https://github.com/Aras1907/gnome-3-finger-drag/releases/latest).
2. Install it, either by opening the zip in **Extension Manager** or from a terminal:
   ```sh
   gnome-extensions install --force gnome-3-finger-drag@extension.org.shell-extension.zip
   ```
3. Restart GNOME Shell: log out and back in on Wayland, or press `Alt+F2`, type `r` and press Enter on X11.
4. Enable the extension:
   ```sh
   gnome-extensions enable gnome-3-finger-drag@extension.org
   ```

## Building from source

```sh
git clone https://github.com/Aras1907/gnome-3-finger-drag.git
cd gnome-3-finger-drag
./build.sh
```

`build.sh` packs the extension, installs it for the current user, compiles the schemas and enables it.

## Uninstall

```sh
gnome-extensions uninstall gnome-3-finger-drag@extension.org
```
