/**
 * nav-more-proxies.js - "More" menu entries that press a top-bar button.
 *
 * The pro look folds the top bar's tag tools (tag library, mass tag editor)
 * into the More menu: blind judges found seven unlabelled icons in the bar
 * (2026-11-08). The bar buttons stay in the page (hidden by look-pro.css), so
 * every opener, shortcut and test keeps one source of truth; an entry with
 * data-proxy-click="<button id>" closes the menu and presses that button.
 * Today's look hides these entries (ui-refresh.css) and keeps the bar buttons.
 *
 * Classic script: no globals.
 */
(function () {
    'use strict';

    function onClick(event) {
        const entry = event.target.closest('[data-proxy-click]');
        if (!entry) return;
        const target = document.getElementById(entry.dataset.proxyClick);
        window._closeNavToolsMenu?.();
        target?.click();
    }

    function bind() {
        document.getElementById('nav-tools-menu')?.addEventListener('click', onClick);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }
})();
