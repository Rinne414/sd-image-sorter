'use strict';

/**
 * The main window (the program's own web UI) and the small always-on-top
 * Quick collect window. Closing the main window hides it to the tray; after
 * HIDDEN_RELEASE_MS hidden, the page is released to give its memory back
 * and is loaded again on the next open.
 */

const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

const { isBackendUrl, isStatusPageUrl } = require('./paths');

const HIDDEN_RELEASE_MS = 10 * 60 * 1000;
const BACKGROUND = '#0E0E0F';
const PRELOAD = path.join(__dirname, 'preload.js');
const STATUS_PAGE = path.join(__dirname, 'pages', 'status.html');

function webPreferences() {
    return { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false };
}

/** Links that leave the program open in the user's browser, never inside the shell. */
function guardNavigation(win, getPort) {
    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
        if (isBackendUrl(url, getPort())) return { action: 'allow' };
        if (/^https?:\/\//iu.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    // A picture dropped on the window outside a drop zone would navigate to its
    // file: URL; only the bundled start-up page may be a file: page here.
    contents.on('will-navigate', (event, url) => {
        if (isStatusPageUrl(url, STATUS_PAGE) || isBackendUrl(url, getPort())) return;
        event.preventDefault();
        if (/^https?:\/\//iu.test(url)) shell.openExternal(url);
    });
}

class WindowManager {
    constructor({ icon, getPort, shouldHideOnClose, onHiddenFirstTime }) {
        this.icon = icon;
        this.getPort = getPort;
        this.shouldHideOnClose = shouldHideOnClose;
        this.onHiddenFirstTime = onHiddenFirstTime;
        this.main = null;
        this.quick = null;
        this.quitting = false;
        this.releaseTimer = null;
        this.lastLoad = null;
    }

    createMain(show) {
        const win = new BrowserWindow({
            width: 1440, height: 900, minWidth: 1100, minHeight: 640,
            show: false, backgroundColor: BACKGROUND, icon: this.icon,
            title: 'SD Image Sorter', webPreferences: webPreferences(),
        });
        win.removeMenu();
        guardNavigation(win, this.getPort);
        win.once('ready-to-show', () => { if (show) win.show(); });
        win.on('close', (event) => this.handleClose(event, win));
        win.on('show', () => this.cancelRelease());
        win.on('closed', () => { if (this.main === win) this.main = null; });
        this.main = win;
        return win;
    }

    handleClose(event, win) {
        if (this.quitting || !this.shouldHideOnClose()) return;
        event.preventDefault();
        win.hide();
        this.onHiddenFirstTime();
        this.cancelRelease();
        this.releaseTimer = setTimeout(() => {
            if (this.main === win && !win.isVisible()) win.destroy();
        }, HIDDEN_RELEASE_MS);
    }

    cancelRelease() {
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
    }

    /** Load the program's page, or the start-up/status page, into the main window. */
    load(target) {
        this.lastLoad = target;
        const win = this.main || this.createMain(target.show !== false);
        if (target.url) return win.loadURL(target.url);
        return win.loadFile(STATUS_PAGE, { query: target.query || {} });
    }

    /** Bring the window up, re-creating it when it was released while hidden. */
    showMain() {
        if (!this.main && this.lastLoad) this.load({ ...this.lastLoad, show: true });
        const win = this.main;
        if (!win) return null;
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
        return win;
    }

    openQuickCollect(url) {
        if (this.quick && !this.quick.isDestroyed()) {
            this.quick.show();
            this.quick.focus();
            return this.quick;
        }
        const win = new BrowserWindow({
            width: 380, height: 480, minWidth: 300, minHeight: 360,
            alwaysOnTop: true, minimizable: false, maximizable: false, fullscreenable: false,
            backgroundColor: BACKGROUND, icon: this.icon, title: 'Quick collect', webPreferences: webPreferences(),
        });
        win.removeMenu();
        guardNavigation(win, this.getPort);
        win.on('closed', () => { this.quick = null; });
        win.loadURL(url);
        this.quick = win;
        return win;
    }

    closeAll() {
        this.quitting = true;
        this.cancelRelease();
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
    }
}

module.exports = { WindowManager };
