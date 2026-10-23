'use strict';

/**
 * IPC handlers behind window.sdDesktop (preload.js). Program features are
 * answered only for the program's own page on its own port; the start-up
 * page (a local file) may only retry or open the log folder.
 */

const path = require('node:path');

const { ipcMain } = require('electron');

const { isBackendUrl, isStatusPageUrl } = require('./paths');
const { startNativeDrag } = require('./drag');

const STATUS_PAGE = path.join(__dirname, 'pages', 'status.html');

function senderUrl(event) {
    return event.senderFrame?.url || event.sender.getURL();
}

function fromBackend(event, getPort) {
    return isBackendUrl(senderUrl(event), getPort());
}

function fromStatusPage(event) {
    return isStatusPageUrl(senderUrl(event), STATUS_PAGE);
}

function refuse() {
    return Promise.reject(new Error('not-allowed'));
}

/**
 * @param {object} deps
 * @param {() => number|null} deps.getPort
 * @param {string} deps.dragIcon
 * @param {() => object} deps.describeSettings
 * @param {(key: string, value: unknown) => object} deps.changeSetting
 * @param {() => void} deps.openQuickCollect
 * @param {() => void} deps.retryStart
 * @param {() => void} deps.openLogFolder
 */
function registerIpc(deps) {
    ipcMain.handle('sd:start-drag', (event, imageIds, libraryId) => {
        if (!fromBackend(event, deps.getPort)) return refuse();
        return startNativeDrag(event.sender, { imageIds, libraryId, port: deps.getPort() }, deps.dragIcon);
    });
    ipcMain.handle('sd:get-settings', (event) => {
        if (!fromBackend(event, deps.getPort)) return refuse();
        return deps.describeSettings();
    });
    ipcMain.handle('sd:set-setting', (event, key, value) => {
        if (!fromBackend(event, deps.getPort)) return refuse();
        return deps.changeSetting(String(key), value);
    });
    ipcMain.handle('sd:open-quick-collect', (event) => {
        if (!fromBackend(event, deps.getPort)) return refuse();
        deps.openQuickCollect();
        return true;
    });
    ipcMain.handle('sd:retry-start', (event) => {
        if (!fromStatusPage(event)) return refuse();
        deps.retryStart();
        return true;
    });
    ipcMain.handle('sd:open-log-folder', (event) => {
        if (!fromStatusPage(event)) return refuse();
        deps.openLogFolder();
        return true;
    });
}

module.exports = { registerIpc };
