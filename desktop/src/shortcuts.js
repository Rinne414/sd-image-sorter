'use strict';

/**
 * Desktop and Start-menu shortcuts (Windows), made without administrator
 * rights: both folders belong to the current user. The plan is pure so it
 * runs under `node --test`; writing goes through Electron's
 * shell.writeShortcutLink.
 */

const path = require('node:path');

const SHORTCUT_NAME = 'SD Image Sorter.lnk';

/**
 * The two shortcut files and how each is written. Empty when a folder is unknown.
 *
 * They point at the shell itself (desktop\sd-image-sorter-shell.exe), not at
 * the top-level launcher: the shortcut target is then the very program that
 * owns the window, so the taskbar groups the window under the shortcut and a
 * pinned button starts the shell again without a short-lived second process.
 * The working directory is the program folder, as with the launcher.
 */
function shortcutPlan({ exePath, appRoot, desktopDir, startMenuDir, appUserModelId }) {
    const options = {
        target: exePath,
        cwd: appRoot || path.dirname(exePath),
        description: 'SD Image Sorter',
        icon: exePath,
        iconIndex: 0,
        appUserModelId,
    };
    return [desktopDir, startMenuDir]
        .filter(Boolean)
        .map((folder) => ({ file: path.join(folder, SHORTCUT_NAME), options }));
}

/** Write every shortcut; report which ones worked so the caller can say so truthfully. */
function writeShortcuts(shellApi, plan) {
    const created = [];
    const failed = [];
    for (const { file, options } of plan) {
        try {
            if (!shellApi.writeShortcutLink(file, 'create', options)) throw new Error('refused');
            created.push(file);
        } catch (error) {
            failed.push({ file, reason: error.message });
        }
    }
    return { created, failed };
}

module.exports = { SHORTCUT_NAME, shortcutPlan, writeShortcuts };
