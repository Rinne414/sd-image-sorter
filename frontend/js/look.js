/**
 * look.js - which look the classic interface wears, set before the page paints.
 *
 * "pro" (css/look-pro.css): the owner's brand magenta as the one accent, flat
 * sidebar rows, one corner and type scale (goal 2026-11-08, .plans/ui-pro-2026-11).
 * Anything else, or nothing stored: today's look. Loaded in <head> so the page
 * never flashes the other look first.
 */
(function () {
    'use strict';

    const KEY = 'sd-look';
    const LOOKS = new Set(['pro']);

    function read() {
        try {
            const value = localStorage.getItem(KEY);
            return LOOKS.has(value) ? value : null;
        } catch (_error) {
            return null;
        }
    }

    function apply(look) {
        if (look) document.documentElement.setAttribute('data-look', look);
        else document.documentElement.removeAttribute('data-look');
    }

    apply(read());

    // Settings > Appearance: the look switch (index.html #settings-look).
    document.addEventListener('DOMContentLoaded', () => {
        const select = document.getElementById('settings-look');
        if (!select) return;
        select.value = read() || '';
        select.addEventListener('change', () => window.SdLook.set(select.value || null));
    });

    window.SdLook = {
        current: read,
        set(look) {
            const next = LOOKS.has(look) ? look : null;
            try {
                if (next) localStorage.setItem(KEY, next);
                else localStorage.removeItem(KEY);
            } catch (_error) {
                // Storage blocked: the look still changes until the page reloads.
            }
            apply(next);
        },
    };
})();
