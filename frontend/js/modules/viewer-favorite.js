/**
 * viewer-favorite.js - favourite and rate the picture that is open.
 *
 * The heart was only on the grid's tiles: with a picture open full size, the
 * moment a user decides "this one is a keeper", there was nothing to press,
 * and the number keys did nothing (walkthrough as a power user, 2026-11-10).
 *
 * - A heart button beside "Your rating" in the picture viewer toggles the
 *   favourite (the same Gallery.toggleFavorite the tiles use).
 * - With the viewer open and no field in focus, 1 to 5 set the star rating
 *   and 0 clears it (Gallery.setUserRating).
 *
 * The viewer writes the open picture's id on #modal-user-rating each time it
 * shows a picture; this module reads it from there. Classic script, no globals.
 */
(function () {
    'use strict';

    const ratingHost = () => document.getElementById('modal-user-rating');
    const heart = () => document.getElementById('modal-favorite-btn');

    function openImageId() {
        const id = Number(ratingHost()?.dataset.imageId);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    /** The picture viewer is open and no other dialog sits on top of it. */
    const viewerIsOpen = () => document.getElementById('image-modal')?.classList.contains('visible')
        && [...document.querySelectorAll('.modal.visible')].every((modal) => modal.id === 'image-modal');

    function syncHeart() {
        const button = heart();
        if (!button) return;
        const id = openImageId();
        const on = id !== null && Boolean(window.Gallery?.isFavorited?.(id));
        button.hidden = id === null;
        button.classList.toggle('is-favorited', on);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    async function toggle() {
        const id = openImageId();
        if (id === null || typeof window.Gallery?.toggleFavorite !== 'function') return;
        const pending = window.Gallery.toggleFavorite(id);
        syncHeart(); // the toggle is optimistic: show it at once
        await pending;
        syncHeart(); // and again once the server answered (it may have rolled back)
    }

    function onKeydown(event) {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!/^[0-5]$/.test(event.key) || !viewerIsOpen()) return;
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
        const id = openImageId();
        if (id === null || typeof window.Gallery?.setUserRating !== 'function') return;
        event.preventDefault();
        window.Gallery.setUserRating(id, Number(event.key));
    }

    function wire() {
        const button = heart();
        const host = ratingHost();
        if (!button || !host) return;
        button.addEventListener('click', toggle);
        new MutationObserver(syncHeart).observe(host, { attributes: true, attributeFilter: ['data-image-id'] });
        document.addEventListener('keydown', onKeydown);
        syncHeart();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
