import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ThreeFingerDragPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            description: 'Drag with three fingers. Four-finger swipes switch workspaces and open the overview.'
        });
        page.add(group);

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
        group.add(delayRow);

        const extrasGroup = new Adw.PreferencesGroup({
            title: 'Additional Gestures'
        });
        page.add(extrasGroup);

        const swipeBackRow = new Adw.SwitchRow({
            title: 'Swipe Back in Files',
            subtitle: 'Swipe two fingers right or left in Files (Nautilus) to go back or forward, with the folder sliding like a page'
        });
        settings.bind('nautilus-swipe-back', swipeBackRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        extrasGroup.add(swipeBackRow);
    }
}
