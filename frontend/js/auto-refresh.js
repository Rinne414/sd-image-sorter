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
            const api = window.App?.API;
            if (!api?.post) return;
            try {
                const result = await api.post('/api/library/auto-refresh', {});
                if (result && result.status === 'started') {
                    // Quietly surface newly-found folders in the sidebar tree.
                    window.FolderTreeUI?.refresh?.();
                }
            } catch (error) {
                /* background nicety — stay silent on failure */
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
