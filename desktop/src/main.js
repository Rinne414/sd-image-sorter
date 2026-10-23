'use strict';

/**
 * SD Image Sorter desktop shell (optional; the browser launchers stay).
 * Keeps the program resident in the tray, adds a global shortcut, native
 * drag-out of picture files and a Quick collect window. No telemetry: the
 * crash reporter is never started and nothing is sent anywhere.
 */

const { app } = require('electron');

const { HIDDEN_ARG } = require('./autostart');
const { DesktopController } = require('./controller');

const APP_USER_MODEL_ID = 'io.github.rinne414.sd-image-sorter';

app.setAppUserModelId(APP_USER_MODEL_ID);
if (process.platform === 'linux') {
    // Global shortcuts on Wayland go through the desktop portal.
    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let controller = null;
    app.on('second-instance', () => controller?.open());
    // Closing the last window keeps the program in the tray; Quit ends it.
    app.on('window-all-closed', () => {});
    app.whenReady().then(() => {
        controller = new DesktopController({ startHidden: process.argv.includes(HIDDEN_ARG) });
        // Main-process handle for diagnostics and the shell's end-to-end check
        // (scripts driving Electron); pages cannot reach it (contextIsolation).
        globalThis.sdDesktopController = controller;
        return controller.init();
    });
}
