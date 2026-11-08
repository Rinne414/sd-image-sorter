/**
 * pro-toolbar.js - the pro look's gallery toolbar in one row when it fits.
 *
 * Blind judges (2026-11-08, rounds 3-6) put "three chrome rows before the
 * first picture" first. In the pro look this moves the search row's groups
 * into the gallery header: search, its buttons and the quick chips after the
 * source tabs, the aspect / sort tools before the view buttons. It keeps the
 * one row only when nothing overflows; otherwise (more sources, a narrower
 * window) every node goes back and the two balanced rows stay. Nothing is
 * hidden or removed here; look-pro.css styles the one-row state through
 * html.pro-toolbar-one-row (and drops the size slider's -/+ steppers there,
 * which the slider and the [ ] keys cover).
 *
 * Today's look never changes. Classic script, no globals.
 */
(function () {
    'use strict';

    const ONE_ROW = 'pro-toolbar-one-row';
    const moved = [];
    let scheduled = false;

    function parts() {
        const header = document.querySelector('#view-gallery .gallery-header');
        const left = header?.querySelector('.gallery-header-left');
        const right = header?.querySelector('.view-options');
        const row = document.getElementById('gallery-search-row');
        return header && left && right && row ? { header, left, right, row } : null;
    }

    function remember(node) {
        moved.push({ node, parent: node.parentNode, next: node.nextSibling });
    }

    function restore() {
        while (moved.length) {
            const { node, parent, next } = moved.pop();
            parent.insertBefore(node, next && next.parentNode === parent ? next : null);
        }
        document.documentElement.classList.remove(ONE_ROW);
    }

    function merge(p) {
        const search = ['.gallery-search-box', '.gallery-search-btns', '.gallery-quick-chips']
            .map((sel) => p.row.querySelector(`:scope > ${sel}`))
            .filter(Boolean);
        const tools = p.row.querySelector(':scope > .gallery-search-tools');
        search.forEach((node) => { remember(node); p.left.appendChild(node); });
        if (tools) { remember(tools); p.right.insertBefore(tools, p.right.firstChild); }
        document.documentElement.classList.add(ONE_ROW);
    }

    // A few pixels of scroll room (focus-ring padding, sub-pixel rounding at the
    // interface zoom) clip nothing visible.
    const SLACK = 4;

    /** An element shows all of its content (nothing scrolled or clipped away). */
    function holdsContent(el) {
        return !el || el.scrollWidth <= el.clientWidth + SLACK;
    }

    /**
     * True when the one row holds everything: no group clips its content (the
     * groups shrink before they overflow, so the header alone never shows it),
     * the source tabs and quick chips show every item, and the groups sit side
     * by side on one line.
     */
    function fits(p) {
        if (!holdsContent(p.header) || !holdsContent(p.left) || !holdsContent(p.right)) return false;
        if (!holdsContent(document.getElementById('generator-tabs'))) return false;
        if (!holdsContent(p.left.querySelector('.gallery-quick-chips'))) return false;
        const left = p.left.getBoundingClientRect();
        const right = p.right.getBoundingClientRect();
        const lastLeft = p.left.lastElementChild?.getBoundingClientRect();
        // Bounding boxes are in zoomed pixels: the slack scales with the zoom.
        const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        if (lastLeft && lastLeft.right > left.right + SLACK * zoom) return false;
        return Math.abs(left.top - right.top) < 4 && left.right <= right.left;
    }

    /** Run a DOM move without losing the user's place in a field that moves. */
    function keepingFocus(move) {
        const active = document.activeElement;
        const caret = active && typeof active.selectionStart === 'number'
            ? [active.selectionStart, active.selectionEnd]
            : null;
        move();
        if (active && active !== document.body && document.activeElement !== active && active.isConnected) {
            active.focus({ preventScroll: true });
            if (caret) active.setSelectionRange(caret[0], caret[1]);
        }
    }

    /**
     * Nodes move only when the state has to change: typing a search updates the
     * source counts, which asks again, and must not shuffle the field it types in.
     */
    function decide() {
        scheduled = false;
        const merged = moved.length > 0;
        const p = parts();
        if (document.documentElement.dataset.look !== 'pro' || !p || p.header.offsetParent === null) {
            if (merged) keepingFocus(restore);
            return;
        }
        if (merged) {
            if (!fits(p)) keepingFocus(restore);
            return;
        }
        keepingFocus(() => {
            merge(p);
            if (!fits(p)) restore();
        });
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(decide);
    }

    function start() {
        const p = parts();
        if (!p) return;
        // Only a change of width can change the answer (the one row changes the height).
        let lastWidth = -1;
        new ResizeObserver((entries) => {
            const width = Math.round(entries[entries.length - 1].contentRect.width);
            if (width === lastWidth) return;
            const grew = width > lastWidth;
            lastWidth = width;
            // Wider: a two-row toolbar may now fit in one; narrower: re-check the one row.
            if (grew && moved.length) return;
            schedule();
        }).observe(p.header.parentElement || p.header);
        const tabs = document.getElementById('generator-tabs');
        if (tabs) new MutationObserver(schedule).observe(tabs, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
        new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-look'] });
        schedule();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
