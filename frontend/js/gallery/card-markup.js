/**
 * gallery/card-markup.js — gallery.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/gallery.js pre-cut
 * lines 1178-1509 + 1761-1865 (of 4,708): card markup + createVirtualGalleryItem + skeleton + order badge.
 * Classic script: joins the ONE unsealed window.Gallery object declared in
 * gallery/base.js, which loads FIRST (the shared consts + module helpers
 * live there); index.html lists the family in original line order.
 */
Object.assign(window.Gallery, {
    _formatLargeCardRating(image) {
        const rating = String(image?.rating || '').trim().toLowerCase();
        return ['general', 'sensitive', 'questionable', 'explicit'].includes(rating)
            ? rating
            : 'unrated';
    },

    _formatLargeCardAspect(image) {
        const width = Number(image?.width || 0);
        const height = Number(image?.height || 0);
        if (!width || !height) return this._t('gallery.largeUnknownRatio', null, 'Unknown ratio');
        if (width === height) return this._t('filter.square', null, 'Square');
        return width > height
            ? this._t('filter.landscape', null, 'Landscape')
            : this._t('filter.portrait', null, 'Portrait');
    },

    _truncateLargeCardPrompt(prompt, maxLength = 140) {
        const normalized = String(prompt || '').replace(/\s+/g, ' ').trim();
        if (!normalized) {
            const _v = window.I18n?.t?.('gallery.noPromptPreview'); return (_v && _v !== 'gallery.noPromptPreview') ? _v : 'No prompt info yet';
        }

        return normalized.length > maxLength
            ? `${normalized.slice(0, maxLength - 1).trim()}...`
            : normalized;
    },

    _buildGalleryItemMarkup(image, viewMode, initialUrl, finalUrl, generatorColor, immediateLoad = false) {
        const safeFilename = (image.filename || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const isWaterfall = viewMode === 'waterfall';
        const isLarge = viewMode === 'large';
        const generatorValue = this._normalizeGenerator(image.generator);
        const generatorLabel = this._formatGeneratorLabel(generatorValue);
        const imgAttributes = immediateLoad
            ? `src="${initialUrl}" loading="lazy" decoding="async"`
            : `data-src="${initialUrl}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" decoding="async"`;
        const highResAttr = finalUrl ? ` data-highres-src="${finalUrl}"` : '';

        if (!isLarge) {
            const imageTag = isWaterfall
                ? `<img src="${initialUrl}" alt="${safeFilename}" loading="lazy" decoding="async" draggable="false"${highResAttr}>`
                : `<img ${imgAttributes} alt="${safeFilename}" draggable="false"${highResAttr}>`;

            const aestheticBadge = image.aesthetic_score != null
                ? `<span class="gallery-item-aesthetic" title="${this._escapeHtml(this._t('filter.aestheticTitle', null, 'Aesthetic Score'))}: ${Number(image.aesthetic_score).toFixed(1)}">${Number(image.aesthetic_score).toFixed(1)}</span>`
                : '';

            return `
                ${imageTag}
                ${this._favoriteButtonHtml(image)}
                ${this._ratingBadgeHtml(image)}
                <div class="gallery-item-overlay" aria-hidden="true">
                    <span class="gallery-item-generator" data-generator-value="${this._escapeHtml(generatorValue)}" style="background: ${generatorColor}">
                        ${this._escapeHtml(generatorLabel)}
                    </span>
                    ${aestheticBadge}
                </div>
            `;
        }

        const rating = this._formatLargeCardRating(image);
        const ratingFallback = rating === 'unrated' ? 'Unrated' : rating.charAt(0).toUpperCase() + rating.slice(1);
        const ratingLabel = this._t(`gallery.rating.${rating}`, null, ratingFallback);
        const noCheckpointLabel = this._t('gallery.noCheckpoint', null, 'No checkpoint');
        const checkpoint = String(image?.checkpoint || '').trim() || noCheckpointLabel;
        const checkpointLabel = checkpoint
            ? checkpoint.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '') || checkpoint
            : noCheckpointLabel;
        const sizeLabel = image.width && image.height ? `${image.width}x${image.height}` : this._t('gallery.unknownSize', null, 'Unknown size');
        const aspectLabel = this._formatLargeCardAspect(image);
        const promptPreview = this._truncateLargeCardPrompt(image.prompt);
        const pathMeta = (() => {
            if (!image.path) return '';
            const dir = image.path.replace(/\\/g, '/').split('/');
            dir.pop(); // remove filename
            const last = dir.pop(); // get parent folder
            const parent = last || '';
            const fullDir = dir.length ? `${dir.join('/')}/${parent}` : parent;
            return {
                parent,
                fullDir,
            };
        })();

        return `
            <div class="gallery-item-media">
                <img ${imgAttributes} alt="${safeFilename}" draggable="false"${highResAttr}>
                ${this._favoriteButtonHtml(image)}
                ${this._ratingBadgeHtml(image)}
            </div>
            <div class="gallery-item-large-meta">
                <div class="gallery-item-large-top">
                    <span class="gallery-item-generator" data-generator-value="${this._escapeHtml(generatorValue)}" style="background: ${generatorColor}">
                        ${this._escapeHtml(generatorLabel)}
                    </span>
                    <span class="gallery-item-rating rating-${rating}">
                        ${this._escapeHtml(ratingLabel)}
                    </span>
                </div>
                <div class="gallery-item-title" title="${safeFilename}">
                    ${safeFilename}
                </div>
                ${pathMeta?.parent ? `
                    <div class="gallery-item-subfolder" title="${this._escapeHtml(image.path || '')}">
                        <span class="gallery-item-subfolder-label">${this._t('modal.folder', null, 'Folder')}</span>
                        <span class="gallery-item-subfolder-name">${this._escapeHtml(pathMeta.parent)}</span>
                    </div>
                ` : ''}
                ${pathMeta?.fullDir ? `<div class="gallery-item-path" title="${this._escapeHtml(image.path || '')}">${this._escapeHtml(pathMeta.fullDir)}</div>` : ''}
                <div class="gallery-item-subline">
                    <span>${this._escapeHtml(sizeLabel)}</span>
                    <span>${this._escapeHtml(aspectLabel)}</span>
                </div>
                <div class="gallery-item-checkpoint" title="${this._escapeHtml(checkpoint)}">
                    ${this._escapeHtml(checkpointLabel)}
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
        const generatorValue = this._normalizeGenerator(image.generator);
        const generatorLabel = this._formatGeneratorLabel(generatorValue);

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
        if (isGalleryImageSelected(AppState, image.id)) {
            item.classList.add('selected');
        }
        item.dataset.id = image.id;
        item.dataset.index = index;
        item.draggable = true;
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'gridcell');
        item.setAttribute('aria-label', `${image.filename || 'Image'} - ${generatorLabel}`);
        item.setAttribute('aria-selected', isGalleryImageSelected(AppState, image.id) ? 'true' : 'false');

        item.innerHTML = this._buildGalleryItemMarkup(
            image,
            viewMode,
            initialUrl,
            finalUrl,
            genColors[generatorValue] || genColors.unknown,
            true
        );
        this._attachGalleryOrderBadge(item, index);

        // Add event listeners
        item.addEventListener('click', (event) => {
            // v3.3.0 FEAT-COLLECTIONS: heart button toggles favorite without
            // triggering selection/preview.
            const favBtn = event.target.closest?.('.gallery-item-fav');
            if (favBtn) {
                event.preventDefault();
                event.stopPropagation();
                this.toggleFavorite(image.id);
                return;
            }
            if (AppState.selectionMode) {
                this.handleSelectionInteraction(event, image.id, Number(item.dataset.index));
            } else {
                this.openPreview(image.id);
            }
        });

        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._showContextMenu(e, image);
        });

        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (AppState.selectionMode) {
                    this.handleSelectionInteraction(e, image.id, Number(item.dataset.index));
                } else {
                    this.openPreview(image.id);
                }
            }
        });

        item.addEventListener('dragstart', (e) => {
            // Use full image URL (not thumbnail) so ComfyUI gets the original with workflow metadata
            const imgUrl = `/api/image-file/${image.id}`;
            const absoluteUrl = new URL(imgUrl, window.location.origin).href;
            const originalFilename = image.filename || `image_${image.id}.png`;
            e.dataTransfer.setData('text/uri-list', absoluteUrl);
            e.dataTransfer.setData('text/plain', absoluteUrl);
            const mimeType = originalFilename.toLowerCase().endsWith('.png') ? 'image/png' :
                originalFilename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
            e.dataTransfer.setData('DownloadURL', `${mimeType}:${originalFilename}:${absoluteUrl}`);
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

    _attachGalleryOrderBadge(item, index) {
        if (!item) return;
        const order = Number(index) + 1;
        if (!Number.isFinite(order) || order <= 0) return;
        item.querySelector('.gallery-item-order')?.remove();
        const badge = document.createElement('span');
        badge.className = 'gallery-item-order';
        badge.textContent = String(order);
        badge.title = this._t('gallery.order', null, 'Current gallery order');
        item.appendChild(badge);
    },

    createGalleryItem(image, index, viewMode = null) {
        const { AppState } = getGalleryAppContext();
        const genColors = this._getGenColors();
        const generatorValue = this._normalizeGenerator(image.generator);
        const generatorLabel = this._formatGeneratorLabel(generatorValue);
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
        if (isGalleryImageSelected(AppState, image.id)) {
            item.classList.add('selected');
        }
        item.dataset.id = image.id;
        item.dataset.index = index;
        item.draggable = true;

        // Accessibility: make item focusable and add ARIA attributes
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'gridcell');
        item.setAttribute('aria-label', `${image.filename || 'Image'} - ${generatorLabel}`);
        item.setAttribute('aria-selected', isGalleryImageSelected(AppState, image.id) ? 'true' : 'false');
        item.innerHTML = this._buildGalleryItemMarkup(
            image,
            resolvedViewMode,
            initialUrl,
            finalUrl,
            genColors[generatorValue] || genColors.unknown,
            false
        );
        this._attachGalleryOrderBadge(item, index);

        // Prevent the browser from dragging the rendered thumbnail/webp directly.
        // We always want the gallery card drag payload to point at the original file URL.
        item.querySelectorAll('img').forEach((img) => {
            img.draggable = false;
        });

        item.addEventListener('click', (event) => {
            // v3.3.0 FEAT-COLLECTIONS: heart button toggles favorite without
            // triggering selection/preview.
            const favBtn = event.target.closest?.('.gallery-item-fav');
            if (favBtn) {
                event.preventDefault();
                event.stopPropagation();
                this.toggleFavorite(image.id);
                return;
            }
            if (AppState.selectionMode) {
                this.handleSelectionInteraction(event, image.id, Number(item.dataset.index));
            } else {
                this.openPreview(image.id);
            }
        });

        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._showContextMenu(e, image);
        });

        // Keyboard navigation: Enter/Space to open preview or toggle selection
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (AppState.selectionMode) {
                    this.handleSelectionInteraction(e, image.id, Number(item.dataset.index));
                } else {
                    this.openPreview(image.id);
                }
            }
        });

        item.addEventListener('dragstart', (e) => {
            // Use full image URL (not thumbnail) so ComfyUI gets the original with workflow metadata
            const imgUrl = `/api/image-file/${image.id}`;
            const absoluteUrl = new URL(imgUrl, window.location.origin).href;
            const originalFilename = image.filename || `image_${image.id}.png`;
            e.dataTransfer.setData('text/uri-list', absoluteUrl);
            e.dataTransfer.setData('text/plain', absoluteUrl);
            const mimeType = originalFilename.toLowerCase().endsWith('.png') ? 'image/png' :
                originalFilename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
            e.dataTransfer.setData('DownloadURL', `${mimeType}:${originalFilename}:${absoluteUrl}`);
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

});
