/**
 * gallery/virtual-layout.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 689-1177 (of 4,708): scroll/viewport/anchor, large-image upgrade queue, thumb size, virtual decision, lazy load.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _getScrollContainer() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return null;

        let node = grid.parentElement;
        while (node) {
            const style = window.getComputedStyle(node);
            const canScroll = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4;
            if (canScroll) {
                return node;
            }
            node = node.parentElement;
        }

        return document.scrollingElement || document.documentElement;
    },

    _isViewportScrollContainer(scrollContainer = this._getScrollContainer()) {
        return Boolean(
            scrollContainer &&
            (
                scrollContainer === document.documentElement ||
                scrollContainer === document.body ||
                scrollContainer === document.scrollingElement
            )
        );
    },

    _getScrollViewportRect(scrollContainer = this._getScrollContainer()) {
        if (!scrollContainer) return null;

        if (this._isViewportScrollContainer(scrollContainer)) {
            return {
                top: 0,
                bottom: window.innerHeight,
                height: window.innerHeight,
            };
        }

        return scrollContainer.getBoundingClientRect();
    },

    _isWaterfallVirtualList(instance = this.virtualList) {
        return Boolean(instance && typeof window.WaterfallVirtualList !== 'undefined' && instance instanceof window.WaterfallVirtualList);
    },

    _cancelPendingRender() {
        this.renderSessionId += 1;
        if (this.pendingRenderFrame) {
            cancelAnimationFrame(this.pendingRenderFrame);
            this.pendingRenderFrame = null;
        }
    },

    _scheduleIdleTask(callback) {
        if (typeof window.requestIdleCallback === 'function') {
            return window.requestIdleCallback(callback, { timeout: 180 });
        }

        return window.setTimeout(() => callback({
            didTimeout: true,
            timeRemaining: () => 0
        }), 48);
    },

    _cancelIdleTask(taskId) {
        if (!taskId) return;

        if (typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(taskId);
            return;
        }

        clearTimeout(taskId);
    },

    _cancelLargeUpgradeWork() {
        this.largeUpgradeQueue.clear();
        if (this.largeUpgradeTaskId) {
            this._cancelIdleTask(this.largeUpgradeTaskId);
            this.largeUpgradeTaskId = null;
        }
    },

    _cancelPendingWork() {
        this._cancelPendingRender();
        this._cancelLargeUpgradeWork();
    },

    _getThumbnailSources(imageId, viewMode) {
        const { API } = getGalleryAppContext();
        const getUrl = (size) => API?.getThumbnailUrl?.(imageId, size) ?? `/api/image-thumbnail/${imageId}?size=${size}`;

        if (viewMode === 'large') {
            return {
                initialUrl: getUrl(GALLERY_VIRTUAL_CONFIG.largeThumb.initialSize),
                finalUrl: getUrl(GALLERY_VIRTUAL_CONFIG.largeThumb.finalSize)
            };
        }

        const size = viewMode === 'waterfall' ? 384 : 256;
        return {
            initialUrl: getUrl(size),
            finalUrl: null
        };
    },

    _queueLargeImageUpgrade(img) {
        const { AppState } = getGalleryAppContext();
        if (
            !img ||
            !img.isConnected ||
            AppState.viewMode !== 'large' ||
            !img.dataset.highresSrc ||
            img.dataset.src
        ) {
            return;
        }

        this.largeUpgradeQueue.add(img);

        if (!this.largeUpgradeTaskId) {
            this.largeUpgradeTaskId = this._scheduleIdleTask((deadline) => this._flushLargeImageUpgradeQueue(deadline));
        }
    },

    _flushLargeImageUpgradeQueue(deadline) {
        const { AppState } = getGalleryAppContext();
        this.largeUpgradeTaskId = null;

        if (AppState.viewMode !== 'large') {
            this.largeUpgradeQueue.clear();
            return;
        }

        let processed = 0;
        while (
            this.largeUpgradeQueue.size > 0 &&
            processed < 4 &&
            (deadline?.didTimeout || (typeof deadline?.timeRemaining === 'function' ? deadline.timeRemaining() > 2 : true))
        ) {
            const nextImg = this.largeUpgradeQueue.values().next().value;
            this.largeUpgradeQueue.delete(nextImg);
            processed += 1;

            if (!nextImg?.isConnected || !nextImg.dataset.highresSrc) {
                continue;
            }

            const highResSrc = nextImg.dataset.highresSrc;
            const preload = new Image();
            preload.decoding = 'async';
            preload.onload = () => {
                const { AppState: currentState } = getGalleryAppContext();
                if (!nextImg.isConnected || currentState.viewMode !== 'large') return;
                nextImg.src = highResSrc;
                nextImg.dataset.upgraded = 'true';
                delete nextImg.dataset.highresSrc;
            };
            preload.onerror = () => { /* keep the medium thumbnail */ };
            preload.src = highResSrc;
        }

        if (this.largeUpgradeQueue.size > 0) {
            this.largeUpgradeTaskId = this._scheduleIdleTask((nextDeadline) => this._flushLargeImageUpgradeQueue(nextDeadline));
        }
    },

    _scheduleVisibleLargeImageUpgrade(items = null) {
        const { AppState } = getGalleryAppContext();
        if (AppState.viewMode !== 'large') return;

        const scrollContainer = this._getScrollContainer();
        if (!scrollContainer) return;

        const scrollRect = this._getScrollViewportRect(scrollContainer);
        if (!scrollRect) return;
        const margin = GALLERY_VIRTUAL_CONFIG.largeThumb.visibleMargin;
        const candidates = items && items.length > 0
            ? items
            : Array.from(document.querySelectorAll('#gallery-grid .gallery-item'));

        candidates.forEach((item) => {
            const target = item instanceof HTMLElement ? item : item?.closest?.('.gallery-item');
            const img = target?.querySelector?.('img');
            if (!target || !img || !img.dataset.highresSrc) return;

            const rect = target.getBoundingClientRect();
            if (rect.top < scrollRect.bottom + margin && rect.bottom > scrollRect.top - margin) {
                this._queueLargeImageUpgrade(img);
            }
        });
    },

    _handleRenderedLargeItems(items) {
        if (!items || items.length === 0) return;
        requestAnimationFrame(() => this._scheduleVisibleLargeImageUpgrade(items));
    },

    _resetGridLayoutState() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;

        grid.classList.remove('virtual-scroll');
        grid.style.position = '';
        grid.style.display = '';
        grid.style.minHeight = '';
        grid.style.gridTemplateColumns = '';
        grid.style.height = '';

        grid.querySelectorAll('.gallery-item').forEach((item) => {
            item.style.position = '';
            item.style.top = '';
            item.style.left = '';
            item.style.width = '';
            item.style.height = '';
            item.style.aspectRatio = '';
        });
    },

    _findImageIndexById(imageId) {
        return this.images.findIndex((image) => String(image.id) === String(imageId));
    },

    _captureViewAnchor() {
        const grid = document.getElementById('gallery-grid');
        const scrollContainer = this._getScrollContainer();
        if (!grid || !scrollContainer) return null;

        const scrollRect = this._getScrollViewportRect(scrollContainer);
        if (!scrollRect) return null;
        const visibleItems = Array.from(grid.querySelectorAll('.gallery-item'));
        if (visibleItems.length === 0) return null;

        let anchorItem = visibleItems[0];
        let bestDistance = Number.POSITIVE_INFINITY;

        visibleItems.forEach((item) => {
            const rect = item.getBoundingClientRect();
            const intersectsViewport = rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
            if (!intersectsViewport) return;

            const distance = Math.abs(rect.top - scrollRect.top);
            if (distance < bestDistance) {
                bestDistance = distance;
                anchorItem = item;
            }
        });

        if (!anchorItem?.dataset?.id) return null;

        return {
            imageId: anchorItem.dataset.id,
            offset: anchorItem.getBoundingClientRect().top - scrollRect.top
        };
    },

    _restoreViewAnchor(anchor) {
        if (!anchor?.imageId) return false;

        const grid = document.getElementById('gallery-grid');
        const scrollContainer = this._getScrollContainer();
        if (!grid || !scrollContainer) return false;
        const isViewportScroll = this._isViewportScrollContainer(scrollContainer);

        const targetIndex = this._findImageIndexById(anchor.imageId);
        if (targetIndex < 0) return false;

        const currentPageTop = window.pageYOffset || document.documentElement.scrollTop || 0;
        const gridOffsetTop = isViewportScroll
            ? currentPageTop + grid.getBoundingClientRect().top
            : grid.offsetTop;
        const applyScroll = (itemTop) => {
            const nextScrollTop = Math.max(0, gridOffsetTop + itemTop - anchor.offset);
            if (isViewportScroll) {
                window.scrollTo(0, nextScrollTop);
            } else {
                scrollContainer.scrollTop = nextScrollTop;
            }
        };

        if (this.useVirtualScroll && this.virtualList) {
            const layout = this.virtualList.getLayoutForIndex?.(targetIndex) || this.virtualList.getLayoutForKey?.(anchor.imageId);
            if (!layout) return false;
            applyScroll(layout.top);
            return true;
        }

        const targetItem = Array.from(grid.querySelectorAll('.gallery-item'))
            .find((item) => item.dataset.id === String(anchor.imageId));

        if (!targetItem) return false;

        applyScroll(targetItem.offsetTop);
        return true;
    },

    _scheduleAnchorRestore(anchor) {
        if (!anchor) return;

        const token = ++this.anchorRestoreToken;
        const attemptRestore = (remaining) => {
            if (token !== this.anchorRestoreToken) return;

            const restored = this._restoreViewAnchor(anchor);
            if (!restored && remaining > 0) {
                requestAnimationFrame(() => attemptRestore(remaining - 1));
                return;
            }

            if (restored) {
                this._scheduleVisibleLargeImageUpgrade();
            }
        };

        requestAnimationFrame(() => requestAnimationFrame(() => attemptRestore(8)));
    },

    /**
     * Owner FB-3: current thumbnail size in px (120–400). Defaults to the
     * grid baseline (200) so nothing changes until the user moves the slider.
     */
    getThumbnailSizePx() {
        if (this._thumbnailSizePx == null) {
            let saved = NaN;
            try {
                saved = parseInt(localStorage.getItem('sd-sorter:grid-size'), 10);
            } catch (e) { /* storage blocked: fall back to default */ }
            this._thumbnailSizePx = Number.isFinite(saved)
                ? Math.max(120, Math.min(400, saved))
                : GALLERY_VIRTUAL_CONFIG.minColumnWidth.grid;
        }
        return this._thumbnailSizePx;
    },

    /**
     * Per-mode min column width derived from the shared thumbnail size.
     * large/waterfall keep their identity by scaling their default ratio to
     * the grid baseline (at the default 200px this returns exactly the
     * GALLERY_VIRTUAL_CONFIG values — zero change for slider non-users).
     */
    _effectiveMinColumnWidth(viewMode) {
        const base = this.getThumbnailSizePx();
        const scale = base / GALLERY_VIRTUAL_CONFIG.minColumnWidth.grid;
        if (viewMode === 'waterfall') {
            return Math.round(GALLERY_VIRTUAL_CONFIG.waterfall.columnWidth * scale);
        }
        if (viewMode === 'large') {
            return Math.round(GALLERY_VIRTUAL_CONFIG.minColumnWidth.large * scale);
        }
        return base;
    },

    /**
     * Live entry point for the toolbar slider / [ ] shortcuts (app.js
     * updateGridSize). Persisting the px value stays with the caller; this
     * updates layout state and reflows the active virtual list in place.
     */
    setThumbnailSize(px) {
        const parsed = Number(px);
        if (!Number.isFinite(parsed)) return;
        this._thumbnailSizePx = Math.max(120, Math.min(400, parsed));
        if (this.virtualList) {
            const { AppState } = getGalleryAppContext();
            this.virtualList.updateConfig({
                minColumnWidth: this._effectiveMinColumnWidth(AppState.viewMode),
            });
        }
    },

    _buildVirtualListOptions(grid, scrollContainer, viewMode) {
        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';
        const minColumnWidth = this._effectiveMinColumnWidth(isWaterfall ? 'waterfall' : (isLarge ? 'large' : 'grid'));

        const options = {
            container: grid,
            scrollContainer,
            renderItem: (index, image) => this.createVirtualGalleryItem(index, image, viewMode),
            getItemKey: (index, image) => image.id || index,
            onItemsRendered: (elements) => this._handleRenderedLargeItems(elements),
            config: {
                bufferSize: GALLERY_VIRTUAL_CONFIG.bufferSize,
                threshold: GALLERY_VIRTUAL_CONFIG.threshold,
                forceVirtual: isWaterfall || isLarge,
                estimatedItemHeight: isLarge ? 420 : GALLERY_VIRTUAL_CONFIG.estimatedItemHeight,
                itemAspectRatio: isLarge ? GALLERY_VIRTUAL_CONFIG.aspectRatio.large : GALLERY_VIRTUAL_CONFIG.aspectRatio.grid,
                rowGap: GALLERY_VIRTUAL_CONFIG.rowGap,
                columnGap: GALLERY_VIRTUAL_CONFIG.columnGap,
                minColumnWidth,
            }
        };

        if (isWaterfall) {
            options.columnWidth = minColumnWidth;
            options.minHeight = GALLERY_VIRTUAL_CONFIG.waterfall.minHeight;
            options.maxHeight = GALLERY_VIRTUAL_CONFIG.waterfall.maxHeight;
            options.estimatedHeight = GALLERY_VIRTUAL_CONFIG.waterfall.estimatedHeight;
        }

        return options;
    },

    /**
     * Check if virtual scrolling should be enabled
     * @param {number} imageCount - Number of images
     * @returns {boolean}
     */
    shouldUseVirtualScroll(imageCount, viewMode = null) {
        const resolvedViewMode = viewMode || getGalleryAppContext().AppState.viewMode;

        if (resolvedViewMode === 'waterfall') {
            return imageCount > 0 && typeof window.WaterfallVirtualList !== 'undefined';
        }

        if (resolvedViewMode === 'large') {
            return imageCount > 0 && typeof window.VirtualList !== 'undefined';
        }

        if (typeof window.VirtualList === 'undefined') {
            return false;
        }

        return imageCount >= GALLERY_VIRTUAL_CONFIG.threshold;
    },

    /**
     * Create a shared IntersectionObserver for lazy-loading images
     * @returns {IntersectionObserver}
     */
    _createLazyObserver() {
        return new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this._loadImage(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '600px', threshold: 0 });  // 增加 300px → 600px
    },

    /**
     * Load a single image by swapping data-src to src
     * @param {HTMLElement} item - Gallery item element
     */
    _loadImage(item) {
        const { AppState } = getGalleryAppContext();
        const img = item.querySelector('img');
        if (img && img.dataset.src) {
            img.onerror = () => {
                img.src = 'data:image/svg+xml,' + encodeURIComponent(`
                    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
                        <rect fill="#1e293b" width="200" height="200"/>
                        <text fill="#64748b" font-family="sans-serif" font-size="14" x="100" y="100" text-anchor="middle">Not found</text>
                    </svg>
                `);
            };
            img.src = img.dataset.src;
            delete img.dataset.src;

            if (AppState.viewMode === 'large') {
                this._queueLargeImageUpgrade(img);
            }
        }
    },

    /**
     * Fallback: force-load images that are currently visible but not yet loaded.
     * Handles edge cases where IntersectionObserver misses items.
     * @param {HTMLElement[]} items - Items to check
     */
    _loadVisibleImages(items) {
        if (!items || items.length === 0) return;
        const viewportHeight = window.innerHeight;
        const margin = 300;

        items.forEach(item => {
            const rect = item.getBoundingClientRect();
            if (rect.top < viewportHeight + margin && rect.bottom > -margin) {
                this._loadImage(item);
                if (this.lazyObserver) {
                    try { this.lazyObserver.unobserve(item); } catch (_e) { /* already unobserved */ }
                }
            }
        });

        this._scheduleVisibleLargeImageUpgrade(items);
    },

});
