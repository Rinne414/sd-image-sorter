/**
 * After an update, say once what changed: the running version's summary from
 * its release notes (GET /api/updates/whats-new), in the UI language, with a
 * link to the full notes. A fresh install says nothing. Each window remembers
 * the version it has shown, so a reload does not show it again.
 */
(function () {
    'use strict';

    const SEEN_KEY = 'sd-whats-new-seen-version';
    // Automated browsers (browser tests) never get the notice unless a test asks
    // for it: every test starts with empty storage and a persistent toast would
    // sit over the controls the test drives.
    const AUTOMATION_OPT_IN_KEY = 'sd-whats-new-in-automation';
    const DELAY_MS = 2500;
    const SHOW_MS = 15000;

    function t(key, fallback, params) {
        const value = window.I18n?.t?.(key, params);
        if (value && value !== key) return value;
        return typeof window.I18n?.format === 'function' ? window.I18n.format(fallback, params) : fallback;
    }

    function readSeen() {
        try {
            return localStorage.getItem(SEEN_KEY);
        } catch (_error) {
            return null;
        }
    }

    function writeSeen(version) {
        try {
            localStorage.setItem(SEEN_KEY, version);
        } catch (_error) {
            // Private window or blocked storage: the notice may show again, nothing breaks.
        }
    }

    function automatedWithoutOptIn() {
        if (!navigator.webdriver) return false;
        try {
            return localStorage.getItem(AUTOMATION_OPT_IN_KEY) !== '1';
        } catch (_error) {
            return true;
        }
    }

    async function check() {
        if (automatedWithoutOptIn()) return;
        let state = null;
        try {
            const response = await fetch('/api/updates/whats-new', { headers: { Accept: 'application/json' } });
            state = response.ok ? await response.json() : null;
        } catch (_error) {
            state = null;
        }
        if (!state?.version) return;
        const seen = readSeen();
        writeSeen(state.version);
        if (seen === state.version || !state.available) return;
        // A version this window saw before, or the backend saw an older run.
        if (!seen && !state.updated) return;
        const chinese = String(window.I18n?.currentLang || '').startsWith('zh');
        const summary = chinese
            ? (state.summary_zh || state.summary_en)
            : (state.summary_en || state.summary_zh);
        if (!summary || typeof window.showToast !== 'function') return;
        window.showToast(
            t('whatsNew.toast', 'Updated to {version}. {summary}', { version: state.version, summary }),
            'info',
            {
                // Long enough to read, then out of the way: it sits over the
                // top-right of banners, so it must not stay there.
                duration: SHOW_MS,
                actionLabel: t('whatsNew.fullNotes', 'Full notes'),
                onAction: () => window.open(state.notes_url, '_blank', 'noopener'),
            },
        );
    }

    function start() {
        setTimeout(check, DELAY_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
