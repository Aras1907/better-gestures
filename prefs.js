import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class BetterGesturesPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            description: 'Drag with three fingers. Four-finger swipes switch workspaces and open the overview.'
        });
        page.add(group);

        const dragRow = new Adw.SwitchRow({
            title: 'Three-Finger Drag',
            subtitle: 'When off, three-finger swipes are left to GNOME'
        });
        settings.bind('three-finger-drag', dragRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(dragRow);

        const speedRow = new Adw.SpinRow({
            title: 'Drag Speed',
            subtitle: '1.0 matches normal pointer speed',
            adjustment: new Gtk.Adjustment({
                lower: 0.25,
                upper: 4.0,
                step_increment: 0.05
            }),
            digits: 2
        });
        settings.bind('drag-speed', speedRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('three-finger-drag', speedRow, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(speedRow);

        const delayRow = new Adw.SpinRow({
            title: 'Drop Delay (ms)',
            subtitle: 'How long to keep holding after your fingers lift, so three fingers can continue the drag. Any other input (one-finger movement, scrolling, clicks, other gestures, key presses) drops right away. 0 drops the moment your fingers lift',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10000,
                step_increment: 50
            })
        });
        settings.bind('drop-delay', delayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('three-finger-drag', delayRow, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(delayRow);

        const extrasGroup = new Adw.PreferencesGroup({
            title: 'Additional Gestures'
        });
        page.add(extrasGroup);

        const swipeBackRow = new Adw.SwitchRow({
            title: 'Swipe Back and Forward in Files',
            subtitle: 'Swipe two fingers right or left in Files (Nautilus) to go back or forward, with the folder sliding like a page'
        });
        settings.bind('nautilus-swipe-back', swipeBackRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        extrasGroup.add(swipeBackRow);

        const touchSwipeRow = new Adw.SwitchRow({
            title: 'Touchscreen Swipe in Files',
            subtitle: 'On a touchscreen in Files, swipe one finger in from the left edge of the folder view to go back, or from the right edge to go forward. Needs GNOME 49 or later'
        });
        settings.bind('nautilus-touch-swipe', touchSwipeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        extrasGroup.add(touchSwipeRow);

        const animationRow = new Adw.SwitchRow({
            title: 'Animate Back and Forward in Files',
            subtitle: 'Slide the folder like a page when going back or forward with the buttons in Files, Alt+← and Alt+→, or the side buttons of a mouse'
        });
        settings.bind('nautilus-navigation-animation', animationRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        extrasGroup.add(animationRow);
    }
}
