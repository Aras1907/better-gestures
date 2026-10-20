# Better Gestures for GNOME

A GNOME Shell extension that brings the macOS **three-finger drag** to GNOME. Move windows, select text, and drag and drop files by sliding three fingers on the touchpad. No click is needed.

GNOME's own three-finger gestures (workspace switching, overview) move to **four fingers**, so the two don't clash.

## Features

- **Three-finger drag** works everywhere: window moves, text selection, drag and drop.
- **Four-finger swipes** switch workspaces and open the overview.
- **Drop delay:** after you lift your fingers, the drag stays held for a short time (5 seconds by default). You can reposition your fingers and keep dragging, like on macOS. Any other input drops it immediately.
- **Drag speed:** a multiplier on pointer speed while dragging.
- **On/off switch:** turn the three-finger drag off in the settings to leave three-finger swipes to GNOME.
- **Swipe back and forward in Files (Nautilus):** swipe two fingers right to go back and left to go forward, with the folder view sliding like a page in Safari. The sidebar and header bar stay put. The folder you are going to shows as soon as the swipe starts, if you have already visited it in that window.
- **Touchscreen swipes in Files:** swipe one finger in from the left edge of the folder view to go back, or from the right edge to go forward. Touches elsewhere scroll, select and drag files as usual. Needs GNOME 49 or later.
- **Page turns for the buttons in Files:** going back or forward with the back and forward buttons, `Alt+←` and `Alt+→`, or a mouse's side buttons slides the folder the same way.

## Gestures

| Gesture | Action |
|---|---|
| Three fingers, slide | Drag (move windows, select text, drag and drop) |
| Four fingers, swipe left/right | Switch workspace |
| Four fingers, swipe up | Open the overview |
| Two fingers, swipe right in Files | Go back to the previous folder |
| Two fingers, swipe left in Files | Go forward to the next folder |
| One finger on a touchscreen, swipe in from the left/right edge of the folder view in Files | Go back/forward |

In Files, the page follows your fingers. Lift past about 40% of the window, or flick, to turn the page. Lift earlier and it slides back. If there is no folder to go back or forward to (for example in a window you just opened), nothing happens: the page does not move, and the swipe scrolls Files as usual.

## Settings

Open the extension's preferences (Extension Manager or the Extensions app):

| Setting | Range | Default | Description |
|---|---|---|---|
| Three-Finger Drag | on/off | on | Drag with three fingers (when off, GNOME gets three-finger swipes) |
| Drag Speed | 0.25 – 4.0 | 1.0 | Pointer speed multiplier while dragging |
| Drop Delay (ms) | 0 – 10000 | 5000 | How long to keep holding after fingers lift (0 drops at once) |
| Swipe Back and Forward in Files | on/off | on | Two-finger back and forward swipes in Nautilus |
| Touchscreen Swipe in Files | on/off | on | One-finger touchscreen back and forward swipes in Nautilus (GNOME 49+) |
| Animate Back and Forward in Files | on/off | on | Slide the folder when going back or forward with the buttons, the keyboard or a mouse's side buttons |

## Requirements

- GNOME Shell 46, 47, 48, 49 or 50, on any Linux distribution (Fedora, Ubuntu, Debian, Arch, openSUSE and others)
- Any CPU architecture (x86_64, ARM64 and others): the extension is plain JavaScript run by GNOME Shell, with nothing to compile
- A touchpad with multi-touch support
- For the swipes in Files: a Wayland session (the default on GNOME; GNOME 49 and later have no X11 session at all). Touchscreen swipes need GNOME 49 or later

## Installation

1. Download `better-gestures@extension.org.shell-extension.zip` from the [latest release](https://github.com/Aras1907/better-gestures/releases/latest).
2. Install it, either by opening the zip in **Extension Manager** or from a terminal:
   ```sh
   gnome-extensions install --force better-gestures@extension.org.shell-extension.zip
   ```
3. Restart GNOME Shell: log out and back in on Wayland, or press `Alt+F2`, type `r` and press Enter on X11.
4. Enable the extension:
   ```sh
   gnome-extensions enable better-gestures@extension.org
   ```

## Building from source

```sh
git clone https://github.com/Aras1907/better-gestures.git
cd better-gestures
./build.sh
```

`build.sh` packs the extension, installs it for the current user and enables it. It only needs `gnome-extensions` and `gsettings`, which every GNOME desktop has.

To install for all users instead (for distribution packages), use Meson:

```sh
meson setup build
sudo meson install -C build
```

## Uninstall

```sh
gnome-extensions uninstall better-gestures@extension.org
```
