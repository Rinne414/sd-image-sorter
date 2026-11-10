/**
 * gallery/selection.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 1866-2064 (of 4,708): selection system (toggle/range/all/invert/clear/sync).
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _emitSelectionChanged(AppState) {
        const { getSelectedGalleryCount } = getGalleryAppContext();
        const detail = {
            selectionMode: Boolean(AppState.selectionMode),
            selectedCount: typeof getSelectedGalleryCount === 'function'
                ? getSelectedGalleryCount()
                : AppState.selectedIds.size,
            selectionScope: AppState.selectionScope || 'visible',
        };
        window.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
        document.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
    },

    _finalizeSelectionChange(AppState, updateSelectionUI) {
        this.syncSelectionState();
        if (updateSelectionUI) updateSelectionUI();
        this._emitSelectionChanged(AppState);
    },

    getVisibleGalleryIds() {
        // A stack tile stands for every picture of its run.
        return Array.from(document.querySelectorAll('#gallery-grid .gallery-item[data-id]'))
            .flatMap((item) => (item.dataset.runIds ? item.dataset.runIds.split(',') : [item.dataset.id]))
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id));
    },

    selectRange(startIndex, endIndex, { additive = false } = {}) {
        const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
        if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return;

        let lower = Math.max(0, Math.min(startIndex, endIndex));
        let upper = Math.min(AppState.images.length - 1, Math.max(startIndex, endIndex));
        if (this._widenRangeToStacks) [lower, upper] = this._widenRangeToStacks(lower, upper);
        updateSelectionState((selection) => {
            const nextIds = selectionBaseForScope(selection, 'loaded', { additive });
            for (let index = lower; index <= upper; index += 1) {
                const image = AppState.images[index];
                if (image?.id != null) {
                    nextIds.add(Number(image.id));
                }
            }
            selection.selectedIds = nextIds;
            selection.scope = 'loaded';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });
        this.lastSelectedIndex = endIndex;
        this._finalizeSelectionChange(AppState, updateSelectionUI);
    },

    handleSelectionInteraction(event, imageId, index) {
        const normalizedIndex = Number.isInteger(index) ? index : null;
        const additive = Boolean(event?.ctrlKey || event?.metaKey);

        if (event?.shiftKey && this.lastSelectedIndex !== null && normalizedIndex !== null) {
            this.selectRange(this.lastSelectedIndex, normalizedIndex, { additive });
            return;
        }

        this.toggleSelection(imageId);
        if (normalizedIndex !== null) {
            this.lastSelectedIndex = normalizedIndex;
        }
    },

    selectAllVisible() {
        const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
        const visibleIds = this.getVisibleGalleryIds();
        updateSelectionState((selection) => {
            const nextIds = selectionBaseForScope(selection, 'visible');
            visibleIds.forEach((imageId) => nextIds.add(imageId));
            selection.selectedIds = nextIds;
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });
        this._finalizeSelectionChange(AppState, updateSelectionUI);
    },

    invertVisibleSelection() {
        const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
        const visibleIds = this.getVisibleGalleryIds();
        updateSelectionState((selection) => {
            const nextIds = selectionBaseForScope(selection, 'visible');
            visibleIds.forEach((imageId) => {
                if (nextIds.has(imageId)) {
                    nextIds.delete(imageId);
                } else {
                    nextIds.add(imageId);
                }
            });
            selection.selectedIds = nextIds;
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });
        this._finalizeSelectionChange(AppState, updateSelectionUI);
    },

    clearSelection() {
        const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
        updateSelectionState((selection) => {
            selection.selectedIds = new Set();
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });
        this.lastSelectedIndex = null;
        this._finalizeSelectionChange(AppState, updateSelectionUI);
    },

    toggleSelection(imageId) {
        const { AppState, updateSelectionState, updateSelectionUI, showToast } = getGalleryAppContext();
        const normalizedImageId = Number.isFinite(Number(imageId)) ? Number(imageId) : imageId;

        const filteredTokenActive = AppState.selectionScope === 'filtered'
            && Boolean(AppState.selectionToken)
            && window.App?.isFilteredSelectionActiveForCurrentFilters?.();
        if (filteredTokenActive) {
            const currentlySelected = isGalleryImageSelected(AppState, normalizedImageId);
            const nextExcludedIds = new Set(AppState.selectedIds || []);
            if (currentlySelected) {
                nextExcludedIds.add(normalizedImageId);
            } else {
                nextExcludedIds.delete(normalizedImageId);
            }
            const updateExclusions = window.App?.updateFilteredSelectionExclusions;
            const translatedFailure = window.I18n?.t?.('selection.exclusionRefreshFailed');
            const failureMessage = translatedFailure
                && translatedFailure !== 'selection.exclusionRefreshFailed'
                ? translatedFailure
                : 'Could not update the filtered selection. The previous selection was restored.';
            if (typeof updateExclusions !== 'function') {
                showToast?.(`${failureMessage} Selection refresh is unavailable.`, 'error');
                return;
            }
            Promise.resolve(updateExclusions(nextExcludedIds)).catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                showToast?.(`${failureMessage} ${reason}`, 'error');
            });
            return;
        }

        const isNowSelected = !AppState.selectedIds.has(normalizedImageId);

        updateSelectionState((selection) => {
            // A range pick (Shift) is scope "loaded" and one click is "visible";
            // both hold the picked ids themselves. Toggling one picture after a
            // range used to start from an empty set (the scopes differed), so
            // five outlined pictures silently became a selection of one.
            const currentScope = selection?.scope || selection?.selectionScope || 'visible';
            const keepsIds = currentScope === 'visible' || currentScope === 'loaded';
            const nextIds = keepsIds ? new Set(selection?.selectedIds || []) : new Set();
            if (isNowSelected) {
                nextIds.add(normalizedImageId);
            } else {
                nextIds.delete(normalizedImageId);
            }
            selection.selectedIds = nextIds;
            selection.scope = currentScope === 'loaded' ? 'loaded' : 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });

        // Update DOM element if it exists in the current view. A stack tile
        // (Group runs) carries its first picture's id: it stays marked only
        // while every picture of its run is selected.
        const item = document.querySelector(`.gallery-item[data-id="${normalizedImageId}"]`);
        const runIds = item?.dataset.runIds ? item.dataset.runIds.split(',') : null;
        const tileSelected = runIds ? this._isTileSelected(AppState, normalizedImageId, runIds) : isNowSelected;
        if (item) {
            item.classList.toggle('selected', tileSelected);
            item.setAttribute('aria-selected', tileSelected ? 'true' : 'false');
        }

        // Update virtual list's rendered item directly if available
        if (this.useVirtualScroll && this.virtualList) {
            this.virtualList.toggleItemClass(normalizedImageId, 'selected', tileSelected);
        }

        // Also update legacy VirtualGallery if it's active
        if (window.VirtualGallery && window.VirtualGallery.initialized) {
            window.VirtualGallery.updateItemSelection(normalizedImageId, isNowSelected);
        }

        this._emitSelectionChanged(AppState);
        if (updateSelectionUI) updateSelectionUI();
    },

    /** A tile is selected when its picture is; a stack when every picture of its run is. */
    _isTileSelected(AppState, imageId, runIds) {
        return runIds && runIds.length
            ? runIds.every((id) => isGalleryImageSelected(AppState, id))
            : isGalleryImageSelected(AppState, imageId);
    },

    syncSelectionState() {
        const { AppState, updateSelectionUI } = getGalleryAppContext();
        document.querySelectorAll('.gallery-item').forEach((item) => {
            const runIds = item.dataset.runIds ? item.dataset.runIds.split(',') : null;
            const isSelected = this._isTileSelected(AppState, item.dataset.id, runIds);
            item.classList.toggle('selected', isSelected);
            item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        });

        if (updateSelectionUI) updateSelectionUI();
    },

    _setContextImageSelection(imageId, shouldSelect) {
        const app = window.App || {};
        const normalizedImageId = Number.isFinite(Number(imageId)) ? Number(imageId) : imageId;

        if (typeof app.setSelectionMode === 'function' && !app.AppState?.selectionMode) {
            app.setSelectionMode(true, { clearSelectionWhenDisabled: false });
        }

        if (typeof app.updateSelectionState !== 'function') {
            this.toggleSelection(normalizedImageId);
            return;
        }

        app.updateSelectionState((selection) => {
            const nextIds = selectionBaseForScope(selection, 'visible');
            if (shouldSelect) {
                nextIds.add(normalizedImageId);
            } else {
                nextIds.delete(normalizedImageId);
            }
            selection.selectionMode = true;
            selection.selectedIds = nextIds;
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });

        app.resetSelectionDataCache?.();
        this.syncSelectionState();
        app.emitSelectionStateChanged?.();
    },

});
