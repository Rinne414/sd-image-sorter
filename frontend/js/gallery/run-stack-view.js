/**
 * gallery/run-stack-view.js - the "Group runs" view of the classic gallery.
 *
 * Glue between gallery/run-groups.js (which pictures form a run) and the
 * gallery: the virtual list gets the grouped list while the switch is on and
 * the order is by time; Gallery.images stays the flat list, so preview
 * next/previous, selection and every batch action keep working on pictures.
 * A closed run shows as one stack tile with a count button that opens it in
 * place; selecting a stack selects every picture in it.
 *
 * Classic script: joins window.Gallery (gallery/base.js loads first).
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'sd-sorter:group-runs';
    // Runs are pictures next to each other in time: other orders stay flat.
    const TIME_SORTS = new Set(['newest', 'oldest']);

    function t(key, fallback, params) {
        const value = window.I18n?.t?.(key, params);
        return value && value !== key ? value : (window.I18n?.format?.(fallback, params) ?? fallback);
    }

    function readWanted() {
        try {
            return localStorage.getItem(STORAGE_KEY) === '1';
        } catch (_error) {
            return false;
        }
    }

    Object.assign(window.Gallery, {
        _openRunKeys: new Set(),
        // Bumped whenever a run opens or folds: the grouped list is cached on it.
        _openRunVersion: 0,
        _runDisplayCache: null,

        isRunGroupingWanted() {
            return readWanted();
        },

        /** Grouping applies now: the switch is on and the order is by time. */
        _runGroupingActive() {
            if (!window.GalleryRunGroups || !readWanted()) return false;
            const { AppState } = getGalleryAppContext();
            const sortBy = AppState?.filters?.sortBy || 'newest';
            return TIME_SORTS.has(sortBy);
        },

        /**
         * What the grid shows: the grouped list, or the flat list itself. The
         * gallery replaces Gallery.images with a new array on every load and
         * append, so the grouped list is reused until the array or an open run
         * changes (preview steps and anchor restores ask for it often).
         */
        _displayItems() {
            const images = this.images || [];
            if (!this._runGroupingActive()) return images;
            const cache = this._runDisplayCache;
            if (cache && cache.images === images && cache.length === images.length
                && cache.openVersion === this._openRunVersion) {
                return cache.items;
            }
            const items = window.GalleryRunGroups.groupRuns(images, { openKeys: this._openRunKeys });
            this._runDisplayCache = { images, length: images.length, openVersion: this._openRunVersion, items };
            return items;
        },

        _setRunOpen(key, open) {
            if (open) this._openRunKeys.add(key);
            else this._openRunKeys.delete(key);
            this._openRunVersion += 1;
            this._refreshDisplayItems();
        },

        /**
         * A closed stack is whole in a range selection: widen [lower, upper]
         * (places in Gallery.images) to every closed stack it touches.
         */
        _widenRangeToStacks(lower, upper) {
            if (!this._runGroupingActive()) return [lower, upper];
            let from = lower;
            let to = upper;
            this._displayItems().forEach((item) => {
                if (!item._stack) return;
                const start = item._flatIndex;
                const end = start + item._stack.size - 1;
                if (start <= upper && end >= lower) {
                    from = Math.min(from, start);
                    to = Math.max(to, end);
                }
            });
            return [from, to];
        },

        /** The grid position showing the picture at this place in the flat list. */
        _displayIndexForFlat(flatIndex) {
            if (!this._runGroupingActive()) return flatIndex;
            const items = this._displayItems();
            for (let index = items.length - 1; index >= 0; index -= 1) {
                if (items[index]._flatIndex <= flatIndex) return index;
            }
            return flatIndex;
        },

        /** Redraw the grid from the current list without reloading anything. */
        _refreshDisplayItems() {
            if (this.useVirtualScroll && this.virtualList) {
                this.virtualList.setItems(this._displayItems());
                this.syncSelectionState?.();
            }
        },

        setRunGrouping(on) {
            try {
                localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
            } catch (_error) {
                // Storage blocked: the switch still works until the page reloads.
            }
            this._openRunKeys.clear();
            this._openRunVersion += 1;
            this.syncRunGroupingButton();
            if (Array.isArray(this.images)) this.setImages(this.images);
        },

        syncRunGroupingButton() {
            const button = document.getElementById('btn-group-runs');
            if (!button) return;
            const wanted = readWanted();
            button.setAttribute('aria-pressed', wanted ? 'true' : 'false');
            button.classList.toggle('active', wanted);
            button.title = wanted && !this._runGroupingActive()
                ? t('gallery.groupRunsTimeOnly', 'Runs are grouped only when sorted by date')
                : t('gallery.groupRunsTitle', 'Show each generation run (same prompt, model and size, minutes apart) as one stack');
        },

        /** Stack tiles and the pictures of an open run get their marks here. */
        _decorateRunStack(item, image) {
            if (image._stack) {
                const { key, ids, size } = image._stack;
                item.classList.add('gallery-stack');
                item.dataset.runIds = ids.join(',');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'gallery-stack-open';
                button.textContent = `×${size}`;
                const label = t('gallery.stackOpen', '{count} pictures from one run: show them all', { count: size });
                button.title = label;
                button.setAttribute('aria-label', label);
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this._setRunOpen(key, true);
                });
                item.appendChild(button);
                return;
            }
            if (image._runMember) {
                const { key, position, size } = image._runMember;
                item.classList.add('gallery-run-member');
                if (position === 0) {
                    item.classList.add('gallery-run-first');
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'gallery-stack-open gallery-stack-close';
                    button.textContent = t('gallery.stackFold', 'Fold');
                    const label = t('gallery.stackClose', 'Fold the {count} pictures back into one stack', { count: size });
                    button.title = label;
                    button.setAttribute('aria-label', label);
                    button.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        this._setRunOpen(key, false);
                    });
                    item.appendChild(button);
                }
                if (position === size - 1) item.classList.add('gallery-run-last');
            }
        },

        /**
         * A click on a stack in selection mode. Shift selects the range from the
         * last pick (selectRange widens it to whole stacks); a plain click
         * toggles every picture of the run.
         */
        _handleStackSelection(event, ids, flatIndex) {
            const hasIndex = Number.isInteger(flatIndex);
            if (event?.shiftKey && this.lastSelectedIndex !== null && hasIndex) {
                this.selectRange(this.lastSelectedIndex, flatIndex, { additive: Boolean(event.ctrlKey || event.metaKey) });
                return;
            }
            this._toggleStackSelection(ids);
            if (hasIndex) this.lastSelectedIndex = flatIndex;
        },

        /** Select every picture of a stack, or clear them all when all were selected. */
        _toggleStackSelection(ids) {
            const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
            const allSelected = ids.every((id) => isGalleryImageSelected(AppState, id));
            const filteredTokenActive = AppState.selectionScope === 'filtered'
                && Boolean(AppState.selectionToken)
                && window.App?.isFilteredSelectionActiveForCurrentFilters?.();
            if (filteredTokenActive) {
                ids.forEach((id) => {
                    if (isGalleryImageSelected(AppState, id) === allSelected) this.toggleSelection(id);
                });
                return;
            }
            updateSelectionState((selection) => {
                const nextIds = selectionBaseForScope(selection, 'visible');
                ids.forEach((id) => (allSelected ? nextIds.delete(Number(id)) : nextIds.add(Number(id))));
                selection.selectedIds = nextIds;
                selection.scope = 'visible';
                selection.filterKey = null;
                selection.selectionToken = null;
                selection.selectionTotal = 0;
            });
            this._finalizeSelectionChange(AppState, updateSelectionUI);
        },
    });
})();

// The switch in the gallery's view options.
document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('btn-group-runs');
    if (!button) return;
    button.addEventListener('click', () => {
        window.Gallery.setRunGrouping(!window.Gallery.isRunGroupingWanted());
    });
    document.addEventListener('languageChanged', () => window.Gallery.syncRunGroupingButton());
    window.Gallery.syncRunGroupingButton();
});
