/**
 * Random sort that can be re-rolled.
 *
 * "Random" was one fixed shuffle: the same order on every visit. The gallery
 * now sends a seed with the random sort (the same seed is the same order, so
 * scrolling and paging stay stable) and the button beside the sort menu, which
 * reverses every other sort and means nothing for a shuffle, becomes
 * "Shuffle again" while the sort is Random.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'sd-gallery-random-seed';
    const MAX_SEED = 2147483646;
    const REVERSE = { icon: '#i-sort', key: 'tip.reverseSortOrder', fallback: 'Reverse sort order' };
    const SHUFFLE = { icon: '#i-dice', key: 'tip.shuffleAgain', fallback: 'Shuffle again' };

    function newSeed() {
        return 1 + Math.floor(Math.random() * (MAX_SEED - 1));
    }

    function readSeed() {
        try {
            const stored = Number(localStorage.getItem(STORAGE_KEY));
            if (Number.isInteger(stored) && stored > 0 && stored <= MAX_SEED) return stored;
        } catch (error) {
            // No storage (private window): a seed for this page load is enough.
        }
        return 0;
    }

    let seed = readSeed();

    function currentSeed() {
        if (!seed) reshuffle();
        return seed;
    }

    function reshuffle() {
        seed = newSeed();
        try {
            localStorage.setItem(STORAGE_KEY, String(seed));
        } catch (error) {
            // Kept for this page load only.
        }
        return seed;
    }

    function isRandomSort() {
        return window.App?.AppState?.filters?.sortBy === 'random';
    }

    function translate(key, fallback) {
        const text = window.I18n?.t?.(key);
        return text && text !== key ? text : fallback;
    }

    /** The button reads "Shuffle again" while the sort is Random, "Reverse" otherwise. */
    function sync() {
        const button = document.getElementById('sort-reverse-btn');
        if (!button) return;
        const face = isRandomSort() ? SHUFFLE : REVERSE;
        const label = translate(face.key, face.fallback);
        button.querySelector('use')?.setAttribute('href', face.icon);
        button.title = label;
        button.setAttribute('aria-label', label);
        button.dataset.i18nTitle = face.key;
        button.dataset.i18nAria = face.key;
        button.classList.toggle('is-shuffle', face === SHUFFLE);
        if (face === SHUFFLE) {
            button.classList.remove('active');
            button.removeAttribute('aria-pressed');
        }
    }

    function wire() {
        const button = document.getElementById('sort-reverse-btn');
        if (!button) return;
        // Before the reverse handler: for a shuffle the press means "again".
        button.addEventListener('click', (event) => {
            if (!isRandomSort()) return;
            event.stopImmediatePropagation();
            event.preventDefault();
            reshuffle();
            window.App?.loadImages?.();
        }, true);
        document.getElementById('gallery-sort')?.addEventListener('change', () => setTimeout(sync, 0));
        sync();
    }

    window.GalleryReshuffle = Object.freeze({ currentSeed, reshuffle, sync });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
