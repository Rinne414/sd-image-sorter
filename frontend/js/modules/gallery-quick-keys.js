/**
 * gallery-quick-keys.js - three keys a keyboard user expects in the gallery.
 *
 * Walkthrough as a power user (2026-11-10, 1366x768): the arrow keys did
 * nothing until a picture had been clicked, "/" did not reach the search box,
 * and Ctrl+A in select mode selected the page's text instead of the pictures.
 *
 * - "/" puts the cursor in the gallery search box.
 * - An arrow key with no picture in focus focuses the first picture on screen;
 *   from there the gallery's own arrow handling takes over.
 * - Ctrl+A (Cmd+A) in select mode presses "Select everything in this filter",
 *   the button that is already in the batch panel.
 *
 * Only on the gallery page, never while typing in a field, never while a
 * dialog is open, never during text composition. Classic script, no globals.
 */
(function () {
    'use strict';

    const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

    const isTyping = (target) => target instanceof Element
        && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

    const galleryIsOpen = () => document.getElementById('view-gallery')?.classList.contains('active')
        && !document.querySelector('.modal.visible')
        && !document.querySelector('.entry-page:not([hidden]):not(.is-hidden)');

    /** The first picture whose top edge is on screen (the grid may be scrolled). */
    function firstTileOnScreen() {
        const tiles = [...document.querySelectorAll('#gallery-grid .gallery-item')];
        return tiles.find((tile) => {
            const box = tile.getBoundingClientRect();
            return box.width > 0 && box.bottom > 80 && box.top < window.innerHeight;
        }) || tiles[0] || null;
    }

    function onKeydown(event) {
        if (event.isComposing || event.defaultPrevented || !galleryIsOpen() || isTyping(event.target)) return;
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey;

        if (event.key === '/' && plain) {
            const search = document.getElementById('gallery-search-input');
            if (!search) return;
            event.preventDefault();
            search.focus();
            search.select();
            return;
        }

        if (ARROWS.has(event.key) && plain && !event.shiftKey) {
            if (document.activeElement?.closest?.('.gallery-item, [role="tablist"], [role="menu"], details[open]')) return;
            const tile = firstTileOnScreen();
            if (!tile) return;
            event.preventDefault();
            tile.focus({ preventScroll: false });
            return;
        }

        const selectAll = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a';
        if (selectAll && window.App?.AppState?.selectionMode) {
            const button = document.getElementById('btn-select-all');
            if (!button || button.disabled) return;
            event.preventDefault();
            button.click();
        }
    }

    document.addEventListener('keydown', onKeydown);
})();
