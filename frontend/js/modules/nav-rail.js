/**
 * Navigation brand behavior.
 *
 * Historical note: this module shipped with the Aurora Phase 3 left nav rail
 * and owned its collapse toggle. The owner reverted the rail to the classic
 * top bar (2026-07-05), so the collapse state, its localStorage key
 * ('sd-sorter:rail-collapsed') and #btn-rail-collapse are gone. What remains
 * is orientation-independent and still wanted:
 *
 *   Brand block (#nav-brand) — click / Enter / Space returns to the mission
 *   entry page via window.EntryPage.show(). Explicit intent, so it works
 *   even when the user enabled "skip entry page" (unlike ESC, which
 *   entry-page.js deliberately disables for skippers).
 */
(function () {
    'use strict';

    function goToEntry() {
        if (window.EntryPage && typeof window.EntryPage.show === 'function') {
            window.EntryPage.show();
        }
    }

    function boot() {
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
})();
