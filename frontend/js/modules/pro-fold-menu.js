/**
 * pro-fold-menu.js - proposal B folds a few gallery buttons into a labelled
 * menu (View, More beside the picture count), puts the top bar's guide and
 * language switch into one Help menu and moves AI tagging into the gallery's
 * tools.
 *
 * Blind A/B rounds (2026-11-08/09): the gallery toolbar carried about fifteen
 * controls and several bare icons nobody could name. In proposal B (the pro
 * look with data-look-variant="b") the folded buttons move into their menu,
 * where each shows its own name; each keeps its handler and pressed state.
 * Nothing is removed: proposal A and today's look keep every button where it
 * was. (Select pictures stays at the sidebar's foot: the owner, 2026-11-09.)
 *
 * The menus are created from <head>, so each menu's Esc listener comes before
 * the body scripts' own Esc handlers.
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

    function whenReady(start) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    function onLookChange(callback) {
        new MutationObserver(callback).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-look', 'data-look-variant'],
        });
    }

    /**
     * Keeps nodes() inside the host element while proposal B is on and puts
     * them back where they were (same parent, same place) when it is off.
     */
    function relocate(hostId, nodes) {
        const moved = [];

        function moveIn() {
            const host = el(hostId);
            if (!host || moved.length) return;
            nodes().filter(Boolean).forEach((node) => {
                moved.push({ node, parent: node.parentNode, next: node.nextSibling });
                host.appendChild(node);
            });
        }

        function moveBack() {
            while (moved.length) {
                const { node, parent, next } = moved.pop();
                parent.insertBefore(node, next && next.parentNode === parent ? next : null);
            }
        }

        return { sync: () => (active() ? moveIn() : moveBack()) };
    }

    /**
     * @param {{button: string, popover: string, body: string, nodes: () => Element[], placement?: string}} spec
     *   element ids of the menu button, its popover and the popover's body;
     *   nodes() lists the buttons to fold.
     */
    function createMenu(spec) {
        const placement = spec.placement || 'bottom-end';
        const mover = relocate(spec.body, spec.nodes);
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

        function sync() {
            if (!active()) close();
            mover.sync();
        }

        window.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !isOpen()) return;
            event.stopImmediatePropagation();
            event.preventDefault();
            close();
            el(spec.button)?.focus({ preventScroll: true });
        }, true);

        whenReady(() => {
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
            onLookChange(sync);
            sync();
        });
    }

    createMenu({
        button: 'btn-pro-view',
        popover: 'pro-view-popover',
        body: 'pro-view-popover-body',
        nodes: () => [
            ...document.querySelectorAll('#view-gallery .view-btn[data-size]'),
            el('btn-group-runs'),
            el('btn-pro-inspector'),
        ],
    });
    createMenu({
        button: 'btn-pro-more',
        popover: 'pro-more-popover',
        body: 'pro-more-popover-body',
        placement: 'bottom-start',
        nodes: () => [el('btn-random'), el('btn-reconnect-missing')],
    });

    // The owner's top bar (2026-11-09, sample 3 of three): one filled button.
    // The guide and the language switch share one Help menu, and AI tagging,
    // a gallery action shown only on the gallery page, joins the gallery's tools.
    createMenu({
        button: 'btn-pro-help',
        popover: 'pro-help-popover',
        body: 'pro-help-popover-body',
        nodes: () => [el('btn-help'), el('btn-shortcuts'), el('btn-language-toggle')],
    });
    const tagging = relocate('pro-tag-slot', () => [el('btn-tag')]);
    whenReady(() => {
        onLookChange(tagging.sync);
        tagging.sync();
    });
})();
