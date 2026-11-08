/**
 * pro-fold-menu.js - proposal B folds a few toolbar buttons into one labelled
 * menu (the View menu, the More menu beside the picture count).
 *
 * Blind A/B rounds (2026-11-08): the gallery toolbar carried about fifteen
 * controls and several bare icons nobody could name; the judges asked for
 * about six visible. In proposal B (the pro look with data-look-variant="b")
 * the folded buttons move into their menu, where each shows its own name;
 * each keeps its handler and pressed state. Nothing is removed: proposal A
 * and today's look keep the buttons in the toolbar.
 *
 * create(...) runs from <head>, so each menu's Esc listener comes before the
 * body scripts' own Esc handlers.
 *
 * Classic script, no globals.
 */
(function () {
    'use strict';

    const el = (id) => document.getElementById(id);

    function active() {
        const root = document.documentElement;
        return root.dataset.look === 'pro' && root.dataset.lookVariant === 'b';
    }

    /**
     * @param {{button: string, popover: string, body: string, nodes: () => Element[], placement?: string}} spec
     *   element ids of the menu button, its popover and the popover's body;
     *   nodes() lists the buttons to fold.
     */
    function create(spec) {
        const moved = [];
        const placement = spec.placement || 'bottom-end';

        const isOpen = () => el(spec.popover)?.hidden === false;

        function close() {
            const pop = el(spec.popover);
            if (!pop || pop.hidden) return;
            pop.hidden = true;
            el(spec.button)?.setAttribute('aria-expanded', 'false');
        }

        function open() {
            const pop = el(spec.popover);
            const button = el(spec.button);
            if (!pop || !button) return;
            pop.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            window.PopupPosition?.place(pop, { anchor: button, placement, gap: 6 });
            pop.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
        }

        function fold() {
            const host = el(spec.body);
            if (!host || moved.length) return;
            spec.nodes().filter(Boolean).forEach((node) => {
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

        const sync = () => (active() ? fold() : unfold());

        window.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !isOpen()) return;
            event.stopImmediatePropagation();
            event.preventDefault();
            close();
            el(spec.button)?.focus({ preventScroll: true });
        }, true);

        function start() {
            const button = el(spec.button);
            const pop = el(spec.popover);
            if (!button || !pop) return;
            document.body.appendChild(pop);
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                if (isOpen()) close();
                else open();
            });
            // A choice closes the menu, as menus do (its own handler has run by then).
            pop.addEventListener('click', (event) => {
                if (event.target.closest?.('button')) close();
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
        return { open, close, isOpen };
    }

    create({
        button: 'btn-pro-view',
        popover: 'pro-view-popover',
        body: 'pro-view-popover-body',
        nodes: () => [
            ...document.querySelectorAll('#view-gallery .view-btn[data-size]'),
            el('btn-group-runs'),
            el('btn-pro-inspector'),
        ],
    });
    create({
        button: 'btn-pro-more',
        popover: 'pro-more-popover',
        body: 'pro-more-popover-body',
        placement: 'bottom-start',
        nodes: () => [el('btn-random'), el('btn-reconnect-missing')],
    });
})();
