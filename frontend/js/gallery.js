/**
 * SD Image Sorter - Gallery Module
 * Handles image grid display, preview modal, multi-selection and drag-and-drop
 * Supports virtual scrolling for large image collections (500+ images)
 */

function getGalleryAppContext() {
    const app = window.App || {};
    return {
        $: app.$ || ((selector) => document.querySelector(selector)),
        API: app.API || window.API,
        AppState: app.AppState || {
            images: [],
            filters: {},
            selectedIds: new Set(),
            selectionMode: false,
            viewMode: 'grid'
        },
        updateSelectionUI: app.updateSelectionUI || window.updateSelectionUI,
        showModal: app.showModal || window.showModal,
        formatSize: app.formatSize || window.formatSize,
        showToast: app.showToast || window.showToast
    };
}

function getRequiredGalleryAPI() {
    const { API } = getGalleryAppContext();
    if (!API) {
        throw new Error('App API is not ready yet');
    }
    return API;
}

/**
 * Gallery Virtual Scrolling Configuration
 */
const GALLERY_VIRTUAL_CONFIG = {
    bufferSize: 10,           // Items to render outside viewport
    threshold: 96,            // Minimum items to enable virtual scrolling
    estimatedItemHeight: 200, // Estimated height for grid mode
    rowGap: 16,               // Gap between rows
    columnGap: 16,            // Gap between columns
    aspectRatio: {
        grid: 1,
        large: 0.84
    },
    progressiveRender: {
        initialCount: {
            grid: 24,
            large: 10
        },
        batchCount: {
            grid: 36,
            large: 12
        }
    },
    largeThumb: {
        initialSize: 384,
        finalSize: 512,
        visibleMargin: 320
    },
    minColumnWidth: {
        grid: 200,
        large: 340,
        waterfall: 280
    },
    waterfall: {
        columnWidth: 280,
        minHeight: 180,
        maxHeight: 600,
        estimatedHeight: 350
    }
};

const DEFAULT_GENERATOR_COLORS = {
    comfyui: '#22c55e',
    nai: '#f97316',
    webui: '#3b82f6',
    forge: '#8b5cf6',
    unknown: '#64748b'
};

