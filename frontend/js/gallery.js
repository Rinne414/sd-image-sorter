/**
 * SD Image Sorter - Gallery Module
 * Handles image grid display, preview modal, multi-selection and drag-and-drop
 * Supports virtual scrolling for large image collections (500+ images)
 */

function getGalleryAppContext() {
    const app = window.App || {};
    const appState = app.AppState || {
        images: [],
        filters: {},
        selectedIds: new Set(),
        selectionMode: false,
        selectionScope: 'visible',
        selectionFilterKey: null,
        selectionToken: null,
        selectionTotal: 0,
        viewMode: 'grid'
    };
    const cloneSelectionState = app.cloneSelectionState || ((selectionState) => ({
        selectionMode: Boolean(selectionState?.selectionMode),
        selectedIds: new Set(Array.from(selectionState?.selectedIds || [])),
        scope: selectionState?.scope || selectionState?.selectionScope || 'visible',
        filterKey: selectionState?.filterKey || selectionState?.selectionFilterKey || null,
        selectionToken: selectionState?.selectionToken || null,
        selectionTotal: Number(selectionState?.selectionTotal || 0) || 0,
    }));
    const setSelectionState = app.setSelectionState || ((nextSelection) => {
        const nextState = cloneSelectionState(nextSelection);
        appState.selectionMode = nextState.selectionMode;
        appState.selectedIds = nextState.selectedIds;
        appState.selectionScope = nextState.scope;
        appState.selectionFilterKey = nextState.filterKey || null;
        appState.selectionToken = nextState.selectionToken || null;
        appState.selectionTotal = Number(nextState.selectionTotal || 0) || 0;
        return nextState;
    });
    const updateSelectionState = app.updateSelectionState || ((updater) => {
        const draft = cloneSelectionState({
            selectionMode: appState.selectionMode,
            selectedIds: appState.selectedIds,
            scope: appState.selectionScope,
            filterKey: appState.selectionFilterKey,
            selectionToken: appState.selectionToken,
            selectionTotal: appState.selectionTotal,
        });
        const nextState = typeof updater === 'function'
            ? (updater(draft) ?? draft)
            : updater;
        return setSelectionState(nextState);
    });
    return {
        $: app.$ || ((selector) => document.querySelector(selector)),
        API: app.API || window.API,
        AppState: appState,
        updateSelectionState,
        updateSelectionUI: app.updateSelectionUI || window.updateSelectionUI,
        showModal: app.showModal || window.showModal,
        formatSize: app.formatSize || window.formatSize,
        showToast: app.showToast || window.showToast,
        getSelectedGalleryCount: app.getSelectedGalleryCount,
        isFilteredSelectionActiveForCurrentFilters: app.isFilteredSelectionActiveForCurrentFilters
    };
}

function getRequiredGalleryAPI() {
    const { API } = getGalleryAppContext();
    if (!API) {
        throw new Error('App API is not ready yet');
    }
    return API;
}

function selectionBaseForScope(selection, nextScope, { additive = true } = {}) {
    if (!additive) return new Set();

    const currentScope = selection?.scope || selection?.selectionScope || 'visible';
    if (currentScope === nextScope) {
        return new Set(selection?.selectedIds || []);
    }

    if (nextScope === 'visible' || currentScope === 'filtered') {
        return new Set();
    }

    return new Set(selection?.selectedIds || []);
}

function isGalleryImageSelected(AppState, imageId) {
    const app = window.App || {};
    const numericId = Number(imageId);
    const idIsExcluded = AppState.selectedIds.has(numericId) || AppState.selectedIds.has(String(imageId));
    if (AppState.selectionScope === 'filtered' && AppState.selectionToken) {
        const tokenStillValid = typeof app.isFilteredSelectionActiveForCurrentFilters === 'function'
            ? app.isFilteredSelectionActiveForCurrentFilters()
            : true;
        return tokenStillValid && !idIsExcluded;
    }
    return idIsExcluded;
}

/**
 * Gallery Virtual Scrolling Configuration
 */
const GALLERY_VIRTUAL_CONFIG = {
    bufferSize: 20,           // Items to render outside viewport (增加 10 → 20)
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
    reforge: '#a855f7',
    fooocus: '#ec4899',
    'easy-diffusion': '#14b8a6',
    invokeai: '#0ea5e9',
    swarmui: '#facc15',
    drawthings: '#f472b6',
    gemini: '#fbbf24',
    'gpt-image': '#10b981',
    others: '#94a3b8',
    unknown: '#64748b'
};

