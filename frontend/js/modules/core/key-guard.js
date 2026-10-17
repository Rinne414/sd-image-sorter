/**
 * Keys that belong to the browser. A single-letter shortcut must not fire while
 * Ctrl, Alt or Meta is held (Ctrl+Shift+R was taking "R, show a random picture"
 * and the hard reload never happened), and the page never takes a reload,
 * address-bar, tab or dev-tools combo.
 *
 * Two parts:
 *  - KeyGuard.hasModifier(event): handlers that answer plain keys return early
 *    on it, so Ctrl+G stays "find next" instead of "grid view".
 *  - A window capture listener that stops browser combos before any page
 *    handler sees them, so a handler written later cannot take them either.
 *    It never calls preventDefault: the browser still acts on the key.
 */
(function () {
    'use strict';

    const RELOAD_AND_DEVTOOLS_KEYS = new Set(['F5', 'F11', 'F12']);
    // With Ctrl/Meta held: reload, address bar, tabs, windows, dev tools, history.
    const CTRL_LETTERS = new Set(['r', 'l', 'w', 't', 'n']);
    const CTRL_SHIFT_LETTERS = new Set(['r', 'n', 't', 'w', 'i', 'j', 'c', 'delete']);

    function hasModifier(event) {
        return Boolean(event.ctrlKey || event.metaKey || event.altKey);
    }

    function isBrowserCombo(event) {
        const key = String(event.key || '').toLowerCase();
        if (RELOAD_AND_DEVTOOLS_KEYS.has(event.key)) return true;
        // Alt+Left / Alt+Right are Back / Forward.
        if (event.altKey && !event.ctrlKey && !event.metaKey
            && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            return true;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
        // Ctrl+1..9 pick a tab; Ctrl+Tab / PageUp / PageDown walk them.
        if (/^[1-9]$/.test(event.key)) return true;
        if (event.key === 'Tab' || event.key === 'PageUp' || event.key === 'PageDown') return true;
        return event.shiftKey ? CTRL_SHIFT_LETTERS.has(key) : CTRL_LETTERS.has(key);
    }

    window.addEventListener('keydown', (event) => {
        if (isBrowserCombo(event)) event.stopImmediatePropagation();
    }, true);

    window.KeyGuard = { hasModifier, isBrowserCombo };
})();
