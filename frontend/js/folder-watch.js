/**
 * SD Image Sorter - Folder watching client.
 *
 * The backend watches library folders whose "Watch for new pictures" box is on
 * and indexes new pictures within seconds (services/folder_watch.py). This
 * module polls GET /api/watch/status while the page is visible, refreshes the
 * gallery quietly when its `generation` grows (new pictures arrived), and
 * publishes the status as a `folder-watch-status` window event so the Library
 * Folders list can show each folder's live state.
 *
 * Polling is fast only while something is watched; otherwise it checks rarely,
 * so turning watching on from another tab is still noticed.
 */
(function () {
    'use strict';

    const ACTIVE_POLL_MS = 4000;
    const IDLE_POLL_MS = 30000;

    function normalizePath(value) {
        return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    /**
     * The library root for an imported folder: the root with that exact path,
     * else the deepest root that contains it (importing a subfolder of a
     * registered root keeps that root). Case-insensitive, either slash.
     */
    function rootForPath(roots, folderPath) {
        const wanted = normalizePath(folderPath);
        if (!wanted) return null;
        let best = null;
        roots.forEach((root) => {
            const path = normalizePath(root.path);
            if (!path || (wanted !== path && !wanted.startsWith(`${path}/`))) return;
            if (!best || path.length > normalizePath(best.path).length) best = root;
        });
        return best;
    }

    const FolderWatch = {
        _timer: null,
        _generation: null,
        _status: null,
        _started: false,

        start() {
            if (this._started) return;
            this._started = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) this.poke();
            });
            this.poke();
        },

        status() {
            return this._status;
        },

        /** Check now (after a switch was flipped) and reschedule. */
        poke() {
            if (this._timer) clearTimeout(this._timer);
            this._timer = null;
            this._poll();
        },

        _schedule() {
            if (this._timer) clearTimeout(this._timer);
            const watching = Boolean(this._status?.roots?.length);
            this._timer = setTimeout(() => this._poll(), watching ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        },

        async _poll() {
            if (document.hidden) {
                this._schedule();
                return;
            }
            const api = window.App?.API;
            if (!api?.get) {
                this._schedule();
                return;
            }
            try {
                const status = await api.get('/api/watch/status');
                this._apply(status);
            } catch (error) {
                window.Logger?.warn?.('Folder watch status could not be read', { error });
            }
            this._schedule();
        },

        _apply(status) {
            if (!status || typeof status !== 'object') return;
            const generation = Number(status.generation || 0);
            // "Changed", not "grew": the counter starts again at 0 when the
            // program restarts while this page stays open.
            const arrived = this._generation !== null && generation !== this._generation;
            this._generation = generation;
            this._status = status;
            window.dispatchEvent(new CustomEvent('folder-watch-status', { detail: status }));
            if (arrived) this._refreshViews();
        },

        /**
         * Turn watching on for the library folder that holds `folderPath`
         * (offered after a folder import) and say what happened.
         */
        async watchFolder(folderPath) {
            const app = window.App || {};
            const folder = String(folderPath || '').split(/[\\/]/).filter(Boolean).pop() || folderPath;
            const say = (key, fallback, type) => app.showToast?.(appT(key, fallback, { folder }), type);
            let root;
            try {
                const data = await app.API.get('/api/library-roots');
                root = rootForPath(Array.isArray(data?.roots) ? data.roots : [], folderPath);
            } catch (error) {
                say('libraryRoots.watchFailed', 'Could not change watching for this folder', 'error');
                return false;
            }
            if (!root) {
                say('flow.watchFolderNotFound', 'This folder is not in Library Folders, so it cannot be watched. Add it there first.', 'warning');
                return false;
            }
            if (Number(root.watch) === 1) {
                say('flow.watchFolderAlready', 'Already watching {folder}: new pictures join the gallery by themselves.', 'info');
                return true;
            }
            try {
                await app.API.patch(`/api/library-roots/${Number(root.id)}/watch`, { watch: true });
            } catch (error) {
                say('libraryRoots.watchFailed', 'Could not change watching for this folder', 'error');
                return false;
            }
            say('flow.watchFolderOn', 'Watching {folder}: new pictures join the gallery by themselves. Turn it off in Library Folders.', 'success');
            this.poke();
            return true;
        },

        _refreshViews() {
            // Forced: polls are 4 s apart, and a throttled call here would
            // drop this arrival for good (the next poll sees no change).
            if (typeof _refreshScanDrivenViews === 'function') {
                _refreshScanDrivenViews(true, { refreshGallery: true });
            }
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => FolderWatch.start());
    } else {
        FolderWatch.start();
    }

    FolderWatch.rootForPath = rootForPath;
    window.FolderWatch = FolderWatch;
})();