const Gallery = {
    images: [],
    loading: false,
    lastSelectedIndex: null,
    _languageBound: false,
    _analysisBound: false,
    _modalAnalysisRunning: new Set(),
    lazyObserver: null,
    currentPreviewIndex: -1,
    currentPreviewRequestId: 0,
    showAllTags: false,
    // v3.3.0 FEAT-COLLECTIONS: source-image ids currently in Favorites.
    // Hydrated from /api/collections/favorites/ids on load; kept in sync as
    // the user toggles hearts so re-renders show the correct state.
    favoriteIds: new Set(),
    modalSectionState: {
        prompt: true,
        negative: false,
        params: false,
        modelAssets: false,
        loras: false,
        nodes: false,
        color: false,
    },
    _histogramMode: 'rgb',

    // Virtual scrolling state
    virtualList: null,
    useVirtualScroll: false,
    // Owner FB-3: one thumbnail-size px shared by the toolbar slider, the
    // [ / ] shortcuts and every layout path. Lazily hydrated from the same
    // localStorage key the slider block in app.js persists.
    _thumbnailSizePx: null,
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

    // v3.3.0 FEAT-COLLECTIONS: favorite (heart) state + toggle.
    async hydrateFavorites() {
        try {
            const result = await window.App?.API?.getFavoriteIds?.();
            const ids = Array.isArray(result?.image_ids) ? result.image_ids : [];
            this.favoriteIds = new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)));
            this._applyFavoriteStateToDom();
        } catch (error) {
            window.App?.Logger?.warn?.('Failed to hydrate favorites:', error);
        }
    },

    isFavorited(imageId) {
        return this.favoriteIds.has(Number(imageId));
    },

    _favoriteButtonHtml(image) {
        const id = Number(image?.id);
        const on = this.favoriteIds.has(id);
        const title = this._t('collections.favoriteToggle', null, 'Favorite');
        return `<button type="button" class="gallery-item-fav${on ? ' is-favorited' : ''}" `
            + `data-fav-id="${id}" aria-pressed="${on ? 'true' : 'false'}" `
            + `title="${this._escapeHtml(title)}" aria-label="${this._escapeHtml(title)}">`
            + `<span aria-hidden="true">♥</span></button>`;
    },

    _applyFavoriteStateToDom() {
        document.querySelectorAll('#gallery-grid .gallery-item[data-id]').forEach((item) => {
            const id = Number(item.dataset.id);
            const btn = item.querySelector('.gallery-item-fav');
            if (btn) {
                const on = this.favoriteIds.has(id);
                btn.classList.toggle('is-favorited', on);
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        });
    },

    async toggleFavorite(imageId) {
        const app = window.App || {};
        const id = Number(imageId);
        const next = !this.favoriteIds.has(id);
        // Optimistic update with rollback on failure.
        if (next) this.favoriteIds.add(id); else this.favoriteIds.delete(id);
        this._applyFavoriteStateToDom();
        try {
            const result = await app.API?.setFavorite?.(id, next);
            const favorited = Boolean(result?.favorited);
            if (favorited) this.favoriteIds.add(id); else this.favoriteIds.delete(id);
            this._applyFavoriteStateToDom();
            // v3.3.1 FEAT-COLLECTIONS: refresh the sidebar Favorites count.
            window.CollectionsUI?.notifyChanged?.();
        } catch (error) {
            // Roll back.
            if (next) this.favoriteIds.delete(id); else this.favoriteIds.add(id);
            this._applyFavoriteStateToDom();
            app.showToast?.(
                app.appT?.('collections.favoriteFailed', 'Could not update favorite') || 'Could not update favorite',
                'error'
            );
        }
    },

    // v3.3.3 WIRING-01: user star rating (0-5). The backend was fully built
    // (POST /api/images/{id}/rating, min_user_rating filter, user_rating sort,
    // migration 015) but the frontend surfaced none of it. The value rides on
    // each image object (image.user_rating), so unlike favorites there is no
    // separate id-set to hydrate — we read/patch it in place.
    _userRatingOf(image) {
        const n = Number(image?.user_rating);
        return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n) : 0;
    },

    _ratingBadgeHtml(image) {
        const stars = this._userRatingOf(image);
        if (stars <= 0) return '';
        const label = this._t('rating.cardLabel', { stars }, `${stars}/5 stars`);
        return `<span class="gallery-item-stars" data-rating-badge `
            + `title="${this._escapeHtml(label)}" aria-label="${this._escapeHtml(label)}">`
            + `${'★'.repeat(stars)}</span>`;
    },

    _renderModalRating(image) {
        const container = document.getElementById('modal-user-rating');
        if (!container) return;
        const stars = this._userRatingOf(image);
        const id = Number(image?.id);
        container.dataset.imageId = Number.isFinite(id) ? String(id) : '';
        container.dataset.rating = String(stars);
        const starLabel = (n) => this._t('rating.setStars', { stars: n }, `Rate ${n}/5`);
        let html = '';
        for (let n = 1; n <= 5; n++) {
            html += `<button type="button" class="star${n <= stars ? ' is-filled' : ''}" data-star="${n}" `
                + `role="radio" aria-checked="${n === stars ? 'true' : 'false'}" `
                + `title="${this._escapeHtml(starLabel(n))}" aria-label="${this._escapeHtml(starLabel(n))}">★</button>`;
        }
        const clearLabel = this._t('rating.clear', null, 'Clear rating');
        html += `<button type="button" class="star-clear${stars === 0 ? ' is-hidden' : ''}" data-star="0" `
            + `title="${this._escapeHtml(clearLabel)}" aria-label="${this._escapeHtml(clearLabel)}">✕</button>`;
        container.innerHTML = html;
        if (!container.dataset.bound) {
            container.dataset.bound = '1';
            container.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-star]');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                const value = Number(btn.dataset.star);
                const imageId = Number(container.dataset.imageId);
                if (Number.isFinite(imageId)) this.setUserRating(imageId, value);
            });
        }
    },

    _applyRatingToState(imageId, value) {
        const id = Number(imageId);
        let prev = 0;
        const apply = (list) => {
            if (!Array.isArray(list)) return;
            const img = list.find((image) => Number(image?.id) === id);
            if (img) { prev = this._userRatingOf(img); img.user_rating = value; }
        };
        apply(this.images);
        apply(window.App?.AppState?.images);
        return prev;
    },

    _renderRatingEverywhere(imageId, value) {
        const id = Number(imageId);
        const modal = document.getElementById('modal-user-rating');
        if (modal && Number(modal.dataset.imageId) === id) {
            this._renderModalRating({ id, user_rating: value });
        }
        const item = document.querySelector(`#gallery-grid .gallery-item[data-id="${id}"]`);
        if (item) {
            const existing = item.querySelector('[data-rating-badge]');
            const html = this._ratingBadgeHtml({ id, user_rating: value });
            if (existing) {
                if (html) existing.outerHTML = html; else existing.remove();
            } else if (html) {
                const anchor = item.querySelector('.gallery-item-media') || item;
                anchor.insertAdjacentHTML('beforeend', html);
            }
        }
    },

    async setUserRating(imageId, stars) {
        const app = window.App || {};
        const id = Number(imageId);
        const value = Math.max(0, Math.min(5, Math.round(Number(stars) || 0)));
        // Optimistic update with rollback on failure (mirrors toggleFavorite).
        const prev = this._applyRatingToState(id, value);
        this._renderRatingEverywhere(id, value);
        try {
            const result = await app.API?.setRating?.(id, value);
            const saved = Number(result?.user_rating);
            const finalVal = Number.isFinite(saved) ? saved : value;
            this._applyRatingToState(id, finalVal);
            this._renderRatingEverywhere(id, finalVal);
        } catch (error) {
            this._applyRatingToState(id, prev);
            this._renderRatingEverywhere(id, prev);
            app.showToast?.(
                app.appT?.('rating.failed', 'Could not update rating') || 'Could not update rating',
                'error'
            );
        }
    },

    // FLOW-03: route the currently-previewed image into the next pipeline step.
    // Reuses the exact functions the right-click context menu calls, so behavior
    // stays consistent. View-switching handoffs close the modal first; "collection"
    // overlays a picker so the modal is left underneath.
    _handleModalHandoff(action) {
        const app = window.App || {};
        const id = this._currentPreviewId;
        if (!id) return;
        const image = this.images.find((im) => Number(im.id) === Number(id))
            || app.AppState?.images?.find((im) => Number(im.id) === Number(id));
        const filename = (image && image.filename) || '';
        const closeModal = () => {
            const fn = app.closeModal || window.closeModal || window.hideModal;
            if (typeof fn === 'function') fn('image-modal');
        };
        switch (action) {
            case 'censor':
                if (typeof app.addToCensorQueue === 'function') app.addToCensorQueue([id]);
                else app.showToast?.(app.appT?.('gallery.contextSendToCensorFailed', 'Failed to send image to Edit') || 'Failed', 'error');
                closeModal();
                break;
            case 'similar':
                app.openSimilarFromImage?.(id);
                closeModal();
                break;
            case 'dataset':
                if (typeof app.addToDatasetMaker === 'function') {
                    app.addToDatasetMaker([id], { switchView: true, showToast: true })
                        .then((ok) => { if (ok) closeModal(); });
                } else {
                    app.showToast?.(app.appT?.('selection.sendToDatasetMakerUnavailable', 'Dataset Maker module not loaded yet — try again in a moment.') || 'Dataset Maker not loaded yet', 'error');
                }
                break;
            case 'collection':
                // Picker overlays on top; keep the image modal underneath so the
                // user returns to the image after choosing a collection.
                window.CollectionsUI?.openAddToCollectionPicker?.([id]);
                break;
            case 'prompt':
                app.openPromptBuildFromImage?.(id);
                closeModal();
                break;
            case 'reader':
                app.openReaderFromImage?.(id, filename);
                closeModal();
                break;
            default:
                break;
        }
    },

    _patchImageState(imageId, patch = {}) {
        const id = Number(imageId);
        const apply = (list) => {
            if (!Array.isArray(list)) return;
            const image = list.find((item) => Number(item?.id) === id);
            if (image) Object.assign(image, patch);
        };
        apply(this.images);
        apply(window.App?.AppState?.images);
        if (this._lastModalImage && Number(this._lastModalImage.id) === id) {
            Object.assign(this._lastModalImage, patch);
        }
    },

    _buildColorAnalysisPatch(colorData = {}) {
        const patch = {};
        [
            'dominant_colors',
            'avg_brightness',
            'color_temperature',
            'color_saturation',
            'brightness_distribution',
            'brightness_histogram',
            'brightness_skew',
        ].forEach((field) => {
            if (Object.prototype.hasOwnProperty.call(colorData, field)) {
                patch[field] = colorData[field];
            }
        });
        return patch;
    },

    _modalAnalysisActions: new Set(['aesthetic', 'color', 'artist', 'caption']),

    _syncModalAnalysisButtons() {
        const anyBusy = this._modalAnalysisRunning.size > 0;
        document.querySelectorAll('[data-modal-analysis]').forEach((button) => {
            const action = button.dataset.modalAnalysis;
            const busy = anyBusy;
            const actionBusy = this._modalAnalysisRunning.has(action);
            button.disabled = anyBusy;
            button.classList.toggle('is-busy', busy);
            button.classList.toggle('is-running-action', actionBusy);
            button.setAttribute('aria-busy', busy ? 'true' : 'false');
            button.setAttribute('aria-disabled', anyBusy ? 'true' : 'false');
        });
    },

    _setModalAnalysisBusy(action, busy) {
        if (busy) this._modalAnalysisRunning.add(action);
        else this._modalAnalysisRunning.delete(action);
        this._syncModalAnalysisButtons();
    },

    async _refreshCurrentPreviewDetails(imageId) {
        if (Number(this._currentPreviewId) !== Number(imageId)) return;
        const api = getRequiredGalleryAPI();
        const result = await api.getImage(imageId);
        if (Number(this._currentPreviewId) !== Number(imageId)) return;
        this._hydratePreview(result.image, result.tags);
    },

    _getArtistSinglePayload(imageId) {
        const artist = window.ArtistIdent;
        const threshold = Number(artist?.getThresholdValue?.());
        let modelConfig = {};
        if (artist && typeof artist._getIdentifyModelConfig === 'function') {
            modelConfig = artist._getIdentifyModelConfig();
        } else {
            const modelSource = String(document.getElementById('artist-model-source')?.value || 'huggingface').trim() || 'huggingface';
            const modelPath = String(document.getElementById('artist-model-path')?.value || '').trim();
            modelConfig = {
                model_source: modelSource,
                model_path: modelSource === 'local' ? modelPath : null,
                use_gpu: document.getElementById('artist-use-gpu') ? !!document.getElementById('artist-use-gpu').checked : null,
            };
        }
        return {
            image_id: Number(imageId),
            threshold: Number.isFinite(threshold) ? threshold : 0.03,
            top_k: 5,
            ...modelConfig,
        };
    },

    async _handleModalAnalysis(action) {
        const app = window.App || {};
        const api = getRequiredGalleryAPI();
        const showToast = app.showToast || window.showToast;
        const id = Number(this._currentPreviewId);
        if (!this._modalAnalysisActions.has(action) || !Number.isFinite(id) || this._modalAnalysisRunning.size > 0) return;

        this._setModalAnalysisBusy(action, true);
        try {
            if (action === 'aesthetic') {
                const result = await api.post(`/api/aesthetic/score/${id}`);
                const score = Number(result?.aesthetic_score);
                if (Number.isFinite(score)) {
                    this._patchImageState(id, { aesthetic_score: score });
                    if (Number(this._currentPreviewId) === id && this._lastModalImage && this._lastParsedData) {
                        this._renderModalSections(this._lastModalImage, this._lastParsedData);
                    }
                }
                await app.refreshAestheticStatus?.();
                const scoreText = Number.isFinite(score) ? score.toFixed(2) : '-';
                showToast?.(
                    this._t('modal.scoreThisDone', { score: scoreText }, 'Aesthetic score updated: {score}').replace('{score}', scoreText),
                    'success'
                );
                return;
            }

            if (action === 'color') {
                const result = await api.post(`/api/colors/analyze-single/${id}`);
                if (result?.color_data) {
                    const colorPatch = this._buildColorAnalysisPatch(result.color_data);
                    if (Object.keys(colorPatch).length > 0) {
                        this._patchImageState(id, colorPatch);
                    }
                }
                await window.ColorBackfill?.refreshProgress?.();
                showToast?.(this._t('modal.colorsThisDone', null, 'Color analysis updated'), 'success');
                return;
            }

            if (action === 'artist') {
                const result = await api.post('/api/artists/identify', this._getArtistSinglePayload(id));
                await window.ArtistIdent?.loadStats?.();
                const artistName = result?.artist || 'undefined';
                const confidence = Number(result?.confidence);
                const confidenceText = Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : '-';
                showToast?.(
                    this._t('modal.artistThisDone', { artist: artistName, confidence: confidenceText }, 'Artist: {artist} ({confidence})')
                        .replace('{artist}', artistName)
                        .replace('{confidence}', confidenceText),
                    'success'
                );
                return;
            }

            if (action === 'caption') {
                const tags = (this._lastModalTags || [])
                    .map((tag) => tag?.tag)
                    .filter(Boolean);
                const result = await api.post('/api/vlm/caption', { image_id: id, tags });
                if (result?.error) {
                    throw new Error(result.error);
                }
                if (result?.caption) {
                    this._patchImageState(id, { ai_caption: result.caption, nl_caption: result.caption });
                    if (Number(this._currentPreviewId) === id && this._lastModalImage) {
                        this._renderModalCaption(this._lastModalImage);
                    }
                }
                await this._refreshCurrentPreviewDetails(id);
                await app.loadImages?.();
                showToast?.(this._t('modal.captionThisDone', null, 'Caption updated'), 'success');
            }
        } catch (error) {
            showToast?.(
                formatUserError(error, this._t('modal.analysisThisFailed', null, 'This image analysis failed')),
                'error'
            );
        } finally {
            this._setModalAnalysisBusy(action, false);
        }
    },

    _normalizeGenerator(generator) {
        const normalized = String(generator || 'unknown').trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(DEFAULT_GENERATOR_COLORS, normalized)
            ? normalized
            : 'unknown';
    },

    _formatGeneratorLabel(generator) {
        return window.App?.formatGeneratorLabel?.(generator, 'Unknown')
            || String(generator || 'unknown');
    },

    _setGeneratorText(element, generator) {
        if (!element) return;
        const normalized = this._normalizeGenerator(generator);
        element.dataset.generatorValue = normalized;
        element.textContent = this._formatGeneratorLabel(normalized);
    },

    /**
     * Show or hide the "metadata-only detection" hint shown for
     * closed-source AI providers (Gemini / gpt-image) where we
     * identified the source via Content Credentials / EXIF rather
     * than the in-pixel invisible watermark. The note keeps the user
     * aware that we have NOT verified Google's SynthID or OpenAI's
     * pixel signal directly. Stay in sync with
     * backend/metadata_parser.py::MetadataParser._maybe_detect_ai_provider.
     */
    _updateAiProviderNote(generator) {
        const note = document.getElementById('modal-ai-provider-note');
        if (!note) return;
        const text = document.getElementById('modal-ai-provider-text');
        const id = String(generator || '').trim().toLowerCase();
        if (id === 'gemini') {
            if (text) {
                text.setAttribute('data-i18n', 'modal.aiProviderNote.gemini');
                text.textContent = this._t(
                    'modal.aiProviderNote.gemini',
                    null,
                    'Identified via Content Credentials / EXIF metadata. Google\'s invisible SynthID watermark embedded in the pixels themselves is not yet checked by this app — planned for a future opt-in detector.'
                );
            }
            note.style.display = '';
            note.dataset.provider = 'gemini';
            return;
        }
        if (id === 'gpt-image') {
            if (text) {
                // Swap the data-i18n attribute so the global i18n
                // re-translate cycle (which honours data-i18n on every
                // child element) updates the gpt-image text instead of
                // resetting it to the gemini key the HTML markup ships
                // with.
                text.setAttribute('data-i18n', 'modal.aiProviderNote.gptImage');
                text.textContent = this._t(
                    'modal.aiProviderNote.gptImage',
                    null,
                    'Identified via Content Credentials / EXIF metadata. OpenAI\'s invisible in-pixel watermark is not yet checked by this app and currently has no public open-source detector.'
                );
            }
            note.style.display = '';
            note.dataset.provider = 'gpt-image';
            return;
        }
        note.style.display = 'none';
        delete note.dataset.provider;
    },

    refreshLocalizedContent() {
        const { AppState } = getGalleryAppContext();
        document.querySelectorAll('#gallery-grid .gallery-item').forEach((item) => {
            const imageId = item.dataset.id;
            const image = AppState.images.find((entry) => String(entry.id) === String(imageId));
            const generator = image?.generator || item.querySelector('.gallery-item-generator')?.dataset.generatorValue || 'unknown';
            const generatorLabel = this._formatGeneratorLabel(generator);
            const generatorEl = item.querySelector('.gallery-item-generator');
            if (generatorEl) {
                this._setGeneratorText(generatorEl, generator);
            }
            item.setAttribute('aria-label', `${image?.filename || 'Image'} - ${generatorLabel}`);
        });

        const modalGenerator = document.getElementById('modal-generator');
        if (modalGenerator?.dataset.generatorValue) {
            modalGenerator.textContent = this._formatGeneratorLabel(modalGenerator.dataset.generatorValue);
        }
    },

    _bindLanguageUpdates() {
        if (this._languageBound) return;
        document.addEventListener('languageChanged', () => this.refreshLocalizedContent());
        this._languageBound = true;
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

    _fallbackParseMeta(metaObj, image) {
        return {
            generation_params: {},
            is_img2img: false,
            img2img_info: {},
            character_prompts: [],
            prompt_nodes: [],
            model_assets: null,
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

    _renderModalModelAssets(parsedData) {
        const section = document.querySelector('#modal-model-assets-section');
        const grid = document.querySelector('#modal-model-assets-grid');
        if (!section || !grid) return;

        const assets = parsedData?.model_assets || null;
        const hasAssets = assets && (
            assets.primary_model_name ||
            (assets.loras && assets.loras.length) ||
            (assets.yolo_models && assets.yolo_models.length) ||
            (assets.checkpoint_candidates && assets.checkpoint_candidates.length) ||
            (assets.unet_candidates && assets.unet_candidates.length) ||
            (assets.vae_candidates && assets.vae_candidates.length) ||
            (assets.clip_candidates && assets.clip_candidates.length) ||
            (assets.diffusion_model_candidates && assets.diffusion_model_candidates.length) ||
            (assets.model_candidates && assets.model_candidates.length) ||
            (assets.yolo_candidates && assets.yolo_candidates.length) ||
            (assets.global_lora_candidates && assets.global_lora_candidates.length) ||
            (assets.global_yolo_candidates && assets.global_yolo_candidates.length)
        );

        if (!hasAssets) {
            section.style.display = 'none';
            grid.innerHTML = '';
            return;
        }

        const t = (key, fallback) => this._t(key, null, fallback);
        const blocks = [];
        const humanizeSource = (value) => {
            if (!value) return '';
            if (value === 'activity_subgraph_fallback') return t('modal.modelAssetsSourceActivity', 'Active subgraph fallback');
            if (value === 'global_candidate_fallback') return t('modal.modelAssetsSourceGlobal', 'Global candidate fallback');
            if (value === 'global_graph_fallback') return t('modal.modelAssetsSourceGraph', 'Full graph fallback');
            if (value === 'fast_path') return t('modal.modelAssetsSourceFastPath', 'Fast path');
            return String(value).replace(/_/g, ' ');
        };
        const humanizeConfidence = (value) => {
            if (value === 'high') return t('modal.modelAssetsConfidenceHigh', 'High confidence');
            if (value === 'medium') return t('modal.modelAssetsConfidenceMedium', 'Medium confidence');
            if (value === 'low') return t('modal.modelAssetsConfidenceLow', 'Low confidence');
            return '';
        };
        const addListBlock = (label, values) => {
            if (!Array.isArray(values) || values.length === 0) return;
            const uniqueValues = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
            if (!uniqueValues.length) return;
            blocks.push(`
                <div class="model-asset-block">
                    <div class="param-item"><span class="param-label">${window.escapeHtml(label)}</span></div>
                    <div class="model-asset-list">
                        ${uniqueValues.map((value) => `<span class="model-asset-pill">${window.escapeHtml(value)}</span>`).join('')}
                    </div>
                </div>
            `);
        };
        const addCandidateBlock = (label, items) => {
            if (!Array.isArray(items) || items.length === 0) return;
            const uniqueItems = [];
            const seenNames = new Set();
            for (const item of items) {
                const name = String(item?.name || '').trim();
                if (!name || seenNames.has(name)) continue;
                seenNames.add(name);
                uniqueItems.push(item);
            }
            if (!uniqueItems.length) return;

            blocks.push(`
                <div class="model-asset-block model-asset-block-secondary">
                    <div class="param-item"><span class="param-label">${window.escapeHtml(label)}</span></div>
                    <div class="model-asset-candidate-list">
                        ${uniqueItems.map((item) => {
                            const metaParts = [
                                humanizeSource(item?.source_mode),
                                item?.node_id ? `${t('modal.modelAssetsNode', 'Node')} ${item.node_id}` : '',
                                item?.class_type ? String(item.class_type) : '',
                                item?.key_path ? String(item.key_path) : (item?.input_key ? String(item.input_key) : ''),
                            ].filter(Boolean);
                            const confidence = String(item?.confidence || 'low').toLowerCase();
                            return `
                                <div class="model-asset-candidate model-asset-candidate-secondary">
                                    <div class="model-asset-candidate-head">
                                        <span class="model-asset-pill">${window.escapeHtml(String(item?.name || ''))}</span>
                                        <span class="model-asset-confidence is-${window.escapeHtml(confidence)}">${window.escapeHtml(humanizeConfidence(confidence))}</span>
                                    </div>
                                    <div class="model-asset-candidate-meta">${window.escapeHtml(metaParts.join(' • '))}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `);
        };

        if (assets.primary_model_name) {
            const primaryModelType = assets.primary_model_type || t('generator.unknown', 'Unknown');
            blocks.push(`
                <div class="model-asset-block">
                    <div class="param-item"><span class="param-label">${window.escapeHtml(t('modal.primaryModel', 'Primary Model'))}</span><span class="param-value">${window.escapeHtml(assets.primary_model_name)}</span></div>
                    <div class="param-item"><span class="param-label">${window.escapeHtml(t('modal.primaryModelType', 'Primary Model Type'))}</span><span class="param-value">${window.escapeHtml(primaryModelType)}</span></div>
                </div>
            `);
        }

        if (assets.source) {
            blocks.push(`
                <div class="model-asset-block">
                    <div class="param-item"><span class="param-label">${window.escapeHtml(t('modal.modelAssetsSource', 'Parser Source'))}</span><span class="param-value">${window.escapeHtml(humanizeSource(assets.source))}</span></div>
                </div>
            `);
        }
        if (Array.isArray(assets.sources) && assets.sources.length > 1) {
            addListBlock(t('modal.modelAssetsSources', 'All Sources'), assets.sources.map((value) => humanizeSource(value)));
        }

        addListBlock(t('modal.modelAssetsCheckpoints', 'Checkpoint Candidates'), (assets.checkpoint_candidates || []).map((item) => item.name));
        addListBlock(t('modal.modelAssetsUnets', 'UNet Candidates'), (assets.unet_candidates || []).map((item) => item.name));
        addListBlock(t('modal.modelAssetsVae', 'VAE'), (assets.vae_candidates || []).map((item) => item.name));
        addListBlock(t('modal.modelAssetsClip', 'CLIP / Text Encoder'), (assets.clip_candidates || []).map((item) => item.name));
        addListBlock(t('modal.modelAssetsDiffusion', 'Diffusion Candidates'), (assets.diffusion_model_candidates || []).map((item) => item.name));
        addListBlock(t('modal.modelAssetsModels', 'Additional / Upscale / ControlNet Models'), (assets.model_candidates || []).map((item) => item.name));

        const loraDetails = parsedData?.generation_params?.lora_details || [];
        const loraDetailMap = new Map();
        for (const detail of loraDetails) {
            if (detail?.name) loraDetailMap.set(detail.name, detail);
        }
        const loraNames = (assets.lora_candidates || []).map((item) => {
            const detail = loraDetailMap.get(item.name);
            if (detail && typeof detail.strength_model === 'number') {
                const sm = detail.strength_model;
                const sc = detail.strength_clip;
                if (typeof sc === 'number' && sc !== sm) {
                    return `${item.name}  (M:${sm} / C:${sc})`;
                }
                return `${item.name}  (${sm})`;
            }
            return item.name;
        });
        addListBlock(t('modal.modelAssetsLoras', 'LoRAs'), loraNames);
        addListBlock(t('modal.modelAssetsYolo', 'YOLO / Detector Models'), assets.yolo_models || (assets.yolo_candidates || []).map((item) => item.name));
        addCandidateBlock(t('modal.modelAssetsGlobalLoras', 'Global LoRA Candidates'), assets.global_lora_candidates || []);
        addCandidateBlock(t('modal.modelAssetsGlobalYolo', 'Full-graph YOLO Candidates'), assets.global_yolo_candidates || []);

        grid.innerHTML = blocks.join('');
        section.style.display = '';
    },

    _applyModalPromptView(promptView) {
        const promptText = document.querySelector('#modal-prompt-text');
        const negSection = document.querySelector('#modal-negative-section');
        const negText = document.querySelector('#modal-negative-text');
        const promptHeader = document.querySelector('.modal-prompt h4');
        const toggleBtn = document.querySelector('#btn-toggle-prompt-format');
        const alternateTarget = this._getAlternatePromptTarget(promptView.sourceFormat);

        if (promptText) {
            // Metadata L3: a ComfyUI/unknown image with no prompt usually
            // means the graph's text lives at runtime (wildcards, dynamic
            // prompts) or was stripped — say so instead of a bare "No prompt".
            const generator = String(this._lastModalImage?.generator || '').toLowerCase();
            const isUnrecoverable = !promptView.promptText
                && (generator === 'comfyui' || generator === 'unknown');
            promptText.textContent = promptView.promptText
                || (isUnrecoverable
                    ? this._t('modal.promptUnrecoverable', null, 'No prompt could be recovered from this file — it may be generated at runtime (wildcards / dynamic prompts) or stripped on export.')
                    : this._t('modal.noPrompt', null, 'No prompt'));
            promptText.classList.toggle('prompt-unrecoverable-note', isUnrecoverable);
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
            // Write into the label span so the collapse icon survives.
            const headerLabel = promptHeader.querySelector('.section-toggle-label');
            (headerLabel || promptHeader).textContent = this._t(promptView.headerKey || 'modal.prompt', null, fallbackLabel);
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
            const checkpointFilterValue = window.App?.normalizeCheckpointFilterValue?.(
                image.checkpoint_normalized || image.checkpoint
            ) || '';
            cpItem.style.display = '';
            cpText.textContent = image.checkpoint;
            // Make checkpoint clickable to filter
            cpText.classList.add('modal-checkpoint-clickable');
            cpText.style.cursor = 'pointer';
            cpText.onclick = () => {
                const AppState = window.App?.AppState;
                if (AppState && checkpointFilterValue) {
                    if (!AppState.filters.checkpoints.includes(checkpointFilterValue)) {
                        window.App?.updateFilters?.((filters) => {
                            filters.checkpoints = [...filters.checkpoints, checkpointFilterValue];
                        });
                    }
                    const closeModal = window.App?.closeModal || window.closeModal;
                    closeModal?.('image-modal');
                    window.App?.updateFilterSummary?.();
                    window.App?.loadImages?.();
                }
            };
        } else {
            cpItem.style.display = 'none';
        }

        // --- Aesthetic Score ---
        const aeItem = $('#modal-aesthetic-item');
        const aeText = $('#modal-aesthetic-score');
        if (aeItem && aeText) {
            if (image.aesthetic_score != null) {
                aeItem.style.display = '';
                aeText.textContent = `${Number(image.aesthetic_score).toFixed(2)} / 10`;
                aeText.style.color = image.aesthetic_score >= 6 ? '#22c55e' : image.aesthetic_score >= 4 ? '#f59e0b' : '#ef4444';
            } else {
                aeItem.style.display = 'none';
            }
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
            lorasList.innerHTML = loras.map(l => `<span class="lora-pill modal-lora-clickable" data-lora="${window.escapeHtml(l)}">${window.escapeHtml(l)}</span>`).join('');
            // Attach click handlers to filter by LoRA
            lorasList.querySelectorAll('.modal-lora-clickable').forEach(el => {
                el.addEventListener('click', () => {
                    const lora = el.dataset.lora;
                    const AppState = window.App?.AppState;
                    if (AppState && lora) {
                        if (!AppState.filters.loras.includes(lora)) {
                            window.App?.updateFilters?.((filters) => {
                                filters.loras = [...filters.loras, lora];
                            });
                        }
                        const closeModal = window.App?.closeModal || window.closeModal;
                        closeModal?.('image-modal');
                        window.App?.updateFilterSummary?.();
                        window.App?.loadImages?.();
                    }
                });
            });
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

        this._renderModalModelAssets(parsedData);

        // --- Civitai Resources ---
        const civitaiSection = $('#modal-civitai-section');
        const civitaiList = $('#modal-civitai-list');
        const civitaiResources = parsedData?.civitai_resources;
        if (Array.isArray(civitaiResources) && civitaiResources.length > 0) {
            civitaiSection.style.display = '';
            civitaiList.innerHTML = civitaiResources.map(resource => {
                const modelName = window.escapeHtml(resource.model_name || 'Unknown Model');
                const versionName = resource.version_name
                    ? ` <span class="civitai-version">${window.escapeHtml(resource.version_name)}</span>`
                    : '';
                const weight = resource.weight != null
                    ? ` <span class="civitai-weight">(weight: ${resource.weight})</span>`
                    : '';
                const link = resource.civitai_url
                    ? ` <a href="${window.escapeHtml(resource.civitai_url)}" target="_blank" rel="noopener noreferrer" class="civitai-link">View on Civitai →</a>`
                    : '';
                return `<li><strong>${modelName}</strong>${versionName}${weight}${link}</li>`;
            }).join('');
        } else {
            civitaiSection.style.display = 'none';
            civitaiList.innerHTML = '';
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
            const collapseKey = toggle.dataset.collapseKey;

            const icon = toggle.querySelector('.collapse-icon');
            const isCollapsed = target.style.display === 'none';

            if (isCollapsed) {
                target.style.display = '';
                if (icon) icon.textContent = '▼';
                toggle.classList.remove('section-collapsed');
                if (collapseKey) this.modalSectionState[collapseKey] = true;
            } else {
                target.style.display = 'none';
                if (icon) icon.textContent = '▶';
                toggle.classList.add('section-collapsed');
                if (collapseKey) this.modalSectionState[collapseKey] = false;
            }
        });

        document.addEventListener('click', (e) => {
            const button = e.target.closest('.modal-color-mode-btn');
            if (!button) return;
            this._histogramMode = button.dataset.histogramMode || 'rgb';
            document.querySelectorAll('.modal-color-mode-btn').forEach((node) => {
                node.classList.toggle('active', node === button);
            });
            const imgEl = document.getElementById('modal-image');
            if (imgEl) this._extractColorDistribution(imgEl);
        });
    },

    _applyModalSectionStates() {
        document.querySelectorAll('#image-modal .section-toggle').forEach((toggle) => {
            const targetId = toggle.dataset.target;
            const collapseKey = toggle.dataset.collapseKey;
            if (!targetId || !collapseKey) return;
            const target = document.getElementById(targetId);
            if (!target) return;
            const expanded = this.modalSectionState[collapseKey] !== false;
            target.style.display = expanded ? '' : 'none';
            toggle.classList.toggle('section-collapsed', !expanded);
            const icon = toggle.querySelector('.collapse-icon');
            if (icon) icon.textContent = expanded ? '▼' : '▶';
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

    // ============== FLOW-02: inline tag editing in the preview modal ==============
    // Tags could only be edited in Dataset / Mass Tag — never where you actually
    // look at the image. The ✎ Edit toggle turns the read-only tag list into
    // removable chips + an add box; Save diffs against the original and commits
    // through the single-image scope of the bulk add/remove endpoints. AI rating
    // tags (general/sensitive/...) stay read-only — they're model output, not
    // user vocabulary.
    _ratingTagNames() {
        return ['general', 'sensitive', 'questionable', 'explicit'];
    },

    _bindTagEditOnce() {
        if (this._tagEditBound) return;
        this._tagEditBound = true;
        document.querySelector('#btn-edit-modal-tags')?.addEventListener('click', () => {
            if (this._tagsEditMode) this._exitTagEdit(); else this._enterTagEdit();
        });
        document.querySelector('#btn-cancel-modal-tags')?.addEventListener('click', () => this._exitTagEdit());
        document.querySelector('#btn-save-modal-tags')?.addEventListener('click', () => this._saveModalTags());
        const input = document.querySelector('#modal-tags-add-input');
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                // When the tag autocomplete dropdown is open, Enter belongs
                // to the suggestion accept (listener order is not reliable
                // between same-node handlers, so check state instead).
                if (window.CaptionAutocomplete?.isOpen?.()) return;
                e.preventDefault();
                this._addTagFromInput();
            }
        });
    },

    _enterTagEdit() {
        const ratings = this._ratingTagNames();
        const otherTags = (this._lastModalTags || []).filter(t => !ratings.includes(t.tag));
        this._tagEditWorking = otherTags.map(t => t.tag);
        this._tagEditOriginal = [...this._tagEditWorking];
        this._tagsEditMode = true;
        const list = document.querySelector('#modal-tags-list');
        const editor = document.querySelector('#modal-tags-editor');
        if (list) { list.hidden = true; list.style.display = 'none'; }
        if (editor) editor.hidden = false;
        const editBtn = document.querySelector('#btn-edit-modal-tags');
        if (editBtn) editBtn.classList.add('active');
        this._renderTagEditChips();
        const input = document.querySelector('#modal-tags-add-input');
        if (input) { input.value = ''; input.focus(); }
    },

    _exitTagEdit() {
        this._tagsEditMode = false;
        const list = document.querySelector('#modal-tags-list');
        const editor = document.querySelector('#modal-tags-editor');
        if (editor) editor.hidden = true;
        if (list) { list.hidden = false; list.style.display = ''; }
        const editBtn = document.querySelector('#btn-edit-modal-tags');
        if (editBtn) editBtn.classList.remove('active');
    },

    _renderTagEditChips() {
        const wrap = document.querySelector('#modal-tags-edit-chips');
        if (!wrap) return;
        wrap.innerHTML = (this._tagEditWorking || []).map((tag, i) =>
            `<span class="tag tag-editable">${this._escapeHtml(tag)}<button type="button" class="tag-remove" data-idx="${i}" aria-label="Remove tag">×</button></span>`
        ).join('');
        wrap.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.idx);
                if (Number.isInteger(idx)) {
                    this._tagEditWorking.splice(idx, 1);
                    this._renderTagEditChips();
                }
            });
        });
    },

    _addTagFromInput() {
        const input = document.querySelector('#modal-tags-add-input');
        if (!input) return;
        const raw = (input.value || '').trim();
        if (!raw) return;
        // Accept comma-separated input; normalize to lowercase to match WD14 vocab.
        raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(tag => {
            if (!this._tagEditWorking.includes(tag)) this._tagEditWorking.push(tag);
        });
        input.value = '';
        this._renderTagEditChips();
        input.focus();
    },

    async _saveModalTags() {
        const id = Number(this._currentPreviewId);
        if (!id) { this._exitTagEdit(); return; }
        // Fold any text still sitting in the add box into the working set first.
        this._addTagFromInput();
        const original = new Set(this._tagEditOriginal || []);
        const working = new Set(this._tagEditWorking || []);
        const added = [...working].filter(t => !original.has(t));
        const removed = [...original].filter(t => !working.has(t));
        if (added.length === 0 && removed.length === 0) { this._exitTagEdit(); return; }

        const app = window.App || {};
        const api = app.API;
        const saveBtn = document.querySelector('#btn-save-modal-tags');
        if (saveBtn) saveBtn.disabled = true;
        try {
            if (added.length) {
                await api.post('/api/tags/bulk/add', { image_ids: [id], tags: added, dry_run: false });
            }
            if (removed.length) {
                await api.post('/api/tags/bulk/remove', { image_ids: [id], tags: removed, dry_run: false });
            }
            app.showToast?.(this._t('modal.tagsSaved', null, 'Tags updated'), 'success');
            this._exitTagEdit();
            await this._reloadModalTags(id);
            app.loadImages?.();
        } catch (e) {
            app.showToast?.(this._t('modal.tagsSaveFailed', null, 'Failed to update tags'), 'error');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    },

    async _reloadModalTags(id) {
        const api = window.App?.API;
        if (!api?.getImage) return;
        try {
            const result = await api.getImage(Number(id));
            if (result?.tags) {
                this._lastModalTags = result.tags;
                this._renderModalTags(result.tags);
            }
        } catch (_e) {
            /* best-effort refresh */
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

    _renderModalCaption(image) {
        const section = document.querySelector('#modal-caption-section');
        const textEl = document.querySelector('#modal-caption-text');
        if (!section || !textEl) return;

        const caption = image?.ai_caption;
        if (caption && caption.trim()) {
            textEl.textContent = caption.trim();
            section.style.display = '';
        } else {
            section.style.display = 'none';
            textEl.textContent = '';
        }
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
            ['Path', image?.path],
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

    _cleanupZoomHandlers(modalImg = document.getElementById('modal-image')) {
        if (modalImg) {
            if (this._zoomWheelHandler) {
                modalImg.removeEventListener('wheel', this._zoomWheelHandler);
            }
            if (this._zoomMousedownHandler) {
                modalImg.removeEventListener('mousedown', this._zoomMousedownHandler);
            }
            if (this._zoomDblclickHandler) {
                modalImg.removeEventListener('dblclick', this._zoomDblclickHandler);
            }
            modalImg.style.cursor = 'default';
        }
        if (this._zoomMousemoveHandler) {
            document.removeEventListener('mousemove', this._zoomMousemoveHandler);
        }
        if (this._zoomMouseupHandler) {
            document.removeEventListener('mouseup', this._zoomMouseupHandler);
        }
        this._zoomWheelHandler = null;
        this._zoomMousedownHandler = null;
        this._zoomDblclickHandler = null;
        this._zoomMousemoveHandler = null;
        this._zoomMouseupHandler = null;
    },

    _getModalInfoScroller() {
        return document.querySelector('#image-modal .modal-info-scroll')
            || document.querySelector('#image-modal .modal-info');
    },

    _captureModalInfoScrollState() {
        const info = this._getModalInfoScroller();
        if (!info) return null;
        const maxScroll = Math.max(0, info.scrollHeight - info.clientHeight);
        return {
            top: info.scrollTop || 0,
            ratio: maxScroll > 0 ? (info.scrollTop || 0) / maxScroll : 0,
        };
    },

    _cancelModalInfoScrollRestore() {
        const pending = this._modalInfoScrollRestore;
        if (!pending) return;
        this._modalInfoScrollRestore = null;
        if (pending.rafId) cancelAnimationFrame(pending.rafId);
        if (pending.timerId) window.clearTimeout(pending.timerId);
        pending.detach();
    },

    _restoreModalInfoScrollState(scrollState) {
        // A new restore supersedes any still-pending one so rapid prev/next
        // navigation cannot replay a stale snapshot.
        this._cancelModalInfoScrollRestore();
        const info = this._getModalInfoScroller();
        if (!info || !scrollState) return;
        const apply = () => {
            const maxScroll = Math.max(0, info.scrollHeight - info.clientHeight);
            if (maxScroll <= 0) return;
            const targetTop = Math.max(scrollState.top || 0, (scrollState.ratio || 0) * maxScroll);
            info.scrollTop = Math.min(maxScroll, targetTop);
        };
        // Cancel the delayed re-apply as soon as the user scrolls on their
        // own — otherwise the 120ms timer snaps their position back.
        const userScrollEvents = ['wheel', 'touchstart', 'mousedown'];
        const onUserScroll = () => this._cancelModalInfoScrollRestore();
        userScrollEvents.forEach((type) => info.addEventListener(type, onUserScroll, { passive: true }));
        const pending = {
            rafId: 0,
            timerId: 0,
            detach: () => userScrollEvents.forEach((type) => info.removeEventListener(type, onUserScroll)),
        };
        this._modalInfoScrollRestore = pending;
        pending.rafId = requestAnimationFrame(() => {
            pending.rafId = requestAnimationFrame(() => {
                pending.rafId = 0;
                apply();
            });
        });
        pending.timerId = window.setTimeout(() => {
            pending.timerId = 0;
            apply();
            this._cancelModalInfoScrollRestore();
        }, 120);
    },

    _closeModalCopyMenu() {
        document.getElementById('modal-copy-menu')?.removeAttribute('open');
    },

    _closeModalToolsMenu() {
        document.getElementById('modal-tools-menu')?.removeAttribute('open');
    },

    async openPreview(imageId) {
        const { $, showModal, formatSize, showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();
        const wasModalVisible = document.getElementById('image-modal')?.classList.contains('visible');
        const modalInfoScrollState = wasModalVisible ? this._captureModalInfoScrollState() : null;
        this._pendingModalInfoScrollState = modalInfoScrollState;

        // Reset zoom/pan transform when opening a new preview (including adjacent navigation)
        const modalImgReset = $('#modal-image');
        if (modalImgReset) {
            modalImgReset.style.transform = '';
            modalImgReset.style.cursor = 'default';
        }

        this._initSectionToggles();
        const summaryImage = this.images.find(image => image.id === imageId) || window.App?.AppState?.images?.find(image => image.id === imageId);
        this.currentPreviewIndex = this.images.findIndex(image => image.id === imageId);
        this._currentPreviewId = imageId;
        // FLOW-03: bind the modal handoff row once (delegated). The row sends the
        // currently-previewed image into the next pipeline step.
        if (!this._handoffBound) {
            this._handoffBound = true;
            document.querySelector('.modal-handoff-row')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-modal-handoff]');
                if (!btn) return;
                e.preventDefault();
                this._closeModalToolsMenu();
                this._handleModalHandoff(btn.dataset.modalHandoff);
            });
        }
        if (!this._analysisBound) {
            this._analysisBound = true;
            document.querySelector('.modal-analysis-row')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-modal-analysis]');
                if (!btn) return;
                e.preventDefault();
                this._closeModalToolsMenu();
                this._handleModalAnalysis(btn.dataset.modalAnalysis);
            });
        }
        if (!this._modalCopyMenuOutsideBound) {
            this._modalCopyMenuOutsideBound = true;
            document.addEventListener('click', (event) => {
                const copyMenu = document.getElementById('modal-copy-menu');
                const toolsMenu = document.getElementById('modal-tools-menu');
                if (copyMenu?.hasAttribute('open') && !copyMenu.contains(event.target)) {
                    copyMenu.removeAttribute('open');
                }
                if (toolsMenu?.hasAttribute('open') && !toolsMenu.contains(event.target)) {
                    toolsMenu.removeAttribute('open');
                }
            });
        }
        this._syncModalAnalysisButtons();
        // FLOW-02: bind the inline tag-editor controls once, and make sure each
        // freshly-opened image starts in read-only (not a leftover edit session).
        this._bindTagEditOnce();
        this._exitTagEdit();
        this.currentPreviewRequestId += 1;
        const requestId = this.currentPreviewRequestId;
        this.showAllTags = false;
        this._lastModalImage = null;
        this._lastModalTags = [];
        this._lastParsedData = null;

        // Show skeleton modal content while loading. When the modal is
        // ALREADY showing an image (prev/next navigation), keep it on screen
        // and swap only after the next image has decoded — hiding it first
        // produced a black flash on every switch (owner 2026-07-05, design
        // rule: no uncomfortable/rapid flashes).
        const modalImgEl = $('#modal-image');
        const isRenavigation = !!(modalImgEl?.getAttribute('src'))
            && !!document.getElementById('image-modal')?.classList.contains('visible');
        if (window.SkeletonModal) {
            window.SkeletonModal.showImageModal('image-modal', { keepImage: isRenavigation });
        }

        const nextImageUrl = API?.getImageUrl?.(imageId) ?? `/api/image-file/${imageId}`;
        // When image loads, hide the skeleton
        modalImgEl.onload = () => {
            if (window.SkeletonModal) {
                window.SkeletonModal.hideImageModal('image-modal');
            }
        };
        if (isRenavigation) {
            const preload = new Image();
            preload.src = nextImageUrl;
            const applyPreloaded = () => {
                if (requestId !== this.currentPreviewRequestId) return; // user moved on
                modalImgEl.src = nextImageUrl;
            };
            if (typeof preload.decode === 'function') {
                preload.decode().then(applyPreloaded).catch(applyPreloaded);
            } else {
                preload.onload = applyPreloaded;
                preload.onerror = applyPreloaded;
            }
        } else {
            modalImgEl.src = nextImageUrl;
        }
        $('#modal-filename').textContent = summaryImage?.filename || `Image #${imageId}`;
        const modalGenerator = $('#modal-generator');
        if (modalGenerator) {
            const summaryGenerator = summaryImage?.generator || '';
            modalGenerator.dataset.generatorValue = this._normalizeGenerator(summaryGenerator);
            modalGenerator.textContent = summaryGenerator
                ? this._formatGeneratorLabel(summaryGenerator)
                : '-';
        }
        // Show the "we only check metadata, not the invisible pixel
        // watermark" note for closed-source AI providers (Gemini /
        // gpt-image). Hide for everything else. Stay in sync with
        // backend/metadata_parser.py — when a new closed-AI provider
        // gets a metadata-only detector but no in-pixel detector,
        // add it here so the user is aware.
        this._updateAiProviderNote(summaryImage?.generator);
        $('#modal-size').textContent = summaryImage ? `${summaryImage.width || '?'}×${summaryImage.height || '?'} • ${formatSize(summaryImage.file_size || 0)}` : '-';
        this._renderModalRating(summaryImage || { id: imageId, user_rating: 0 });
        $('#modal-prompt-text').textContent = summaryImage?.prompt || this._t('modal.loadingPrompt', null, 'Loading prompt…');
        $('#modal-negative-text').textContent = this._t('modal.loadingNegative', null, 'Loading…');
        $('#modal-loading-state').textContent = this._t('modal.loadingDetails', null, 'Loading details…');
        $('#modal-loading-state').style.display = '';
        document.querySelector('#modal-tags-list').textContent = this._t('modal.loadingTags', null, 'Loading tags…');
        document.querySelector('#modal-tags-list').style.color = 'var(--text-muted)';
        $('#btn-toggle-prompt-format').disabled = true;
        $('#btn-toggle-prompt-format').textContent = this._t('modal.viewAsSD', null, 'View as SD');
        ['#modal-loras-section', '#modal-negative-section', '#modal-characters-section', '#modal-params-section', '#modal-model-assets-section', '#modal-img2img-section', '#modal-nodes-section', '#modal-caption-section'].forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.style.display = 'none';
            }
        });
        document.querySelector('#modal-key-params').style.display = 'none';
        document.querySelector('#modal-checkpoint-item').style.display = 'none';
        const aeItemReset = document.querySelector('#modal-aesthetic-item');
        if (aeItemReset) aeItemReset.style.display = 'none';
        document.querySelector('#modal-img2img-badge').style.display = 'none';
        document.querySelector('#modal-loras-list').innerHTML = '';
        document.querySelector('#modal-characters-list').innerHTML = '';
        document.querySelector('#modal-params-grid').innerHTML = '';
        document.querySelector('#modal-model-assets-grid').innerHTML = '';
        document.querySelector('#modal-img2img-info').innerHTML = '';
        document.querySelector('#modal-nodes-list').innerHTML = '';
        $('#btn-reparse-metadata').onclick = async () => {
            try {
                $('#modal-loading-state').textContent = this._t('modal.reparsing', null, 'Reading image info again…');
                $('#modal-loading-state').style.display = '';
                const reparsed = await API.reparseImage(imageId);
                if (requestId !== this.currentPreviewRequestId) return;
                this._hydratePreview(reparsed.image, reparsed.tags);
                showToast?.(this._t('modal.metadataReparsed', null, 'Image info refreshed'), 'success');
            } catch (error) {
                showToast?.(formatUserError(error, this._t('modal.failedReparse', null, 'Could not read the image info again')), "error");
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
            } finally {
                this._closeModalCopyMenu();
            }
        };
        const getPromptView = () => this._getModalPromptView() || this._buildPromptView(this._lastModalImage, this._lastParsedData, 'original');
        $('#btn-toggle-prompt-format').onclick = () => this._togglePromptFormat();
        $('#btn-copy-prompt').onclick = () => copyToClipboard((getPromptView().promptText || ''), this._t('modal.promptCopied', null, 'Prompt copied'));
        $('#btn-copy-negative').onclick = () => copyToClipboard((getPromptView().negativeText || ''), this._t('modal.negativeCopied', null, 'Negative prompt copied'));
        $('#btn-copy-tags').onclick = () => copyToClipboard((this._lastModalTags || []).map(tag => tag.tag).join(', '), this._t('modal.tagsCopied', null, 'Tags copied'));
        const tagCategoryButton = document.querySelector('#btn-copy-tags-category');
        if (tagCategoryButton) {
            tagCategoryButton.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._closeModalCopyMenu();
                window.TagCategoryCopy?.showMenu?.({
                    anchor: tagCategoryButton,
                    source: {
                        imageId: this._lastModalImage?.id,
                        image: this._lastModalImage,
                        tags: this._lastModalTags || [],
                        prompt: getPromptView().promptText || '',
                    },
                    title: this._t('tagCategory.copyOptions', null, 'Copy Options'),
                });
            };
        }
        const btnCopyCaption = document.querySelector('#btn-copy-caption');
        if (btnCopyCaption) {
            btnCopyCaption.onclick = () => copyToClipboard(
                document.querySelector('#modal-caption-text')?.textContent || '',
                this._t('modal.captionCopied', null, 'Caption copied')
            );
        }
        $('#btn-copy-params').onclick = () => copyToClipboard(
            this._serializeGenerationParams(this._lastModalImage, this._lastParsedData),
            this._t('modal.paramsCopied', null, 'Image settings copied')
        );
        $('#btn-copy-all').onclick = () => copyToClipboard(this._buildCopyAllText(this._lastModalImage, this._lastParsedData, this._lastModalTags, getPromptView()), this._t('modal.allCopied', null, 'All image info copied'));
        $('#btn-open-folder').onclick = async () => {
            const image = this._lastModalImage;
            if (!image?.id) return;
            try {
                const API = getRequiredGalleryAPI();
                await API.openFolder(image.id);
            } catch (error) {
                showToast?.(this._t('modal.openFolderFailed', null, 'Failed to open folder'), 'error');
            }
        };

        showModal?.('image-modal');
        if (modalInfoScrollState) {
            this._restoreModalInfoScrollState(modalInfoScrollState);
        } else {
            const info = this._getModalInfoScroller();
            if (info) info.scrollTop = 0;
        }

        // Zoom/pan for modal image
        {
            const modalImg = $('#modal-image');
            let scale = 1;
            let translateX = 0;
            let translateY = 0;
            let isPanning = false;
            let startX = 0;
            let startY = 0;

            const resetZoom = () => {
                scale = 1;
                translateX = 0;
                translateY = 0;
                modalImg.style.transform = '';
                modalImg.style.cursor = 'default';
            };

            this._cleanupZoomHandlers(modalImg);

            this._zoomWheelHandler = (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                scale = Math.max(0.5, Math.min(scale * delta, 10));
                if (Math.abs(scale - 1) < 0.05) { resetZoom(); return; }
                modalImg.style.transform = `scale(${scale}) translate(${translateX}px, ${translateY}px)`;
                modalImg.style.cursor = scale > 1 ? 'grab' : 'default';
            };

            this._zoomMousedownHandler = (e) => {
                if (scale <= 1) return;
                isPanning = true;
                startX = e.clientX - translateX;
                startY = e.clientY - translateY;
                modalImg.style.cursor = 'grabbing';
                e.preventDefault();
            };

            this._zoomMousemoveHandler = (e) => {
                if (!isPanning) return;
                translateX = e.clientX - startX;
                translateY = e.clientY - startY;
                modalImg.style.transform = `scale(${scale}) translate(${translateX}px, ${translateY}px)`;
            };

            this._zoomMouseupHandler = () => {
                if (isPanning) {
                    isPanning = false;
                    modalImg.style.cursor = scale > 1 ? 'grab' : 'default';
                }
            };

            this._zoomDblclickHandler = resetZoom;

            modalImg.addEventListener('wheel', this._zoomWheelHandler, { passive: false });
            modalImg.addEventListener('mousedown', this._zoomMousedownHandler);
            document.addEventListener('mousemove', this._zoomMousemoveHandler);
            document.addEventListener('mouseup', this._zoomMouseupHandler);
            modalImg.addEventListener('dblclick', this._zoomDblclickHandler);
        }

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
        const pathEl = $('#modal-file-path');
        const subfolderEl = $('#modal-file-subfolder');
        if (pathEl) {
            const normalizedPath = String(image.path || '');
            const pathParts = normalizedPath.replace(/\\/g, '/').split('/');
            pathParts.pop();
            const parentFolder = pathParts.pop() || '';
            pathEl.textContent = normalizedPath;
            pathEl.title = image.path || '';
            if (subfolderEl) {
                subfolderEl.textContent = parentFolder || '';
                subfolderEl.title = parentFolder || '';
                subfolderEl.style.display = parentFolder ? '' : 'none';
            }
            pathEl.closest('.modal-path-row')?.style.setProperty('display', image.path ? '' : 'none');
        }
        const modalGeneratorFinal = $('#modal-generator');
        if (modalGeneratorFinal) {
            modalGeneratorFinal.dataset.generatorValue = this._normalizeGenerator(image.generator);
            modalGeneratorFinal.textContent = this._formatGeneratorLabel(image.generator);
        }
        $('#modal-size').textContent = `${image.width}×${image.height} • ${formatSize(image.file_size)}`;
        this._renderModalRating(image);
        $('#modal-prompt-text').textContent = image.prompt || this._t('modal.noPrompt', null, 'No prompt');
        const parsedData = this._extractParsedData(image);
        this._lastModalImage = image;
        this._lastModalTags = tags;
        this._lastParsedData = parsedData;

        this._renderModalSections(image, parsedData);
        this._renderModalTags(tags);
        this._renderModalCaption(image);
        this._applyModalPromptView(this._buildPromptView(image, parsedData, 'original'));
        this._applyModalSectionStates();
        $('#modal-loading-state').style.display = 'none';
        $('#btn-toggle-all-tags').textContent = this._t('modal.showMore', null, 'Show More');
        this._restoreModalInfoScrollState(this._pendingModalInfoScrollState);

        // Extract and display color distribution
        this._extractColorDistribution($('#modal-image'));
    },

    _extractColorDistribution(imgEl) {
        const container = document.getElementById('modal-color-distribution');
        const histCanvas = document.getElementById('modal-color-histogram-canvas');
        const paletteEl = document.getElementById('modal-color-palette');
        if (!container || !histCanvas || !paletteEl || !imgEl) return;

        const extract = () => {
            try {
                // Sample the image at a reasonable size
                const sampleCanvas = document.createElement('canvas');
                const sampleSize = 128;
                sampleCanvas.width = sampleSize;
                sampleCanvas.height = sampleSize;
                const sampleCtx = sampleCanvas.getContext('2d');
                sampleCtx.drawImage(imgEl, 0, 0, sampleSize, sampleSize);
                const data = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;
                const totalPixels = sampleSize * sampleSize;

                // === RGB Histogram ===
                const rHist = new Uint32Array(256);
                const gHist = new Uint32Array(256);
                const bHist = new Uint32Array(256);
                const lHist = new Uint32Array(256); // luminance

                // Color palette buckets
                const buckets = {};

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i+1], b = data[i+2];
                    rHist[r]++;
                    gHist[g]++;
                    bHist[b]++;
                    lHist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;

                    // Bucket for palette
                    const br = Math.round(r / 32) * 32;
                    const bg = Math.round(g / 32) * 32;
                    const bb = Math.round(b / 32) * 32;
                    const key = `${br},${bg},${bb}`;
                    if (!buckets[key]) buckets[key] = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
                    buckets[key].count++;
                    buckets[key].sumR += r;
                    buckets[key].sumG += g;
                    buckets[key].sumB += b;
                }

                // Draw histogram on canvas
                const rect = histCanvas.parentElement.getBoundingClientRect();
                const w = Math.max(256, Math.floor(rect.width * (window.devicePixelRatio || 1)));
                const h = Math.max(60, Math.floor(80 * (window.devicePixelRatio || 1)));
                histCanvas.width = w;
                histCanvas.height = h;
                const ctx = histCanvas.getContext('2d');
                ctx.clearRect(0, 0, w, h);

                // Find max value for normalization (skip 0 and 255 to avoid clipping spikes)
                let maxVal = 1;
                for (let i = 1; i < 255; i++) {
                    maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i]);
                }

                const drawChannel = (hist, color) => {
                    ctx.beginPath();
                    ctx.moveTo(0, h);
                    for (let i = 0; i < 256; i++) {
                        const x = (i / 255) * w;
                        const barH = Math.min(h, (hist[i] / maxVal) * h * 0.92);
                        ctx.lineTo(x, h - barH);
                    }
                    ctx.lineTo(w, h);
                    ctx.closePath();
                    ctx.fillStyle = color;
                    ctx.fill();
                };

                const mode = this._histogramMode || 'rgb';
                if (mode === 'luma') {
                    drawChannel(lHist, 'rgba(255,255,255,0.2)');
                } else if (mode === 'split') {
                    const drawLine = (hist, color, bandIndex) => {
                        const bandHeight = h / 3;
                        const bandTop = bandHeight * bandIndex;
                        ctx.beginPath();
                        ctx.moveTo(0, bandTop + bandHeight);
                        for (let i = 0; i < 256; i++) {
                            const x = (i / 255) * w;
                            const barH = Math.min(bandHeight, (hist[i] / maxVal) * bandHeight * 0.92);
                            ctx.lineTo(x, bandTop + bandHeight - barH);
                        }
                        ctx.strokeStyle = color;
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    };
                    drawLine(rHist, 'rgba(239,68,68,0.95)', 0);
                    drawLine(gHist, 'rgba(52,211,153,0.95)', 1);
                    drawLine(bHist, 'rgba(66,133,244,0.95)', 2);
                } else {
                    drawChannel(lHist, 'rgba(255,255,255,0.08)');
                    drawChannel(bHist, 'rgba(66,133,244,0.35)');
                    drawChannel(gHist, 'rgba(52,211,153,0.35)');
                    drawChannel(rHist, 'rgba(239,68,68,0.35)');
                }

                // === Color Palette ===
                const sorted = Object.values(buckets)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 9);
                const paletteTotal = sorted.reduce((s, b) => s + b.count, 0);

                paletteEl.innerHTML = sorted.map(b => {
                    const avgR = Math.round(b.sumR / b.count);
                    const avgG = Math.round(b.sumG / b.count);
                    const avgB = Math.round(b.sumB / b.count);
                    const hex = '#' + [avgR, avgG, avgB].map(v => v.toString(16).padStart(2, '0')).join('');
                    const pct = ((b.count / paletteTotal) * 100).toFixed(1);
                    return `<div class="modal-color-swatch" onclick="navigator.clipboard.writeText('${hex}')" title="Click to copy ${hex}">
                        <span class="swatch-dot" style="background:${hex}"></span>
                        <span>${hex}</span>
                        <span style="opacity:0.5">${pct}%</span>
                    </div>`;
                }).join('');

                container.style.display = '';
            } catch (e) {
                container.style.display = 'none';
            }
        };

        if (imgEl.complete && imgEl.naturalWidth > 0) {
            extract();
        } else {
            imgEl.addEventListener('load', extract, { once: true });
        }
    },

    openAdjacentPreview(direction) {
        if (!this.images.length || this.currentPreviewIndex < 0) return;
        const nextIndex = this.currentPreviewIndex + direction;
        if (nextIndex < 0 || nextIndex >= this.images.length) return;
        this.openPreview(this.images[nextIndex].id);
    },

    /**
     * Show a context menu on right-click for a gallery item
     * @param {MouseEvent} e - The contextmenu event
     * @param {Object} image - The image data object
     */
    _showContextMenu(e, image) {
        // Remove existing menu
        document.querySelector('.gallery-context-menu')?.remove();
        document.querySelector('.collections-picker-menu')?.remove();
        const t = (key, fallback, params) => { const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : fallback; };
        const app = window.App || {};
        const imageId = Number(image?.id);
        const selectedIds = app.AppState?.selectedIds instanceof Set ? app.AppState.selectedIds : new Set();
        const isSelected = selectedIds.has(imageId) || selectedIds.has(String(image?.id));
        const selectedImageIds = Array.from(selectedIds)
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0);
        const actionImageIds = isSelected && selectedImageIds.length > 1 ? selectedImageIds : [imageId];
        const actionCount = actionImageIds.length;
        const checkpointFilterValue = app.normalizeCheckpointFilterValue?.(
            image.checkpoint_normalized || image.checkpoint
        ) || '';

        const menu = document.createElement('div');
        menu.className = 'gallery-context-menu';
        menu.setAttribute('role', 'menu');

        const scopeLabel = actionCount > 1
            ? t('gallery.contextApplyToSelected', 'Use selected ({count})', { count: actionCount })
                .replace('{count}', String(actionCount))
            : '';
        const labelWithScope = (key, fallback) => {
            const label = t(key, fallback);
            return scopeLabel ? `${label} · ${scopeLabel}` : label;
        };
        const tagCopySource = { imageId: image.id, image };

        const items = [
            { label: t('gallery.contextPreview', 'Preview'), icon: '\u{1F5BC}', action: () => this.openPreview(image.id) },
            { label: isSelected ? t('gallery.contextDeselectImage', 'Deselect Image') : t('gallery.contextSelectImage', 'Select Image'), icon: isSelected ? '\u2715' : '\u2713', action: () => this._setContextImageSelection(image.id, !isSelected) },
            { type: 'separator' },
            { label: t('gallery.contextCopyTags', 'Copy Tags'), icon: '\u{1F3F7}', action: async () => {
                const copy = window.TagCategoryCopy;
                if (!copy) {
                    app.showToast?.(t('modal.copyFailed', 'Failed to copy text'), 'error');
                    return;
                }
                const tags = await copy.getTagsFromSource(tagCopySource);
                await copy.copyTags(tags, t('modal.tagsCopied', 'Tags copied'));
            }},
            { label: t('gallery.contextCopyTagCategory', 'Copy Tag Category...'), icon: '\u25BE', action: (event) => {
                if (!window.TagCategoryCopy?.showMenu) {
                    app.showToast?.(t('modal.copyFailed', 'Failed to copy text'), 'error');
                    return;
                }
                window.TagCategoryCopy.showMenu({
                    x: event.clientX,
                    y: event.clientY,
                    source: tagCopySource,
                    title: t('tagCategory.copyOptions', 'Copy Options'),
                });
            }},
            { type: 'separator' },
            { label: this.isFavorited(image.id)
                ? t('collections.contextUnfavorite', 'Remove from Favorites')
                : t('collections.contextFavorite', 'Add to Favorites'),
              icon: this.isFavorited(image.id) ? '\u{1F494}' : '♥',
              action: () => this.toggleFavorite(image.id) },
            { label: labelWithScope('collections.contextAddTo', 'Add to collection…'), icon: '\u{1F4DA}',
              action: () => window.CollectionsUI?.openAddToCollectionPicker?.(actionImageIds) },
            { type: 'separator' },
            { label: labelWithScope('gallery.contextMoveImage', 'Move...'), icon: '\u{1F4C1}', action: () => app.moveOrCopyGalleryImages?.(actionImageIds, 'move', { source: 'context' }) },
            { label: labelWithScope('gallery.contextCopyImage', 'Copy...'), icon: '\u{1F4C4}', action: () => app.moveOrCopyGalleryImages?.(actionImageIds, 'copy', { source: 'context' }) },
            { type: 'separator' },
            { label: labelWithScope('gallery.contextSendToCensor', 'Send to Censor'), icon: '\u{1F533}', action: () => {
                if (typeof app.addToCensorQueue === 'function') {
                    app.addToCensorQueue(actionImageIds);
                } else {
                    app.showToast?.(t('gallery.contextSendToCensorFailed', 'Failed to send image to Edit'), 'error');
                }
            }},
            { label: labelWithScope('modal.addToDataset', 'Add to dataset'), icon: '\u{1F4E6}', action: () => app.addToDatasetMaker?.(actionImageIds, { switchView: true, showToast: true }) },
            { label: t('gallery.contextFindSimilar', 'Find Similar'), icon: '\u{1F50E}', action: () => app.openSimilarFromImage?.(image.id) },
            { label: t('gallery.contextNearDuplicates', 'Find near-duplicates (CLIP)'), icon: '\u{1F46F}', action: () => window.ClipTools?.near?.(image.id) },
            actionCount === 2
                ? { label: t('gallery.contextCompareTwo', 'Compare 2 images (CLIP)'), icon: '⚖️', action: () => window.ClipTools?.compare?.(actionImageIds[0], actionImageIds[1]) }
                : null,
            { label: t('gallery.contextPromptHelper', 'Prompt Helper'), icon: '\u{1F9EA}', action: () => app.openPromptBuildFromImage?.(image.id) },
            { label: t('gallery.contextReadMetadata', 'Metadata / Info'), icon: '\u{1F4D6}', action: () => app.openReaderFromImage?.(image.id, image.filename || '') },
            checkpointFilterValue ? { label: t('gallery.contextFilterCheckpoint', 'Filter by Checkpoint'), icon: '\u{1F50D}', action: () => {
                if (app.AppState) {
                    app.updateFilters?.((filters) => {
                        if (!filters.checkpoints.includes(checkpointFilterValue)) {
                            filters.checkpoints = [...filters.checkpoints, checkpointFilterValue];
                        }
                    });
                    app.updateFilterSummary?.();
                    app.loadImages?.();
                }
            }} : null,
            { type: 'separator' },
            { label: t('gallery.contextOpenFolder', 'Open in Folder'), icon: '\u{1F4C2}', action: () => {
                app.API?.openFolder?.(image.id);
            }},
            { label: t('gallery.contextCopyPath', 'Copy Path'), icon: '\u{1F4CB}', action: () => {
                if (typeof app.copyTextToClipboard === 'function') {
                    app.copyTextToClipboard(image.path || '', t('gallery.pathCopied', 'Path copied'));
                } else {
                    navigator.clipboard.writeText(image.path || '');
                    app.showToast?.(t('gallery.pathCopied', 'Path copied'), 'success');
                }
            }},
            { type: 'separator' },
            { label: labelWithScope('gallery.contextRemoveFromGallery', 'Remove from Gallery'), icon: '\u{1F9F9}', danger: true, action: () => app.removeGalleryImagesByIds?.(actionImageIds) },
            { label: labelWithScope('gallery.contextMoveToTrash', 'Move to Trash...'), icon: '\u{1F5D1}', danger: true, action: () => app.deleteGalleryImagesByIds?.(actionImageIds) },
        ].filter(Boolean);

        items.forEach((item) => {
            if (item.type === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'context-menu-separator';
                separator.setAttribute('role', 'separator');
                menu.appendChild(separator);
                return;
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = `context-menu-item${item.danger ? ' is-danger' : ''}`;
            button.setAttribute('role', 'menuitem');

            const icon = document.createElement('span');
            icon.className = 'context-menu-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = item.icon;

            const label = document.createElement('span');
            label.className = 'context-menu-label';
            label.textContent = item.label;

            button.append(icon, label);
            button.addEventListener('click', (event) => {
                Promise.resolve(item.action(event, menu)).catch((error) => {
                    const message = typeof formatUserError === 'function'
                        ? formatUserError(error, t('modal.copyFailed', 'Failed to copy text'))
                        : t('modal.copyFailed', 'Failed to copy text');
                    app.showToast?.(message, 'error');
                });
                menu.remove();
            });
            menu.appendChild(button);
        });

        document.body.appendChild(menu);
        this._positionContextMenu(menu, e.clientX, e.clientY, e.currentTarget || e.target?.closest?.('.gallery-item'));

        // Scroll affordance: fade cue at the bottom while more items remain
        // below the fold (short windows), cleared when scrolled to the end.
        const updateScrollCue = () => {
            const moreBelow = menu.scrollHeight - menu.scrollTop - menu.clientHeight > 4;
            menu.classList.toggle('has-more-below', moreBelow);
        };
        menu.addEventListener('scroll', updateScrollCue, { passive: true });
        updateScrollCue();

        // Close on click outside or Escape.
        const closeMenu = () => {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('keydown', closeOnEscape);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') closeMenu();
        };
        setTimeout(() => {
            document.addEventListener('click', closeMenu);
            document.addEventListener('keydown', closeOnEscape);
        }, 0);
    },

    _positionContextMenu(menu, clientX, clientY, anchorElement = null) {
        if (!menu) return;
        const anchorRect = anchorElement?.getBoundingClientRect?.() || null;
        const rawX = Number.isFinite(clientX) ? clientX : anchorRect?.right;
        const rawY = Number.isFinite(clientY) ? clientY : anchorRect?.top;
        const pointerInsideAnchor = anchorRect
            && rawX >= anchorRect.left - 1
            && rawX <= anchorRect.right + 1
            && rawY >= anchorRect.top - 1
            && rawY <= anchorRect.bottom + 1;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
        const x = anchorRect && !pointerInsideAnchor
            ? clamp(rawX ?? anchorRect.right, anchorRect.left, anchorRect.right)
            : (rawX ?? 8);
        const y = anchorRect && !pointerInsideAnchor
            ? clamp(rawY ?? anchorRect.top, anchorRect.top, anchorRect.bottom)
            : (rawY ?? 8);
        // Let the menu use the full viewport height (19 items ≈ 660px) so all
        // actions stay visible on desktop screens; PopupPosition still clamps
        // to the available space when the window is short.
        if (anchorRect && window.PopupPosition?.place) {
            const placement = anchorRect.right + 8 > window.innerWidth - 260
                ? 'left'
                : 'right';
            window.PopupPosition.place(menu, {
                anchor: anchorElement,
                placement,
                gap: 8,
                maxHeight: Math.max(120, window.innerHeight - 16),
            });
            return;
        }

        window.PopupPosition?.place(menu, {
            x,
            y,
            placement: 'point',
            maxHeight: Math.max(120, window.innerHeight - 16),
        });
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
            // Only handle arrow keys when focus is on a gallery item.
            if (!e.target.classList.contains('gallery-item')) return;
            // Delegate the shared grid-navigation logic to the A11y utility so
            // the switch/focus handling lives in one place. We keep the gallery
            // semantics intact: clamp at edges (wrap:false), dynamic column
            // count from the live layout, and a screen-reader position announce
            // on each move. Enter/Space still open via the per-item keydown.
            const a11y = window.A11y;
            if (!a11y || typeof a11y.handleGridKeyboardNavigation !== 'function') return;

            const total = grid.querySelectorAll('.gallery-item').length;
            const gridStyle = window.getComputedStyle(grid);
            const gridWidth = grid.offsetWidth;
            const itemWidth = grid.querySelector('.gallery-item')?.offsetWidth || 200;
            const columnGap = parseInt(gridStyle.columnGap) || 16;
            const columns = Math.max(1, Math.floor((gridWidth + columnGap) / (itemWidth + columnGap)));

            a11y.handleGridKeyboardNavigation(e, grid, '.gallery-item', {
                columns,
                wrap: false,
                onNavigate: (_item, index) => this.announceImagePosition(index, total),
            });
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
    },

    // ============== Metadata Editing from Gallery ==============
    _metadataBackup: {},

    openMetadataEditor() {
        const image = this._lastModalImage;
        if (!image || !image.id) return;

        const { $ } = getGalleryAppContext();
        const modal = $('#metadata-editor-modal');
        if (!modal) return;

        // Populate form fields with current data
        const parsedData = this._lastParsedData || {};
        $('#meta-edit-prompt').value = image.prompt || '';
        $('#meta-edit-negative').value = image.negative_prompt || '';
        $('#meta-edit-seed').value = parsedData.seed || '';
        $('#meta-edit-sampler').value = parsedData.sampler || '';
        $('#meta-edit-steps').value = parsedData.steps || '';
        $('#meta-edit-cfg').value = parsedData.cfg_scale || '';
        $('#meta-edit-checkpoint').value = parsedData.model || image.checkpoint || '';
        $('#meta-edit-loras').value = Array.isArray(image.loras) ? image.loras.join(', ') : '';
        $('#meta-edit-format').value = 'png';

        modal.dataset.imageId = image.id;
        modal.dataset.imagePath = image.path || '';
        showModal('metadata-editor-modal');
    },

    async saveMetadataEdit() {
        const { $, showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();
        const modal = $('#metadata-editor-modal');
        if (!modal) return;

        const imageId = Number(modal.dataset.imageId);
        const sourcePath = modal.dataset.imagePath;
        if (!imageId || !sourcePath) {
            showToast?.(this._t('modal.editNoPath', null, 'Cannot save: image path not found'), 'error');
            return;
        }

        try {
            // Backup current metadata
            const currentImage = this._lastModalImage;
            this._metadataBackup[imageId] = {
                prompt: currentImage.prompt,
                negative_prompt: currentImage.negative_prompt,
                checkpoint: currentImage.checkpoint,
                loras: currentImage.loras,
                parsedData: { ...this._lastParsedData }
            };

            // Collect edited metadata
            const metadata = {
                prompt: $('#meta-edit-prompt').value.trim(),
                negative: $('#meta-edit-negative').value.trim(),
                seed: $('#meta-edit-seed').value.trim(),
                sampler: $('#meta-edit-sampler').value.trim(),
                steps: $('#meta-edit-steps').value.trim(),
                cfg_scale: $('#meta-edit-cfg').value.trim(),
                model: $('#meta-edit-checkpoint').value.trim(),
                loras: $('#meta-edit-loras').value.trim()
            };

            const format = $('#meta-edit-format').value || 'png';

            // Save edited metadata (overwrite in-place)
            await API.saveEditedMetadata(sourcePath, sourcePath, format, metadata, true);

            // Update in-memory data
            currentImage.prompt = metadata.prompt;
            currentImage.negative_prompt = metadata.negative;
            if (metadata.model) currentImage.checkpoint = metadata.model;
            if (metadata.loras) {
                currentImage.loras = metadata.loras.split(',').map(l => l.trim()).filter(Boolean);
            }

            // Update parsed data
            if (this._lastParsedData) {
                if (metadata.seed) this._lastParsedData.seed = metadata.seed;
                if (metadata.sampler) this._lastParsedData.sampler = metadata.sampler;
                if (metadata.steps) this._lastParsedData.steps = metadata.steps;
                if (metadata.cfg_scale) this._lastParsedData.cfg_scale = metadata.cfg_scale;
                if (metadata.model) this._lastParsedData.model = metadata.model;
            }

            // Update modal display without full reload
            this._hydratePreview(currentImage, this._lastModalTags);

            // Update gallery card if visible
            this._updateGalleryCardInPlace(imageId, currentImage);

            // Close editor modal
            closeModal('metadata-editor-modal');

            // Show success toast with Undo
            showToast?.(
                this._t('modal.metadataUpdated', null, 'Metadata updated'),
                'success',
                {
                    duration: 10000,
                    actionLabel: this._t('modal.undo', null, 'Undo'),
                    onAction: () => this.undoMetadataEdit(imageId)
                }
            );
        } catch (error) {
            showToast?.(
                formatUserError(error, this._t('modal.editFailed', null, 'Failed to save metadata')),
                'error'
            );
        }
    },

    async undoMetadataEdit(imageId) {
        const backup = this._metadataBackup[imageId];
        if (!backup) return;

        const { showToast } = getGalleryAppContext();
        const API = getRequiredGalleryAPI();
        const currentImage = this._lastModalImage;
        if (!currentImage || currentImage.id !== imageId) return;

        try {
            const sourcePath = currentImage.path;
            if (!sourcePath) return;

            // Restore from backup
            const metadata = {
                prompt: backup.prompt || '',
                negative: backup.negative_prompt || '',
                seed: backup.parsedData?.seed || '',
                sampler: backup.parsedData?.sampler || '',
                steps: backup.parsedData?.steps || '',
                cfg_scale: backup.parsedData?.cfg_scale || '',
                model: backup.checkpoint || '',
                loras: Array.isArray(backup.loras) ? backup.loras.join(', ') : ''
            };

            await API.saveEditedMetadata(sourcePath, sourcePath, 'png', metadata, true);

            // Restore in-memory data
            currentImage.prompt = backup.prompt;
            currentImage.negative_prompt = backup.negative_prompt;
            currentImage.checkpoint = backup.checkpoint;
            currentImage.loras = backup.loras;
            this._lastParsedData = { ...backup.parsedData };

            // Update modal display
            this._hydratePreview(currentImage, this._lastModalTags);

            // Update gallery card
            this._updateGalleryCardInPlace(imageId, currentImage);

            // Clear backup
            delete this._metadataBackup[imageId];

            showToast?.(this._t('modal.metadataRestored', null, 'Metadata restored'), 'info');
        } catch (error) {
            showToast?.(
                formatUserError(error, this._t('modal.undoFailed', null, 'Failed to restore metadata')),
                'error'
            );
        }
    },

    _updateGalleryCardInPlace(imageId, updatedImage) {
        const card = document.querySelector(`#gallery-grid .gallery-item[data-id="${imageId}"]`);
        if (!card) return;

        // Update prompt text if visible
        const promptEl = card.querySelector('.gallery-item-prompt');
        if (promptEl && updatedImage.prompt) {
            promptEl.textContent = updatedImage.prompt;
            promptEl.title = updatedImage.prompt;
        }

        // Update checkpoint badge if visible
        const checkpointEl = card.querySelector('.gallery-item-checkpoint');
        if (checkpointEl && updatedImage.checkpoint) {
            checkpointEl.textContent = updatedImage.checkpoint;
            checkpointEl.title = updatedImage.checkpoint;
        }
    }
};

// Export configuration for external use
window.GALLERY_VIRTUAL_CONFIG = GALLERY_VIRTUAL_CONFIG;
window.Gallery = Gallery;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Gallery._bindLanguageUpdates());
} else {
    Gallery._bindLanguageUpdates();
}