const Gallery = {
    images: [],
    loading: false,
    lazyObserver: null,
    currentPreviewIndex: -1,
    currentPreviewRequestId: 0,
    showAllTags: false,

    // Virtual scrolling state
    virtualList: null,
    useVirtualScroll: false,
    pendingRenderFrame: null,
    renderSessionId: 0,
    largeUpgradeQueue: new Set(),
    largeUpgradeTaskId: null,
    anchorRestoreToken: 0,

    /**
     * Get generator color map (uses global override if available)
     * @returns {Object} Generator color mapping
     */
    _getGenColors() {
        return window.GENERATOR_COLORS || DEFAULT_GENERATOR_COLORS;
    },

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

    _buildVirtualListOptions(grid, scrollContainer, viewMode) {
        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';
        const minColumnWidth = isWaterfall
            ? GALLERY_VIRTUAL_CONFIG.waterfall.columnWidth
            : (isLarge ? GALLERY_VIRTUAL_CONFIG.minColumnWidth.large : GALLERY_VIRTUAL_CONFIG.minColumnWidth.grid);

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
            options.columnWidth = GALLERY_VIRTUAL_CONFIG.waterfall.columnWidth;
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
        }, { rootMargin: '300px', threshold: 0 });
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

    _formatLargeCardRating(image) {
        const rating = String(image?.rating || '').trim().toLowerCase();
        return ['general', 'sensitive', 'questionable', 'explicit'].includes(rating)
            ? rating
            : 'unrated';
    },

    _formatLargeCardAspect(image) {
        const width = Number(image?.width || 0);
        const height = Number(image?.height || 0);
        if (!width || !height) return 'Unknown ratio';
        if (width === height) return 'Square';
        return width > height ? 'Landscape' : 'Portrait';
    },

    _truncateLargeCardPrompt(prompt, maxLength = 140) {
        const normalized = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return 'No prompt metadata';
        }

        return normalized.length > maxLength
            ? `${normalized.slice(0, maxLength - 1).trim()}...`
            : normalized;
    },

    _buildGalleryItemMarkup(image, viewMode, initialUrl, finalUrl, generatorColor, immediateLoad = false) {
        const safeFilename = (image.filename || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';
        const imgAttributes = immediateLoad
            ? `src="${initialUrl}" loading="lazy" decoding="async"`
            : `data-src="${initialUrl}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" decoding="async"`;
        const highResAttr = finalUrl ? ` data-highres-src="${finalUrl}"` : '';

        if (!isLarge) {
            const imageTag = isWaterfall
                ? `<img src="${initialUrl}" alt="${safeFilename}" loading="lazy" decoding="async"${highResAttr}>`
                : `<img ${imgAttributes} alt="${safeFilename}"${highResAttr}>`;

            return `
                ${imageTag}
                <div class="gallery-item-overlay" aria-hidden="true">
                    <span class="gallery-item-generator" style="background: ${generatorColor}">
                        ${this._escapeHtml(image.generator)}
                    </span>
                </div>
            `;
        }

        const rating = this._formatLargeCardRating(image);
        const ratingLabel = rating === 'unrated' ? 'Unrated' : rating.charAt(0).toUpperCase() + rating.slice(1);
        const checkpoint = String(image?.checkpoint || '').trim() || 'No checkpoint';
        const sizeLabel = image.width && image.height ? `${image.width}x${image.height}` : 'Unknown size';
        const aspectLabel = this._formatLargeCardAspect(image);
        const promptPreview = this._truncateLargeCardPrompt(image.prompt);

        return `
            <div class="gallery-item-media">
                <img ${imgAttributes} alt="${safeFilename}"${highResAttr}>
            </div>
            <div class="gallery-item-large-meta">
                <div class="gallery-item-large-top">
                    <span class="gallery-item-generator" style="background: ${generatorColor}">
                        ${this._escapeHtml(image.generator)}
                    </span>
                    <span class="gallery-item-rating rating-${rating}">
                        ${this._escapeHtml(ratingLabel)}
                    </span>
                </div>
                <div class="gallery-item-title" title="${safeFilename}">
                    ${safeFilename}
                </div>
                <div class="gallery-item-subline">
                    <span>${this._escapeHtml(sizeLabel)}</span>
                    <span>${this._escapeHtml(aspectLabel)}</span>
                </div>
                <div class="gallery-item-checkpoint" title="${this._escapeHtml(checkpoint)}">
                    ${this._escapeHtml(checkpoint)}
                </div>
                <div class="gallery-item-prompt" title="${this._escapeHtml(promptPreview)}">
                    ${this._escapeHtml(promptPreview)}
                </div>
            </div>
        `;
    },

    /**
     * Initialize virtual scrolling if needed
     * @param {string} viewMode - Current view mode ('grid', 'large', 'waterfall')
     */
    initVirtualScroll(viewMode) {
        const { $ } = getGalleryAppContext();
        const grid = $('#gallery-grid');
        if (!grid) return null;

        if (window.VirtualGallery?.initialized && typeof window.VirtualGallery.destroy === 'function') {
            window.VirtualGallery.destroy();
        }

        const scrollContainer = this._getScrollContainer();
        if (!scrollContainer) return null;

        this._cancelPendingRender();
        this._cancelLargeUpgradeWork();
        this._resetGridLayoutState();

        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
            this.lazyObserver = null;
        }

        // Cleanup existing virtual list
        if (this.virtualList) {
            this.virtualList.destroy();
            this.virtualList = null;
        }

        const isWaterfall = viewMode === 'waterfall';
        const VirtualListClass = isWaterfall ? window.WaterfallVirtualList : window.VirtualList;
        if (!VirtualListClass) return null;

        try {
            const options = this._buildVirtualListOptions(grid, scrollContainer, viewMode);
            this.virtualList = new VirtualListClass(options);
            this.virtualList.init(this.images);
            this.useVirtualScroll = true;
            this._scheduleVisibleLargeImageUpgrade();

            return this.virtualList;
        } catch (error) {
            if (window.Logger) window.Logger.warn('Gallery: Failed to initialize virtual scrolling, falling back to standard rendering:', error);
            this.useVirtualScroll = false;
            return null;
        }
    },

    /**
     * Create a gallery item for virtual scrolling (without lazy loading)
     * @param {number} index - Item index
     * @param {Object} image - Image data
     * @param {string} viewMode - Current view mode
     * @returns {HTMLElement}
     */
    createVirtualGalleryItem(index, image, viewMode) {
        const { AppState } = getGalleryAppContext();
        const genColors = this._getGenColors();

        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';
        const { initialUrl, finalUrl } = this._getThumbnailSources(image.id, viewMode);

        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (isWaterfall) {
            item.classList.add('waterfall-item');
        }
        if (isLarge) {
            item.classList.add('large-card');
        }
        if (AppState.selectedIds.has(image.id)) {
            item.classList.add('selected');
        }
        item.dataset.id = image.id;
        item.dataset.index = index;
        item.draggable = true;
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'gridcell');
        item.setAttribute('aria-label', `${image.filename || 'Image'} - ${image.generator || 'Unknown generator'}`);
        item.setAttribute('aria-selected', AppState.selectedIds.has(image.id) ? 'true' : 'false');

        item.innerHTML = this._buildGalleryItemMarkup(
            image,
            viewMode,
            initialUrl,
            finalUrl,
            genColors[image.generator] || genColors.unknown,
            true
        );

        // Add event listeners
        item.addEventListener('click', () => {
            if (AppState.selectionMode) {
                this.toggleSelection(image.id);
            } else {
                this.openPreview(image.id);
            }
        });

        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (AppState.selectionMode) {
                    this.toggleSelection(image.id);
                } else {
                    this.openPreview(image.id);
                }
            }
        });

        item.addEventListener('dragstart', (e) => {
            const API = getRequiredGalleryAPI();
            const imgUrl = API?.getImageUrl?.(image.id) ?? `/api/image-file/${image.id}`;
            const absoluteUrl = new URL(imgUrl, window.location.origin).href;
            e.dataTransfer.setData('text/uri-list', absoluteUrl);
            e.dataTransfer.setData('text/plain', absoluteUrl);
            const mimeType = image.filename.toLowerCase().endsWith('.png') ? 'image/png' :
                image.filename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
            e.dataTransfer.setData('DownloadURL', `${mimeType}:${image.filename}:${absoluteUrl}`);
            const img = item.querySelector('img');
            if (img && img.src) {
                e.dataTransfer.setDragImage(img, 50, 50);
            }
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'copyMove';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });

        return item;
    },

    /**
     * Show skeleton gallery while loading
     * @param {string} viewMode - 'grid', 'large', or 'waterfall'
     */
    showSkeleton(viewMode = 'grid') {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;

        // Hide existing content
        grid.innerHTML = '';

        // Use SkeletonGallery if available
        if (window.SkeletonGallery) {
            window.SkeletonGallery.show(viewMode);
        } else {
            // Fallback: create simple skeleton items
            const count = viewMode === 'large' ? 12 : 20;
            for (let i = 0; i < count; i++) {
                const item = document.createElement('div');
                item.className = 'skeleton-gallery-item skeleton-item';
                item.innerHTML = '<div class="skeleton-image"></div>';
                grid.appendChild(item);
            }
        }
    },

    /**
     * Hide skeleton gallery
     */
    hideSkeleton() {
        if (window.SkeletonGallery) {
            window.SkeletonGallery.hide();
        }
        // Remove any skeleton items directly in grid
        const grid = document.getElementById('gallery-grid');
        if (grid) {
            grid.querySelectorAll('.skeleton-gallery-item').forEach(el => el.remove());
            grid.querySelectorAll('.skeleton-item').forEach(el => el.remove());
        }
    },

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
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 60px; color: var(--text-secondary);">
                    <div style="font-size: 48px; margin-bottom: 16px;">📷</div>
                    <p>No images found. Click "Scan Folder" to add images.</p>
                </div>
            `;
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

    createGalleryItem(image, index, viewMode = null) {
        const { AppState } = getGalleryAppContext();
        const genColors = this._getGenColors();
        const resolvedViewMode = viewMode || AppState.viewMode;
        const isWaterfall = resolvedViewMode === 'waterfall';
        const isLarge = resolvedViewMode === 'large';
        const { initialUrl, finalUrl } = this._getThumbnailSources(image.id, resolvedViewMode);

        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (isWaterfall) {
            item.classList.add('waterfall-item');
        }
        if (isLarge) {
            item.classList.add('large-card');
        }
        if (AppState.selectedIds.has(image.id)) {
            item.classList.add('selected');
        }
        item.dataset.id = image.id;
        item.dataset.index = index;
        item.draggable = true;

        // Accessibility: make item focusable and add ARIA attributes
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'gridcell');
        item.setAttribute('aria-label', `${image.filename || 'Image'} - ${image.generator || 'Unknown generator'}`);
        item.setAttribute('aria-selected', AppState.selectedIds.has(image.id) ? 'true' : 'false');
        item.innerHTML = this._buildGalleryItemMarkup(
            image,
            resolvedViewMode,
            initialUrl,
            finalUrl,
            genColors[image.generator] || genColors.unknown,
            false
        );

        item.addEventListener('click', () => {
            if (AppState.selectionMode) {
                this.toggleSelection(image.id);
            } else {
                this.openPreview(image.id);
            }
        });

        // Keyboard navigation: Enter/Space to open preview or toggle selection
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (AppState.selectionMode) {
                    this.toggleSelection(image.id);
                } else {
                    this.openPreview(image.id);
                }
            }
        });

        item.addEventListener('dragstart', (e) => {
            const API = getRequiredGalleryAPI();
            const imgUrl = API?.getImageUrl?.(image.id) ?? `/api/image-file/${image.id}`;
            const absoluteUrl = new URL(imgUrl, window.location.origin).href;
            e.dataTransfer.setData('text/uri-list', absoluteUrl);
            e.dataTransfer.setData('text/plain', absoluteUrl);
            const mimeType = image.filename.toLowerCase().endsWith('.png') ? 'image/png' :
                image.filename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
            e.dataTransfer.setData('DownloadURL', `${mimeType}:${image.filename}:${absoluteUrl}`);
            const img = item.querySelector('img');
            if (img && img.src) {
                e.dataTransfer.setDragImage(img, 50, 50);
            }
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'copyMove';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });

        return item;
    },

    toggleSelection(imageId) {
        const { $, AppState, updateSelectionUI } = getGalleryAppContext();

        const isNowSelected = !AppState.selectedIds.has(imageId);

        if (isNowSelected) {
            AppState.selectedIds.add(imageId);
        } else {
            AppState.selectedIds.delete(imageId);
        }

        // Update DOM element if it exists in the current view
        const item = document.querySelector(`.gallery-item[data-id="${imageId}"]`);
        if (item) {
            item.classList.toggle('selected', isNowSelected);
            item.setAttribute('aria-selected', isNowSelected ? 'true' : 'false');
        }

        // Update virtual list's rendered item directly if available
        if (this.useVirtualScroll && this.virtualList) {
            this.virtualList.toggleItemClass(imageId, 'selected', isNowSelected);
        }

        // Also update legacy VirtualGallery if it's active
        if (window.VirtualGallery && window.VirtualGallery.initialized) {
            window.VirtualGallery.updateItemSelection(imageId, isNowSelected);
        }

        if (updateSelectionUI) updateSelectionUI();
    },

    syncSelectionState() {
        const { AppState, updateSelectionUI } = getGalleryAppContext();
        document.querySelectorAll('.gallery-item').forEach((item) => {
            const imageId = item.dataset.id;
            const isSelected = AppState.selectedIds.has(Number(imageId)) || AppState.selectedIds.has(imageId);
            item.classList.toggle('selected', isSelected);
            item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        });

        if (updateSelectionUI) updateSelectionUI();
    },

    /**
     * Extract parsed metadata from image, with JS fallback for old images.
     * Returns { generation_params, is_img2img, img2img_info, character_prompts, prompt_nodes }
     */
    _extractParsedData(image) {
        // Try to get _parsed from metadata_json
        let metaObj = null;
        if (image.metadata_json) {
            try {
                metaObj = typeof image.metadata_json === 'string'
                    ? JSON.parse(image.metadata_json)
                    : image.metadata_json;
            } catch (_) {
                metaObj = null;
            }
        }

        if (metaObj && metaObj._parsed) {
            return metaObj._parsed;
        }

        // Fallback: try to extract from raw metadata for old images
        return this._fallbackParseMeta(metaObj, image);
    },

    /**
     * Fallback parser for metadata (stub - should be implemented based on project needs)
     */
    _fallbackParseMeta(metaObj, image) {
        // Basic fallback - return empty parsed data
        return {
            generation_params: {},
            is_img2img: false,
            img2img_info: {},
            character_prompts: [],
            prompt_nodes: []
        };
    },

    _t(key, params, fallback) {
        if (window.I18n && typeof window.I18n.t === 'function') {
            const translated = window.I18n.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return fallback || key;
    },

    _getModalPromptView() {
        return this._modalPromptView || null;
    },

    _getPromptViewText() {
        const view = this._getModalPromptView();
        if (!view) {
            return {
                promptText: this._lastModalImage?.prompt || '',
                negativeText: this._lastModalImage?.negative_prompt || '',
                formatLabel: 'Original',
                isConverted: false,
                sourceFormat: this._detectPromptFormat(this._lastModalImage, this._lastParsedData),
                targetFormat: 'original',
                characterPrompts: [],
            };
        }
        return view;
    },

    _detectPromptFormat(image, parsedData) {
        const generator = String(image?.generator || '').toLowerCase();
        const combinedPrompt = [image?.prompt, image?.negative_prompt].filter(Boolean).join('\n');
        if (generator.includes('novel') || generator.includes('nai')) return 'nai';
        if (generator.includes('webui') || generator.includes('forge') || generator.includes('comfy')) return 'sd';
        if (parsedData?.character_prompts?.length) return 'nai';
        if (parsedData?.prompt_nodes?.length) return 'sd';
        if (/\b\d*\.?\d+\s*::/.test(combinedPrompt)) return 'nai';
        if (/[{][^{}]+[}]|\[[^\[\]]+\]/.test(combinedPrompt)) return 'nai';
        if (/<lora:[^>]+>/i.test(combinedPrompt)) return 'sd';
        if (/\((?:[^()\\]|\\.)+:\s*-?\d*\.?\d+\)/.test(combinedPrompt)) return 'sd';
        return 'unknown';
    },

    _normalizeCharacterPrompt(characterPrompt, index) {
        if (!characterPrompt) return null;

        const prompt = String(characterPrompt.prompt || '').trim();
        if (!prompt) return null;

        return {
            index: characterPrompt.index ?? index,
            prompt,
            negative_prompt: String(characterPrompt.negative_prompt || '').trim(),
            center: characterPrompt.center || null,
        };
    },

    _dedupePromptTokens(tokens) {
        const seen = new Set();
        const result = [];

        (tokens || []).forEach((token) => {
            const cleaned = String(token || '').trim();
            if (!cleaned) return;

            const normalized = cleaned.toLowerCase();
            if (seen.has(normalized)) return;

            seen.add(normalized);
            result.push(cleaned);
        });

        return result;
    },

    _collectPromptTextsFromNodes(parsedData, role) {
        if (!Array.isArray(parsedData?.prompt_nodes)) return [];

        return parsedData.prompt_nodes
            .filter((node) => {
                const nodeRole = String(node?.role || '').toLowerCase();
                return role === 'negative'
                    ? nodeRole.includes('negative')
                    : !nodeRole.includes('negative');
            })
            .map(node => String(node?.text || '').trim())
            .filter(Boolean);
    },

    _mergePromptSegments(segments) {
        const seen = new Set();
        const cleaned = [];

        (segments || []).forEach((segment) => {
            const text = String(segment || '').trim();
            if (!text) return;

            const normalized = text.toLowerCase();
            if (seen.has(normalized)) return;

            seen.add(normalized);
            cleaned.push(text);
        });

        return cleaned.join(', ');
    },

    _getPromptSourceBundle(image, parsedData) {
        const characterPrompts = Array.isArray(parsedData?.character_prompts)
            ? parsedData.character_prompts.map((entry, index) => this._normalizeCharacterPrompt(entry, index)).filter(Boolean)
            : [];
        const positiveSources = [image?.prompt];
        const negativeSources = [image?.negative_prompt];

        if (!String(image?.prompt || '').trim()) {
            positiveSources.push(...this._collectPromptTextsFromNodes(parsedData, 'positive'));
        }

        if (!String(image?.negative_prompt || '').trim()) {
            negativeSources.push(...this._collectPromptTextsFromNodes(parsedData, 'negative'));
        }

        if (characterPrompts.length > 0) {
            positiveSources.push(...characterPrompts.map(entry => entry.prompt));
            negativeSources.push(...characterPrompts.map(entry => entry.negative_prompt));
        }

        return {
            promptText: this._mergePromptSegments(positiveSources),
            negativeText: this._mergePromptSegments(negativeSources),
            characterPrompts,
        };
    },

    _formatPromptWeight(weight) {
        const numeric = Number(weight);
        if (!Number.isFinite(numeric)) return '';

        return (Math.round(numeric * 1000) / 1000)
            .toFixed(3)
            .replace(/0+$/, '')
            .replace(/\.$/, '');
    },

    _convertBracketRuns(text, openChar, closeChar, multiplier, transform) {
        const escapedOpen = openChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedClose = closeChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(${escapedOpen}+)([^${escapedOpen}${escapedClose}]+?)(${escapedClose}+)`, 'g');

        return String(text || '').replace(pattern, (match, openRun, content, closeRun) => {
            const trimmedContent = String(content || '').trim();
            if (!trimmedContent || openRun.length !== closeRun.length) {
                return match;
            }

            return transform(trimmedContent, Math.pow(multiplier, openRun.length), match);
        });
    },

    _convertNaiPromptTextToSd(text) {
        if (!text) return '';

        let converted = String(text);

        converted = converted.replace(/(^|[,\n]\s*|\s)(\d*\.?\d+)::\s*([\s\S]*?)\s*::(?=,|$|\n)/g, (match, prefix, weight, content) => {
            const trimmedContent = String(content || '').trim();
            const formattedWeight = this._formatPromptWeight(weight);
            if (!trimmedContent || !formattedWeight) return match;
            return `${prefix}(${trimmedContent}:${formattedWeight})`;
        });

        converted = this._convertBracketRuns(converted, '{', '}', 1.05, (content, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `(${content}:${formattedWeight})` : content;
        });

        converted = this._convertBracketRuns(converted, '[', ']', 1 / 1.05, (content, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `(${content}:${formattedWeight})` : content;
        });

        return converted.replace(/\s{2,}/g, ' ').trim();
    },

    _convertSdPromptTextToNai(text) {
        if (!text) return '';

        let converted = String(text);

        converted = converted.replace(/<lora:([^:>]+):([^>]+)>/gi, (match, name, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            const trimmedName = String(name || '').trim();
            if (!trimmedName || !formattedWeight) return trimmedName || match;
            return `${formattedWeight}::${trimmedName}::`;
        });

        converted = converted.replace(/\(([^()]*?):\s*(-?\d*\.?\d+)\)/g, (match, content, weight) => {
            const trimmedContent = String(content || '').trim();
            const formattedWeight = this._formatPromptWeight(weight);
            if (!trimmedContent || !formattedWeight) return match;
            return `${formattedWeight}::${trimmedContent}::`;
        });

        converted = this._convertBracketRuns(converted, '(', ')', 1.1, (content, weight, originalMatch) => {
            if (/:\s*-?\d*\.?\d+\s*$/.test(content)) {
                return originalMatch;
            }

            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `${formattedWeight}::${content}::` : content;
        });

        converted = this._convertBracketRuns(converted, '[', ']', 1 / 1.1, (content, weight) => {
            const formattedWeight = this._formatPromptWeight(weight);
            return formattedWeight ? `${formattedWeight}::${content}::` : content;
        });

        return converted.replace(/\s{2,}/g, ' ').trim();
    },

    _convertPromptBundle(image, parsedData, targetFormat) {
        const sourceBundle = this._getPromptSourceBundle(image, parsedData);
        const sourceFormat = this._detectPromptFormat(image, parsedData);

        if (targetFormat === 'sd') {
            return {
                promptText: sourceFormat === 'nai'
                    ? this._convertNaiPromptTextToSd(sourceBundle.promptText)
                    : sourceBundle.promptText,
                negativeText: sourceFormat === 'nai'
                    ? this._convertNaiPromptTextToSd(sourceBundle.negativeText)
                    : sourceBundle.negativeText,
            };
        }

        if (targetFormat === 'nai') {
            return {
                promptText: sourceFormat === 'sd'
                    ? this._convertSdPromptTextToNai(sourceBundle.promptText)
                    : sourceBundle.promptText,
                negativeText: sourceFormat === 'sd'
                    ? this._convertSdPromptTextToNai(sourceBundle.negativeText)
                    : sourceBundle.negativeText,
            };
        }

        return {
            promptText: sourceBundle.promptText,
            negativeText: sourceBundle.negativeText,
        };
    },

    _buildPromptView(image, parsedData, targetFormat = 'original') {
        const sourceBundle = this._getPromptSourceBundle(image, parsedData);
        const promptText = sourceBundle.promptText;
        const negativeText = sourceBundle.negativeText;
        const sourceFormat = this._detectPromptFormat(image, parsedData);
        const normalizedTarget = ['original', 'sd', 'nai'].includes(targetFormat) ? targetFormat : 'original';
        const characterPrompts = sourceBundle.characterPrompts;

        if (normalizedTarget === 'original') {
            return {
                promptText,
                negativeText,
                formatLabel: 'Original',
                headerKey: 'modal.promptOriginal',
                sourceFormat,
                targetFormat: 'original',
                isConverted: false,
                characterPrompts,
            };
        }

        if (normalizedTarget === 'sd') {
            const converted = this._convertPromptBundle(image, parsedData, 'sd');

            return {
                promptText: converted.promptText || promptText,
                negativeText: converted.negativeText || negativeText,
                formatLabel: 'SD',
                headerKey: 'modal.promptSD',
                sourceFormat,
                targetFormat: 'sd',
                isConverted: sourceFormat !== 'sd',
                characterPrompts,
            };
        }

        const converted = this._convertPromptBundle(image, parsedData, 'nai');

        return {
            promptText: converted.promptText || promptText,
            negativeText: converted.negativeText || negativeText,
            formatLabel: 'NAI',
            headerKey: 'modal.promptNAI',
            sourceFormat,
            targetFormat: 'nai',
            isConverted: sourceFormat !== 'nai',
            characterPrompts,
        };
    },

    _buildConvertedPromptView(image, parsedData, targetFormat) {
        return this._buildPromptView(image, parsedData, targetFormat);
    },

    _getAlternatePromptTarget(sourceFormat) {
        if (sourceFormat === 'nai') return 'sd';
        if (sourceFormat === 'sd') return 'nai';
        return null;
    },

    _normalizeMetadataKey(key) {
        return String(key || '')
            .replace(/[\s_-]/g, '')
            .toLowerCase();
    },

    _getMetadataObject(image) {
        if (!image?.metadata_json) return {};

        try {
            const metadata = typeof image.metadata_json === 'string'
                ? JSON.parse(image.metadata_json)
                : image.metadata_json;
            return metadata && typeof metadata === 'object' ? metadata : {};
        } catch (_) {
            return {};
        }
    },

    _parseEmbeddedJson(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value;
        }

        if (typeof value !== 'string') return null;

        let text = value.trim();
        if (!text) return null;

        if (text.startsWith('ASCII') || text.startsWith('UNICODE')) {
            text = text.slice(7).trim();
        }

        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
            text = text.slice(jsonStart, jsonEnd + 1);
        }

        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    },

    _extractCommentData(image) {
        const metadata = this._getMetadataObject(image);
        return this._parseEmbeddedJson(metadata.Comment)
            || this._parseEmbeddedJson(metadata.UserComment)
            || null;
    },

    _findMetadataValue(sources, aliases) {
        const normalizedAliases = aliases.map(alias => this._normalizeMetadataKey(alias));

        for (const source of sources) {
            if (!source || typeof source !== 'object') continue;

            for (const alias of aliases) {
                if (Object.prototype.hasOwnProperty.call(source, alias) && source[alias] != null && source[alias] !== '') {
                    return source[alias];
                }
            }

            for (const [key, value] of Object.entries(source)) {
                if (value == null || value === '') continue;
                if (normalizedAliases.includes(this._normalizeMetadataKey(key))) {
                    return value;
                }
            }
        }

        return null;
    },

    _formatMetadataValue(value) {
        if (value == null) return '';

        if (Array.isArray(value)) {
            return value
                .map(item => this._formatMetadataValue(item))
                .filter(Boolean)
                .join(', ');
        }

        if (typeof value === 'number') {
            return Number.isInteger(value)
                ? String(value)
                : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
        }

        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }

        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (_) {
                return String(value);
            }
        }

        return String(value).trim();
    },

    _extractRawParameterText(image) {
        const metadata = this._getMetadataObject(image);
        const rawValue = this._findMetadataValue(
            [metadata],
            ['parameters', 'Parameters', 'ImageDescription']
        );

        if (typeof rawValue !== 'string') return '';

        const start = rawValue.search(/(?:^|\n)\s*Steps\s*:/i);
        if (start === -1) return '';

        return rawValue
            .slice(start)
            .replace(/\s*\n\s*/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    },

    _summarizeWorkflowValue(value, image, parsedData) {
        const generator = String(image?.generator || '').toLowerCase();
        const workflowFallback = generator.includes('comfy')
            ? (parsedData?.is_img2img ? 'ComfyUI img2img workflow' : 'ComfyUI workflow')
            : '';

        if (value == null || value === '') {
            return workflowFallback;
        }

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) {
                return workflowFallback;
            }

            if (/^\s*[\[{]/.test(trimmed)) {
                return workflowFallback;
            }

            if (/txt2img/i.test(trimmed)) return 'txt2img';
            if (/img2img/i.test(trimmed)) return 'img2img';
            if (/inpaint/i.test(trimmed)) return 'inpaint';
            if (trimmed.length > 80) {
                return workflowFallback || trimmed.slice(0, 80).trim() + '...';
            }

            return trimmed;
        }

        if (typeof value === 'object') {
            return workflowFallback;
        }

        return workflowFallback || String(value);
    },

    _buildGenerationParamEntries(image, parsedData) {
        const params = parsedData?.generation_params || {};
        const metadata = this._getMetadataObject(image);
        const commentData = this._extractCommentData(image);
        const imageExtras = {
            checkpoint: image?.checkpoint || null,
        };
        const sources = [params, commentData, imageExtras, metadata];
        const entries = [];
        const usedKeys = new Set();

        const pushEntry = (label, aliases) => {
            const aliasList = Array.isArray(aliases) ? aliases : [aliases];
            const rawValue = this._findMetadataValue(sources, aliasList);
            if (rawValue == null || rawValue === '') return;

            const displayValue = this._formatMetadataValue(rawValue);
            if (!displayValue) return;

            entries.push({ label, value: displayValue });
            aliasList.forEach(alias => usedKeys.add(this._normalizeMetadataKey(alias)));
        };

        pushEntry('Steps', ['steps']);
        pushEntry('CFG scale', ['cfg_scale', 'cfg', 'scale']);
        pushEntry('Sampler', ['sampler', 'sampler_name']);
        pushEntry('Scheduler', ['scheduler', 'noise_schedule', 'schedule_type']);
        pushEntry('Seed', ['seed', 'noise_seed']);
        pushEntry(parsedData?.is_img2img ? 'Denoising strength' : 'Denoise', ['denoising_strength', 'denoise', 'strength']);
        pushEntry('Noise', ['noise']);
        const workflowSummary = this._summarizeWorkflowValue(
            this._findMetadataValue([params, commentData], ['workflow', 'request_type']),
            image,
            parsedData
        );
        if (workflowSummary) {
            entries.push({ label: 'Workflow', value: workflowSummary });
            ['workflow', 'request_type'].forEach(alias => usedKeys.add(this._normalizeMetadataKey(alias)));
        }
        pushEntry('Size', ['size', 'resolution']);
        pushEntry('Input', ['input']);
        pushEntry('Output', ['output']);
        pushEntry('Priority', ['priority']);
        pushEntry('Quantity', ['quantity', 'n_samples']);
        pushEntry('Ecosystem', ['ecosystem']);
        pushEntry('Created Date', ['Created Date', 'created_date', 'createdDate', 'generation_time', 'Generation time']);
        pushEntry('Output Format', ['outputFormat', 'output_format']);
        pushEntry('Enhanced Compatibility', ['enhancedCompatibility', 'enhanced_compatibility']);
        pushEntry('Clip skip', ['clip_skip', 'clipSkip']);
        pushEntry('Model', ['model', 'checkpoint']);
        pushEntry('Model Hash', ['model_hash']);
        pushEntry('Hires Upscaler', ['hires_upscaler']);
        pushEntry('Hires Scale', ['hires_upscale']);
        pushEntry('Hires Steps', ['hires_steps']);
        pushEntry('SMEA', ['sm']);
        pushEntry('SMEA Dyn', ['sm_dyn']);
        pushEntry('CFG Rescale', ['cfg_rescale']);
        pushEntry('UC Preset', ['uc_preset', 'ucPreset']);
        pushEntry('Quality Toggle', ['quality_toggle', 'qualityToggle']);
        pushEntry('Dynamic Thresholding', ['dynamic_thresholding']);
        pushEntry('Uncond Scale', ['uncond_scale']);
        pushEntry('Skip CFG σ', ['skip_cfg_above_sigma']);
        pushEntry('Use Coords', ['use_coords']);
        pushEntry('Use Order', ['use_order']);

        Object.entries(params).forEach(([key, value]) => {
            const normalizedKey = this._normalizeMetadataKey(key);
            if (usedKeys.has(normalizedKey) || value == null || value === '') {
                return;
            }

            const label = key
                .replace(/_/g, ' ')
                .replace(/\b\w/g, char => char.toUpperCase());
            const displayValue = this._formatMetadataValue(value);
            if (!displayValue) return;

            entries.push({ label, value: displayValue });
        });

        return entries;
    },

    _applyModalPromptView(promptView) {
        const promptText = document.querySelector('#modal-prompt-text');
        const negSection = document.querySelector('#modal-negative-section');
        const negText = document.querySelector('#modal-negative-text');
        const promptHeader = document.querySelector('.modal-prompt h4');
        const toggleBtn = document.querySelector('#btn-toggle-prompt-format');
        const alternateTarget = this._getAlternatePromptTarget(promptView.sourceFormat);

        if (promptText) {
            promptText.textContent = promptView.promptText || this._t('modal.noPrompt', null, 'No prompt');
        }
        if (negText) {
            negText.textContent = promptView.negativeText || '-';
        }
        if (negSection) {
            negSection.style.display = promptView.negativeText ? '' : 'none';
        }
        if (promptHeader) {
            const fallbackLabel = promptView.targetFormat === 'original'
                ? 'Prompt (Original format)'
                : `Prompt (${promptView.formatLabel} format)`;
            promptHeader.textContent = this._t(promptView.headerKey || 'modal.prompt', null, fallbackLabel);
        }
        if (toggleBtn) {
            const hasPrompt = !!(promptView.promptText || promptView.negativeText || (promptView.characterPrompts && promptView.characterPrompts.length));
            toggleBtn.disabled = !hasPrompt || (promptView.targetFormat === 'original' && !alternateTarget);
            if (!hasPrompt) {
                toggleBtn.textContent = this._t('modal.noPrompt', null, 'No prompt');
            } else if (promptView.targetFormat === 'original') {
                if (alternateTarget === 'sd') {
                    toggleBtn.textContent = this._t('modal.viewAsSD', null, 'View as SD format');
                } else if (alternateTarget === 'nai') {
                    toggleBtn.textContent = this._t('modal.viewAsNAI', null, 'View as NAI format');
                } else {
                    toggleBtn.textContent = this._t('modal.promptOriginal', null, 'Original format');
                }
            } else {
                toggleBtn.textContent = this._t('modal.viewOriginal', null, 'View original format');
            }
            toggleBtn.title = toggleBtn.textContent;
            toggleBtn.setAttribute('aria-label', toggleBtn.textContent);
        }
        this._modalPromptView = promptView;
    },

    _togglePromptFormat() {
        const view = this._getModalPromptView();
        if (!view || !this._lastModalImage || !this._lastParsedData) return;

        const alternateTarget = this._getAlternatePromptTarget(view.sourceFormat);
        const nextFormat = view.targetFormat === 'original'
            ? alternateTarget
            : 'original';

        if (!nextFormat) return;
        this._applyModalPromptView(this._buildPromptView(this._lastModalImage, this._lastParsedData, nextFormat));
    },

    _renderModalSections(image, parsedData) {
        const $ = (s) => document.querySelector(s);
        // escapeHtml is now available globally from modules/utils/escape.js

        // --- Checkpoint ---
        const cpItem = $('#modal-checkpoint-item');
        const cpText = $('#modal-checkpoint');
        if (image.checkpoint) {
            cpItem.style.display = '';
            cpText.textContent = image.checkpoint;
        } else {
            cpItem.style.display = 'none';
        }

        // --- img2img Badge ---
        const img2imgBadge = $('#modal-img2img-badge');
        if (parsedData.is_img2img) {
            img2imgBadge.style.display = '';
        } else {
            img2imgBadge.style.display = 'none';
        }

        // --- Key Generation Parameters (always visible bar) ---
        const keyParamsBar = $('#modal-key-params');
        const gp = parsedData.generation_params || {};
        const keyParamMap = {
            'kp-steps': gp.steps,
            'kp-sampler': gp.sampler || gp.sampler_name,
            'kp-scheduler': gp.scheduler || gp.noise_schedule || gp.schedule_type,
            'kp-cfg': gp.cfg_scale ?? gp.cfg ?? gp.scale,
            'kp-seed': gp.seed,
            'kp-denoise': gp.denoise ?? gp.denoising_strength ?? gp.strength,
        };
        let hasAnyKeyParam = false;
        for (const [elemId, val] of Object.entries(keyParamMap)) {
            const el = $(`#${elemId}`);
            if (el) {
                if (val != null && val !== '') {
                    el.style.display = '';
                    const valSpan = el.querySelector('span');
                    if (valSpan) {
                        valSpan.textContent = typeof val === 'number'
                            ? (Number.isInteger(val) ? val : val.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))
                            : String(val);
                    }
                    hasAnyKeyParam = true;
                } else {
                    el.style.display = 'none';
                }
            }
        }
        keyParamsBar.style.display = hasAnyKeyParam ? '' : 'none';

        // --- LoRAs ---
        const lorasSection = $('#modal-loras-section');
        const lorasList = $('#modal-loras-list');
        let loras = [];
        if (image.loras) {
            try {
                loras = typeof image.loras === 'string' ? JSON.parse(image.loras) : image.loras;
            } catch (_) { /* ignore */ }
        }
        if (Array.isArray(loras) && loras.length > 0) {
            lorasSection.style.display = '';
            lorasList.innerHTML = loras.map(l => `<span class="lora-pill">${window.escapeHtml(l)}</span>`).join('');
        } else {
            lorasSection.style.display = 'none';
            lorasList.innerHTML = '';
        }

        // --- Negative Prompt ---
        const negSection = $('#modal-negative-section');
        const negText = $('#modal-negative-text');
        if (image.negative_prompt) {
            negSection.style.display = '';
            negText.textContent = image.negative_prompt;
            negText.style.display = '';
        } else {
            negSection.style.display = 'none';
        }

        // --- Character Prompts (NAI V4) ---
        const charsSection = $('#modal-characters-section');
        const charsList = $('#modal-characters-list');
        if (parsedData.character_prompts && parsedData.character_prompts.length > 0) {
            const characterLabel = window.escapeHtml(this._t('modal.character', null, 'Character'));
            const negLabel = window.escapeHtml(this._t('modal.negativeShort', null, 'Neg'));
            charsSection.style.display = '';
            charsList.innerHTML = parsedData.character_prompts.map((c, i) => {
                const centerStr = c.center ? ` (${c.center.x?.toFixed?.(2) || c.center.x}, ${c.center.y?.toFixed?.(2) || c.center.y})` : '';
                const negHtml = c.negative_prompt
                    ? `<div class="char-negative"><strong>${negLabel}:</strong> ${window.escapeHtml(c.negative_prompt)}</div>`
                    : '';
                return `
                    <div class="character-card">
                        <div class="character-card-header">${characterLabel} ${c.index != null ? c.index + 1 : i + 1}${centerStr}</div>
                        <div>${window.escapeHtml(c.prompt)}</div>
                        ${negHtml}
                    </div>
                `;
            }).join('');
        } else {
            charsSection.style.display = 'none';
            charsList.innerHTML = '';
        }

        // --- Generation Parameters ---
        const paramsSection = $('#modal-params-section');
        const paramsGrid = $('#modal-params-grid');
        const paramEntries = this._buildGenerationParamEntries(image, parsedData);
        if (paramEntries.length > 0) {
            paramsSection.style.display = '';
            paramsGrid.innerHTML = paramEntries.map(({ label, value }) => `
                <div class="param-item">
                    <span class="param-label">${window.escapeHtml(label)}</span>
                    <span class="param-value">${window.escapeHtml(value)}</span>
                </div>
            `).join('');
            paramsGrid.style.display = '';
        } else {
            paramsSection.style.display = 'none';
            paramsGrid.innerHTML = '';
        }

        // --- img2img Details ---
        const img2imgSection = $('#modal-img2img-section');
        const img2imgInfo = $('#modal-img2img-info');
        if (parsedData.is_img2img && parsedData.img2img_info && Object.keys(parsedData.img2img_info).length > 0) {
            img2imgSection.style.display = '';
            img2imgInfo.innerHTML = Object.entries(parsedData.img2img_info).map(([key, val]) => {
                const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                return `<div class="param-item"><span class="param-label">${window.escapeHtml(label)}</span><span class="param-value">${window.escapeHtml(String(val))}</span></div>`;
            }).join('');
        } else {
            img2imgSection.style.display = 'none';
            img2imgInfo.innerHTML = '';
        }

        // --- ComfyUI Node Breakdown ---
        const nodesSection = $('#modal-nodes-section');
        const nodesList = $('#modal-nodes-list');
        if (parsedData.prompt_nodes && parsedData.prompt_nodes.length > 0) {
            nodesSection.style.display = '';
            nodesList.innerHTML = parsedData.prompt_nodes.map(node => {
                const roleClass = (node.role || '').toLowerCase().includes('negative') ? 'negative' : 'positive';
                const roleLabel = node.role || 'unknown';
                const nodeTitle = node.node_id ? `Node #${node.node_id}` : (node.class_type || 'Node');
                return `
                    <div class="prompt-node-item">
                        <div class="prompt-node-header">
                            <span>${window.escapeHtml(nodeTitle)}</span>
                            <span class="node-role ${roleClass}">${window.escapeHtml(roleLabel)}</span>
                        </div>
                        <div class="prompt-node-text">${window.escapeHtml(node.text || '')}</div>
                    </div>
                `;
            }).join('');
            nodesList.style.display = '';
        } else {
            nodesSection.style.display = 'none';
            nodesList.innerHTML = '';
        }
    },

    /**
     * Initialize collapsible section toggle handlers (called once).
     */
    _initSectionToggles() {
        if (this._togglesInitialized) return;
        this._togglesInitialized = true;

        document.addEventListener('click', (e) => {
            const toggle = e.target.closest('.section-toggle');
            if (!toggle) return;

            const targetId = toggle.dataset.target;
            if (!targetId) return;

            const target = document.getElementById(targetId);
            if (!target) return;

            const icon = toggle.querySelector('.collapse-icon');
            const isCollapsed = target.style.display === 'none';

            if (isCollapsed) {
                target.style.display = '';
                if (icon) icon.textContent = '▼';
                toggle.classList.remove('section-collapsed');
            } else {
                target.style.display = 'none';
                if (icon) icon.textContent = '▶';
                toggle.classList.add('section-collapsed');
            }
        });
    },

    _escapeHtml(value) {
        // Delegate to global escapeHtml from modules/utils/escape.js
        return window.escapeHtml(value);
    },

    _renderModalTags(tags = []) {
        const tagsList = document.querySelector('#modal-tags-list');
        if (!tagsList) return;

        if (tags.length === 0) {
            tagsList.textContent = this._t('modal.noTags', null, 'No tags. Run WD14 tagger first.');
            tagsList.style.color = 'var(--text-muted)';
            return;
        }
        tagsList.style.color = '';

        const ratingTags = ['general', 'sensitive', 'questionable', 'explicit'];
        const ratings = tags.filter(t => ratingTags.includes(t.tag));
        const otherTags = tags.filter(t => !ratingTags.includes(t.tag));
        const visibleTags = this.showAllTags ? otherTags : otherTags.slice(0, 40);

        let html = '';
        if (ratings.length > 0) {
            const rating = ratings.reduce((a, b) => a.confidence > b.confidence ? a : b);
            const ratingColors = {
                general: '#22c55e',
                sensitive: '#eab308',
                questionable: '#f97316',
                explicit: '#ef4444'
            };
            html += `<span class="tag" style="background: ${ratingColors[rating.tag]}; color: white; font-weight: 600;">${this._escapeHtml(rating.tag)}</span>`;
        }

        html += visibleTags.map(t => `<span class="tag">${this._escapeHtml(t.tag)}</span>`).join('');
        tagsList.innerHTML = html;

        const toggleBtn = document.querySelector('#btn-toggle-all-tags');
        if (toggleBtn) {
            toggleBtn.style.display = otherTags.length > 40 ? '' : 'none';
            toggleBtn.textContent = this.showAllTags
                ? this._t('modal.showLess', null, 'Show Less')
                : this._t('modal.showMore', null, 'Show More');
        }
    },

    _serializeGenerationParams(image, parsedData) {
        const rawParamText = this._extractRawParameterText(image);
        if (rawParamText) {
            return rawParamText;
        }

        return this._buildGenerationParamEntries(image, parsedData)
            .map(({ label, value }) => `${label}: ${value}`)
            .join(', ');
    },

    _buildCopyAllText(image, parsedData, tags, promptView = null) {
        const loras = (() => {
            try {
                if (!image?.loras) return [];
                return typeof image.loras === 'string' ? JSON.parse(image.loras) : image.loras;
            } catch (_) {
                return [];
            }
        })();
        const currentPromptView = promptView || this._getModalPromptView() || this._buildConvertedPromptView(image, parsedData, 'original');
        const promptText = String(currentPromptView?.promptText ?? image?.prompt ?? '').trim();
        const negativeText = String(currentPromptView?.negativeText ?? image?.negative_prompt ?? '').trim();
        const paramsText = this._serializeGenerationParams(image, parsedData);

        const civitaiParts = [];
        if (promptText) civitaiParts.push(promptText);
        if (negativeText) civitaiParts.push(`Negative prompt: ${negativeText}`);
        if (paramsText) civitaiParts.push(paramsText);
        if (civitaiParts.length > 0) {
            return civitaiParts.join('\n');
        }

        const sections = [
            ['Filename', image?.filename],
            ['Generator', image?.generator],
            ['Size', image?.width && image?.height ? `${image.width}x${image.height}` : null],
            ['Prompt', currentPromptView?.promptText ?? image?.prompt],
            ['Negative', currentPromptView?.negativeText ?? image?.negative_prompt],
            ['Checkpoint', image?.checkpoint],
            ['LoRAs', loras.length ? loras.join(', ') : null],
            ['Tags', tags?.length ? tags.map(tag => tag.tag).join(', ') : null],
            ['Params', paramsText],
        ];

        return sections
            .filter(([, value]) => value != null && value !== '' && value !== 'undefined')
            .map(([label, value]) => `${label}:
${String(value)}`)
            .join('\n\n');
    },

    async openPreview(imageId) {
        const { $, showModal, formatSize, showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();

        this._initSectionToggles();
        const summaryImage = this.images.find(image => image.id === imageId) || window.App?.AppState?.images?.find(image => image.id === imageId);
        this.currentPreviewIndex = this.images.findIndex(image => image.id === imageId);
        this.currentPreviewRequestId += 1;
        const requestId = this.currentPreviewRequestId;
        this.showAllTags = false;
        this._lastModalImage = null;
        this._lastModalTags = [];
        this._lastParsedData = null;

        // Show skeleton modal content while loading
        if (window.SkeletonModal) {
            window.SkeletonModal.showImageModal('image-modal');
        }

        $('#modal-image').src = API?.getImageUrl?.(imageId) ?? `/api/image-file/${imageId}`;
        // When image loads, hide the skeleton
        $('#modal-image').onload = () => {
            if (window.SkeletonModal) {
                window.SkeletonModal.hideImageModal('image-modal');
            }
        };
        $('#modal-filename').textContent = summaryImage?.filename || `Image #${imageId}`;
        $('#modal-generator').textContent = (summaryImage?.generator || '-').toUpperCase();
        $('#modal-size').textContent = summaryImage ? `${summaryImage.width || '?'}×${summaryImage.height || '?'} • ${formatSize(summaryImage.file_size || 0)}` : '-';
        $('#modal-prompt-text').textContent = summaryImage?.prompt || this._t('modal.loadingPrompt', null, 'Loading prompt…');
        $('#modal-negative-text').textContent = this._t('modal.loadingNegative', null, 'Loading…');
        $('#modal-loading-state').textContent = this._t('modal.loadingDetails', null, 'Loading details…');
        $('#modal-loading-state').style.display = '';
        document.querySelector('#modal-tags-list').textContent = this._t('modal.loadingTags', null, 'Loading tags…');
        document.querySelector('#modal-tags-list').style.color = 'var(--text-muted)';
        $('#btn-toggle-prompt-format').disabled = true;
        $('#btn-toggle-prompt-format').textContent = this._t('modal.viewAsSD', null, 'View as SD');
        ['#modal-loras-section', '#modal-negative-section', '#modal-characters-section', '#modal-params-section', '#modal-img2img-section', '#modal-nodes-section'].forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.style.display = 'none';
            }
        });
        document.querySelector('#modal-key-params').style.display = 'none';
        document.querySelector('#modal-checkpoint-item').style.display = 'none';
        document.querySelector('#modal-img2img-badge').style.display = 'none';
        document.querySelector('#modal-loras-list').innerHTML = '';
        document.querySelector('#modal-characters-list').innerHTML = '';
        document.querySelector('#modal-params-grid').innerHTML = '';
        document.querySelector('#modal-img2img-info').innerHTML = '';
        document.querySelector('#modal-nodes-list').innerHTML = '';
        $('#btn-reparse-metadata').onclick = async () => {
            try {
                $('#modal-loading-state').textContent = this._t('modal.reparsing', null, 'Reparsing metadata…');
                $('#modal-loading-state').style.display = '';
                const reparsed = await API.reparseImage(imageId);
                if (requestId !== this.currentPreviewRequestId) return;
                this._hydratePreview(reparsed.image, reparsed.tags);
                showToast?.(this._t('modal.metadataReparsed', null, 'Metadata reparsed'), 'success');
            } catch (error) {
                showToast?.(formatUserError(error, this._t('modal.failedReparse', null, 'Failed to reparse metadata')), "error");
            }
        };
        $('#modal-prev-image').onclick = () => this.openAdjacentPreview(-1);
        $('#modal-next-image').onclick = () => this.openAdjacentPreview(1);

        if (this._modalKeydownHandler) {
            document.removeEventListener('keydown', this._modalKeydownHandler);
        }
        this._modalKeydownHandler = (e) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.openAdjacentPreview(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.openAdjacentPreview(1);
            } else if (e.key === 'Escape') {
                document.removeEventListener('keydown', this._modalKeydownHandler);
                this._modalKeydownHandler = null;
                const closeModal = window.App?.closeModal || window.closeModal;
                if (typeof closeModal === 'function') {
                    closeModal('image-modal');
                }
            }
        };
        document.addEventListener('keydown', this._modalKeydownHandler);
        $('#btn-toggle-all-tags').onclick = () => {
            this.showAllTags = !this.showAllTags;
            this._renderModalTags(this._lastModalTags || []);
        };

        const copyToClipboard = async (text, successMessage) => {
            try {
                await navigator.clipboard.writeText(text || '');
                showToast?.(successMessage, 'success');
            } catch (error) {
                showToast?.(this._t('modal.copyFailed', null, 'Failed to copy text'), 'error');
            }
        };
        const getPromptView = () => this._getModalPromptView() || this._buildPromptView(this._lastModalImage, this._lastParsedData, 'original');
        $('#btn-toggle-prompt-format').onclick = () => this._togglePromptFormat();
        $('#btn-copy-prompt').onclick = () => copyToClipboard((getPromptView().promptText || ''), this._t('modal.promptCopied', null, 'Prompt copied'));
        $('#btn-copy-negative').onclick = () => copyToClipboard((getPromptView().negativeText || ''), this._t('modal.negativeCopied', null, 'Negative prompt copied'));
        $('#btn-copy-tags').onclick = () => copyToClipboard((this._lastModalTags || []).map(tag => tag.tag).join(', '), this._t('modal.tagsCopied', null, 'Tags copied'));
        $('#btn-copy-params').onclick = () => copyToClipboard(
            this._serializeGenerationParams(this._lastModalImage, this._lastParsedData),
            this._t('modal.paramsCopied', null, 'Params copied')
        );
        $('#btn-copy-all').onclick = () => copyToClipboard(this._buildCopyAllText(this._lastModalImage, this._lastParsedData, this._lastModalTags, getPromptView()), this._t('modal.allCopied', null, 'All metadata copied'));

        showModal?.('image-modal');

        try {
            const result = await API.getImage(imageId);
            if (requestId !== this.currentPreviewRequestId) {
                return;
            }
            this._hydratePreview(result.image, result.tags);
        } catch (error) {
            if (requestId !== this.currentPreviewRequestId) {
                return;
            }
            $('#modal-loading-state').textContent = this._t('modal.failedLoadDetails', null, 'Failed to load details');
            showToast?.(this._t('modal.failedLoadDetails', null, 'Failed to load details'), 'error');
        }
    },

    _hydratePreview(image, tags) {
        const { $, formatSize } = getGalleryAppContext();

        // Hide skeleton modal content
        if (window.SkeletonModal) {
            window.SkeletonModal.hideImageModal('image-modal');
        }

        $('#modal-filename').textContent = image.filename;
        $('#modal-generator').textContent = image.generator.toUpperCase();
        $('#modal-size').textContent = `${image.width}×${image.height} • ${formatSize(image.file_size)}`;
        $('#modal-prompt-text').textContent = image.prompt || this._t('modal.noPrompt', null, 'No prompt');
        const parsedData = this._extractParsedData(image);
        this._lastModalImage = image;
        this._lastModalTags = tags;
        this._lastParsedData = parsedData;

        this._renderModalSections(image, parsedData);
        this._renderModalTags(tags);
        this._applyModalPromptView(this._buildPromptView(image, parsedData, 'original'));
        $('#modal-loading-state').style.display = 'none';
        $('#btn-toggle-all-tags').textContent = this._t('modal.showMore', null, 'Show More');
    },

    openAdjacentPreview(direction) {
        if (!this.images.length || this.currentPreviewIndex < 0) return;
        const nextIndex = this.currentPreviewIndex + direction;
        if (nextIndex < 0 || nextIndex >= this.images.length) return;
        this.openPreview(this.images[nextIndex].id);
    },

    // Cleanup when switching views
    destroy() {
        this._cancelPendingWork();
        if (this.lazyObserver) {
            this.lazyObserver.disconnect();
            this.lazyObserver = null;
        }
        // Cleanup virtual list
        if (this.virtualList) {
            this.virtualList.destroy();
            this.virtualList = null;
        }
        this.useVirtualScroll = false;
        // Also cleanup legacy VirtualGallery if it's active
        if (window.VirtualGallery && typeof window.VirtualGallery.destroy === 'function') {
            window.VirtualGallery.destroy();
        }
    },

    /**
     * Get virtual scrolling statistics
     * @returns {Object} Statistics object
     */
    getVirtualStats() {
        return {
            enabled: this.useVirtualScroll,
            itemCount: this.images.length,
            renderedCount: this.virtualList ? this.virtualList.getRenderedCount() : this.images.length,
            threshold: GALLERY_VIRTUAL_CONFIG.threshold,
        };
    },

    /**
     * Initialize keyboard navigation for gallery grid
     * Enables arrow key navigation within the gallery grid
     */
    initKeyboardNavigation() {
        if (this._keyboardNavInitialized) return;
        this._keyboardNavInitialized = true;

        const grid = document.getElementById('gallery-grid');
        if (!grid) return;

        grid.addEventListener('keydown', (e) => {
            // Only handle arrow keys when focus is on a gallery item
            if (!e.target.classList.contains('gallery-item')) return;

            const items = Array.from(grid.querySelectorAll('.gallery-item'));
            const currentIndex = items.findIndex(item => item === e.target);
            if (currentIndex < 0) return;

            // Get the grid layout to determine column count
            const gridStyle = window.getComputedStyle(grid);
            const gridWidth = grid.offsetWidth;
            const itemWidth = items[0]?.offsetWidth || 200;
            const columnGap = parseInt(gridStyle.columnGap) || 16;
            const columns = Math.max(1, Math.floor((gridWidth + columnGap) / (itemWidth + columnGap)));

            let nextIndex = -1;

            switch (e.key) {
                case 'ArrowRight':
                    e.preventDefault();
                    nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : currentIndex;
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    nextIndex = currentIndex > 0 ? currentIndex - 1 : currentIndex;
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    nextIndex = currentIndex + columns < items.length ? currentIndex + columns : currentIndex;
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    nextIndex = currentIndex - columns >= 0 ? currentIndex - columns : currentIndex;
                    break;
                case 'Home':
                    e.preventDefault();
                    nextIndex = 0;
                    break;
                case 'End':
                    e.preventDefault();
                    nextIndex = items.length - 1;
                    break;
                default:
                    return;
            }

            if (nextIndex >= 0 && items[nextIndex]) {
                items[nextIndex].focus();
                // Announce to screen readers
                this.announceImagePosition(nextIndex, items.length);
            }
        });
    },

    /**
     * Announce image position to screen readers
     * @param {number} index - Current image index
     * @param {number} total - Total number of images
     */
    announceImagePosition(index, total) {
        const image = this.images[index];
        if (!image) return;

        const message = `Image ${index + 1} of ${total}: ${image.filename || 'Untitled'}`;
        if (window.A11y && typeof window.A11y.announce === 'function') {
            window.A11y.announce(message, 'polite');
        }
    },

    /**
     * Announce loading state to screen readers
     * @param {string} message - The message to announce
     */
    announceLoading(message) {
        if (window.A11y && typeof window.A11y.announce === 'function') {
            window.A11y.announce(message, 'polite');
        }
    },

    /**
     * Announce selection change to screen readers
     * @param {string} imageId - The image ID
     * @param {boolean} selected - Whether the image is selected
     */
    announceSelection(imageId, selected) {
        const image = this.images.find(img => img.id === imageId);
        const filename = image?.filename || 'Image';
        const message = selected ? `${filename} selected` : `${filename} deselected`;
        if (window.A11y && typeof window.A11y.announce === 'function') {
            window.A11y.announce(message, 'polite');
        }
    }
};

// Export configuration for external use
window.GALLERY_VIRTUAL_CONFIG = GALLERY_VIRTUAL_CONFIG;
window.Gallery = Gallery;
