'use strict';

/**
 * Tray icon: Open, Quick collect, Pause/Resume folder watching, Quit. The
 * watching item reads GET /api/watch/status each time the menu is rebuilt,
 * so it always says what clicking it will do.
 */

const { Menu, Tray, nativeImage } = require('electron');

const { getJson, postJson } = require('./backend');

const LINUX_REFRESH_MS = 30000;

class TrayController {
    constructor({ iconPath, t, getPort, actions }) {
        this.t = t;
        this.getPort = getPort;
        this.actions = actions;
        this.paused = null;
        this.tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
        this.tray.setToolTip(t('tooltip'));
        this.tray.on('click', () => actions.open());
        // Windows: the menu is built fresh on each right-click. Linux tray
        // hosts send no click events, so the menu is attached and refreshed
        // on a timer instead.
        this.attachMenu = process.platform === 'linux';
        if (this.attachMenu) {
            this.timer = setInterval(() => this.refresh(), LINUX_REFRESH_MS);
        } else {
            this.tray.on('right-click', () => this.refresh().then(() => this.tray.popUpContextMenu(this.menu)));
        }
        this.render();
    }

    async refresh() {
        const port = this.getPort();
        if (!port) {
            this.paused = null;
        } else {
            try {
                const status = await getJson(port, '/api/watch/status');
                this.paused = Boolean(status.paused);
            } catch {
                this.paused = null;
            }
        }
        this.render();
    }

    async togglePause() {
        const port = this.getPort();
        if (!port || this.paused === null) return;
        try {
            const status = await postJson(port, '/api/watch/pause', { paused: !this.paused });
            this.paused = Boolean(status.paused);
        } catch {
            this.paused = null;
        }
        this.render();
    }

    watchingItem() {
        if (this.paused === null) return { label: this.t('watchingUnknown'), enabled: false };
        return {
            label: this.paused ? this.t('resumeWatching') : this.t('pauseWatching'),
            click: () => this.togglePause(),
        };
    }

    menuTemplate() {
        return [
            { label: this.t('open'), click: () => this.actions.open() },
            { label: this.t('quickCollect'), click: () => this.actions.quickCollect() },
            { type: 'separator' },
            this.watchingItem(),
            { type: 'separator' },
            { label: this.t('quit'), click: () => this.actions.quit() },
        ];
    }

    render() {
        this.menu = Menu.buildFromTemplate(this.menuTemplate());
        if (this.attachMenu) this.tray.setContextMenu(this.menu);
    }

    notify(title, content) {
        if (process.platform === 'win32') {
            this.tray.displayBalloon({ title, content, iconType: 'info' });
            return true;
        }
        return false;
    }

    destroy() {
        if (this.timer) clearInterval(this.timer);
        this.tray.destroy();
    }
}

module.exports = { TrayController };
