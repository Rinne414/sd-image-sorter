/**
 * prompt-lab/image-picker.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 180-376 (of 2,485):
 * image record/thumb/meta helpers, _ensureImageCatalog (newest-200), the
 * _getPickerTargetMeta target map, and the image-picker modal
 * (open/close/render/debounced search/grid/select).
 * Classic script: joins the ONE unsealed window.PromptLab object declared
 * in prompt-lab/base.js (loads FIRST); prompt-lab/boot.js declares the
 * initPromptLab boot LAST; index.html lists the family in original line order.
 */
Object.assign(window.PromptLab, {
    _getImageThumbUrl(imageId, size = 320) {
        const api = window.App?.API;
        return api?.getThumbnailUrl?.(imageId, size) || `/api/image-thumbnail/${imageId}?size=${size}`;
    },

    _getImageRecord(imageId) {
        const numericId = Number(imageId);
        if (!Number.isFinite(numericId)) return null;
        const fromCatalog = (this.imageCatalog || []).find((image) => Number(image.id) === numericId);
        if (fromCatalog) return fromCatalog;
        return (window.App?.AppState?.images || []).find((image) => Number(image.id) === numericId) || null;
    },

    _getPromptLabImages() {
        if (Array.isArray(this.imageCatalog) && this.imageCatalog.length > 0) {
            return this.imageCatalog;
        }
        return window.App?.AppState?.images || [];
    },

    async _ensureImageCatalog() {
        if (this.imageCatalogLoaded && this.imageCatalog.length > 0) {
            return this.imageCatalog;
        }
        if (this.imageCatalogPromise) {
            return this.imageCatalogPromise;
        }

        this.imageCatalogPromise = (async () => {
            const api = window.App?.API;
            if (!api?.getImages) {
                this.imageCatalog = window.App?.AppState?.images || [];
                this.imageCatalogLoaded = true;
                return this.imageCatalog;
            }

            const result = await api.getImages({
                sortBy: 'newest',
                limit: 200,
            });
            this.imageCatalog = Array.isArray(result?.images) ? result.images : [];
            this.imageCatalogLoaded = true;
            this.imageCatalogPromise = null;
            return this.imageCatalog;
        })().catch((error) => {
            this.imageCatalogPromise = null;
            throw error;
        });

        return this.imageCatalogPromise;
    },

    _formatPromptlabImageMeta(image) {
        if (!image) return '';
        const parts = [];
        if (image.aesthetic_score != null) parts.push(`★ ${Number(image.aesthetic_score).toFixed(1)}`);
        if (image.width && image.height) parts.push(`📐 ${image.width}×${image.height}`);
        if (image.generator) parts.push(String(image.generator));
        if (image.checkpoint) {
            const checkpoint = String(image.checkpoint).replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || String(image.checkpoint);
            parts.push(`🧠 ${checkpoint}`);
        }
        return parts.join(' · ');
    },

    _renderImagePreviewCard(targetId, imageId, emptyKey, emptyFallback) {
        const container = document.getElementById(targetId);
        if (!container) return;

        const image = this._getImageRecord(imageId);
        if (!image) {
            container.className = 'promptlab-image-preview-card promptlab-image-preview-empty';
            container.textContent = this._t(emptyKey, emptyFallback);
            return;
        }

        container.className = 'promptlab-image-preview-card';
        container.innerHTML = `
            <div class="promptlab-image-preview-body">
                <img class="promptlab-image-preview-thumb" src="${escapeHtml(this._getImageThumbUrl(image.id, 320))}" alt="${escapeHtml(image.filename || '')}" loading="lazy">
                <div class="promptlab-image-preview-info">
                    <div class="promptlab-image-preview-title">${escapeHtml(image.filename || `Image ${image.id}`)}</div>
                    <div class="promptlab-image-preview-meta">${escapeHtml(this._formatPromptlabImageMeta(image) || this._t('promptlab.noImageMeta', 'No quick info yet'))}</div>
                </div>
            </div>
        `;
    },

    _getPickerTargetMeta(target) {
        if (target === 'compare-a') {
            return {
                selectId: 'pl-compare-a',
                title: this._t('promptlab.pickImageForA', 'Pick Image A'),
            };
        }
        if (target === 'compare-b') {
            return {
                selectId: 'pl-compare-b',
                title: this._t('promptlab.pickImageForB', 'Pick Image B'),
            };
        }
        return {
            selectId: 'pl-build-source',
            title: this._t('promptlab.pickImageForBuild', 'Pick Build Template'),
        };
    },

    openImagePicker(target) {
        this.imagePickerTarget = target;
        const modal = document.getElementById('promptlab-image-picker-modal');
        const title = document.getElementById('pl-image-picker-title');
        const search = document.getElementById('pl-image-picker-search');
        const meta = this._getPickerTargetMeta(target);
        if (title) title.textContent = meta.title;
        if (search) search.value = '';
        this.renderImagePicker(true);
        modal?.classList.add('visible');
        this._ensureImageCatalog()
            .then(() => this.renderImagePicker())
            .catch(() => this.renderImagePicker());
    },

    closeImagePicker() {
        document.getElementById('promptlab-image-picker-modal')?.classList.remove('visible');
        this.imagePickerTarget = '';
    },

    renderImagePicker(isLoading = false) {
        const grid = document.getElementById('pl-image-picker-grid');
        const count = document.getElementById('pl-image-picker-count');
        if (!grid) return;

        if (isLoading) {
            grid.innerHTML = `<div class="promptlab-image-preview-empty">${escapeHtml(this._t('promptlab.loadingImages', 'Loading images...'))}</div>`;
            return;
        }

        const query = String(document.getElementById('pl-image-picker-search')?.value || '').trim().toLowerCase();

        if (query && window.App?.API?.getImages) {
            this._searchPickerDebounced(query, grid, count);
            return;
        }

        const images = this._getPromptLabImages();
        this._renderPickerGrid(images, grid, count);
    },

    _searchPickerTimer: null,
    _searchPickerDebounced(query, grid, count) {
        clearTimeout(this._searchPickerTimer);
        this._searchPickerTimer = setTimeout(async () => {
            try {
                const result = await window.App.API.getImages({
                    sortBy: 'newest',
                    limit: 200,
                    search: query,
                });
                const images = Array.isArray(result?.images) ? result.images : [];
                this._renderPickerGrid(images, grid, count);
            } catch {
                this._renderPickerGrid([], grid, count);
            }
        }, 300);
    },

    _renderPickerGrid(images, grid, count) {
        if (count) {
            count.textContent = this._t('promptlab.pickImageCount', '{count} images', { count: images.length }).replace('{count}', images.length);
        }

        if (!images.length) {
            grid.innerHTML = `<div class="promptlab-image-preview-empty">${escapeHtml(this._t('promptlab.pickImageNoResults', 'No images matched this search.'))}</div>`;
            return;
        }

        grid.innerHTML = images.map((image) => `
            <div class="promptlab-image-picker-card" data-image-id="${image.id}">
                <img src="${escapeHtml(this._getImageThumbUrl(image.id, 320))}" alt="${escapeHtml(image.filename || '')}" loading="lazy">
                <div class="promptlab-image-picker-info">
                    <div class="promptlab-image-picker-name">${escapeHtml(image.filename || `Image ${image.id}`)}</div>
                    <div class="promptlab-image-picker-meta">${escapeHtml(this._formatPromptlabImageMeta(image) || this._t('promptlab.noImageMeta', 'No quick info yet'))}</div>
                </div>
            </div>
        `).join('');
    },

    selectImageFromPicker(imageId) {
        const meta = this._getPickerTargetMeta(this.imagePickerTarget);
        const select = document.getElementById(meta.selectId);
        if (select) {
            select.value = String(imageId);
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        this.closeImagePicker();
    },

});
