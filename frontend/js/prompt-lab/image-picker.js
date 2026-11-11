/**
 * prompt-lab/image-picker.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 180-376 (of 2,485):
 * image record/thumb/meta helpers, _ensureImageCatalog (newest 200, for the selects), the
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
        const picked = this._pickedRecords?.get(numericId);
        if (picked) return picked;
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
        if (image.width && image.height) parts.push(`${image.width}×${image.height}`);
        if (image.generator) parts.push(String(image.generator));
        if (image.checkpoint) {
            const checkpoint = String(image.checkpoint).replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || String(image.checkpoint);
            parts.push(checkpoint);
        }
        return parts.join(' · ');
    },

    _renderImagePreviewCard(targetId, imageId, emptyKey, emptyFallback) {
        const container = document.getElementById(targetId);
        if (!container) return;

        const image = this._getImageRecord(imageId);
        if (!image) {
            container.className = 'promptlab-image-preview-card promptlab-image-preview-empty';
            container.dataset.i18n = emptyKey;
            container.textContent = this._t(emptyKey, emptyFallback);
            return;
        }

        // The language refresh rewrites every [data-i18n] element's text: with
        // the empty-state key left on, the chosen picture's preview was replaced
        // by "choose a picture" again a moment after it appeared.
        container.removeAttribute('data-i18n');
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
        if (typeof window.App?.showModal === 'function') {
            // Escape closes it through closeImagePicker, which also forgets the target.
            window.App.showModal('promptlab-image-picker-modal', { onEscape: () => this.closeImagePicker() });
        } else {
            modal?.classList.add('visible');
        }
        this.renderImagePicker();
    },

    closeImagePicker() {
        if (typeof window.App?.hideModal === 'function') window.App.hideModal('promptlab-image-picker-modal');
        else document.getElementById('promptlab-image-picker-modal')?.classList.remove('visible');
        this.imagePickerTarget = '';
    },

    // The picker lists the whole library, newest first, a page at a time: the
    // next page arrives when the grid is scrolled near its end. A search works
    // the same way on its hits. (It used to stop at the newest 200.)
    PICKER_PAGE: 200,
    _picker: { query: '', images: [], cursor: null, hasMore: false, loading: false, run: 0, failed: '' },
    _pickedRecords: new Map(),

    renderImagePicker(isLoading = false) {
        const grid = document.getElementById('pl-image-picker-grid');
        if (!grid) return;

        if (isLoading) {
            grid.innerHTML = `<div class="promptlab-image-preview-empty">${escapeHtml(this._t('promptlab.loadingImages', 'Loading images...'))}</div>`;
            return;
        }

        this._bindPickerScroll(grid);
        const query = String(document.getElementById('pl-image-picker-search')?.value || '').trim();
        clearTimeout(this._searchPickerTimer);
        // Typing waits a moment before asking; opening the picker asks at once.
        this._searchPickerTimer = setTimeout(() => this._loadPickerPage(query, true), query ? 300 : 0);
    },

    _searchPickerTimer: null,

    _bindPickerScroll(grid) {
        if (grid.dataset.pagingBound === '1') return;
        grid.dataset.pagingBound = '1';
        grid.addEventListener('scroll', () => {
            const nearEnd = grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 600;
            if (nearEnd && this._picker.hasMore && !this._picker.loading) {
                this._loadPickerPage(this._picker.query, false);
            }
        });
    },

    async _loadPickerPage(query, fresh) {
        const grid = document.getElementById('pl-image-picker-grid');
        const count = document.getElementById('pl-image-picker-count');
        if (!grid) return;
        const state = this._picker;
        const api = window.App?.API;
        if (!api?.getImages) {
            state.images = this._getPromptLabImages();
            state.hasMore = false;
            this._renderPickerGrid(state.images, grid, count);
            return;
        }
        const run = fresh ? state.run + 1 : state.run;
        if (fresh) {
            Object.assign(state, { query, images: [], cursor: null, hasMore: false, failed: '', run });
        }
        state.loading = true;
        let page = [];
        try {
            const result = await api.getImages({
                sortBy: 'newest',
                limit: this.PICKER_PAGE,
                ...(query ? { search: query } : {}),
                ...(state.cursor ? { cursor: state.cursor } : {}),
            });
            if (run !== state.run) return; // a newer search took over
            page = Array.isArray(result?.images) ? result.images : [];
            state.images = fresh ? page : state.images.concat(page);
            state.cursor = result?.next_cursor || null;
            state.hasMore = Boolean(result?.has_more && state.cursor && page.length);
        } catch (error) {
            if (run !== state.run) return;
            state.hasMore = false;
            state.failed = error?.message || String(error);
        } finally {
            if (run === state.run) state.loading = false;
        }
        if (fresh) {
            this._renderPickerGrid(state.images, grid, count);
            grid.scrollTop = 0;
        } else {
            this._appendPickerCards(page, grid, count);
        }
    },

    _pickerCountText() {
        const state = this._picker;
        return state.hasMore
            ? this._t('promptlab.pickImageCountMore', '{count} shown, scroll for more', { count: state.images.length })
            : this._t('promptlab.pickImageCount', '{count} images', { count: state.images.length });
    },

    _pickerCardsHtml(images) {
        return images.map((image) => `
            <div class="promptlab-image-picker-card" data-image-id="${image.id}">
                <img src="${escapeHtml(this._getImageThumbUrl(image.id, 320))}" alt="${escapeHtml(image.filename || '')}" loading="lazy">
                <div class="promptlab-image-picker-info">
                    <div class="promptlab-image-picker-name">${escapeHtml(image.filename || `Image ${image.id}`)}</div>
                    <div class="promptlab-image-picker-meta">${escapeHtml(this._formatPromptlabImageMeta(image) || this._t('promptlab.noImageMeta', 'No quick info yet'))}</div>
                </div>
            </div>
        `).join('');
    },

    _renderPickerGrid(images, grid, count) {
        if (count) count.textContent = this._pickerCountText();

        if (this._picker.failed) {
            grid.innerHTML = `<div class="promptlab-image-preview-empty">${escapeHtml(this._t('promptlab.pickImageFailed', 'The pictures could not be loaded: {reason}', { reason: this._picker.failed }))}</div>`;
            return;
        }
        if (!images.length) {
            grid.innerHTML = `<div class="promptlab-image-preview-empty">${escapeHtml(this._t('promptlab.pickImageNoResults', 'No images matched this search.'))}</div>`;
            return;
        }

        grid.innerHTML = this._pickerCardsHtml(images);
    },

    _appendPickerCards(images, grid, count) {
        if (count) count.textContent = this._pickerCountText();
        if (this._picker.failed) {
            window.App?.showToast?.(this._t('promptlab.pickImageFailed', 'The pictures could not be loaded: {reason}', { reason: this._picker.failed }), 'error');
            return;
        }
        grid.insertAdjacentHTML('beforeend', this._pickerCardsHtml(images));
    },

    selectImageFromPicker(imageId) {
        const meta = this._getPickerTargetMeta(this.imagePickerTarget);
        const select = document.getElementById(meta.selectId);
        if (select) {
            // The selects list only the newest pictures; one picked from further
            // down gets an option of its own, or the select would fall back to
            // "nothing chosen" and the pick would be lost.
            const value = String(imageId);
            const record = this._picker.images.find((image) => String(image.id) === value);
            if (record) this._pickedRecords.set(Number(record.id), record);
            if (value && !Array.from(select.options).some((option) => option.value === value)) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = record?.filename || this._t('promptlab.imageOptionFallback', 'Image #{id}', { id: value });
                select.appendChild(option);
            }
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        this.closeImagePicker();
    },

});
