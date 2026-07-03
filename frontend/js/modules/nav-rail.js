/**
 * Aurora Phase 3 — left navigation rail behavior.
 *
 * The rail itself is pure CSS (ui-refresh.css "Nav Rail" section, >=769px);
 * this module owns the two interactive bits:
 *   1. Collapse toggle (#btn-rail-collapse) — flips html.rail-collapsed and
 *      persists it. The pre-paint inline script in index.html <head> applies
 *      the stored state before first render, so this module only handles
 *      user toggles after load.
 *   2. Brand block (#nav-brand) — click / Enter / Space returns to the
 *      mission entry page via window.EntryPage.show(). Explicit intent, so it
 *      works even when the user enabled "skip entry page" (unlike ESC, which
 *      entry-page.js deliberately disables for skippers).
 */
(function () {
    'use strict';

    const COLLAPSED_KEY = 'sd-sorter:rail-collapsed';

    function isCollapsed() {
        return document.documentElement.classList.contains('rail-collapsed');
    }

    function persist(collapsed) {
        try {
            localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
        } catch (e) { /* storage blocked: state stays session-only */ }
    }

    function setCollapsed(collapsed) {
        document.documentElement.classList.toggle('rail-collapsed', !!collapsed);
        persist(!!collapsed);
        const btn = document.getElementById('btn-rail-collapse');
        if (btn) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    }

    function goToEntry() {
        if (window.EntryPage && typeof window.EntryPage.show === 'function') {
            window.EntryPage.show();
        }
    }

    function boot() {
        const btn = document.getElementById('btn-rail-collapse');
        if (btn) {
            btn.setAttribute('aria-pressed', isCollapsed() ? 'true' : 'false');
            btn.addEventListener('click', () => setCollapsed(!isCollapsed()));
        }

        const brand = document.getElementById('nav-brand');
        if (brand) {
            brand.addEventListener('click', goToEntry);
            brand.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    goToEntry();
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.NavRail = { isCollapsed, setCollapsed };
})();
