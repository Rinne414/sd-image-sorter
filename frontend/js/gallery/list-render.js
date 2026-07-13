/**
 * gallery/list-render.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 1510-1760 (of 4,708): setImages/appendImages/setViewMode/refresh/render.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    setImages(images) {
        this.images = images;
        this._cancelPendingWork();

        // Hide skeleton before rendering
        this.hideSkeleton();

        // Decide whether to use virtual scrolling
        const { AppState } = getGalleryAppContext();
        const shouldVirtual = this.shouldUseVirtualScroll(images.length, AppState.viewMode);
        const wantsWaterfall = AppState.viewMode === 'waterfall';
        const canReuseVirtual = Boolean(
            shouldVirtual &&
            this.virtualList &&
            (wantsWaterfall ? this._isWaterfallVirtualList() : !this._isWaterfallVirtualList())
        );

        if (canReuseVirtual) {
            this.useVirtualScroll = true;
            this.virtualList.setItems(images);
            this._scheduleVisibleLargeImageUpgrade();
            return;
        }

        if (shouldVirtual) {
            if (this.virtualList) {
                this.virtualList.destroy();
                this.virtualList = null;
            }
            const virtualList = this.initVirtualScroll(AppState.viewMode);
            if (!virtualList) {
                this.useVirtualScroll = false;
                this.render();
            }
            return;
        }

        this.useVirtualScroll = false;
        if (this.virtualList) {
            this.virtualList.destroy();
            this.virtualList = null;
        }
        this.render();
    },

    appendImages(newImages) {
        if (!newImages || newImages.length === 0) return;

        const { $, AppState } = getGalleryAppContext();
        const grid = $('#gallery-grid');
        if (!grid) return;

        const viewMode = AppState.viewMode;
        const isWaterfall = viewMode === 'waterfall';
        const startIndex = this.images.length;

        // Append to internal array
        this.images = [...this.images, ...newImages];

        const shouldVirtualNow = this.shouldUseVirtualScroll(this.images.length, AppState.viewMode);

        if (shouldVirtualNow && (!this.useVirtualScroll || !this.virtualList)) {
            if (this.lazyObserver) {
                this.lazyObserver.disconnect();
                this.lazyObserver = null;
            }
            const virtualList = this.initVirtualScroll(AppState.viewMode);
            if (!virtualList) {
                this.useVirtualScroll = false;
                this.render();
            }
            return;
        }

        // If using virtual scrolling, append to virtual list
        if (this.useVirtualScroll && this.virtualList) {
            this.virtualList.appendItems(newImages);
            return;
        }

        // Always create a fresh observer for appended images
        // The previous observer may have stale internal state
        if (!isWaterfall) {
            if (this.lazyObserver) {
                this.lazyObserver.disconnect();
            }
            this.lazyObserver = this._createLazyObserver();

            // Re-observe any existing items that still have data-src (not yet loaded)
            grid.querySelectorAll('.gallery-item').forEach(item => {
                const img = item.querySelector('img');
                if (img && img.dataset.src) {
                    this.lazyObserver.observe(item);
                }
            });
        }

        // Build new items in fragment
        const fragment = document.createDocumentFragment();
        const newItems = [];
        newImages.forEach((image, i) => {
            const index = startIndex + i;
            const item = this.createGalleryItem(image, index, viewMode);
            fragment.appendChild(item);
            if (!isWaterfall) newItems.push(item);
        });

        // Append to DOM FIRST, then observe — items must be in DOM
        grid.appendChild(fragment);

        if (this.lazyObserver && !isWaterfall) {
            newItems.forEach(item => this.lazyObserver.observe(item));
            // Fallback: force-load any already-visible images
            requestAnimationFrame(() => this._loadVisibleImages(newItems));
        } else {
            this._scheduleVisibleLargeImageUpgrade(newItems);
        }
    },

    /**
     * Set view mode and re-render
     * @param {string} mode - View mode ('grid', 'large', 'waterfall')
     */
    setViewMode(mode) {
        const nextMode = ['grid', 'large', 'waterfall'].includes(mode) ? mode : 'grid';
        const anchor = this.images.length > 0 ? this._captureViewAnchor() : null;
        const shouldVirtual = this.shouldUseVirtualScroll(this.images.length, nextMode);
        const canReuseStandardVirtual = Boolean(
            shouldVirtual &&
            this.virtualList &&
            !this._isWaterfallVirtualList() &&
            nextMode !== 'waterfall'
        );

        this._cancelPendingWork();

        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
            this.lazyObserver = null;
        }

        if (canReuseStandardVirtual && typeof this.virtualList.reconfigure === 'function') {
            const grid = document.getElementById('gallery-grid');
            const scrollContainer = this._getScrollContainer();
            if (grid && scrollContainer) {
                this.useVirtualScroll = true;
                this.virtualList.reconfigure(this._buildVirtualListOptions(grid, scrollContainer, nextMode));
                this._scheduleAnchorRestore(anchor);
                return;
            }
        }

        if (this.virtualList) {
            this.virtualList.destroy();
            this.virtualList = null;
        }

        if (shouldVirtual) {
            const virtualList = this.initVirtualScroll(nextMode);
            if (!virtualList) {
                this.useVirtualScroll = false;
                this.render();
            }
            this._scheduleAnchorRestore(anchor);
            return;
        }

        this.useVirtualScroll = false;
        this.render();
        this._scheduleAnchorRestore(anchor);
    },

    /**
     * Refresh the gallery (force re-render)
     */
    refresh() {
        if (this.useVirtualScroll && this.virtualList) {
            this.virtualList.refresh();
        } else {
            this.render();
        }
    },

    render() {
        const { $, AppState } = getGalleryAppContext();
        const grid = $('#gallery-grid');
        if (!grid) return;

        if (window.VirtualGallery?.initialized && typeof window.VirtualGallery.destroy === 'function') {
            window.VirtualGallery.destroy();
        }

        this._cancelPendingRender();
        this._cancelLargeUpgradeWork();

        grid.innerHTML = '';
        grid.classList.remove('virtual-scroll');
        grid.style.position = '';
        grid.style.display = '';
        grid.style.minHeight = '';
        grid.style.gridTemplateColumns = '';
        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
        }

        if (this.images.length === 0) {
            return;
        }

        const viewMode = AppState.viewMode;
        const isWaterfall = viewMode === 'waterfall';
        if (!isWaterfall) {
            this.lazyObserver = this._createLazyObserver();
        }

        const sessionId = ++this.renderSessionId;
        const initialCount = GALLERY_VIRTUAL_CONFIG.progressiveRender.initialCount[viewMode] || this.images.length;
        const batchCount = GALLERY_VIRTUAL_CONFIG.progressiveRender.batchCount[viewMode] || this.images.length;

        const appendBatch = (startIndex, maxCount) => {
            if (sessionId !== this.renderSessionId) return;

            const endIndex = Math.min(this.images.length, startIndex + maxCount);
            const fragment = document.createDocumentFragment();
            const createdItems = [];

            for (let index = startIndex; index < endIndex; index++) {
                const item = this.createGalleryItem(this.images[index], index, viewMode);
                fragment.appendChild(item);
                createdItems.push(item);
            }

            grid.appendChild(fragment);

            if (this.lazyObserver && !isWaterfall) {
                createdItems.forEach(item => this.lazyObserver.observe(item));
                requestAnimationFrame(() => this._loadVisibleImages(createdItems));
            } else {
                this._scheduleVisibleLargeImageUpgrade(createdItems);
            }

            if (endIndex < this.images.length) {
                this.pendingRenderFrame = requestAnimationFrame(() => appendBatch(endIndex, batchCount));
            } else {
                this.pendingRenderFrame = null;
            }
        };

        appendBatch(0, Math.min(initialCount, this.images.length));
    },

});
