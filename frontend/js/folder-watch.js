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

    window.FolderWatch = FolderWatch;
})();
