/**
 * SD Image Sorter - Idle library auto-refresh (v3.3.2 Library Navigation, Phase C)
 *
 * When enabled (opt-in, default OFF — honoring the owner's "background scanning
 * is opt-in" stance), this quietly asks the backend to quick-import the stalest
 * library root while the user is idle, so newly dropped images appear without a
 * manual scan. It NEVER tags (the backend uses quick_import only — GPU safety)
 * and the backend no-ops while any scan is running, so this is always safe.
 *
 * Gating is conservative: only fires after IDLE_MS of no input, only every
 * POLL_MS, and never while the tab is hidden. The enable flag lives in
 * localStorage and is toggled from the Library Folders modal (library-roots-ui).
 */
(function () {
    'use strict';

    const AUTO_REFRESH_KEY = 'library_auto_refresh_enabled';
    const IDLE_MS = 60 * 1000;        // require 60s of no interaction
    const POLL_MS = 5 * 60 * 1000;    // attempt at most once every 5 minutes

    const AutoRefresh = {
        _lastActivity: 0,
        _enabled: false,
        _timer: null,
        _started: false,

        isEnabled() {
            try {
                return localStorage.getItem(AUTO_REFRESH_KEY) === '1';
            } catch (error) {
                return false;
            }
        },

        start() {
            if (this._started) return;
            this._started = true;
            const mark = () => { this._lastActivity = Date.now(); };
            ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((evt) => {
                window.addEventListener(evt, mark, { passive: true });
            });
            mark();
            this.setEnabled(this.isEnabled());
        },

        setEnabled(on) {
            this._enabled = Boolean(on);
            if (this._enabled) {
                if (!this._timer) this._timer = setInterval(() => this._tick(), POLL_MS);
            } else if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
        },

        async _tick() {
            if (!this._enabled) return;
            if (document.hidden) return;
            if (Date.now() - this._lastActivity < IDLE_MS) return; // user is active
            const app = window.App;
            const api = app?.API;
            if (!api?.post) {
                const message = appT(
                    'libraryRoots.autoRefreshUnavailable',
                    'Idle library refresh is unavailable. Restart the app and try again.'
                );
                window.Logger?.error?.('Idle auto-refresh API is unavailable', { appAvailable: Boolean(app) });
                app?.showToast?.(message, 'error');
                return;
            }
            try {
                const result = await api.post('/api/library/auto-refresh', {});
                const status = typeof result?.status === 'string' ? result.status : '';
                const reason = typeof result?.reason === 'string' ? result.reason : '';
                if (status === 'started') {
                    if (typeof app.beginAutoRefreshScanProgress !== 'function') {
                        throw new TypeError('The idle auto-refresh progress handler is unavailable');
                    }
                    app.beginAutoRefreshScanProgress(result.scan);
                    window.FolderTreeUI?.refresh?.();
                    return;
                }
                if (
                    (status === 'skipped' && reason === 'scan_in_progress')
                    || (status === 'skipped' && reason === 'manual_completion_pending')
                    || (status === 'idle' && reason === 'no_enabled_roots')
                ) return;

                const statusLabel = status || '<missing>';
                const reasonLabel = reason || '<missing>';
                const detailLabel = typeof result?.detail === 'string' && result.detail.trim()
                    ? result.detail.trim()
                    : '<missing>';
                window.Logger?.error?.('Idle auto-refresh start returned an unexpected result', {
                    detail: detailLabel,
                    reason: reasonLabel,
                    status: statusLabel,
                });
                app.showToast(
                    appT(
                        'libraryRoots.autoRefreshUnexpectedStart',
                        'Idle library refresh did not start (status: {status}, reason: {reason}, detail: {detail}). Open Library Folders and run Rescan.'
                    )
                        .replace('{status}', statusLabel)
                        .replace('{reason}', reasonLabel)
                        .replace('{detail}', detailLabel),
                    'error'
                );
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                window.Logger?.error?.('Idle auto-refresh start failed', { error });
                app.showToast(
                    appT(
                        'libraryRoots.autoRefreshStartFailed',
                        'Could not start idle library refresh: {detail}. Open Library Folders and run Rescan.'
                    ).replace('{detail}', detail),
                    'error'
                );
            }
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => AutoRefresh.start());
    } else {
        AutoRefresh.start();
    }

    window.AutoRefresh = AutoRefresh;
})();
