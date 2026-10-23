'use strict';

/**
 * Ties the pieces together: backend (attach or start), windows, tray,
 * global shortcut, settings. One instance per shell process (main.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, globalShortcut, shell } = require('electron');

const autostart = require('./autostart');
const { BackendProcess, choosePlan, waitUntilReady } = require('./backend');
const { registerIpc } = require('./ipc');
const { backendUrl, candidatePorts, findAppRoot } = require('./paths');
const { SettingsStore } = require('./settings');
const { registerShortcut } = require('./shortcut');
const { makeTranslator, pickLanguage } = require('./strings');
const { TrayController } = require('./tray');
const { WindowManager } = require('./windows');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const LOG_LINES = 40;

class DesktopController {
    constructor({ startHidden }) {
        this.startHidden = startHidden;
        this.locale = app.getLocale();
        this.t = makeTranslator(this.locale);
        this.env = { ...process.env };
        this.appRoot = findAppRoot(
            [this.env.SD_IMAGE_SORTER_APP_ROOT, path.dirname(process.execPath), app.getAppPath()],
            fs.existsSync,
        );
        const dataDir = this.env.SD_IMAGE_SORTER_DATA_DIR || (this.appRoot ? path.join(this.appRoot, 'data') : app.getPath('userData'));
        this.logDir = path.join(dataDir, 'logs');
        this.settings = new SettingsStore(this.env.SD_IMAGE_SORTER_CONFIG_DIR || path.join(dataDir, 'config'));
        this.port = null;
        this.backend = null;
        this.shortcut = { ok: false, accelerator: null, reason: null };
        this.windows = new WindowManager({
            icon: ICON,
            getPort: () => this.port,
            shouldHideOnClose: () => this.settings.get().closeToTray,
            onHiddenFirstTime: () => this.showCloseNotice(),
        });
    }

    init() {
        this.tray = new TrayController({
            iconPath: ICON,
            t: this.t,
            getPort: () => this.port,
            actions: { open: () => this.open(), quickCollect: () => this.openQuickCollect(), quit: () => this.quit() },
        });
        this.applyShortcut(this.settings.get().shortcut);
        registerIpc({
            getPort: () => this.port,
            dragIcon: ICON,
            describeSettings: () => this.describeSettings(),
            changeSetting: (key, value) => this.changeSetting(key, value),
            openQuickCollect: () => this.openQuickCollect(),
            retryStart: () => this.retryStart(),
            openLogFolder: () => this.openLogFolder(),
        });
        return this.startBackend();
    }

    statusTarget(titleKey, detail, { log = '', actions = false, params = {} } = {}) {
        return {
            show: !this.startHidden,
            query: {
                lang: pickLanguage(this.locale), title: this.t(titleKey, params), detail, log,
                actions: actions ? '1' : '0', retry: this.t('retry'), openLog: this.t('openLog'),
            },
        };
    }

    showError(key, params = {}, log = '') {
        this.windows.load(this.statusTarget(key, '', { log, actions: true, params }));
        if (this.startHidden) this.windows.showMain();
    }

    async startBackend() {
        this.windows.load(this.statusTarget('starting', this.t('startingDetail')));
        const plan = await choosePlan(this.env.SD_IMAGE_SORTER_PORT);
        if (plan.action === 'none') {
            const ports = candidatePorts(this.env.SD_IMAGE_SORTER_PORT);
            this.showError('noPort', { first: ports[0], last: ports[ports.length - 1] });
            return;
        }
        if (plan.action === 'start' && !(await this.launchChild(plan.port))) return;
        this.port = plan.port;
        this.windows.load({ url: `${backendUrl(this.port)}/`, show: !this.startHidden });
        this.tray.refresh();
    }

    async launchChild(port) {
        if (!this.appRoot) {
            this.showError('appRootMissing');
            return false;
        }
        this.backend = new BackendProcess({
            appRoot: this.appRoot, platform: process.platform, baseEnv: this.env, logDir: this.logDir,
            onExit: (info) => this.onBackendExit(info),
        });
        try {
            this.backend.start(port);
            await waitUntilReady(port, () => Boolean(this.backend?.child));
            return true;
        } catch (error) {
            this.reportStartFailure(error);
            return false;
        }
    }

    reportStartFailure(error) {
        const log = this.backend ? this.backend.tailLog(LOG_LINES) : '';
        if (error.message === 'python-missing') this.showError('pythonMissing', { root: this.appRoot });
        else if (error.message === 'backend-timeout') this.showError('backendTimeout', {}, log);
        else this.showError('backendExited', { code: this.backend?.lastExitCode ?? '?' }, log);
    }

    async onBackendExit({ code, restarted, expected }) {
        if (this.backend) this.backend.lastExitCode = code;
        if (expected || this.port === null) return;
        if (restarted) {
            try {
                await waitUntilReady(this.port, () => Boolean(this.backend?.child));
                this.windows.main?.webContents.reload();
            } catch (error) {
                this.reportStartFailure(error);
            }
            return;
        }
        this.port = null;
        this.showError('backendExited', { code }, this.backend.tailLog(LOG_LINES));
    }

    retryStart() {
        if (this.backend?.child) return;
        this.backend = null;
        this.startBackend();
    }

    openLogFolder() {
        fs.mkdirSync(this.logDir, { recursive: true });
        shell.openPath(this.logDir);
    }

    open() {
        return this.windows.showMain();
    }

    openQuickCollect() {
        if (!this.port) {
            this.open();
            return;
        }
        this.windows.openQuickCollect(`${backendUrl(this.port)}/static/quick-collect.html`);
    }

    focusSearch() {
        const win = this.open();
        if (!win) return;
        const send = () => win.webContents.send('sd:focus-search');
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
        else send();
    }

    applyShortcut(text) {
        this.shortcut = registerShortcut(globalShortcut, text, () => this.focusSearch(), this.shortcut.accelerator);
        return this.shortcut;
    }

    showCloseNotice() {
        if (this.settings.get().closeNoticeShown) return;
        this.tray.notify(this.t('closeNoticeTitle'), this.t('closeNotice'));
        this.settings.update({ closeNoticeShown: true });
    }

    describeSettings() {
        const values = this.settings.get();
        return {
            closeToTray: values.closeToTray,
            shortcut: values.shortcut,
            shortcutOk: this.shortcut.ok,
            // 'invalid' | 'refused' | null; the page words it in its own language.
            shortcutReason: this.shortcut.reason,
            startAtLogin: autostart.isEnabled(app),
            ownsServer: Boolean(this.backend),
            port: this.port,
            shellVersion: app.getVersion(),
        };
    }

    changeSetting(key, value) {
        if (key === 'closeToTray') this.settings.update({ closeToTray: Boolean(value) });
        else if (key === 'startAtLogin') autostart.setEnabled(app, Boolean(value));
        else if (key === 'shortcut') {
            this.settings.update({ shortcut: String(value || '') });
            this.applyShortcut(this.settings.get().shortcut);
        }
        return this.describeSettings();
    }

    /** Quit the shell; a backend it started sees it gone and shuts down gracefully. */
    quit() {
        this.windows.closeAll();
        globalShortcut.unregisterAll();
        this.tray.destroy();
        this.backend?.release();
        app.exit(0);
    }
}

module.exports = { DesktopController };
