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
        return Array.from(document.querySelectorAll('#gallery-grid .gallery-item[data-id]'))
            .map((item) => Number(item.dataset.id))
            .filter((id) => Number.isFinite(id));
    },

    selectRange(startIndex, endIndex, { additive = false } = {}) {
        const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
        if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return;

        const lower = Math.max(0, Math.min(startIndex, endIndex));
        const upper = Math.min(AppState.images.length - 1, Math.max(startIndex, endIndex));
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
        const { AppState, updateSelectionState, updateSelectionUI } = getGalleryAppContext();
        const normalizedImageId = Number.isFinite(Number(imageId)) ? Number(imageId) : imageId;

        const isNowSelected = !AppState.selectedIds.has(normalizedImageId);

        updateSelectionState((selection) => {
            const nextIds = selectionBaseForScope(selection, 'visible');
            if (isNowSelected) {
                nextIds.add(normalizedImageId);
            } else {
                nextIds.delete(normalizedImageId);
            }
            selection.selectedIds = nextIds;
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        });

        // Update DOM element if it exists in the current view
        const item = document.querySelector(`.gallery-item[data-id="${normalizedImageId}"]`);
        if (item) {
            item.classList.toggle('selected', isNowSelected);
            item.setAttribute('aria-selected', isNowSelected ? 'true' : 'false');
        }

        // Update virtual list's rendered item directly if available
        if (this.useVirtualScroll && this.virtualList) {
            this.virtualList.toggleItemClass(normalizedImageId, 'selected', isNowSelected);
        }

        // Also update legacy VirtualGallery if it's active
        if (window.VirtualGallery && window.VirtualGallery.initialized) {
            window.VirtualGallery.updateItemSelection(normalizedImageId, isNowSelected);
        }

        this._emitSelectionChanged(AppState);
        if (updateSelectionUI) updateSelectionUI();
    },

    syncSelectionState() {
        const { AppState, updateSelectionUI } = getGalleryAppContext();
        document.querySelectorAll('.gallery-item').forEach((item) => {
            const imageId = item.dataset.id;
            const isSelected = isGalleryImageSelected(AppState, imageId);
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
