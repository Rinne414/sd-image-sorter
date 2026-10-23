'use strict';

/**
 * Shell settings, kept next to the program's own settings
 * (data/config/desktop-shell.json) so a portable folder stays portable.
 * Start at login is not stored here: the operating system holds it.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SHORTCUT = 'Control+Alt+Space';
const DEFAULTS = Object.freeze({
    closeToTray: true,
    closeNoticeShown: false,
    shortcutsOffered: false,
    shortcut: DEFAULT_SHORTCUT,
});

/** Keep only known keys with the right types; anything else falls back to the default. */
function sanitize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        closeToTray: typeof source.closeToTray === 'boolean' ? source.closeToTray : DEFAULTS.closeToTray,
        closeNoticeShown: typeof source.closeNoticeShown === 'boolean' ? source.closeNoticeShown : DEFAULTS.closeNoticeShown,
        shortcutsOffered: typeof source.shortcutsOffered === 'boolean' ? source.shortcutsOffered : DEFAULTS.shortcutsOffered,
        shortcut: typeof source.shortcut === 'string' ? source.shortcut.trim().slice(0, 100) : DEFAULTS.shortcut,
    };
}

class SettingsStore {
    constructor(configDir) {
        this.file = path.join(configDir, 'desktop-shell.json');
        this.values = sanitize(this.read());
    }

    read() {
        try {
            return JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
            return {};
        }
    }

    get() {
        return { ...this.values };
    }

    update(changes) {
        this.values = sanitize({ ...this.values, ...changes });
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.values, null, 2), 'utf8');
        fs.renameSync(temp, this.file);
        return this.get();
    }
}

module.exports = { DEFAULT_SHORTCUT, SettingsStore, sanitize };
