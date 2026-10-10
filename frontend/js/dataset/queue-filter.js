/**
 * Dataset Maker — queue filters: caption status (All / No caption / Has caption)
 * plus tag include/exclude, the filter bar (chips, count, Clear) and the
 * caption-scope summary that says which images a caption action changes.
 * The caption-status filter moved here from queue-render.js when the tag
 * filter joined it (issue #5).
 * Load order is pinned by the ordered async=false loader in dataset/core.js;
 * this module must load before split-view.js, which calls
 * _initQueueCaptionFilter at load time.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const TAG_SUGGESTION_LIMIT = 500;

    const formatCount = (n) => Number(n || 0).toLocaleString();

    // ---------- Filter state + matching ----------
    DM._queueCaptionFilter = 'all';
    // sd-dataset-tag-editor convention: an image must carry EVERY include tag
    // (AND) and is hidden when it carries ANY exclude tag (OR). Tags keep the
    // spelling the user gave; matching folds them with _normalizeTagKey, the
    // same key find/replace uses.
    DM._queueTagFilter = { include: [], exclude: [] };

    DM._hasQueueTagFilter = function () {
        return this._queueTagFilter.include.length > 0 || this._queueTagFilter.exclude.length > 0;
    };

    DM._hasActiveQueueFilter = function () {
        return (this._queueCaptionFilter || 'all') !== 'all' || this._hasQueueTagFilter();
    };

    // Filters read the booru caption the editor shows (_booruTextFor: the
    // user's edit, else the saved project revision, else the imported or
    // rendered caption), the same text the Tag Vocabulary counts.
    function captionTagKeys(datasetMaker, id) {
        const keys = new Set();
        for (const part of datasetMaker._booruTextFor(id).split(',')) {
            const key = datasetMaker._normalizeTagKey(part);
            if (key) keys.add(key);
        }
        return keys;
    }

    DM._queueIdsForCurrentFilter = function () {
        const ids = Array.from(this.imageIds || []);
        if (!this._hasActiveQueueFilter()) return ids;
        const status = this._queueCaptionFilter || 'all';
        const include = this._queueTagFilter.include.map((tag) => this._normalizeTagKey(tag));
        const exclude = this._queueTagFilter.exclude.map((tag) => this._normalizeTagKey(tag));
        return ids.filter((id) => {
            if (status !== 'all') {
                const hasCaption = this._booruTextFor(id).trim().length > 0;
                if (hasCaption !== (status === 'tagged')) return false;
            }
            if (include.length === 0 && exclude.length === 0) return true;
            const keys = captionTagKeys(this, id);
            return include.every((key) => keys.has(key)) && !exclude.some((key) => keys.has(key));
        });
    };

    DM._queueTagFilterMode = function (tag) {
        const key = this._normalizeTagKey(tag);
        const has = (list) => list.some((item) => this._normalizeTagKey(item) === key);
        if (has(this._queueTagFilter.include)) return 'include';
        if (has(this._queueTagFilter.exclude)) return 'exclude';
        return null;
    };

    /** Put ``tag`` in the include or exclude list (mode null removes it). */
    DM._setQueueTagFilter = function (tag, mode) {
        const value = String(tag || '').trim();
        const key = this._normalizeTagKey(value);
        if (!key) return;
        const without = (list) => list.filter((item) => this._normalizeTagKey(item) !== key);
        const include = without(this._queueTagFilter.include);
        const exclude = without(this._queueTagFilter.exclude);
        if (mode === 'include') include.push(value);
        if (mode === 'exclude') exclude.push(value);
        this._queueTagFilter = { include, exclude };
        this._onQueueFilterChanged();
    };

    DM._toggleQueueTagInclude = function (tag) {
        this._setQueueTagFilter(tag, this._queueTagFilterMode(tag) === 'include' ? null : 'include');
    };

    DM._clearQueueFilters = function () {
        this._queueCaptionFilter = 'all';
        const select = document.getElementById('dataset-queue-caption-filter');
        if (select) select.value = 'all';
        this._queueTagFilter = { include: [], exclude: [] };
        this._onQueueFilterChanged();
    };

    DM._onQueueFilterChanged = function () {
        // Selection actions (Remove selected, Add tag to selected) must never
        // reach images the new filter hides.
        if (this._queueSelection.size > 0) {
            const shown = new Set(this._queueIdsForCurrentFilter());
            for (const id of Array.from(this._queueSelection)) {
                if (!shown.has(Number(id))) this._queueSelection.delete(id);
            }
        }
        this._renderQueue();
        this._renderVocab?.();
    };

    // Caption edits can move an image into or out of an active filter; one
    // render per frame covers a batch of edits.
    DM._scheduleQueueRender = function () {
        if (this._queueRenderFrame) return;
        this._queueRenderFrame = requestAnimationFrame(() => {
            this._queueRenderFrame = 0;
            this._renderQueue();
        });
    };

    // ---------- Filter bar ----------
    function buildChip(datasetMaker, tag, mode) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `dataset-queue-tag-chip is-${mode}`;
        chip.dataset.tag = tag;
        chip.dataset.mode = mode;
        const glyph = document.createElement('span');
        glyph.className = 'dataset-queue-tag-chip-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = mode === 'include' ? '+' : '−';
        const label = document.createElement('span');
        label.className = 'dataset-queue-tag-chip-label';
        label.textContent = tag;
        const remove = document.createElement('span');
        remove.className = 'dataset-queue-tag-chip-x';
        remove.setAttribute('aria-hidden', 'true');
        remove.textContent = '×';
        chip.append(glyph, label, remove);
        chip.title = datasetMaker._t(
            mode === 'include' ? 'dataset.queueTagChipIncludeRemove' : 'dataset.queueTagChipExcludeRemove',
            mode === 'include' ? 'Showing images with "{tag}". Click to remove this filter.'
                : 'Hiding images with "{tag}". Click to remove this filter.',
            { tag },
        );
        chip.setAttribute('aria-label', chip.title);
        chip.addEventListener('click', () => datasetMaker._setQueueTagFilter(tag, null));
        return chip;
    }

    /** Refresh chips, the "Showing N of M" row and the scope summary. */
    DM._renderQueueFilterBar = function (shownIds) {
        this._queueShownIds = shownIds;
        const chips = document.getElementById('dataset-queue-tag-chips');
        if (chips) {
            chips.replaceChildren(
                ...this._queueTagFilter.include.map((tag) => buildChip(this, tag, 'include')),
                ...this._queueTagFilter.exclude.map((tag) => buildChip(this, tag, 'exclude')),
            );
            chips.hidden = chips.childElementCount === 0;
        }
        const active = this._hasActiveQueueFilter();
        const status = document.getElementById('dataset-queue-filter-status');
        if (status) status.hidden = !active;
        const count = document.getElementById('dataset-queue-filter-count');
        if (count) {
            count.textContent = this._t('dataset.queueFilterCount', 'Showing {shown} of {total}', {
                shown: formatCount(shownIds.length),
                total: formatCount(this.imageIds.length),
            });
        }
        this._renderCaptionScopeSummary();
    };

    // The images the queue shows right now (from its last render).
    DM._queueShownIdList = function () {
        return Array.isArray(this._queueShownIds) ? this._queueShownIds : this._queueIdsForCurrentFilter();
    };

    // Name the set a caption action changes, next to the scope select and in
    // the find/replace card (both act on _captionScopeIds).
    DM._renderCaptionScopeSummary = function () {
        const scope = this._captionScope?.() || 'all';
        let text;
        if (scope === 'active') {
            text = this._t('dataset.scopeSummaryActive', 'Changes the current image only.');
        } else if (scope === 'selected') {
            text = this._t('dataset.scopeSummarySelected', 'Changes {count} selected images.',
                { count: formatCount(this._queueSelection.size) });
        } else if (scope === 'filtered') {
            text = this._t('dataset.scopeSummaryFiltered', 'Changes the {count} images shown in the queue.',
                { count: formatCount(this._queueShownIdList().length) });
        } else {
            text = this._t('dataset.scopeSummaryAll', 'Changes all {count} images.',
                { count: formatCount(this.imageIds.length) });
        }
        for (const id of ['dataset-caption-scope-summary', 'dataset-findreplace-scope-summary']) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        }
    };

    // Suggest the queue's own tags, most frequent first, when the box opens.
    DM._fillQueueTagSuggestions = function () {
        const list = document.getElementById('dataset-queue-tag-options');
        if (!list) return;
        const counts = new Map();
        for (const id of this.imageIds || []) {
            for (const part of this._booruTextFor(id).split(',')) {
                const tag = part.trim();
                if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
            }
        }
        const options = Array.from(counts.entries())
            .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
            .slice(0, TAG_SUGGESTION_LIMIT)
            .map(([tag]) => {
                const option = document.createElement('option');
                option.value = tag;
                return option;
            });
        list.replaceChildren(...options);
    };

    DM._initQueueCaptionFilter = function () {
        const select = document.getElementById('dataset-queue-caption-filter');
        select?.addEventListener('change', () => {
            this._queueCaptionFilter = select.value || 'all';
            this._onQueueFilterChanged();
        });
        const input = document.getElementById('dataset-queue-tag-input');
        const addFromInput = (mode) => {
            if (!input) return;
            const tag = input.value.trim();
            if (tag) this._setQueueTagFilter(tag, mode);
            input.value = '';
            input.focus();
        };
        input?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addFromInput(event.shiftKey ? 'exclude' : 'include');
        });
        input?.addEventListener('focus', () => this._fillQueueTagSuggestions());
        document.getElementById('btn-dataset-queue-tag-include')
            ?.addEventListener('click', () => addFromInput('include'));
        document.getElementById('btn-dataset-queue-tag-exclude')
            ?.addEventListener('click', () => addFromInput('exclude'));
        document.getElementById('btn-dataset-queue-clear-filters')
            ?.addEventListener('click', () => this._clearQueueFilters());
        document.getElementById('dataset-caption-scope')
            ?.addEventListener('change', () => this._renderCaptionScopeSummary());
        document.addEventListener('languageChanged', () => {
            this._renderQueueFilterBar(this._queueShownIdList());
        });
    };
})();
