import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as GestureHandlerModule from './lib/gestureHandler.js';
import * as DragManagerModule from './lib/dragManager.js';
import * as ConfigManagerModule from './lib/configManager.js';
import * as SwipeBackModule from './lib/swipeBack.js';

let _gestureHandler = null;
let _dragManager = null;
let _configManager = null;
let _swipeBack = null;

export default class BetterGesturesExtension extends Extension {
    enable() {
        const settings = this.getSettings();
        _configManager = new ConfigManagerModule.ConfigManager(settings);
        _dragManager = new DragManagerModule.DragManager(_configManager);
        _gestureHandler = new GestureHandlerModule.GestureHandler(_dragManager, _configManager);
        _swipeBack = new SwipeBackModule.SwipeBack(_configManager);
        console.log('Better Gestures extension enabled');
    }

    disable() {
        if (_swipeBack) {
            _swipeBack.destroy();
            _swipeBack = null;
        }
        if (_gestureHandler) {
            _gestureHandler.destroy();
            _gestureHandler = null;
        }
        if (_dragManager) {
            _dragManager.destroy();
            _dragManager = null;
        }
        if (_configManager) {
            _configManager.destroy();
            _configManager = null;
        }
        console.log('Better Gestures extension disabled');
    }
}
