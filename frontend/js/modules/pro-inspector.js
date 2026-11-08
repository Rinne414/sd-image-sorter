/**
 * pro-inspector.js - the pro look's details panel beside the gallery grid.
 *
 * Blind judges (2026-11-08, round 9): Eagle, Billfish and Photos all show the
 * selected picture's details in a panel on the right; without one the
 * gallery "looks unfinished". A click opens the preview here, so the panel
 * follows the picture under the pointer (after a short pause) and keeps the
 * last one when the pointer leaves the grid. Size, generator, model, date and
 * rating come from the gallery row; the prompt and tags load once per picture
 * (API.getImage, cached). The toolbar keeps its full width above; only the
 * grid gives the panel room. Wide windows open it by default; the toolbar's
 * info button shows or hides it and the choice is remembered.
 *
 * Today's look never shows it. Classic script, no globals.
 */
(function () {
    'use strict';

    const STORE = 'sd-sorter:pro-inspector';
    const DWELL_MS = 250;
    const WIDE_PX = 1600;
    const details = new Map();
    let shownId = null;
    let dwellTimer = 0;

    const el = (id) => document.getElementById(id);
    const t = (key, fallback, params) => {
        const value = window.I18n?.t?.(key, params);
        return value && value !== key ? value : (window.I18n?.format?.(fallback, params) ?? fallback);
    };

    function preferredOpen() {
        try {
            const saved = localStorage.getItem(STORE);
            if (saved === 'open') return true;
            if (saved === 'closed') return false;
        } catch (_error) { /* storage blocked: use the default */ }
        return window.innerWidth >= WIDE_PX;
    }

    function galleryActive() {
        return document.querySelector('.nav-bar')?.getAttribute('data-view') === 'gallery'
            || document.getElementById('view-gallery')?.classList.contains('active');
    }

    function applyOpen(open) {
        const root = document.documentElement;
        const on = open && root.dataset.look === 'pro' && galleryActive();
        root.classList.toggle('pro-inspector-open', on);
        const button = el('btn-pro-inspector');
        if (button) button.setAttribute('aria-pressed', open ? 'true' : 'false');
        if (on) placeBelowToolbar();
    }

    /**
     * The panel starts under the (sticky) gallery toolbar, whatever its height;
     * measured after layout settles (the toolbar may just have become one row).
     */
    function placeBelowToolbar() {
        requestAnimationFrame(() => {
            const toolbar = el('gallery-toolbar');
            if (!toolbar) return;
            // Bounding boxes are in screen pixels; the interface zoom would scale a
            // CSS length again (148 px became 192 at the 1.3 zoom).
            const screenBottom = Math.max(0, toolbar.getBoundingClientRect().bottom);
            const bottom = window.PopupPosition?.toCssPx ? window.PopupPosition.toCssPx(screenBottom) : screenBottom;
            document.documentElement.style.setProperty('--pro-inspector-top', `${Math.round(bottom)}px`);
        });
    }

    function formatDate(seconds) {
        const value = Number(seconds);
        if (!Number.isFinite(value) || value <= 0) return '';
        const date = new Date(value * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function formatBytes(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value <= 0) return '';
        if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function fact(label, value) {
        if (!value) return null;
        const row = document.createElement('div');
        row.className = 'pro-inspector-fact';
        const name = document.createElement('span');
        name.className = 'pro-inspector-fact-label';
        name.textContent = label;
        const text = document.createElement('span');
        text.className = 'pro-inspector-fact-value';
        text.textContent = value;
        text.title = value;
        row.append(name, text);
        return row;
    }

    function renderEmpty() {
        const body = el('pro-inspector-body');
        if (!body) return;
        const note = document.createElement('p');
        note.className = 'pro-inspector-empty';
        note.textContent = t('inspector.empty', 'Point at a picture to see its details here.');
        body.replaceChildren(note);
    }

    function render(image, detail) {
        const body = el('pro-inspector-body');
        if (!body || !image) return;
        const api = window.App?.API;
        const thumb = document.createElement('img');
        thumb.className = 'pro-inspector-thumb';
        thumb.alt = '';
        thumb.decoding = 'async';
        if (api?.getThumbnailUrl) thumb.src = api.getThumbnailUrl(image.id, 512);

        const name = document.createElement('h3');
        name.className = 'pro-inspector-name';
        name.textContent = image.filename || '';
        name.title = image.path || image.filename || '';

        const facts = document.createElement('div');
        facts.className = 'pro-inspector-facts';
        const size = image.width && image.height ? `${image.width} × ${image.height}` : '';
        const stars = Number(image.user_rating) > 0 ? '★'.repeat(Number(image.user_rating)) : '';
        [
            fact(t('inspector.size', 'Size'), [size, formatBytes(image.file_size)].filter(Boolean).join(' · ')),
            fact(t('inspector.generator', 'Generator'), typeof window.formatGeneratorLabel === 'function'
                ? window.formatGeneratorLabel(image.generator, t('common.unknown', 'Unknown'))
                : (image.generator || '')),
            fact(t('inspector.model', 'Model'), image.checkpoint || ''),
            fact(t('inspector.date', 'Date'), formatDate(image.created_at)),
            fact(t('inspector.rating', 'My rating'), stars),
        ].filter(Boolean).forEach((row) => facts.appendChild(row));

        const parts = [thumb, name, facts];
        const prompt = detail?.image?.prompt || '';
        if (prompt) {
            const head = document.createElement('div');
            head.className = 'pro-inspector-section-head';
            const label = document.createElement('span');
            label.textContent = t('inspector.prompt', 'Prompt');
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'pro-inspector-copy';
            copy.textContent = t('inspector.copyPrompt', 'Copy');
            copy.addEventListener('click', () => {
                if (typeof window.copyTextToClipboard === 'function') {
                    window.copyTextToClipboard(prompt, t('modal.promptCopied', 'Prompt copied'));
                } else {
                    navigator.clipboard?.writeText(prompt);
                }
            });
            head.append(label, copy);
            const text = document.createElement('p');
            text.className = 'pro-inspector-prompt';
            text.textContent = prompt;
            parts.push(head, text);
        }
        const tags = (detail?.tags || [])
            .map((tag) => (typeof tag === 'string' ? tag : tag?.tag || tag?.name || ''))
            .filter(Boolean)
            .slice(0, 16);
        if (tags.length) {
            const head = document.createElement('div');
            head.className = 'pro-inspector-section-head';
            head.textContent = t('inspector.tags', 'Tags');
            const list = document.createElement('div');
            list.className = 'pro-inspector-tags';
            tags.forEach((tag) => {
                const chip = document.createElement('span');
                chip.className = 'pro-inspector-tag';
                chip.textContent = tag.replace(/_/g, ' ');
                list.appendChild(chip);
            });
            parts.push(head, list);
        }
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'btn btn-secondary pro-inspector-open';
        open.textContent = t('inspector.openPreview', 'Open preview');
        open.addEventListener('click', () => window.Gallery?.openPreview?.(image.id));
        parts.push(open);
        body.replaceChildren(...parts);
    }

    function imageById(id) {
        return (window.App?.AppState?.images || []).find((image) => Number(image.id) === Number(id)) || null;
    }

    async function show(id) {
        const image = imageById(id);
        if (!image || Number(id) === shownId) return;
        shownId = Number(id);
        render(image, details.get(shownId));
        if (details.has(shownId)) return;
        try {
            const detail = await window.App?.API?.getImage?.(shownId);
            if (!detail) return;
            details.set(Number(id), detail);
            if (details.size > 200) details.delete(details.keys().next().value);
            if (shownId === Number(id)) render(image, detail);
        } catch (_error) {
            // The row's facts stay; the prompt and tags simply do not show.
        }
    }

    function onPointer(event) {
        if (!document.documentElement.classList.contains('pro-inspector-open')) return;
        const tile = event.target.closest?.('#gallery-grid .gallery-item');
        if (!tile?.dataset.id) return;
        clearTimeout(dwellTimer);
        dwellTimer = setTimeout(() => show(tile.dataset.id), DWELL_MS);
    }

    function start() {
        const button = el('btn-pro-inspector');
        const panel = el('pro-inspector');
        if (!button || !panel) return;
        document.body.appendChild(panel);
        renderEmpty();
        button.addEventListener('click', () => {
            const next = button.getAttribute('aria-pressed') !== 'true';
            try { localStorage.setItem(STORE, next ? 'open' : 'closed'); } catch (_error) { /* per-session only */ }
            applyOpen(next);
        });
        el('gallery-grid')?.addEventListener('mouseover', onPointer);
        el('gallery-grid')?.addEventListener('focusin', onPointer);
        const toolbar = el('gallery-toolbar');
        if (toolbar) new ResizeObserver(placeBelowToolbar).observe(toolbar);
        window.addEventListener('resize', placeBelowToolbar);
        // The one-row toolbar switches by a class on <html>: measure again then.
        new MutationObserver(placeBelowToolbar).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        // A look switch or a page change re-applies the current choice.
        const observer = new MutationObserver(() => applyOpen(button.getAttribute('aria-pressed') === 'true'));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-look'] });
        const nav = document.querySelector('.nav-bar');
        if (nav) observer.observe(nav, { attributes: true, attributeFilter: ['data-view'] });
        applyOpen(preferredOpen());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
