/**
 * Shared control-identity helpers, injected as a context init script.
 *
 * window.__controlKey(el)     -> stable string key for an interactive control
 * window.__controlContext()   -> where the control lives (view / modal / entry)
 *
 * The SAME functions produce keys for both the click ledger (what tests
 * actually clicked) and the control inventory (what exists), so the
 * untested-control diff in scripts/coverage_gate.py is exact.
 */
(() => {
    'use strict';
    if (window.__controlKey) return;

    const INTERACTIVE_SELECTOR = 'button, [role="button"], input, select, textarea, a[href], summary, label';
    // data-* attributes that identify a control better than its text.
    const DATA_KEYS = [
        'view', 'mirrorView', 'action', 'tab', 'gen', 'sortMode', 'target',
        'collapseKey', 'histogramMode', 'modalHandoff', 'modalAnalysis',
        'sidebarSection', 'preset', 'mode',
    ];

    window.__controlKey = (el) => {
        if (!el || el.nodeType !== 1) return null;
        const node = el.closest(INTERACTIVE_SELECTOR) || el;
        const tag = node.tagName.toLowerCase();
        if (node.id) return `${tag}#${node.id}`;

        let key = tag;
        const ds = node.dataset || {};
        for (const k of DATA_KEYS) {
            if (ds[k] != null && ds[k] !== '') {
                const attr = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
                key += `[data-${attr}=${ds[k]}]`;
                break;
            }
        }
        if (key === tag) {
            const aria = node.getAttribute('aria-label');
            const name = node.getAttribute('name');
            const text = String(node.textContent || node.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            if (aria) key += `@${aria.slice(0, 40)}`;
            else if (name) key += `[name=${name}]`;
            else if (node.type && (tag === 'input')) key += `[type=${node.type}]`;
            if (key === tag && text) key += `:${text}`;
        }

        // Scope non-id keys to their nearest identified container so "button:OK"
        // in two different modals stays two different controls.
        const scope = node.closest('.modal[id], section.view[id], #entry-page, .filter-sidebar, nav, header');
        if (scope) {
            const scopeId = scope.id ? `#${scope.id}` : `.${String(scope.className).split(' ')[0]}`;
            return `${scopeId} ${key}`;
        }
        return key;
    };

    window.__controlContext = () => {
        const modal = [...document.querySelectorAll('.modal')].find((m) => {
            if (!m.id) return false;
            const style = getComputedStyle(m);
            return (m.classList.contains('visible') || style.display !== 'none') && style.visibility !== 'hidden';
        });
        if (modal) return `modal:${modal.id}`;
        const entry = document.getElementById('entry-page');
        if (entry && !entry.hidden) return 'entry';
        const view = document.querySelector('section.view.active, .view.active');
        return view && view.id ? `view:${view.id.replace(/^view-/, '')}` : 'unknown';
    };
})();
