/**
 * pro-inspector-overview.js - what the pro look's details panel shows while no
 * picture is under the pointer: the library at a glance.
 *
 * Eagle and Billfish show the folder's facts when nothing is selected; ours
 * showed one line of text in an empty 300 px column, the first thing seen on
 * every start at the owner's 2560 screen (2026-11-09). Now it shows the
 * library's name and picture count, the models, LoRAs and tags used most (a
 * click shows only those pictures, the same filter the statistics dialog
 * applies), and a button to that dialog, which had no entrance left.
 *
 * Numbers come from AppState.analytics, filled by loadStats; no request of its
 * own. Classic script: window.ProInspectorOverview.build(t) returns the nodes
 * and pro-inspector.js places them.
 */
(function () {
    'use strict';

    const TOP_ROWS = 3;
    const TOP_TAGS = 8;

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
        return [translated('div', 'pro-inspector-section-head', 'inspector.topTags', 'Common tags', t), list];
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
     * @param {(key: string, fallback: string, params?: object) => string} t
     * @returns {HTMLElement} the overview, newest numbers first
     */
    function build(t) {
        const stats = window.App?.AppState?.analytics || {};
        const section = document.createElement('div');
        section.className = 'pro-inspector-overview';

        const name = document.createElement('h3');
        name.className = 'pro-inspector-name';
        name.textContent = window.LibraryWorkspace?.getCurrentLibrary?.()?.name
            || t('library.defaultName', 'Main library');
        section.appendChild(name);

        const total = Number(stats.totalImages);
        if (Number.isFinite(total)) {
            const count = document.createElement('p');
            count.className = 'pro-inspector-overview-total';
            count.textContent = t('inspector.overviewCount', '{count} pictures', { count: total });
            section.appendChild(count);
        }

        const groups = [
            ...rankGroup('inspector.topModels', 'Models used most', modelRows(stats, t), t),
            ...rankGroup('inspector.topLoras', 'LoRAs used most', loraRows(stats, t), t),
            ...tagChips(stats, t),
        ];
        section.append(...groups);
        if (total > 0) section.appendChild(statsButton(t));
        section.appendChild(translated('p', 'pro-inspector-empty', 'inspector.empty',
            'Point at a picture to see its details here.', t));
        return section;
    }

    window.ProInspectorOverview = Object.freeze({ build });
})();
