/**
 * Reload keeps the page the user was on. The current page (or the entry page)
 * is kept for the browser tab; a reload or a Back/Forward return puts the user
 * on it again instead of the Gallery. Opening the program fresh, in a new tab
 * or by typing the address, is not a reload and still follows the entry page's
 * own rule. A link with ?view= is decided by the entry page before this.
 *
 * Public: ViewMemory.savedView() -> a page name or null, ViewMemory.start().
 */
(function () {
    'use strict';

    const KEY = 'sd-image-sorter-current-view';

    function read() {
        try {
            return sessionStorage.getItem(KEY);
        } catch (_error) {
            return null;
        }
    }

    function write(screen) {
        try {
            sessionStorage.setItem(KEY, screen);
        } catch (_error) {
            // Storage blocked: the page is simply not remembered.
        }
    }

    function screenNow() {
        if (document.body.classList.contains('entry-active')) return 'entry';
        return document.querySelector('.nav-bar')?.getAttribute('data-view') || 'gallery';
    }

    function isReload() {
        const entry = performance.getEntriesByType?.('navigation')?.[0];
        return entry?.type === 'reload' || entry?.type === 'back_forward';
    }

    /** The page to return to after a reload; null for the entry page, a fresh open, or an unknown page. */
    function savedView() {
        if (!isReload()) return null;
        const view = read();
        if (!view || view === 'entry') return null;
        return document.getElementById(`view-${view}`) ? view : null;
    }

    function remember() {
        write(screenNow());
    }

    let started = false;

    /** From now on every change of page is kept. Called once the first page is decided. */
    function start() {
        if (started) return;
        started = true;
        remember();
        const onChange = new MutationObserver(remember);
        const navBar = document.querySelector('.nav-bar');
        if (navBar) onChange.observe(navBar, { attributes: true, attributeFilter: ['data-view'] });
        onChange.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    window.ViewMemory = { savedView, start };
})();
