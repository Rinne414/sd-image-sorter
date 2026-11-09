/**
 * pro-inspector-overview.js - what the pro look's details panel shows while no
 * picture is under the pointer: the library at a glance.
 *
 * Eagle and Billfish show the folder's facts when nothing is selected; ours
 * showed one line of text in an empty 300 px column, the first thing seen on
 * every start at the owner's 2560 screen (2026-11-09). Now it shows the
 * library's name, how many pictures wait for tagging (with a way to start),
 * the models, LoRAs and tags used most (a click shows only those pictures,
 * the same filter the statistics dialog applies), and a button to that
 * dialog, which had no entrance left.
 *
 * Numbers come from AppState.analytics, filled by loadStats, plus one count
 * of pictures not tagged yet each time those stats load. Classic script: window.ProInspectorOverview.build(t) returns the nodes
 * and pro-inspector.js places them.
 */
(function () {
    'use strict';

    const TOP_ROWS = 3;
    const TOP_TAGS = 8;
    let untaggedCount = null;

    /** A text node the first translation pass can rewrite (drawn before I18n.init). */
    function translated(tagName, className, key, fallback, t) {
        const node = document.createElement(tagName);
        node.className = className;
        node.setAttribute('data-i18n', key);
        node.textContent = t(key, fallback);
        return node;
    }

    function applyFilter(type, value) {
        if (typeof window.applyAnalyticsFilter !== 'function') return;
        window.applyAnalyticsFilter(type, value);
        window.updateFilterSummary?.();
    }

    function rankRow(type, value, label, count, t) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pro-inspector-rank';
        row.title = t('inspector.filterBy', 'Show only pictures with {value}', { value: label });
        const name = document.createElement('span');
        name.className = 'pro-inspector-rank-name';
        name.textContent = label;
        const number = document.createElement('span');
        number.className = 'pro-inspector-rank-count';
        number.textContent = String(count ?? '');
        row.append(name, number);
        row.addEventListener('click', () => applyFilter(type, value));
        return row;
    }

    /** A titled list of the most used values; nothing when the library has none. */
    function rankGroup(key, fallback, rows, t) {
        if (!rows.length) return [];
        const list = document.createElement('div');
        list.className = 'pro-inspector-ranks';
        rows.forEach((row) => list.appendChild(row));
        return [translated('div', 'pro-inspector-section-head', key, fallback, t), list];
    }

    function modelRows(stats, t) {
        const valueOf = (item) => (typeof window.getCheckpointOptionValue === 'function'
            ? window.getCheckpointOptionValue(item)
            : (item.checkpoint_normalized || item.checkpoint || ''));
        return (stats.checkpoints || []).slice(0, TOP_ROWS)
            .filter((item) => valueOf(item))
            .map((item) => rankRow('checkpoint', valueOf(item), item.checkpoint || valueOf(item), item.count, t));
    }

    function loraRows(stats, t) {
        return (stats.loras || []).slice(0, TOP_ROWS)
            .filter((item) => item?.lora)
            .map((item) => rankRow('lora', item.lora, item.lora, item.count, t));
    }

    function tagChips(stats, t) {
        const tags = (stats.top_tags || []).slice(0, TOP_TAGS).filter((item) => item?.tag);
        if (!tags.length) return [];
        const list = document.createElement('div');
        list.className = 'pro-inspector-tags';
        tags.forEach((item) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'pro-inspector-tag pro-inspector-tag-button';
            chip.textContent = item.tag.replace(/_/g, ' ');
            chip.title = t('inspector.filterBy', 'Show only pictures with {value}', { value: item.tag });
            chip.addEventListener('click', () => applyFilter('tag', item.tag));
            list.appendChild(chip);
        });
        return [translated('div', 'pro-inspector-section-head', 'inspector.topTags', 'Tags used most', t), list];
    }

    function statsButton(t) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary pro-inspector-stats';
        const icon = document.createElement('span');
        icon.className = 'pro-inspector-stats-icon';
        icon.setAttribute('aria-hidden', 'true');
        window.UiIcon?.fill(icon, 'i-chart');
        // The label carries data-i18n, not the button: a translation pass
        // rewrites the whole text of its element and would drop the icon.
        button.append(icon, translated('span', 'pro-inspector-stats-label', 'inspector.allStats', 'All statistics', t));
        button.addEventListener('click', () => window.App?.showAnalytics?.());
        return button;
    }

    /**
     * The next step for most libraries (round 19: "the beginner's next action"):
     * how many pictures wait for tagging, and the same door as the top bar's
     * AI tagging button, whose dialog tags only pictures without tags.
     */
    function taggingTodo(t) {
        if (!(untaggedCount > 0)) return [];
        const row = document.createElement('div');
        row.className = 'pro-inspector-todo';
        const text = document.createElement('span');
        text.className = 'pro-inspector-todo-text';
        text.textContent = t('inspector.untaggedCount', '{count} pictures are not tagged yet', { count: untaggedCount });
        const start = translated('button', 'btn btn-secondary pro-inspector-todo-start', 'inspector.startTagging', 'Tag them', t);
        start.type = 'button';
        start.addEventListener('click', () => document.getElementById('btn-tag')?.click());
        row.append(text, start);
        return [row];
    }

    /** Asks the server how many pictures are not tagged yet; build() shows it. */
    async function refreshCounts() {
        const api = window.App?.API;
        if (!api?.countImages || typeof window.createDefaultFilterState !== 'function') return;
        try {
            const result = await api.countImages({ ...window.createDefaultFilterState(), untagged: true });
            const value = Number(result?.count);
            untaggedCount = Number.isFinite(value) ? value : null;
        } catch (_error) {
            untaggedCount = null; // no reminder rather than a wrong one
        }
    }

    /**
     * @param {(key: string, fallback: string, params?: object) => string} t
     * @returns {HTMLElement} the overview: what to do, then what the library holds
     */
    function build(t) {
        const stats = window.App?.AppState?.analytics || {};
        const section = document.createElement('div');
        section.className = 'pro-inspector-overview';

        // The name only: the picture count is already beside the toolbar and in
        // the sidebar (round 19: shown three times).
        const name = document.createElement('h3');
        name.className = 'pro-inspector-name';
        name.textContent = window.LibraryWorkspace?.getCurrentLibrary?.()?.name
            || t('library.defaultName', 'Main library');
        section.append(name, translated('p', 'pro-inspector-empty', 'inspector.empty',
            'Point at a picture to see its details here.', t));

        const groups = [
            ...taggingTodo(t),
            ...rankGroup('inspector.topModels', 'Models used most', modelRows(stats, t), t),
            ...rankGroup('inspector.topLoras', 'LoRAs used most', loraRows(stats, t), t),
            ...tagChips(stats, t),
        ];
        section.append(...groups);
        if (Number(stats.totalImages) > 0) section.appendChild(statsButton(t));
        return section;
    }

    window.ProInspectorOverview = Object.freeze({ build, refreshCounts });
})();
