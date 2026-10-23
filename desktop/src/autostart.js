'use strict';

/**
 * Start at login. Windows and macOS: Electron's login items. Linux: an XDG
 * autostart entry in ~/.config/autostart. Either way the shell starts with
 * --hidden, so it sits in the tray instead of opening a window.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HIDDEN_ARG = '--hidden';
const LINUX_ENTRY = 'sd-image-sorter.desktop';

/** Command line that starts this shell again: the packaged exe, or electron + app folder in a checkout. */
function launchCommand(app) {
    const args = app.isPackaged ? [HIDDEN_ARG] : [app.getAppPath(), HIDDEN_ARG];
    return { path: process.execPath, args };
}

function quoteExec(part) {
    return /[\s"]/u.test(part) ? `"${part.replace(/(["\\$`])/gu, '\\$1')}"` : part;
}

function linuxEntryText(command) {
    const exec = [command.path, ...command.args].map(quoteExec).join(' ');
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=SD Image Sorter',
        `Exec=${exec}`,
        'X-GNOME-Autostart-enabled=true',
        '',
    ].join('\n');
}

function linuxEntryPath() {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'autostart', LINUX_ENTRY);
}

function isEnabled(app) {
    if (process.platform === 'linux') return fs.existsSync(linuxEntryPath());
    const command = launchCommand(app);
    return app.getLoginItemSettings({ path: command.path, args: command.args }).openAtLogin;
}

function setEnabled(app, enabled) {
    const command = launchCommand(app);
    if (process.platform === 'linux') {
        const file = linuxEntryPath();
        if (enabled) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, linuxEntryText(command), 'utf8');
        } else if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
        return isEnabled(app);
    }
    app.setLoginItemSettings({ openAtLogin: enabled, path: command.path, args: command.args });
    return isEnabled(app);
}

module.exports = { HIDDEN_ARG, isEnabled, launchCommand, linuxEntryText, setEnabled };
