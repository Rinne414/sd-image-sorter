/**
 * library-views.js - the Professional look's "Quick views" list at the top of
 * the sidebar: All pictures, Without tags and Last 7 days, each with a live
 * count; a click shows that view.
 *
 * Blind judges (2026-11-09, rounds 17-18) asked for Eagle-style default views
 * (All / Untagged / Recent). "Not tagged yet" is the untagged filter
 * (tagged_at is empty: no AI tagging run and no tag edit, the tagger's own
 * "untagged only" definition); "Last 7 days" is dateFrom (file time).
 * A view starts from the default filters, like loading a saved preset.
 * Counts come from POST /api/images/count (the smart-folder path) and refresh
 * when the gallery reloads.
 *
 * Only proposal B shows the list (look-pro-b.css). Classic script, no globals.
 */
(function () {
    'use strict';

    const RECOUNT_DEBOUNCE_MS = 600;
    const DAY_MS = 24 * 60 * 60 * 1000;
    let recountTimer = 0;
    let epoch = 0;

    function isoDaysAgo(days) {
        const date = new Date(Date.now() - days * DAY_MS);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    const VIEWS = [
        { id: 'all', icon: 'i-images', key: 'libraryViews.all', label: 'All pictures', filters: () => ({}) },
        { id: 'untagged', icon: 'i-tag', key: 'libraryViews.untagged', label: 'Not tagged yet', filters: () => ({ untagged: true }) },
        { id: 'recent', icon: 'i-clock', key: 'libraryViews.recent', label: 'Last 7 days', filters: () => ({ dateFrom: isoDaysAgo(7) }) },
    ];

    /** The view on top of the default filters; the chosen sort order stays. */
    function fullFilters(view) {
        const sortBy = window.App?.AppState?.filters?.sortBy;
        return { ...window.createDefaultFilterState(), ...(sortBy ? { sortBy } : {}), ...view.filters() };
    }

    /** Lights the row of the view the gallery shows now (the date filter has no summary row). */
    function markActive(filters) {
        const plain = (value) => JSON.stringify({ ...value, sortBy: null, limit: null });
        const now = plain(filters || {});
        document.querySelectorAll('#pro-library-views .pro-library-view').forEach((button) => {
            const view = VIEWS.find((v) => v.id === button.dataset.view);
            const on = Boolean(view) && now === plain(fullFilters(view));
            button.classList.toggle('is-active', on);
            if (on) button.setAttribute('aria-current', 'true');
            else button.removeAttribute('aria-current');
        });
    }

    function row(view) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pro-library-view';
        button.dataset.view = view.id;
        const icon = document.createElement('span');
        icon.className = 'pro-library-view-icon';
        icon.setAttribute('aria-hidden', 'true');
        window.UiIcon?.fill(icon, view.icon);
        const label = document.createElement('span');
        label.className = 'pro-library-view-label';
        label.dataset.i18n = view.key;
        label.textContent = window.I18n?.t?.(view.key) || view.label;
        const count = document.createElement('span');
        count.className = 'pro-library-view-count';
        count.textContent = '…';
        button.append(icon, label, count);
        button.addEventListener('click', () => apply(view));
        return button;
    }

    function build() {
        const section = document.createElement('div');
        section.className = 'sidebar-section pro-library-views';
        section.id = 'pro-library-views';
        const head = document.createElement('div');
        head.className = 'sidebar-section-head';
        const title = document.createElement('span');
        title.className = 'sidebar-section-title';
        title.dataset.i18n = 'libraryViews.title';
        title.textContent = window.I18n?.t?.('libraryViews.title') || 'Quick views';
        head.appendChild(title);
        const list = document.createElement('div');
        list.className = 'pro-library-views-list';
        VIEWS.forEach((view) => list.appendChild(row(view)));
        section.append(head, list);
        return section;
    }

    function setCount(id, value) {
        const node = document.querySelector(`#pro-library-views .pro-library-view[data-view="${id}"] .pro-library-view-count`);
        if (node) node.textContent = Number.isFinite(value) ? String(value) : '—';
    }

    async function recount() {
        const api = window.App?.API;
        if (!api?.countImages || typeof window.createDefaultFilterState !== 'function') return;
        const mine = ++epoch;
        // One after another: three cheap COUNTs, no burst on the local server.
        for (const view of VIEWS) {
            try {
                const result = await api.countImages(fullFilters(view));
                if (mine !== epoch) return;
                setCount(view.id, Number(result?.count));
            } catch (_error) {
                if (mine !== epoch) return;
                setCount(view.id, NaN);
            }
        }
    }

    function scheduleRecount(delay = RECOUNT_DEBOUNCE_MS) {
        clearTimeout(recountTimer);
        recountTimer = setTimeout(recount, delay);
    }

    function apply(view) {
        if (typeof window.setAppFilters !== 'function') return;
        window.setAppFilters(fullFilters(view));
        window.updateFilterSummary?.();
        window.syncGenTabsWithFilters?.();
        window.loadImages?.();
    }

    function start() {
        const scroll = document.querySelector('#view-gallery .filter-sidebar-scroll');
        if (!scroll || document.getElementById('pro-library-views')) return;
        scroll.prepend(build());
        window.addEventListener('gallery-images-loaded', () => scheduleRecount());
        document.addEventListener('gallery-filters-changed', (event) => markActive(event.detail?.filters));
        markActive(window.App?.AppState?.filters);
        scheduleRecount(50);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
