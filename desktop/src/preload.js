'use strict';

/**
 * The only bridge between the web UI and the shell (contextIsolation on,
 * sandboxed). The web UI checks `window.sdDesktop` and behaves exactly as in
 * a browser when it is missing. The main process accepts these calls only
 * from the program's own page (desktop/src/ipc.js).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sdDesktop', {
    shell: 'electron',
    /**
     * Start an OS drag of these pictures (image ids of the library the page shows).
     * The shell looks the files up itself; the page never names a path.
     * Resolves when the drop finished (Windows).
     */
    startDrag: (imageIds, libraryId) => ipcRenderer.invoke('sd:start-drag', imageIds, libraryId),
    getSettings: () => ipcRenderer.invoke('sd:get-settings'),
    setSetting: (key, value) => ipcRenderer.invoke('sd:set-setting', key, value),
    openQuickCollect: () => ipcRenderer.invoke('sd:open-quick-collect'),
    retryStart: () => ipcRenderer.invoke('sd:retry-start'),
    openLogFolder: () => ipcRenderer.invoke('sd:open-log-folder'),
    onFocusSearch: (callback) => {
        ipcRenderer.on('sd:focus-search', () => callback());
    },
});
