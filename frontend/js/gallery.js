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
    threshold: 500,           // Minimum items to enable virtual scrolling
    estimatedItemHeight: 200, // Estimated height for grid mode
    rowGap: 16,               // Gap between rows
    columnGap: 16,            // Gap between columns
    minColumnWidth: {
        grid: 200,
        large: 300,
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

    /**
     * Get generator color map (uses global override if available)
     * @returns {Object} Generator color mapping
     */
    _getGenColors() {
        return window.GENERATOR_COLORS || DEFAULT_GENERATOR_COLORS;
    },

    /**
     * Check if virtual scrolling should be enabled
     * @param {number} imageCount - Number of images
     * @returns {boolean}
     */
    shouldUseVirtualScroll(imageCount) {
        // Check if VirtualList class is available
        if (typeof window.VirtualList === 'undefined' && typeof window.WaterfallVirtualList === 'undefined') {
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
    },

    /**
     * Initialize virtual scrolling if needed
     * @param {string} viewMode - Current view mode ('grid', 'large', 'waterfall')
     */
    initVirtualScroll(viewMode) {
        const { $ } = getGalleryAppContext();
        const grid = $('#gallery-grid');
        if (!grid) return null;

        const scrollContainer = grid.parentElement;
        if (!scrollContainer) return null;

        // Cleanup existing virtual list
        if (this.virtualList) {
            this.virtualList.destroy();
            this.virtualList = null;
        }

        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';
        const minColumnWidth = isWaterfall
            ? GALLERY_VIRTUAL_CONFIG.waterfall.columnWidth
            : (isLarge ? GALLERY_VIRTUAL_CONFIG.minColumnWidth.large : GALLERY_VIRTUAL_CONFIG.minColumnWidth.grid);

        const config = {
            bufferSize: GALLERY_VIRTUAL_CONFIG.bufferSize,
            threshold: GALLERY_VIRTUAL_CONFIG.threshold,
            estimatedItemHeight: isLarge ? 300 : GALLERY_VIRTUAL_CONFIG.estimatedItemHeight,
            rowGap: GALLERY_VIRTUAL_CONFIG.rowGap,
            columnGap: GALLERY_VIRTUAL_CONFIG.columnGap,
            minColumnWidth,
        };

        // Create the appropriate virtual list type
        const VirtualListClass = isWaterfall ? window.WaterfallVirtualList : window.VirtualList;
        if (!VirtualListClass) return null;

        try {
            const options = {
                container: grid,
                scrollContainer,
                renderItem: (index, image) => this.createVirtualGalleryItem(index, image, viewMode),
                getItemKey: (index, image) => image.id || index,
                config,
            };

            // Add waterfall-specific options
            if (isWaterfall) {
                options.columnWidth = GALLERY_VIRTUAL_CONFIG.waterfall.columnWidth;
                options.minHeight = GALLERY_VIRTUAL_CONFIG.waterfall.minHeight;
                options.maxHeight = GALLERY_VIRTUAL_CONFIG.waterfall.maxHeight;
                options.estimatedHeight = GALLERY_VIRTUAL_CONFIG.waterfall.estimatedHeight;
            }

            this.virtualList = new VirtualListClass(options);
            this.virtualList.init(this.images);
            this.useVirtualScroll = true;

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
        const { API, AppState } = getGalleryAppContext();
        const genColors = this._getGenColors();

        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';

        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (isWaterfall) {
            item.classList.add('waterfall-item');
        }
        if (AppState.selectedIds.has(image.id)) {
            item.classList.add('selected');
        }
        item.dataset.id = image.id;
        item.dataset.index = index;
        item.draggable = true;

        const safeFilename = (image.filename || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const thumbSize = isLarge ? 512 : isWaterfall ? 384 : 256;
        const thumbnailUrl = API?.getThumbnailUrl?.(image.id, thumbSize) ?? `/api/image-thumbnail/${image.id}?size=${thumbSize}`;

        // For virtual scrolling, load image immediately (no lazy loading)
        item.innerHTML = `
            <img src="${thumbnailUrl}" alt="${safeFilename}" loading="lazy">
            <div class="gallery-item-overlay">
                <span class="gallery-item-generator" style="background: ${genColors[image.generator] || genColors.unknown}">
                    ${this._escapeHtml(image.generator)}
                </span>
            </div>
        `;

        // Add event listeners
        item.addEventListener('click', () => {
            if (AppState.selectionMode) {
                this.toggleSelection(image.id);
            } else {
                this.openPreview(image.id);
            }
        });

        item.addEventListener('dragstart', (e) => {
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
        // Hide skeleton before rendering
        this.hideSkeleton();

        // Decide whether to use virtual scrolling
        const { AppState } = getGalleryAppContext();
        const shouldVirtual = this.shouldUseVirtualScroll(images.length);

        if (shouldVirtual) {
            // Destroy existing virtual list first
            if (this.virtualList) {
                this.virtualList.destroy();
                this.virtualList = null;
            }
            // Initialize virtual scrolling
            this.initVirtualScroll(AppState.viewMode);
        } else {
            // Fall back to standard rendering
            this.useVirtualScroll = false;
            if (this.virtualList) {
                this.virtualList.destroy();
                this.virtualList = null;
            }
            this.render();
        }
    },

    appendImages(newImages) {
        if (!newImages || newImages.length === 0) return;

        const { $, AppState } = getGalleryAppContext();
        const grid = $('#gallery-grid');
        if (!grid) return;

        const isWaterfall = AppState.viewMode === 'waterfall';
        const startIndex = this.images.length;

        // Append to internal array
        this.images = [...this.images, ...newImages];

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
            const item = this.createGalleryItem(image, index, isWaterfall);
            fragment.appendChild(item);
            if (!isWaterfall) newItems.push(item);
        });

        // Append to DOM FIRST, then observe — items must be in DOM
        grid.appendChild(fragment);

        if (this.lazyObserver && !isWaterfall) {
            newItems.forEach(item => this.lazyObserver.observe(item));
            // Fallback: force-load any already-visible images
            requestAnimationFrame(() => this._loadVisibleImages(newItems));
        }
    },

    /**
     * Set view mode and re-render
     * @param {string} mode - View mode ('grid', 'large', 'waterfall')
     */
    setViewMode(mode) {
        const { AppState } = getGalleryAppContext();

        // If using virtual scrolling, reinitialize for new mode
        if (this.useVirtualScroll) {
            if (this.virtualList) {
                this.virtualList.destroy();
                this.virtualList = null;
            }
            this.initVirtualScroll(mode);
        } else {
            // Standard re-render
            this.render();
        }
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

        grid.innerHTML = '';
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

        const isWaterfall = AppState.viewMode === 'waterfall';
        if (!isWaterfall) {
            this.lazyObserver = this._createLazyObserver();
        }

        const fragment = document.createDocumentFragment();
        const allItems = [];
        this.images.forEach((image, index) => {
            const item = this.createGalleryItem(image, index, isWaterfall);
            fragment.appendChild(item);
            if (!isWaterfall) allItems.push(item);
        });

        // Append to DOM FIRST, then observe — items must be in the DOM
        // for IntersectionObserver to reliably detect visibility
        grid.appendChild(fragment);

        if (this.lazyObserver && !isWaterfall) {
            allItems.forEach(item => this.lazyObserver.observe(item));
            // Fallback: force-load any already-visible images
            requestAnimationFrame(() => this._loadVisibleImages(allItems));
        }
    },

    createGalleryItem(image, index, isWaterfall = false) {
        const { API, AppState } = getGalleryAppContext();
        const genColors = this._getGenColors();

        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (isWaterfall) {
            item.classList.add('waterfall-item');
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
        if (AppState.selectedIds.has(image.id)) {
            item.setAttribute('aria-selected', 'true');
        }

        const safeFilename = (image.filename || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const thumbSize = AppState.viewMode === 'large' ? 512 : AppState.viewMode === 'waterfall' ? 384 : 256;
        const thumbnailUrl = API?.getThumbnailUrl?.(image.id, thumbSize) ?? `/api/image-thumbnail/${image.id}?size=${thumbSize}`;
        const imageTag = isWaterfall
            ? `<img src="${thumbnailUrl}" alt="${safeFilename}" loading="lazy">`
            : `<img data-src="${thumbnailUrl}" alt="${safeFilename}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`;

        item.innerHTML = `
            ${imageTag}
            <div class="gallery-item-overlay" aria-hidden="true">
                <span class="gallery-item-generator" style="background: ${genColors[image.generator] || genColors.unknown}">
                    ${this._escapeHtml(image.generator)}
                </span>
            </div>
        `;

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
        if (generator.includes('novel') || generator.includes('nai')) return 'nai';
        if (generator.includes('webui') || generator.includes('forge')) return 'sd';
        if (parsedData?.character_prompts?.length) return 'nai';
        if (parsedData?.prompt_nodes?.length) return 'sd';
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

    _buildNaiMergedPromptText(image, parsedData) {
        const mainPrompt = String(image?.prompt || '').trim();
        const characterPrompts = Array.isArray(parsedData?.character_prompts)
            ? parsedData.character_prompts.map((entry, index) => this._normalizeCharacterPrompt(entry, index)).filter(Boolean)
            : [];

        const promptParts = [];
        if (mainPrompt) {
            promptParts.push(mainPrompt);
        }
        characterPrompts.forEach(characterPrompt => {
            promptParts.push(characterPrompt.prompt);
        });

        return {
            promptText: promptParts.join('\n\n'),
            characterPrompts,
        };
    },

    _buildPromptView(image, parsedData, targetFormat = 'original') {
        const promptText = String(image?.prompt || '').trim();
        const negativeText = String(image?.negative_prompt || '').trim();
        const sourceFormat = this._detectPromptFormat(image, parsedData);
        const normalizedTarget = ['original', 'sd', 'nai'].includes(targetFormat) ? targetFormat : 'original';
        const characterPrompts = Array.isArray(parsedData?.character_prompts)
            ? parsedData.character_prompts.map((entry, index) => this._normalizeCharacterPrompt(entry, index)).filter(Boolean)
            : [];

        if (normalizedTarget === 'original') {
            return {
                promptText,
                negativeText,
                formatLabel: 'Original',
                sourceFormat,
                targetFormat: 'original',
                isConverted: false,
                characterPrompts,
            };
        }

        if (normalizedTarget === 'sd') {
            const mergedPrompt = sourceFormat === 'nai' || characterPrompts.length > 0
                ? this._buildNaiMergedPromptText(image, parsedData).promptText
                : promptText;

            return {
                promptText: mergedPrompt || promptText,
                negativeText,
                formatLabel: 'SD',
                sourceFormat,
                targetFormat: 'sd',
                isConverted: sourceFormat !== 'sd',
                characterPrompts,
            };
        }

        return {
            promptText,
            negativeText,
            formatLabel: 'NAI',
            sourceFormat,
            targetFormat: 'nai',
            isConverted: sourceFormat !== 'nai',
            characterPrompts,
        };
    },

    _buildConvertedPromptView(image, parsedData, targetFormat) {
        return this._buildPromptView(image, parsedData, targetFormat);
    },

    _applyModalPromptView(promptView) {
        const promptText = document.querySelector('#modal-prompt-text');
        const negSection = document.querySelector('#modal-negative-section');
        const negText = document.querySelector('#modal-negative-text');
        const promptHeader = document.querySelector('.modal-prompt h4');
        const toggleBtn = document.querySelector('#btn-toggle-prompt-format');

        if (promptText) {
            promptText.textContent = promptView.promptText || 'No prompt data';
        }
        if (negText) {
            negText.textContent = promptView.negativeText || '-';
        }
        if (negSection) {
            negSection.style.display = promptView.negativeText ? '' : 'none';
        }
        if (promptHeader) {
            promptHeader.textContent = `Prompt (${promptView.formatLabel})`;
        }
        if (toggleBtn) {
            const hasPrompt = !!(promptView.promptText || promptView.negativeText || (promptView.characterPrompts && promptView.characterPrompts.length));
            toggleBtn.disabled = !hasPrompt;
            if (!hasPrompt) {
                toggleBtn.textContent = 'No prompt';
            } else if (promptView.targetFormat === 'original') {
                toggleBtn.textContent = `View as ${promptView.sourceFormat === 'nai' ? 'SD' : 'NAI'}`;
            } else {
                toggleBtn.textContent = 'View Original';
            }
        }
        this._modalPromptView = promptView;
    },

    _togglePromptFormat() {
        const view = this._getModalPromptView();
        if (!view || !this._lastModalImage || !this._lastParsedData) return;

        const nextFormat = view.targetFormat === 'original'
            ? (view.sourceFormat === 'nai' ? 'sd' : 'nai')
            : 'original';

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
            charsSection.style.display = '';
            charsList.innerHTML = parsedData.character_prompts.map((c, i) => {
                const centerStr = c.center ? ` (${c.center.x?.toFixed?.(2) || c.center.x}, ${c.center.y?.toFixed?.(2) || c.center.y})` : '';
                const negHtml = c.negative_prompt
                    ? `<div class="char-negative"><strong>Neg:</strong> ${window.escapeHtml(c.negative_prompt)}</div>`
                    : '';
                return `
                    <div class="character-card">
                        <div class="character-card-header">Character ${c.index != null ? c.index + 1 : i + 1}${centerStr}</div>
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
        if (parsedData.generation_params && Object.keys(parsedData.generation_params).length > 0) {
            paramsSection.style.display = '';
            const paramLabels = {
                steps: 'Steps',
                sampler: 'Sampler',
                seed: 'Seed',
                cfg_scale: 'CFG Scale',
                cfg: 'CFG',
                scale: 'Scale',
                scheduler: 'Scheduler',
                denoise: 'Denoise',
                denoising_strength: 'Denoise',
                strength: 'Strength',
                noise: 'Noise',
                sm: 'SMEA',
                sm_dyn: 'SMEA Dyn',
                cfg_rescale: 'CFG Rescale',
                clip_skip: 'Clip Skip',
                hires_upscaler: 'Hires Upscaler',
                hires_upscale: 'Hires Scale',
                hires_steps: 'Hires Steps',
                model: 'Model',
                model_hash: 'Model Hash',
                sampler_name: 'Sampler',
                noise_schedule: 'Noise Schedule',
                uncond_scale: 'Uncond Scale',
                skip_cfg_above_sigma: 'Skip CFG σ',
                schedule_type: 'Schedule Type',
            };
            paramsGrid.innerHTML = Object.entries(parsedData.generation_params).map(([key, val]) => {
                const label = paramLabels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const displayVal = typeof val === 'number'
                    ? (Number.isInteger(val) ? val : val.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))
                    : window.escapeHtml(String(val));
                return `<div class="param-item"><span class="param-label">${window.escapeHtml(label)}</span><span class="param-value">${displayVal}</span></div>`;
            }).join('');
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
            tagsList.textContent = 'No tags (run WD14 tagger)';
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
            toggleBtn.textContent = this.showAllTags ? 'Show Less' : 'Show More';
        }
    },

    _serializeGenerationParams(parsedData) {
        const params = parsedData?.generation_params || {};
        return Object.entries(params)
            .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
            .join('\n');
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

        const sections = [
            ['Filename', image?.filename],
            ['Generator', image?.generator],
            ['Size', image?.width && image?.height ? `${image.width}x${image.height}` : null],
            ['Prompt', currentPromptView?.promptText ?? image?.prompt],
            ['Negative', currentPromptView?.negativeText ?? image?.negative_prompt],
            ['Checkpoint', image?.checkpoint],
            ['LoRAs', loras.length ? loras.join(', ') : null],
            ['Tags', tags?.length ? tags.map(tag => tag.tag).join(', ') : null],
            ['Params', this._serializeGenerationParams(parsedData)],
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
        $('#modal-prompt-text').textContent = summaryImage?.prompt || 'Loading prompt…';
        $('#modal-negative-text').textContent = 'Loading…';
        $('#modal-loading-state').textContent = 'Loading details…';
        $('#modal-loading-state').style.display = '';
        document.querySelector('#modal-tags-list').textContent = 'Loading tags…';
        document.querySelector('#modal-tags-list').style.color = 'var(--text-muted)';
        $('#btn-toggle-prompt-format').disabled = true;
        $('#btn-toggle-prompt-format').textContent = 'View as SD';
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
                $('#modal-loading-state').textContent = 'Reparsing metadata…';
                $('#modal-loading-state').style.display = '';
                const reparsed = await API.reparseImage(imageId);
                if (requestId !== this.currentPreviewRequestId) return;
                this._hydratePreview(reparsed.image, reparsed.tags);
                showToast?.('Metadata reparsed', 'success');
            } catch (error) {
                showToast?.(formatUserError(error, "Failed to reparse metadata"), "error");
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
                showToast?.('Failed to copy text', 'error');
            }
        };
        const getPromptView = () => this._getModalPromptView() || this._buildPromptView(this._lastModalImage, this._lastParsedData, 'original');
        $('#btn-toggle-prompt-format').onclick = () => this._togglePromptFormat();
        $('#btn-copy-prompt').onclick = () => copyToClipboard((getPromptView().promptText || ''), 'Prompt copied');
        $('#btn-copy-negative').onclick = () => copyToClipboard((getPromptView().negativeText || ''), 'Negative prompt copied');
        $('#btn-copy-tags').onclick = () => copyToClipboard((this._lastModalTags || []).map(tag => tag.tag).join(', '), 'Tags copied');
        $('#btn-copy-params').onclick = () => copyToClipboard(this._serializeGenerationParams(this._lastParsedData), 'Params copied');
        $('#btn-copy-all').onclick = () => copyToClipboard(this._buildCopyAllText(this._lastModalImage, this._lastParsedData, this._lastModalTags, getPromptView()), 'All metadata copied');

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
            $('#modal-loading-state').textContent = 'Failed to load details';
            showToast?.('Failed to load image details', 'error');
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
        $('#modal-prompt-text').textContent = image.prompt || 'No prompt data';
        const parsedData = this._extractParsedData(image);
        this._lastModalImage = image;
        this._lastModalTags = tags;
        this._lastParsedData = parsedData;

        this._renderModalSections(image, parsedData);
        this._renderModalTags(tags);
        this._applyModalPromptView(this._buildPromptView(image, parsedData, 'original'));
        $('#modal-loading-state').style.display = 'none';
        $('#btn-toggle-all-tags').textContent = 'Show More';
    },

    openAdjacentPreview(direction) {
        if (!this.images.length || this.currentPreviewIndex < 0) return;
        const nextIndex = this.currentPreviewIndex + direction;
        if (nextIndex < 0 || nextIndex >= this.images.length) return;
        this.openPreview(this.images[nextIndex].id);
    },

    // Cleanup when switching views
    destroy() {
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
