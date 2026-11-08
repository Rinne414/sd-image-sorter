/**
 * pro-view-popover.js - proposal B's one "View" menu in the gallery toolbar.
 *
 * Blind A/B round (2026-11-08): the second toolbar row still carried about 15
 * controls; the judge asked for about six visible. In proposal B (the pro
 * look with data-look-variant="b") the three view modes, Group runs and the
 * details-panel toggle move into one "View" menu; each keeps its own handler
 * and pressed state. Nothing is removed; proposal A and today's look keep
 * them in the toolbar.
 *
 * Classic script, no globals.
 */
(function () {
    'use strict';

    const moved = [];
    const el = (id) => document.getElementById(id);

    function active() {
        const root = document.documentElement;
        return root.dataset.look === 'pro' && root.dataset.lookVariant === 'b';
    }

    function viewNodes() {
        return [
            ...document.querySelectorAll('#view-gallery .view-btn[data-size]'),
            el('btn-group-runs'),
            el('btn-pro-inspector'),
        ].filter(Boolean);
    }

    function isOpen() {
        return el('pro-view-popover')?.hidden === false;
    }

    function close() {
        const pop = el('pro-view-popover');
        if (!pop || pop.hidden) return;
        pop.hidden = true;
        el('btn-pro-view')?.setAttribute('aria-expanded', 'false');
    }

    function open() {
        const pop = el('pro-view-popover');
        const button = el('btn-pro-view');
        if (!pop || !button) return;
        pop.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        window.PopupPosition?.place(pop, { anchor: button, placement: 'bottom-end', gap: 6 });
        pop.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
    }

    function fold() {
        const host = el('pro-view-popover-body');
        if (!host || moved.length) return;
        viewNodes().forEach((node) => {
            moved.push({ node, parent: node.parentNode, next: node.nextSibling });
            host.appendChild(node);
        });
    }

    function unfold() {
        close();
        while (moved.length) {
            const { node, parent, next } = moved.pop();
            parent.insertBefore(node, next && next.parentNode === parent ? next : null);
        }
    }

    function sync() {
        if (active()) fold();
        else unfold();
    }

    // Esc closes this menu first; registered from <head>, before body scripts.
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isOpen()) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        close();
        el('btn-pro-view')?.focus({ preventScroll: true });
    }, true);

    function start() {
        const button = el('btn-pro-view');
        const pop = el('pro-view-popover');
        if (!button || !pop) return;
        document.body.appendChild(pop);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (isOpen()) close();
            else open();
        });
        document.addEventListener('mousedown', (event) => {
            if (!isOpen()) return;
            if (pop.contains(event.target) || button.contains(event.target)) return;
            close();
        });
        window.addEventListener('resize', close);
        new MutationObserver(sync).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-look', 'data-look-variant'],
        });
        sync();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
