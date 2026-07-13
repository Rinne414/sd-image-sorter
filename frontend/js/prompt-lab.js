/**
 * SD Image Sorter - Prompt Lab Module
 * Interactive prompt builder with category browser, tag sets, exclusion rules,
 * and weighted random generation.
 */

// escapeHtml fallback — main definition is in app.js
if (typeof escapeHtml === 'undefined') {
    var escapeHtml = function(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };
}

const PromptLab = {
    categories: {},
    tagSets: [],
    exclusionRules: [],
    presets: [],
    generatedPrompt: '',
    generatedPromptCore: '',
    isReady: false,
    eventsBound: false,
    randomizeExcludedCategories: new Set(['unknown', 'rating', 'meta']),
    imagePickerTarget: '',
    imageCatalog: [],
    imageCatalogLoaded: false,
    imageCatalogPromise: null,
    statsVisibleCounts: {
        topTags: 20,
        highTags: 20,
        checkpoints: 12,
        bestCheckpoints: 8,
        scoredImages: 8,
        recipes: 8,
    },
    categoryBoardState: null,
    categoryBoardOriginal: null,
    categoryBoardActiveTag: '',
    buildCategoryState: null,

    // User-controlled fixed tags for generated prompts.
    prependTags: '',
    appendTags: '',

    // Current builder state (slot-based)
    slots: {},       // { category: [selected tags] }
    weights: {},     // { category: weight 0-100 }
    locked: {},      // { category: bool } - locked slots survive randomize

    async init() {
        if (!this.eventsBound) {
            this.bindEvents();
            this.bindIntelligenceEvents();
            this.eventsBound = true;
        }

        this.setReadyState(false);

        try {
            await this.loadCategories();
            await this.loadTagSets();
            await this.loadExclusionRules();
            await this.loadPresets();
            await this._ensureImageCatalog().catch(() => null);
            this.renderTagSetOptions();
            this.renderPromptDataTools();
            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            this.renderPresetList();
            this.showFirstUseGuide();
            // Load stats for the default Stats tab
            this.loadStats();
        } finally {
            this.setReadyState(true);
        }
    },

    dismissFirstUseCard() {
        localStorage.setItem('promptlab-guide-seen', 'true');
        const card = document.getElementById('promptlab-start-card');
        if (card) card.hidden = true;
    },

    refreshFirstUseCard() {
        const card = document.getElementById('promptlab-start-card');
        const dismissBtn = document.getElementById('promptlab-start-dismiss');
        if (!card) return;
        if (dismissBtn && dismissBtn.dataset.bound !== 'true') {
            dismissBtn.addEventListener('click', () => this.dismissFirstUseCard());
            dismissBtn.dataset.bound = 'true';
        }
        card.hidden = localStorage.getItem('promptlab-guide-seen') === 'true';
    },

    activateMode(mode) {
        const safeMode = ['stats', 'compare', 'build', 'random'].includes(mode) ? mode : 'stats';
        document.querySelectorAll('.promptlab-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.mode === safeMode);
        });
        document.querySelectorAll('.promptlab-mode').forEach((panel) => {
            panel.classList.toggle('active', panel.id === `promptlab-mode-${safeMode}`);
        });
        if (safeMode === 'stats') this.loadStats();
        if (safeMode === 'compare') this.populateImageSelectors();
        if (safeMode === 'build') this.populateBuildSelector();
    },

    showFirstUseGuide() {
        this.refreshFirstUseCard();
    },

    // ============== Data Loading ==============

    async loadCategories() {
        try {
            const result = await window.App.API.get('/api/prompts/categories');
            this.categories = result.categories || {};
        } catch (e) {
            this.categories = {};
        }
    },

    async loadTagSets() {
        try {
            const result = await window.App.API.get('/api/prompts/sets');
            this.tagSets = result.sets || [];
        } catch (e) {
            this.tagSets = [];
        }
    },

    async loadExclusionRules() {
        try {
            const result = await window.App.API.get('/api/prompts/exclusions');
            this.exclusionRules = result.rules || [];
        } catch (e) {
            this.exclusionRules = [];
        }
    },

    async loadPresets() {
        try {
            const result = await window.App.API.get('/api/prompts/presets');
            this.presets = result.presets || [];
        } catch (e) {
            this.presets = [];
        }
    },

    _escapeValue(value) {
        return escapeHtml(value);
    },

    _safeDataValue(value) {
        return encodeURIComponent(String(value ?? ''));
    },

    _decodeDataValue(value) {
        try {
            return decodeURIComponent(String(value ?? ''));
        } catch (e) {
            return String(value ?? '');
        }
    },

    _t(key, fallback, params) {
        const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : (fallback || key);
    },

    _renderStatsEmpty(message) {
        return `<div class="promptlab-empty-note">${escapeHtml(message)}</div>`;
    },

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

    hasBuilderSelection() {
        return Object.values(this.slots).some((tags) => Array.isArray(tags) && tags.length > 0);
    },

    updateActionState() {
        const hasSelection = this.hasBuilderSelection();
        const hasPrompt = Boolean(this.generatedPrompt?.trim());

        const btnGenerate = document.getElementById('btn-promptlab-generate');
        const btnValidate = document.getElementById('btn-promptlab-validate');
        const btnUseGallery = document.getElementById('btn-promptlab-use-gallery');
        const btnCopy = document.getElementById('btn-promptlab-copy');
        const btnRandom = document.getElementById('btn-promptlab-random');
        const btnClear = document.getElementById('btn-promptlab-clear');
        const btnSavePreset = document.getElementById('btn-promptlab-save-preset');

        if (btnGenerate) btnGenerate.disabled = !this.isReady || !hasSelection;
        if (btnValidate) btnValidate.disabled = !this.isReady || !hasSelection;
        if (btnUseGallery) btnUseGallery.disabled = !this.isReady || !hasPrompt;
        if (btnCopy) btnCopy.disabled = !this.isReady || !hasPrompt;
        if (btnRandom) btnRandom.disabled = !this.isReady;
        if (btnClear) btnClear.disabled = !this.isReady;
        if (btnSavePreset) btnSavePreset.disabled = !this.isReady;
    },

    setReadyState(isReady) {
        this.isReady = isReady;
        const searchInput = document.getElementById('promptlab-search');
        const tagSetSelect = document.getElementById('promptlab-set-select');
        const applyTagSet = document.getElementById('btn-promptlab-apply-tagset');
        const prependInput = document.getElementById('promptlab-prepend');
        const appendInput = document.getElementById('promptlab-append');
        const recatTagInput = document.getElementById('promptlab-recat-tag');
        const recatCategoryInput = document.getElementById('promptlab-recat-category');
        const recatButton = document.getElementById('btn-promptlab-recategorize');
        const categoryBoardButton = document.getElementById('btn-promptlab-category-board');

        if (searchInput) searchInput.disabled = !isReady;
        if (tagSetSelect) tagSetSelect.disabled = !isReady;
        if (applyTagSet) applyTagSet.disabled = !isReady;
        if (prependInput) prependInput.disabled = !isReady;
        if (appendInput) appendInput.disabled = !isReady;
        if (recatTagInput) recatTagInput.disabled = !isReady;
        if (recatCategoryInput) recatCategoryInput.disabled = !isReady;
        if (recatButton) recatButton.disabled = !isReady;
        if (categoryBoardButton) categoryBoardButton.disabled = !isReady;
        document.querySelectorAll('.btn-promptlab-delete-set, .btn-promptlab-delete-exclusion').forEach((button) => {
            button.disabled = !isReady;
        });
        this.updateActionState();
    },

    invalidateGeneratedPrompt() {
        this.generatedPrompt = '';
        this.generatedPromptCore = '';
        this.renderOutput();
    },

    _parsePromptTags(value) {
        return String(value || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
    },

    _normalizePromptTag(tag) {
        return String(tag || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_');
    },

    _mergePromptTags(...tagGroups) {
        const merged = [];
        const seen = new Set();

        for (const group of tagGroups) {
            for (const tag of group) {
                const key = this._normalizePromptTag(tag);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                merged.push(tag);
            }
        }

        return merged;
    },

    _applyPrependAppend(prompt) {
        const prepend = this._parsePromptTags(this.prependTags);
        const core = this._parsePromptTags(prompt);
        const append = this._parsePromptTags(this.appendTags);
        return this._mergePromptTags(prepend, core, append).join(', ');
    },

    _stripAffixesFromPrompt(prompt, prependTags = this.prependTags, appendTags = this.appendTags) {
        const affixKeys = new Set([
            ...this._parsePromptTags(prependTags),
            ...this._parsePromptTags(appendTags),
        ].map((tag) => this._normalizePromptTag(tag)).filter(Boolean));

        if (affixKeys.size === 0) {
            return String(prompt || '').trim();
        }

        return this._parsePromptTags(prompt)
            .filter((tag) => !affixKeys.has(this._normalizePromptTag(tag)))
            .join(', ');
    },

    _readAffixInputs() {
        const prependInput = document.getElementById('promptlab-prepend');
        const appendInput = document.getElementById('promptlab-append');
        this.prependTags = prependInput?.value || '';
        this.appendTags = appendInput?.value || '';
    },

    _syncAffixInputs() {
        const prependInput = document.getElementById('promptlab-prepend');
        const appendInput = document.getElementById('promptlab-append');
        if (prependInput) prependInput.value = this.prependTags || '';
        if (appendInput) appendInput.value = this.appendTags || '';
    },

    _refreshOutputFromAffixes(previousPrepend = this.prependTags, previousAppend = this.appendTags) {
        const outputEl = document.getElementById('promptlab-output');
        const currentOutput = outputEl?.value || this.generatedPrompt || '';
        const core = this.generatedPromptCore || this._stripAffixesFromPrompt(currentOutput, previousPrepend, previousAppend);

        this.generatedPromptCore = core;
        this.generatedPrompt = core ? this._applyPrependAppend(core) : '';
        this.renderOutput();
    },

    handleAffixInput() {
        const previousPrepend = this.prependTags;
        const previousAppend = this.appendTags;
        this._readAffixInputs();

        const outputEl = document.getElementById('promptlab-output');
        const currentOutput = outputEl?.value || this.generatedPrompt || '';
        if (currentOutput.trim() || this.generatedPromptCore.trim()) {
            this._refreshOutputFromAffixes(previousPrepend, previousAppend);
        }
    },

    getSelectedTags() {
        return [...new Set(
            Object.values(this.slots)
                .flat()
                .filter((tag) => Boolean(tag))
        )];
    },

    _buildTagChip(tag, category, selectedTags) {
        const safeTag = this._escapeValue(tag);
        const safeCategory = this._escapeValue(category);
        const encodedTag = this._safeDataValue(tag);
        const encodedCategory = this._safeDataValue(category);
        const selectedClass = selectedTags.includes(tag) ? 'selected' : '';
        return `
            <span class="cat-tag ${selectedClass}"
                  data-tag="${encodedTag}" data-cat="${encodedCategory}"
                  title="Click to add to ${safeCategory} slot">
                ${safeTag}
            </span>
        `;
    },

    _buildSlotTag(tag, category) {
        const safeTag = this._escapeValue(tag);
        const encodedTag = this._safeDataValue(tag);
        const encodedCategory = this._safeDataValue(category);
        return `
            <span class="slot-tag" data-tag="${encodedTag}" data-cat="${encodedCategory}">
                ${safeTag}
                <span class="slot-tag-remove" data-tag="${encodedTag}" data-cat="${encodedCategory}">×</span>
            </span>
        `;
    },

    // ============== Rendering ==============

    renderCategoryBrowser() {
        const container = document.getElementById('promptlab-categories');
        if (!container) return;

        const categoryNames = Object.keys(this.categories);
        if (categoryNames.length === 0) {
            container.innerHTML = `<div class="empty-state">${this._escapeValue(
                this._t('promptlab.categoriesUnavailable', 'No categories loaded. Check backend connection.')
            )}</div>`;
            return;
        }

        const html = categoryNames.map((cat) => {
            const tags = this.categories[cat] || [];
            const selectedTags = this.slots[cat] || [];
            const encodedCategory = this._safeDataValue(cat);
            const safeCategory = this._escapeValue(cat);
            const isExpanded = container.querySelector(`[data-cat="${encodedCategory}"]`)?.classList.contains('expanded');

            return `
                <div class="cat-group ${isExpanded ? 'expanded' : ''}" data-cat="${encodedCategory}">
                    <div class="cat-header" data-cat="${encodedCategory}">
                        <span class="cat-arrow">${isExpanded ? '▼' : '▶'}</span>
                        <span class="cat-name">${safeCategory}</span>
                        <span class="cat-count">${tags.length}</span>
                        ${selectedTags.length > 0 ? `<span class="cat-selected">${selectedTags.length} selected</span>` : ''}
                    </div>
                    <div class="cat-tags" style="display: ${isExpanded ? 'flex' : 'none'};">
                        ${tags.map((tag) => this._buildTagChip(tag, cat, selectedTags)).join('')}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        container.querySelectorAll('.cat-header').forEach((header) => {
            header.addEventListener('click', () => {
                const group = header.parentElement;
                const tagsDiv = group.querySelector('.cat-tags');
                const arrow = header.querySelector('.cat-arrow');
                const isOpen = tagsDiv.style.display !== 'none';
                tagsDiv.style.display = isOpen ? 'none' : 'flex';
                arrow.textContent = isOpen ? '▶' : '▼';
                group.classList.toggle('expanded', !isOpen);
            });
        });

        container.querySelectorAll('.cat-tag').forEach((tagEl) => {
            tagEl.addEventListener('click', () => {
                const tag = this._decodeDataValue(tagEl.dataset.tag);
                const cat = this._decodeDataValue(tagEl.dataset.cat);
                this.toggleTagInSlot(cat, tag);
            });
        });
    },

    renderSlotBuilder() {
        const container = document.getElementById('promptlab-slots');
        if (!container) return;

        const categoryNames = Object.keys(this.categories);
        if (categoryNames.length === 0) {
            container.innerHTML = `<div class="empty-state">${this._escapeValue(
                this._t('promptlab.loadCategoriesFirst', 'Load categories first')
            )}</div>`;
            return;
        }

        const activeCategories = categoryNames.filter((cat) => {
            const selected = this.slots[cat] || [];
            return selected.length > 0;
        });

        const coreCats = ['character', 'outfit', 'pose', 'expression', 'body', 'background', 'style', 'quality'];
        const displayCats = [...new Set([...coreCats.filter(c => categoryNames.includes(c)), ...activeCategories])];

        const html = displayCats.map((cat) => {
            const selected = this.slots[cat] || [];
            const isLocked = this.locked[cat] || false;
            const weight = this.weights[cat] ?? 50;
            const hasConflict = this.checkConflicts(cat);
            const safeCategory = this._escapeValue(cat);
            const encodedCategory = this._safeDataValue(cat);

            return `
                <div class="slot-row ${hasConflict ? 'has-conflict' : ''}" data-slot="${encodedCategory}">
                    <div class="slot-header">
                        <button class="slot-lock ${isLocked ? 'locked' : ''}" data-cat="${encodedCategory}" title="${isLocked ? 'Unlock' : 'Lock'} (survives randomize)">
                            ${isLocked ? '🔒' : '🔓'}
                        </button>
                        <span class="slot-name">${safeCategory}</span>
                        ${hasConflict ? '<span class="conflict-icon" title="Exclusion rule conflict">⚠️</span>' : ''}
                    </div>
                    <div class="slot-tags">
                        ${selected.length > 0 ? selected.map((tag) => this._buildSlotTag(tag, cat)).join('') : `<span class="slot-empty">${this._escapeValue(this._t('promptlab.slotEmpty', 'Click tags in the browser to add'))}</span>`}
                    </div>
                    <div class="slot-weight">
                        <input type="range" min="0" max="100" value="${weight}"
                               class="slot-weight-slider" data-cat="${encodedCategory}" title="Weight: ${weight}%">
                        <span class="slot-weight-value">${weight}%</span>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        container.querySelectorAll('.slot-tag-remove').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeTagFromSlot(
                    this._decodeDataValue(btn.dataset.cat),
                    this._decodeDataValue(btn.dataset.tag),
                );
            });
        });

        container.querySelectorAll('.slot-lock').forEach((btn) => {
            btn.addEventListener('click', () => {
                const cat = this._decodeDataValue(btn.dataset.cat);
                this.locked[cat] = !this.locked[cat];
                this.renderSlotBuilder();
            });
        });

        container.querySelectorAll('.slot-weight-slider').forEach((slider) => {
            slider.addEventListener('input', () => {
                const cat = this._decodeDataValue(slider.dataset.cat);
                this.weights[cat] = parseInt(slider.value, 10) || 0;
                slider.nextElementSibling.textContent = `${slider.value}%`;
            });
        });

        this.updateActionState();
    },

    renderPresetList() {
        const container = document.getElementById('promptlab-presets');
        if (!container) return;

        if (this.presets.length === 0) {
            container.innerHTML = `<div class="preset-empty">${this._escapeValue(
                this._t('promptlab.noPresetsDetailed', 'No saved presets. Save your current configuration as a preset.')
            )}</div>`;
            return;
        }

        container.innerHTML = this.presets.map((preset) => `
            <div class="preset-item" data-id="${preset.id}">
                <span class="preset-name">${this._escapeValue(preset.name)}</span>
                <div class="preset-actions">
                    <button class="btn-preset-load" data-id="${preset.id}" title="Load preset">📂</button>
                    <button class="btn-preset-delete" data-id="${preset.id}" title="Delete preset">🗑️</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.btn-preset-load').forEach((btn) => {
            btn.addEventListener('click', () => this.loadPreset(btn.dataset.id));
        });

        container.querySelectorAll('.btn-preset-delete').forEach((btn) => {
            btn.addEventListener('click', () => this.deletePreset(btn.dataset.id));
        });
    },

    renderTagSetOptions() {
        const selector = document.getElementById('promptlab-set-select');
        if (!selector) return;

        const _pl = window.I18n?.t?.('promptlab.selectTagSet');
        const defaultLabel = (_pl && _pl !== 'promptlab.selectTagSet') ? _pl : '-- Select Tag Set --';
        const options = [
            `<option value="">${this._escapeValue(defaultLabel)}</option>`,
            ...this.tagSets.map((set) => `
                <option value="${this._escapeValue(String(set.id))}">
                    ${this._escapeValue(set.name)}${set.category ? ` (${this._escapeValue(set.category)})` : ''}
                </option>
            `)
        ];

        selector.innerHTML = options.join('');
    },

    _isUserPromptResource(item, builtinPrefix) {
        const id = String(item?.id ?? '').trim();
        return Boolean(id) && !id.startsWith(builtinPrefix);
    },

    _renderResourceEmpty(key, fallback) {
        return `<div class="promptlab-resource-empty">${this._escapeValue(this._t(key, fallback))}</div>`;
    },

    _renderResourceItem(item, actionClass) {
        const safeId = this._safeDataValue(item.id);
        const safeName = this._escapeValue(item.name || item.rule_name || item.id);
        const safeMeta = this._escapeValue(this._formatPromptResourceMeta(item));
        return `
            <div class="promptlab-resource-item">
                <div class="promptlab-resource-main">
                    <span class="promptlab-resource-title">${safeName}</span>
                    ${safeMeta ? `<span class="promptlab-resource-meta">${safeMeta}</span>` : ''}
                </div>
                <button class="btn btn-small btn-ghost ${actionClass}" type="button" data-id="${safeId}" title="${this._escapeValue(this._t('common.delete', 'Delete'))}" aria-label="${this._escapeValue(this._t('common.delete', 'Delete'))}">🗑️</button>
            </div>
        `;
    },

    _formatPromptResourceMeta(item) {
        if (!item) return '';
        if (Array.isArray(item.members) || Array.isArray(item.tags)) {
            const count = item.tag_count ?? (item.members || item.tags || []).length;
            const parts = [];
            if (item.category) parts.push(item.category);
            parts.push(this._t('promptlab.tagCount', '{count} tags', { count }).replace('{count}', count));
            return parts.join(' · ');
        }

        const conditions = (item.conditions || [])
            .map((condition) => condition.tag || condition.condition_tag || '')
            .filter(Boolean);
        const targets = (item.targets || [])
            .map((target) => target.tag || target.excluded_tag || target.category || target.excluded_category || '')
            .filter(Boolean);
        if (!conditions.length && !targets.length) {
            return item.description || '';
        }
        return `${conditions.join(', ') || '*'} → ${targets.join(', ') || '*'}`;
    },

    renderPromptDataTools() {
        const categoryOptions = document.getElementById('promptlab-category-options');
        if (categoryOptions) {
            const categories = Object.keys(this.categories || {}).sort((a, b) => a.localeCompare(b));
            categoryOptions.innerHTML = categories
                .map((category) => `<option value="${this._escapeValue(category)}"></option>`)
                .join('');
        }

        const setList = document.getElementById('promptlab-custom-set-list');
        if (setList) {
            const userSets = this.tagSets.filter((set) => this._isUserPromptResource(set, 'builtin-tag-set'));
            setList.innerHTML = userSets.length
                ? userSets.map((set) => this._renderResourceItem(set, 'btn-promptlab-delete-set')).join('')
                : this._renderResourceEmpty('promptlab.noCustomTagSets', 'No custom tag sets yet.');
        }

        const exclusionList = document.getElementById('promptlab-exclusion-list');
        if (exclusionList) {
            const userRules = this.exclusionRules.filter((rule) => this._isUserPromptResource(rule, 'builtin-exclusion'));
            exclusionList.innerHTML = userRules.length
                ? userRules.map((rule) => this._renderResourceItem(rule, 'btn-promptlab-delete-exclusion')).join('')
                : this._renderResourceEmpty('promptlab.noCustomExclusions', 'No custom exclusions yet.');
        }

        this.setReadyState(this.isReady);
    },

    renderOutput() {
        const outputEl = document.getElementById('promptlab-output');
        if (!outputEl) return;

        outputEl.value = this.generatedPrompt;

        const warningsEl = document.getElementById('promptlab-warnings');
        if (!warningsEl) return;

        const conflicts = this.getAllConflicts();
        if (conflicts.length > 0) {
            const fragment = document.createDocumentFragment();
            conflicts.forEach((conflict) => {
                const item = document.createElement('div');
                item.className = 'warning-item';
                item.textContent = `⚠️ ${conflict}`;
                fragment.appendChild(item);
            });
            warningsEl.replaceChildren(fragment);
            warningsEl.style.display = 'block';
        } else {
            warningsEl.replaceChildren();
            warningsEl.style.display = 'none';
        }

        this.updateActionState();
    },

    // ============== Slot Management ==============

    toggleTagInSlot(category, tag) {
        if (!this.slots[category]) {
            this.slots[category] = [];
        }

        const idx = this.slots[category].indexOf(tag);
        if (idx >= 0) {
            this.slots[category] = this.slots[category].filter(t => t !== tag);
        } else {
            this.slots[category] = [...this.slots[category], tag];
        }

        this.invalidateGeneratedPrompt();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
    },

    removeTagFromSlot(category, tag) {
        if (this.slots[category]) {
            this.slots[category] = this.slots[category].filter(t => t !== tag);
        }
        this.invalidateGeneratedPrompt();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
    },

    // ============== Conflict Detection ==============

    checkConflicts(category) {
        const selected = this.slots[category] || [];
        if (selected.length === 0) return false;

        for (const rule of this.exclusionRules) {
            // Backend shape: { conditions: [{tag, type}], targets: [{tag, category}] }
            // checkConflicts only used for UI highlight — treat as best-effort
            const conditionMet = rule.conditions?.some((cond) => {
                const condTag = String(cond.tag || cond.pattern || '');
                // Check if any currently selected tag in any slot includes the condition tag
                return Object.values(this.slots).some(slotTags =>
                    slotTags.some(t => condTag && t.includes(condTag))
                );
            });

            if (conditionMet) {
                const hasExcluded = rule.targets?.some((target) => {
                    const targetCat = target.category || '';
                    const targetTag = String(target.tag || target.pattern || '');
                    if (!targetCat || targetCat === category) {
                        return selected.some(t => targetTag && t.includes(targetTag));
                    }
                    return false;
                }) || rule.excludes?.some((exc) => {
                    if (exc.category === category) {
                        return selected.some(t => exc.pattern && t.includes(exc.pattern));
                    }
                    return false;
                });
                if (hasExcluded) return true;
            }
        }
        return false;
    },

    getAllConflicts() {
        const conflicts = [];

        for (const rule of this.exclusionRules) {
            const conditionMet = rule.conditions?.some((cond) => {
                const condTag = String(cond.tag || cond.pattern || '');
                return condTag && Object.values(this.slots).some(slotTags =>
                    slotTags.some(t => t.includes(condTag))
                );
            });

            if (conditionMet) {
                const excludedTags = [];
                const targets = rule.targets || rule.excludes || [];
                for (const target of targets) {
                    const targetCat = target.category || '';
                    const targetTag = String(target.tag || target.pattern || '');
                    const catTags = targetCat ? (this.slots[targetCat] || []) : Object.values(this.slots).flat();
                    const found = targetTag ? catTags.filter(t => t.includes(targetTag)) : [];
                    excludedTags.push(...found.map(t => `${t}${targetCat ? ` (${targetCat})` : ''}`));
                }

                if (excludedTags.length > 0) {
                    conflicts.push(`"${rule.name}": ${excludedTags.join(', ')} should be excluded`);
                }
            }
        }

        return conflicts;
    },

    // ============== Generation ==============

    async generate() {
        const { showToast } = window.App;

        if (!this.isReady) {
            showToast(this._t('promptlab.loadingWait', 'Prompt Lab is still loading. Please wait a moment.'), 'info');
            return;
        }

        if (!this.hasBuilderSelection()) {
            showToast(this._t('promptlab.addTagBeforeGenerate', 'Add at least one tag or apply a tag set before generating'), 'warning');
            return;
        }

        try {
            const config = {
                categories: {},
                tag_sets: [],
                quality_preset: 'none',
                count_tag: '',
                include_negative: false,
                count: 1,
            };

            for (const [cat, tags] of Object.entries(this.slots)) {
                if (tags.length > 0) {
                    config.categories[cat] = {
                        tags,
                        weight: (this.weights[cat] ?? 50) / 100,
                        locked: this.locked[cat] || false,
                    };
                }
            }

            const result = await window.App.API.post('/api/prompts/generate', config);
            this._readAffixInputs();
            this.generatedPromptCore = result.positive_prompt || result.prompt || '';
            this.generatedPrompt = this._applyPrependAppend(this.generatedPromptCore);
            this.renderOutput();

            if (result.warnings?.length > 0) {
                showToast(
                    this._t('promptlab.generatedWarnings', 'Generated with {count} warning(s)', { count: result.warnings.length }),
                    'info'
                );
            }
        } catch (e) {
            showToast(formatUserError(e, this._t('promptlab.generateFailed', 'Prompt generation failed')), 'error');
        }
    },

    async randomize() {
        if (!this.isReady) {
            window.App.showToast(this._t('promptlab.loadingWait', 'Prompt Lab is still loading. Please wait a moment.'), 'info');
            return;
        }

        for (const cat of Object.keys(this.categories)) {
            if (this.randomizeExcludedCategories.has(cat)) continue;
            if (this.locked[cat]) continue;

            const tags = this.categories[cat] || [];
            if (tags.length === 0) continue;

            const weight = (this.weights[cat] ?? 50) / 100;
            if (Math.random() > weight) {
                this.slots[cat] = [];
                continue;
            }

            const count = Math.min(tags.length, Math.floor(Math.random() * 3) + 1);
            const shuffled = [...tags].sort(() => Math.random() - 0.5);
            this.slots[cat] = shuffled.slice(0, count);
        }

        if (!this.hasBuilderSelection()) {
            const fallbackOrder = ['character', 'outfit', 'style', 'pose', 'background', 'expression', 'body', 'angle', 'quality'];
            const fallbackCategory = fallbackOrder.find((cat) => (this.categories[cat] || []).length > 0)
                || Object.keys(this.categories).find((cat) => (this.categories[cat] || []).length > 0);

            if (fallbackCategory) {
                const fallbackTags = this.categories[fallbackCategory];
                const fallbackTag = fallbackTags[Math.floor(Math.random() * fallbackTags.length)];
                this.slots[fallbackCategory] = [fallbackTag];
            }
        }

        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        await this.generate();
    },

    async validate() {
        const { showToast } = window.App;

        if (!this.isReady) {
            showToast(this._t('promptlab.loadingWait', 'Prompt Lab is still loading. Please wait a moment.'), 'info');
            return;
        }

        if (!this.hasBuilderSelection()) {
            showToast(this._t('promptlab.addTagBeforeValidate', 'Add at least one tag before validating conflicts'), 'warning');
            return;
        }

        try {
            const allTags = this.getSelectedTags();
            const result = await window.App.API.post('/api/prompts/validate', { tags: allTags });
            const violations = result.violations || result.conflicts || [];

            if (violations.length > 0 || result.valid === false) {
                showToast(
                    this._t('promptlab.conflictsFound', 'Found {count} conflict(s)', { count: violations.length }),
                    'error'
                );
            } else {
                showToast(this._t('promptlab.noConflicts', 'No conflicts detected'), 'success');
            }
        } catch (e) {
            showToast(formatUserError(e, this._t('promptlab.validateFailed', 'Prompt validation failed')), 'error');
        }
    },

    // ============== Presets ==============

    async savePreset() {
        this._readAffixInputs();
        const name = await window.App.showInputModal(
            this._t('promptlab.savePresetTitle', 'Save Preset'),
            this._t('promptlab.savePresetMessage', 'Enter a name for this preset:'),
            ''
        );
        if (!name) return;

        try {
            await window.App.API.post('/api/prompts/presets', {
                name,
                config: {
                    slots: { ...this.slots },
                    weights: { ...this.weights },
                    locked: { ...this.locked },
                    prependTags: this.prependTags,
                    appendTags: this.appendTags,
                }
            });
            await this.loadPresets();
            this.renderPresetList();
            window.App.showToast(
                this._t('promptlab.presetSaved', 'Preset "{name}" saved', { name }),
                'success'
            );
        } catch (e) {
            window.App.showToast(formatUserError(e, this._t('promptlab.presetSaveFailed', 'Failed to save preset')), 'error');
        }
    },

    async loadPreset(id) {
        try {
            const preset = this.presets.find(p => String(p.id) === String(id));
            if (!preset?.config) return;

            this.slots = { ...(preset.config.slots || {}) };
            this.weights = { ...(preset.config.weights || {}) };
            this.locked = { ...(preset.config.locked || {}) };
            this.prependTags = preset.config.prependTags || '';
            this.appendTags = preset.config.appendTags || '';
            this._syncAffixInputs();

            this.invalidateGeneratedPrompt();
            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            window.App.showToast(
                this._t('promptlab.presetLoaded', 'Loaded preset "{name}"', { name: preset.name }),
                'success'
            );
        } catch (e) {
            window.App.showToast(
                formatUserError(e, this._t('promptlab.presetLoadFailed', 'Failed to load preset')),
                'error'
            );
        }
    },

    async deletePreset(id) {
        const { showConfirm, API, showToast } = window.App;

        showConfirm(
            this._t('promptlab.deletePresetTitle', 'Delete Preset'),
            this._t('promptlab.deletePresetMessage', 'Delete this preset? This cannot be undone.'),
            async () => {
                try {
                    await API.delete(`/api/prompts/presets/${id}`);
                    await this.loadPresets();
                    this.renderPresetList();
                    showToast(this._t('promptlab.presetDeleted', 'Preset deleted'), 'info');
                } catch (e) {
                    showToast(
                        formatUserError(e, this._t('promptlab.presetDeleteFailed', 'Failed to delete preset')),
                        'error'
                    );
                }
            }
        );
    },

    // ============== Tag Sets ==============

    applyTagSet(setId) {
        const set = this.tagSets.find(s => String(s.id) === String(setId));
        if (!set) return;

        // Backend shape: { id, name, category, tags: [{tag, weight, required}] }
        const members = set.members || set.tags || [];
        for (const member of members) {
            const cat = member.category || set.category || 'style';
            const tag = member.tag;
            if (!tag) continue;
            if (!this.slots[cat]) this.slots[cat] = [];
            if (!this.slots[cat].includes(tag)) {
                this.slots[cat] = [...this.slots[cat], tag];
            }
        }

        this.invalidateGeneratedPrompt();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        window.App.showToast(
            this._t('promptlab.tagSetApplied', 'Applied tag set "{name}"', { name: set.name }),
            'success'
        );
    },

    async recategorizeTag() {
        const tagInput = document.getElementById('promptlab-recat-tag');
        const categoryInput = document.getElementById('promptlab-recat-category');
        const tag = String(tagInput?.value || '').trim();
        const category = String(categoryInput?.value || '').trim();

        if (!tag || !category) {
            window.App.showToast(
                this._t('promptlab.recategorizeMissing', 'Enter both a tag and a category.'),
                'warning'
            );
            return;
        }

        try {
            await window.App.API.post(`/api/prompts/recategorize?tag=${encodeURIComponent(tag)}&category=${encodeURIComponent(category)}`, {});
            Object.keys(this.slots).forEach((slotCategory) => {
                const tags = this.slots[slotCategory] || [];
                if (!tags.includes(tag)) return;
                this.slots[slotCategory] = tags.filter((slotTag) => slotTag !== tag);
                if (!this.slots[category]) this.slots[category] = [];
                if (!this.slots[category].includes(tag)) this.slots[category] = [...this.slots[category], tag];
            });
            await this.loadCategories();
            await this.loadTagSets();
            this.renderTagSetOptions();
            this.renderPromptDataTools();
            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            window.App.showToast(
                this._t('promptlab.recategorized', 'Moved "{tag}" to "{category}".', { tag, category }),
                'success'
            );
        } catch (e) {
            window.App.showToast(
                formatUserError(e, this._t('promptlab.recategorizeFailed', 'Failed to move tag category')),
                'error'
            );
        }
    },

    _getCategoryBoardGroups() {
        return window.TagCategoryCopy?.CORE_BOARD_GROUPS || [
            { id: 'appearance', labelKey: 'tagCategory.appearance', fallback: 'Appearance', icon: '◌', saveCategory: 'body' },
            { id: 'clothing', labelKey: 'tagCategory.clothing', fallback: 'Clothing', icon: '▣', saveCategory: 'outfit' },
            { id: 'pose', labelKey: 'tagCategory.pose', fallback: 'Pose', icon: '↕', saveCategory: 'pose' },
            { id: 'scenery', labelKey: 'tagCategory.scenery', fallback: 'Scenery', icon: '△', saveCategory: 'background' },
            { id: 'unclassified', labelKey: 'tagCategory.unclassified', fallback: 'Unclassified', icon: '?', saveCategory: 'unknown' },
        ];
    },

    _getCategoryBoardSourceTags() {
        const fromSlots = Object.values(this.slots || {}).flat().filter(Boolean);
        if (fromSlots.length > 0) return fromSlots;

        const buildPrompt = document.getElementById('pl-build-prompt')?.value || '';
        const generated = this.generatedPromptCore || this.generatedPrompt || document.getElementById('promptlab-output')?.value || '';
        const singleTag = document.getElementById('promptlab-recat-tag')?.value || '';
        const source = [buildPrompt, generated, singleTag].find((value) => String(value || '').trim());
        return window.TagCategoryCopy?.parsePromptTags?.(source) || this._parsePromptTags(source);
    },

    _dedupeCategoryBoardTags(tags) {
        const seen = new Set();
        const result = [];
        (tags || []).forEach((tag) => {
            const clean = String(typeof tag === 'object' ? (tag.tag || tag.name || tag.text) : tag || '').trim();
            if (!clean) return;
            const key = clean.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            result.push(clean);
        });
        return result;
    },

    _setCategoryBoardStatus(message, tone = '') {
        const status = document.getElementById('promptlab-category-board-status');
        if (!status) return;
        status.textContent = message || '';
        status.className = `promptlab-category-board-status${tone ? ` ${tone}` : ''}`;
    },

    _syncCategoryBoardSubmitState() {
        const submit = document.getElementById('promptlab-category-board-submit');
        if (!submit) return;
        const changes = this._getCategoryBoardChanges();
        submit.disabled = changes.length === 0;
    },

    _getCategoryBoardChanges() {
        const state = this.categoryBoardState || {};
        const original = this.categoryBoardOriginal || {};
        const changes = [];
        const groups = this._getCategoryBoardGroups();
        const groupById = new Map(groups.map((group) => [group.id, group]));

        for (const [groupId, tags] of Object.entries(state)) {
            for (const tag of tags || []) {
                const key = String(tag || '').toLowerCase();
                if (!key || original[key] === groupId) continue;
                const group = groupById.get(groupId);
                if (!group?.saveCategory) continue;
                changes.push({ tag, groupId, category: group.saveCategory });
            }
        }
        return changes;
    },

    _renderCategoryBoard() {
        const columns = document.getElementById('promptlab-category-board-columns');
        const count = document.getElementById('promptlab-category-board-count');
        if (!columns) return;

        const groups = this._getCategoryBoardGroups();
        const state = this.categoryBoardState || {};
        const total = Object.values(state).reduce((sum, tags) => sum + (tags?.length || 0), 0);
        if (count) count.textContent = String(total);

        columns.innerHTML = groups.map((group) => {
            const tags = state[group.id] || [];
            const label = this._t(group.labelKey, group.fallback);
            return `
                <section class="promptlab-category-board-column promptlab-category-board-${this._escapeValue(group.id)}" data-board-group="${this._safeDataValue(group.id)}">
                    <header class="promptlab-category-board-column-head">
                        <span class="promptlab-category-board-icon" aria-hidden="true">${this._escapeValue(group.icon || '')}</span>
                        <span class="promptlab-category-board-title">${this._escapeValue(label)}</span>
                        <span class="promptlab-category-board-count">${tags.length}</span>
                    </header>
                    <div class="promptlab-category-board-dropzone" data-board-group="${this._safeDataValue(group.id)}">
                        ${tags.length ? tags.map((tag) => `
                            <button type="button" class="promptlab-category-board-tag" draggable="true" data-board-tag="${this._safeDataValue(tag)}" data-board-group="${this._safeDataValue(group.id)}">
                                <span class="promptlab-category-board-grip" aria-hidden="true">⋮⋮</span>
                                <span>${this._escapeValue(tag)}</span>
                            </button>
                        `).join('') : `<div class="promptlab-category-board-empty">${this._escapeValue(this._t('promptlab.categoryBoardDropHere', 'Drop tags here'))}</div>`}
                    </div>
                </section>
            `;
        }).join('');

        columns.querySelectorAll('.promptlab-category-board-tag').forEach((tagEl) => {
            tagEl.addEventListener('dragstart', (event) => {
                const tag = this._decodeDataValue(tagEl.dataset.boardTag);
                this.categoryBoardActiveTag = tag;
                event.dataTransfer?.setData('text/plain', tag);
                event.dataTransfer.effectAllowed = 'move';
                tagEl.classList.add('is-dragging');
            });
            tagEl.addEventListener('dragend', () => {
                tagEl.classList.remove('is-dragging');
                this.categoryBoardActiveTag = '';
            });
        });

        columns.querySelectorAll('.promptlab-category-board-dropzone').forEach((zone) => {
            zone.addEventListener('dragover', (event) => {
                event.preventDefault();
                zone.classList.add('is-over');
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
            zone.addEventListener('drop', (event) => {
                event.preventDefault();
                zone.classList.remove('is-over');
                const tag = event.dataTransfer?.getData('text/plain') || this.categoryBoardActiveTag;
                const groupId = this._decodeDataValue(zone.dataset.boardGroup);
                this._moveCategoryBoardTag(tag, groupId);
            });
        });

        this._syncCategoryBoardSubmitState();
    },

    _moveCategoryBoardTag(tag, targetGroupId) {
        const cleanTag = String(tag || '').trim();
        if (!cleanTag || !targetGroupId || !this.categoryBoardState) return;
        Object.keys(this.categoryBoardState).forEach((groupId) => {
            this.categoryBoardState[groupId] = (this.categoryBoardState[groupId] || []).filter((item) => item !== cleanTag);
        });
        if (!this.categoryBoardState[targetGroupId]) this.categoryBoardState[targetGroupId] = [];
        if (!this.categoryBoardState[targetGroupId].includes(cleanTag)) {
            this.categoryBoardState[targetGroupId].push(cleanTag);
        }
        this._renderCategoryBoard();
    },

    async openCategoryBoard(tags = null) {
        const modalId = 'promptlab-category-board-modal';
        const sourceTags = this._dedupeCategoryBoardTags(Array.isArray(tags) ? tags : this._getCategoryBoardSourceTags());

        window.App?.showModal?.(modalId);
        this._setCategoryBoardStatus(this._t('common.loading', 'Loading...'));
        this.categoryBoardState = null;
        this.categoryBoardOriginal = null;
        document.getElementById('promptlab-category-board-columns')?.replaceChildren();
        this._syncCategoryBoardSubmitState();

        if (sourceTags.length === 0) {
            this._setCategoryBoardStatus(this._t('promptlab.categoryBoardNoTags', 'No tags available. Select tags, paste a tag, or open it from an image.'), 'warning');
            return;
        }

        try {
            if (!Object.keys(this.categories || {}).length) {
                await this.loadCategories();
            }
            const classified = await window.TagCategoryCopy.classifyTags(sourceTags);
            const groups = this._getCategoryBoardGroups();
            const state = Object.fromEntries(groups.map((group) => [group.id, []]));
            const original = {};
            classified.tags.forEach((tag) => {
                const category = classified.tagCategory?.[String(tag).toLowerCase()] || 'unknown';
                const group = window.TagCategoryCopy.groupForCategory(category);
                const groupId = group?.id || 'unclassified';
                if (!state[groupId]) state[groupId] = [];
                state[groupId].push(tag);
                original[String(tag).toLowerCase()] = groupId;
            });
            this.categoryBoardState = state;
            this.categoryBoardOriginal = original;
            this._setCategoryBoardStatus('');
            this._renderCategoryBoard();
        } catch (error) {
            this._setCategoryBoardStatus(formatUserError(error, this._t('promptlab.categoryBoardLoadFailed', 'Failed to prepare category board')), 'error');
        }
    },

    closeCategoryBoard() {
        window.App?.hideModal?.('promptlab-category-board-modal');
    },

    async submitCategoryBoard() {
        const changes = this._getCategoryBoardChanges();
        if (changes.length === 0) {
            this.closeCategoryBoard();
            return;
        }

        const submit = document.getElementById('promptlab-category-board-submit');
        if (submit) submit.disabled = true;
        this._setCategoryBoardStatus(this._t('promptlab.categoryBoardSaving', 'Saving category suggestions...'));

        try {
            for (const change of changes) {
                await window.App.API.post(`/api/prompts/recategorize?tag=${encodeURIComponent(change.tag)}&category=${encodeURIComponent(change.category)}`, {});
            }
            await this.loadCategories();
            await this.loadTagSets();
            this.renderTagSetOptions();
            this.renderPromptDataTools();
            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            window.App?.showToast?.(
                this._t('promptlab.categoryBoardSaved', 'Saved {count} category suggestion(s).', { count: changes.length }).replace('{count}', changes.length),
                'success'
            );
            this.closeCategoryBoard();
        } catch (error) {
            this._setCategoryBoardStatus(formatUserError(error, this._t('promptlab.categoryBoardSaveFailed', 'Failed to save category suggestions')), 'error');
            if (submit) submit.disabled = false;
        }
    },

    deleteTagSet(setId) {
        const set = this.tagSets.find((item) => String(item.id) === String(setId));
        if (!set || !this._isUserPromptResource(set, 'builtin-tag-set')) return;

        window.App.showConfirm(
            this._t('promptlab.deleteTagSetTitle', 'Delete custom tag set?'),
            this._t('promptlab.deleteTagSetMessage', 'Delete "{name}"? This cannot be undone.', { name: set.name }),
            async () => {
                try {
                    await window.App.API.delete(`/api/prompts/sets/${encodeURIComponent(setId)}`);
                    await this.loadTagSets();
                    this.renderTagSetOptions();
                    this.renderPromptDataTools();
                    window.App.showToast(
                        this._t('promptlab.tagSetDeleted', 'Tag set deleted'),
                        'info'
                    );
                } catch (e) {
                    window.App.showToast(
                        formatUserError(e, this._t('promptlab.tagSetDeleteFailed', 'Failed to delete tag set')),
                        'error'
                    );
                }
            }
        );
    },

    deleteExclusionRule(ruleId) {
        const rule = this.exclusionRules.find((item) => String(item.id) === String(ruleId));
        if (!rule || !this._isUserPromptResource(rule, 'builtin-exclusion')) return;

        window.App.showConfirm(
            this._t('promptlab.deleteExclusionTitle', 'Delete custom exclusion?'),
            this._t('promptlab.deleteExclusionMessage', 'Delete "{name}"? This cannot be undone.', { name: rule.name }),
            async () => {
                try {
                    await window.App.API.delete(`/api/prompts/exclusions/${encodeURIComponent(ruleId)}`);
                    await this.loadExclusionRules();
                    this.renderPromptDataTools();
                    this.renderOutput();
                    window.App.showToast(
                        this._t('promptlab.exclusionDeleted', 'Exclusion deleted'),
                        'info'
                    );
                } catch (e) {
                    window.App.showToast(
                        formatUserError(e, this._t('promptlab.exclusionDeleteFailed', 'Failed to delete exclusion')),
                        'error'
                    );
                }
            }
        );
    },

    // ============== Copy ==============

    // Prompt Lab -> Gallery round-trip: take the composed/active prompt and use
    // it as the gallery's prompt filter, then switch to the Gallery view.
    // The prompt is split on commas into individual terms (same convention as the
    // gallery prompt-filter input), so 'exact' match mode ANDs across tags.
    usePromptInGallery() {
        const App = window.App;
        if (!App) return;

        const raw = (document.getElementById('promptlab-output')?.value || this.generatedPrompt || '').trim();
        if (!raw) {
            App.showToast?.(
                this._t('promptlab.findInGalleryEmpty', 'Build or type a prompt first, then find it in the gallery.'),
                'info'
            );
            return;
        }

        const terms = [];
        const seen = new Set();
        for (const part of raw.split(',')) {
            const term = part.trim();
            if (!term) continue;
            const key = term.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            terms.push(term);
        }
        if (terms.length === 0) {
            App.showToast?.(
                this._t('promptlab.findInGalleryEmpty', 'Build or type a prompt first, then find it in the gallery.'),
                'info'
            );
            return;
        }

        App.updateFilters?.((filters) => {
            filters.prompts = terms;
            filters.promptMatchMode = 'exact';
        });
        App.updateFilterSummary?.();
        App.switchView?.('gallery');
        App.loadImages?.();
        App.showToast?.(
            this._t('promptlab.findInGalleryDone', 'Gallery filtered by this prompt'),
            'success'
        );
    },

    copyPrompt() {
        const output = document.getElementById('promptlab-output');
        if (!output?.value) return;
        copyTextToClipboard(output.value, this._t('promptlab.promptCopied', 'Prompt copied'));
    },

    clearAll() {
        this.slots = {};
        this.weights = {};
        this.locked = {};
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        this.invalidateGeneratedPrompt();
    },

    // ============== Event Binding ==============

    bindEvents() {
        const btnGenerate = document.getElementById('btn-promptlab-generate');
        const btnUseGallery = document.getElementById('btn-promptlab-use-gallery');
        const btnRandom = document.getElementById('btn-promptlab-random');
        const btnValidate = document.getElementById('btn-promptlab-validate');
        const btnCopy = document.getElementById('btn-promptlab-copy');
        const btnClear = document.getElementById('btn-promptlab-clear');
        const btnSavePreset = document.getElementById('btn-promptlab-save-preset');
        const outputEl = document.getElementById('promptlab-output');
        const prependInput = document.getElementById('promptlab-prepend');
        const appendInput = document.getElementById('promptlab-append');

        btnGenerate?.addEventListener('click', () => this.generate());
        btnUseGallery?.addEventListener('click', () => this.usePromptInGallery());
        btnRandom?.addEventListener('click', () => this.randomize());
        btnValidate?.addEventListener('click', () => this.validate());
        btnCopy?.addEventListener('click', () => this.copyPrompt());
        btnClear?.addEventListener('click', () => this.clearAll());
        btnSavePreset?.addEventListener('click', () => this.savePreset());
        document.getElementById('btn-promptlab-recategorize')?.addEventListener('click', () => this.recategorizeTag());
        document.getElementById('btn-promptlab-category-board')?.addEventListener('click', () => this.openCategoryBoard());
        document.getElementById('promptlab-category-board-close')?.addEventListener('click', () => this.closeCategoryBoard());
        document.getElementById('promptlab-category-board-cancel')?.addEventListener('click', () => this.closeCategoryBoard());
        document.querySelector('#promptlab-category-board-modal .modal-backdrop')?.addEventListener('click', () => this.closeCategoryBoard());
        document.getElementById('promptlab-category-board-submit')?.addEventListener('click', () => this.submitCategoryBoard());
        document.getElementById('promptlab-custom-set-list')?.addEventListener('click', (event) => {
            const button = event.target.closest('.btn-promptlab-delete-set');
            if (!button) return;
            this.deleteTagSet(this._decodeDataValue(button.dataset.id));
        });
        document.getElementById('promptlab-exclusion-list')?.addEventListener('click', (event) => {
            const button = event.target.closest('.btn-promptlab-delete-exclusion');
            if (!button) return;
            this.deleteExclusionRule(this._decodeDataValue(button.dataset.id));
        });
        outputEl?.addEventListener('input', (event) => {
            this.generatedPrompt = event.target.value;
            this.generatedPromptCore = this._stripAffixesFromPrompt(event.target.value);
            this.updateActionState();
        });
        prependInput?.addEventListener('input', () => this.handleAffixInput());
        appendInput?.addEventListener('input', () => this.handleAffixInput());

        const setSelector = document.getElementById('promptlab-set-select');
        setSelector?.addEventListener('change', (e) => {
            if (e.target.value) {
                this.applyTagSet(e.target.value);
                e.target.value = '';
            }
        });

        const btnApplyTagSet = document.getElementById('btn-promptlab-apply-tagset');
        btnApplyTagSet?.addEventListener('click', () => {
            const currentSetSelector = document.getElementById('promptlab-set-select');
            if (currentSetSelector?.value) {
                this.applyTagSet(currentSetSelector.value);
                currentSetSelector.value = '';
            }
        });

        const searchInput = document.getElementById('promptlab-search');
        searchInput?.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            document.querySelectorAll('#promptlab-categories .cat-group').forEach((group) => {
                const catName = this._decodeDataValue(group.dataset.cat).toLowerCase();
                const tags = group.querySelectorAll('.cat-tag');
                let hasMatch = catName.includes(query);

                tags.forEach((tag) => {
                    const matches = this._decodeDataValue(tag.dataset.tag).toLowerCase().includes(query);
                    tag.style.display = query && !matches ? 'none' : '';
                    if (matches) hasMatch = true;
                });

                group.style.display = hasMatch || !query ? '' : 'none';

                if (query && hasMatch) {
                    const tagsDiv = group.querySelector('.cat-tags');
                    if (tagsDiv) tagsDiv.style.display = 'flex';
                    const arrow = group.querySelector('.cat-arrow');
                    if (arrow) arrow.textContent = '▼';
                }
            });
        });
    },

    // ============== Intelligence Features ==============

    bindIntelligenceEvents() {
        const self = this;
        // Tab switching
        document.querySelectorAll('.promptlab-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                // NOISE-09: clicking any mode tab also dismisses the first-use
                // guide card. This used to be the job of the duplicate Compare/
                // Build/Random buttons in the "What Next" card, now removed
                // because they shadowed these always-visible mode tabs.
                self.dismissFirstUseCard();
                self.activateMode(tab.dataset.mode);
            });
        });

        // Compare
        document.getElementById('pl-compare-go')?.addEventListener('click', () => self.runCompare());
        document.getElementById('pl-compare-a')?.addEventListener('change', (event) => {
            self._renderImagePreviewCard('pl-compare-a-preview', event.target.value, 'promptlab.comparePreviewEmpty', 'Choose an image to preview it here.');
        });
        document.getElementById('pl-compare-b')?.addEventListener('change', (event) => {
            self._renderImagePreviewCard('pl-compare-b-preview', event.target.value, 'promptlab.comparePreviewEmpty', 'Choose an image to preview it here.');
        });
        document.getElementById('pl-pick-a')?.addEventListener('click', () => self.openImagePicker('compare-a'));
        document.getElementById('pl-pick-b')?.addEventListener('click', () => self.openImagePicker('compare-b'));
        document.getElementById('pl-pick-build')?.addEventListener('click', () => self.openImagePicker('build'));
        document.getElementById('pl-image-picker-close')?.addEventListener('click', () => self.closeImagePicker());
        document.querySelector('#promptlab-image-picker-modal .modal-backdrop')?.addEventListener('click', () => self.closeImagePicker());
        document.getElementById('pl-image-picker-search')?.addEventListener('input', () => self.renderImagePicker());
        document.getElementById('pl-image-picker-grid')?.addEventListener('click', (event) => {
            const card = event.target.closest('.promptlab-image-picker-card');
            if (!card) return;
            self.selectImageFromPicker(card.dataset.imageId || '');
        });
        document.getElementById('pl-top-tags-more')?.addEventListener('click', () => self._expandStatsSection('topTags', 20));
        document.getElementById('pl-high-tags-more')?.addEventListener('click', () => self._expandStatsSection('highTags', 20));
        document.getElementById('pl-top-checkpoints-more')?.addEventListener('click', () => self._expandStatsSection('checkpoints', 12));
        document.getElementById('pl-best-checkpoints-more')?.addEventListener('click', () => self._expandStatsSection('bestCheckpoints', 8));
        document.getElementById('pl-top-scored-images-more')?.addEventListener('click', () => self._expandStatsSection('scoredImages', 8));
        document.getElementById('pl-recipe-suggestions-more')?.addEventListener('click', () => self._expandStatsSection('recipes', 8));
        // A byte-identical copy of the picker/pick-button bindings above sat
        // here (pin-sweep BUG-1): every click fired its handler twice.

        document.getElementById('pl-best-checkpoints')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;
            const checkpoint = actionButton.dataset.checkpoint || '';
            if (!checkpoint) return;

            if (actionButton.dataset.action === 'gallery') {
                const filters = window.App?.AppState?.filters;
                if (!filters) return;
                filters.checkpoints = filters.checkpoints.includes(checkpoint)
                    ? filters.checkpoints
                    : [...filters.checkpoints, checkpoint];
                window.App?.updateFilterSummary?.();
                window.App?.loadImages?.();
                window.App?.switchView?.('gallery');
            }

            if (actionButton.dataset.action === 'build') {
                const tags = String(actionButton.dataset.tags || '')
                    .split('|')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
                self._openBuildRecipe(checkpoint, tags);
            }

            if (actionButton.dataset.action === 'random') {
                const tags = String(actionButton.dataset.tags || '')
                    .split('|')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
                self._openRandomFromTokens(tags, checkpoint);
            }
        });

        document.getElementById('pl-top-scored-images')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;
            const imageId = actionButton.dataset.imageId || '';
            if (!imageId) return;

            if (actionButton.dataset.action === 'build') {
                self._openBuildFromImageId(imageId);
            }

            if (actionButton.dataset.action === 'reader') {
                const filename = actionButton.dataset.filename || '';
                window.App?.openReaderFromImage?.(Number(imageId), filename);
            }

            if (actionButton.dataset.action === 'preview') {
                window.App?.switchView?.('gallery');
                window.App?.openGalleryPreview?.(Number(imageId));
            }
        });

        document.getElementById('pl-recipe-suggestions')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;

            if (actionButton.dataset.action === 'gallery') {
                const checkpoint = actionButton.dataset.checkpoint || '';
                const tags = String(actionButton.dataset.tags || '')
                    .split('|')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
                const filters = window.App?.AppState?.filters;
                if (!filters) return;
                if (checkpoint) {
                    filters.checkpoints = filters.checkpoints.includes(checkpoint)
                        ? filters.checkpoints
                        : [...filters.checkpoints, checkpoint];
                }
                for (const tag of tags) {
                    if (!filters.tags.includes(tag)) {
                        filters.tags = [...filters.tags, tag];
                    }
                }
                window.App?.updateFilterSummary?.();
                window.App?.loadImages?.();
                window.App?.switchView?.('gallery');
            }

            if (actionButton.dataset.action === 'build') {
                const checkpoint = actionButton.dataset.checkpoint || '';
                const tags = String(actionButton.dataset.tags || '')
                    .split('|')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
                self._openBuildRecipe(checkpoint, tags);
            }

            if (actionButton.dataset.action === 'random') {
                const checkpoint = actionButton.dataset.checkpoint || '';
                const tags = String(actionButton.dataset.tags || '')
                    .split('|')
                    .map((tag) => tag.trim())
                    .filter(Boolean);
                self._openRandomFromTokens(tags, checkpoint);
            }
        });

        document.getElementById('pl-compare-result')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;

            if (actionButton.dataset.action === 'build-image') {
                const imageId = actionButton.dataset.imageId || '';
                if (imageId) self._openBuildFromImageId(imageId);
            }

            if (actionButton.dataset.action === 'build-common') {
                const tokens = String(actionButton.dataset.tokens || '')
                    .split('|')
                    .map((token) => token.trim())
                    .filter(Boolean);
                self._openBuildDraft(tokens);
            }
        });

        document.getElementById('pl-top-tags')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;
            const tag = actionButton.dataset.tag || '';
            if (!tag) return;

            if (actionButton.dataset.action === 'build-tag') {
                self._appendBuildDraftTokens([tag]);
            }

            if (actionButton.dataset.action === 'gallery-tag') {
                self._filterGalleryByTags([tag]);
            }

            if (actionButton.dataset.action === 'random-tag') {
                self._openRandomFromTokens([tag]);
            }
        });

        document.getElementById('pl-high-tags')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-action]');
            if (!actionButton) return;
            const tag = actionButton.dataset.tag || '';
            if (!tag) return;

            if (actionButton.dataset.action === 'build-tag') {
                self._appendBuildDraftTokens([tag]);
            }

            if (actionButton.dataset.action === 'gallery-tag') {
                self._filterGalleryByTags([tag]);
            }

            if (actionButton.dataset.action === 'random-tag') {
                self._openRandomFromTokens([tag]);
            }
        });

        // Build
        document.getElementById('pl-build-source')?.addEventListener('change', (e) => self.loadBuildSource(e.target.value));
        document.getElementById('pl-build-use-checked')?.addEventListener('click', () => self._useCheckedBuildCategories());
        document.getElementById('pl-build-copy-caption')?.addEventListener('click', () => self._copyBuildTrainingCaption());
        document.getElementById('pl-build-clean-prompt')?.addEventListener('click', () => self._cleanBuildPrompt());
        document.getElementById('pl-build-drop-quality')?.addEventListener('click', () => self._cleanBuildPrompt({ dropQuality: true, reorder: true }));
        document.getElementById('pl-build-space-tags')?.addEventListener('click', () => self._cleanBuildPrompt({ spaces: true }));
        document.getElementById('pl-build-reorder')?.addEventListener('click', () => self._cleanBuildPrompt({ reorder: true }));
        document.getElementById('pl-build-copy')?.addEventListener('click', () => {
            const prompt = document.getElementById('pl-build-prompt')?.value;
            if (prompt) {
                navigator.clipboard.writeText(prompt);
                window.App?.showToast?.(self._t('promptlab.promptCopied', 'Prompt copied'), 'success');
            }
        });
        document.getElementById('pl-build-copy-all')?.addEventListener('click', () => {
            const prompt = document.getElementById('pl-build-prompt')?.value || '';
            const neg = document.getElementById('pl-build-negative')?.value || '';
            const text = neg ? `${prompt}\nNegative prompt: ${neg}` : prompt;
            navigator.clipboard.writeText(text);
            window.App?.showToast?.(self._t('promptlab.copyAllSuccess', 'Prompt and negative prompt copied'), 'success');
        });
    },

    async loadStats() {
        try {
            const statsQuery = new URLSearchParams({
                tag_limit: String(Math.max(this.statsVisibleCounts.topTags, 100)),
                high_tag_limit: String(Math.max(this.statsVisibleCounts.highTags, 100)),
                checkpoint_limit: String(Math.max(this.statsVisibleCounts.checkpoints, 30)),
                leader_limit: String(Math.max(this.statsVisibleCounts.bestCheckpoints, 24)),
                recipe_limit: String(Math.max(this.statsVisibleCounts.recipes, 24)),
                scored_limit: String(Math.max(this.statsVisibleCounts.scoredImages, 24)),
            });
            const stats = await window.App.API.get(`/api/prompts/stats?${statsQuery.toString()}`);
            this.lastStats = stats;
            document.getElementById('pl-total-images').textContent = stats.total_images || 0;
            document.getElementById('pl-scored-images').textContent = stats.scored_images || 0;
            document.getElementById('pl-avg-prompt-len').textContent = stats.prompt_length?.avg || 0;

            const topTagsEl = document.getElementById('pl-top-tags');
            if (topTagsEl && stats.top_tags) {
                const visible = stats.top_tags.slice(0, this.statsVisibleCounts.topTags);
                const maxCount = stats.top_tags[0]?.count || 1;
                topTagsEl.innerHTML = visible.length
                    ? visible.map(t =>
                        `<div class="promptlab-tag-item">
                            <span class="tag-name">${escapeHtml(t.tag)}</span>
                            <div class="tag-bar"><div class="tag-bar-fill" style="width:${(t.count / maxCount * 100).toFixed(0)}%"></div></div>
                            <span class="tag-count">${t.pct}%</span>
                            <div class="promptlab-inline-actions">
                                <button class="btn btn-ghost btn-small" data-action="gallery-tag" data-tag="${escapeHtml(t.tag)}">${this._t('promptlab.filterGallery', 'Filter Gallery')}</button>
                                <button class="btn btn-ghost btn-small" data-action="random-tag" data-tag="${escapeHtml(t.tag)}">${this._t('promptlab.useInRandom', 'Use in Random')}</button>
                                <button class="btn btn-secondary btn-small" data-action="build-tag" data-tag="${escapeHtml(t.tag)}">${this._t('promptlab.addToBuild', 'Add to Build')}</button>
                            </div>
                        </div>`
                    ).join('')
                    : this._renderStatsEmpty(this._t('promptlab.noTopTagsYet', 'Import more images to see your strongest recurring tags here.'));
            }

            const highEl = document.getElementById('pl-high-tags');
            if (highEl && stats.high_aesthetic_tags) {
                const maxH = stats.high_aesthetic_tags[0]?.count || 1;
                const visible = stats.high_aesthetic_tags.slice(0, this.statsVisibleCounts.highTags);
                highEl.innerHTML = stats.high_aesthetic_tags.length
                    ? visible.map(t =>
                        `<div class="promptlab-tag-item">
                            <span class="tag-name">${escapeHtml(t.tag)}</span>
                            <div class="tag-bar"><div class="tag-bar-fill" style="width:${(t.count / maxH * 100).toFixed(0)}%;background:#22c55e;"></div></div>
                            <span class="tag-count">${t.count}</span>
                            <div class="promptlab-inline-actions">
                                <button class="btn btn-ghost btn-small" data-action="gallery-tag" data-tag="${escapeHtml(t.tag)}">${this._t('promptlab.filterGallery', 'Filter Gallery')}</button>
                                <button class="btn btn-ghost btn-small" data-action="random-tag" data-tag="${escapeHtml(t.tag)}">${this._t('promptlab.useInRandom', 'Use in Random')}</button>
                                <button class="btn btn-secondary btn-small" data-action="build-tag" data-tag="${escapeHtml(t.tag)}">${this._t('promptlab.addToBuild', 'Add to Build')}</button>
                            </div>
                        </div>`
                    ).join('')
                    : this._renderStatsEmpty(this._t('promptlab.noScoredImagesYet', 'No scored images yet'));
            }

            const cpEl = document.getElementById('pl-top-checkpoints');
            if (cpEl && stats.top_checkpoints) {
                const visible = stats.top_checkpoints.slice(0, this.statsVisibleCounts.checkpoints);
                cpEl.innerHTML = visible.length
                    ? visible.map(c => {
                        const name = c.name.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || c.name;
                        return `<div class="promptlab-tag-item"><span class="tag-name">🧠 ${escapeHtml(name)}</span><span class="tag-count">${c.count}</span></div>`;
                    }).join('')
                    : this._renderStatsEmpty(this._t('promptlab.noCheckpointsYet', 'Checkpoint patterns will appear here after you import more prompt metadata.'));
            }

            const bestCheckpointEl = document.getElementById('pl-best-checkpoints');
            if (bestCheckpointEl) {
                const leaders = stats.checkpoint_score_leaders || [];
                bestCheckpointEl.innerHTML = leaders.length
                    ? leaders.slice(0, this.statsVisibleCounts.bestCheckpoints).map((entry) => {
                        const cleanName = entry.name.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || entry.name;
                        const metaText = entry.avg_score != null
                            ? `★ ${Number(entry.avg_score || 0).toFixed(2)} · ${entry.count} images`
                            : `${entry.count} images`;
                        const matchingRecipe = (stats.checkpoint_recipes || []).find(recipe => recipe.name === entry.name);
                        const recipeTags = Array.isArray(matchingRecipe?.tags) ? matchingRecipe.tags : [];
                        const recipePreview = recipeTags.slice(0, 8);
                        return `<div class="promptlab-action-card">
                            <div class="promptlab-action-title">🧠 ${escapeHtml(cleanName)}</div>
                            <div class="promptlab-action-meta">${metaText}${recipePreview.length ? `<br>${escapeHtml(recipePreview.join(', '))}` : ''}</div>
                            <div class="promptlab-action-buttons">
                                <button class="btn btn-ghost btn-small" data-action="gallery" data-checkpoint="${escapeHtml(entry.name)}">${this._t('promptlab.filterGallery', 'Filter Gallery')}</button>
                                <button class="btn btn-secondary btn-small" data-action="random" data-checkpoint="${escapeHtml(entry.name)}" data-tags="${escapeHtml(recipeTags.join('|'))}">${this._t('promptlab.useInRandom', 'Use in Random')}</button>
                                <button class="btn btn-primary btn-small" data-action="build" data-checkpoint="${escapeHtml(entry.name)}" data-tags="${escapeHtml(recipeTags.join('|'))}">${this._t('promptlab.sendRecipeToBuild', 'Send to Build')}</button>
                            </div>
                        </div>`;
                    }).join('')
                    : this._renderStatsEmpty(this._t('promptlab.notEnoughScoredData', 'Not enough scored data yet'));
            }

            const topScoredEl = document.getElementById('pl-top-scored-images');
            if (topScoredEl) {
                const examples = stats.top_scored_images || [];
                topScoredEl.innerHTML = examples.length
                    ? examples.slice(0, this.statsVisibleCounts.scoredImages).map((entry) => {
                        const cleanCheckpoint = entry.checkpoint
                            ? entry.checkpoint.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || entry.checkpoint
                            : '';
                        const promptPreview = escapeHtml(String(entry.prompt || '').slice(0, 120) || '');
                        return `<div class="promptlab-action-card promptlab-action-card-image">
                            <div class="promptlab-action-thumb">
                                <img src="${escapeHtml(this._getImageThumbUrl(entry.id, 320))}" alt="${escapeHtml(entry.filename || '')}" loading="lazy">
                            </div>
                            <div class="promptlab-action-main">
                                <div class="promptlab-action-title">${escapeHtml(entry.filename)} · ★ ${Number(entry.aesthetic_score || 0).toFixed(2)}</div>
                                <div class="promptlab-action-meta">${cleanCheckpoint ? `🧠 ${escapeHtml(cleanCheckpoint)}<br>` : ''}${promptPreview}</div>
                                <div class="promptlab-action-buttons">
                                    <button class="btn btn-primary btn-small" data-action="build" data-image-id="${entry.id}">${this._t('promptlab.openInBuild', 'Open in Build')}</button>
                                    <button class="btn btn-ghost btn-small" data-action="reader" data-image-id="${entry.id}" data-filename="${escapeHtml(entry.filename || '')}">${this._t('promptlab.openInReader', 'Open in Reader')}</button>
                                    <button class="btn btn-ghost btn-small" data-action="preview" data-image-id="${entry.id}">${this._t('promptlab.previewImage', 'Preview Image')}</button>
                                </div>
                            </div>
                        </div>`;
                    }).join('')
                    : this._renderStatsEmpty(this._t('promptlab.noScoredExamples', 'No scored examples yet'));
            }

            const recipeEl = document.getElementById('pl-recipe-suggestions');
            if (recipeEl) {
                const recipes = stats.checkpoint_recipes || [];
                recipeEl.innerHTML = recipes.length
                    ? recipes.slice(0, this.statsVisibleCounts.recipes).map((entry) => {
                        const cleanName = entry.name.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || entry.name;
                        const tags = Array.isArray(entry.tags) ? entry.tags : [];
                        const tagPreview = tags.slice(0, 8);
                        const metaText = entry.avg_score != null
                            ? `★ ${Number(entry.avg_score || 0).toFixed(2)} · ${entry.count} images`
                            : `${entry.count} images`;
                        return `<div class="promptlab-action-card">
                            <div class="promptlab-action-title">🧪 ${escapeHtml(cleanName)}</div>
                            <div class="promptlab-action-meta">${metaText}<br>${escapeHtml(tagPreview.join(', '))}</div>
                            <div class="promptlab-action-buttons">
                                <button class="btn btn-secondary btn-small" data-action="gallery" data-checkpoint="${escapeHtml(entry.name)}" data-tags="${escapeHtml(tags.join('|'))}">${this._t('promptlab.tryRecipe', 'Try in Gallery')}</button>
                                <button class="btn btn-secondary btn-small" data-action="random" data-checkpoint="${escapeHtml(entry.name)}" data-tags="${escapeHtml(tags.join('|'))}">${this._t('promptlab.useInRandom', 'Use in Random')}</button>
                                <button class="btn btn-primary btn-small" data-action="build" data-checkpoint="${escapeHtml(entry.name)}" data-tags="${escapeHtml(tags.join('|'))}">${this._t('promptlab.sendRecipeToBuild', 'Send to Build')}</button>
                            </div>
                        </div>`;
                    }).join('')
                    : this._renderStatsEmpty(this._t('promptlab.noRecipeSuggestions', 'No recipe suggestions yet'));
            }

            this._syncStatsLoadMore('pl-top-tags-more', stats.top_tags_total ?? stats.top_tags?.length ?? 0, this.statsVisibleCounts.topTags);
            this._syncStatsLoadMore('pl-high-tags-more', stats.high_aesthetic_tags_total ?? stats.high_aesthetic_tags?.length ?? 0, this.statsVisibleCounts.highTags);
            this._syncStatsLoadMore('pl-top-checkpoints-more', stats.top_checkpoints_total ?? stats.top_checkpoints?.length ?? 0, this.statsVisibleCounts.checkpoints);
            this._syncStatsLoadMore('pl-best-checkpoints-more', stats.checkpoint_score_leaders_total ?? (stats.checkpoint_score_leaders || []).length, this.statsVisibleCounts.bestCheckpoints);
            this._syncStatsLoadMore('pl-top-scored-images-more', stats.top_scored_images_total ?? (stats.top_scored_images || []).length, this.statsVisibleCounts.scoredImages);
            this._syncStatsLoadMore('pl-recipe-suggestions-more', stats.checkpoint_recipes_total ?? (stats.checkpoint_recipes || []).length, this.statsVisibleCounts.recipes);
        } catch (e) {
            (window.Logger?.error || console.error)('Failed to load prompt stats:', e);
            // Surface the failure instead of leaving a silently stale/empty
            // panel: inline note in the primary stats column + a toast.
            const failMsg = this._t('promptlab.statsLoadFailed', 'Could not load prompt stats. Please try again.');
            const topTagsEl = document.getElementById('pl-top-tags');
            if (topTagsEl) {
                topTagsEl.innerHTML = this._renderStatsEmpty(failMsg);
            }
            const toast = window.App?.showToast;
            if (typeof toast === 'function') {
                toast(typeof formatUserError === 'function' ? formatUserError(e, failMsg) : failMsg, 'error');
            }
        }
    },

    _syncStatsLoadMore(buttonId, totalCount, visibleCount) {
        const button = document.getElementById(buttonId);
        if (!button) return;
        button.style.display = totalCount > visibleCount ? 'inline-flex' : 'none';
    },

    _expandStatsSection(key, step) {
        this.statsVisibleCounts[key] = (this.statsVisibleCounts[key] || 0) + step;
        this.loadStats();
    },

    populateImageSelectors() {
        const images = this._getPromptLabImages();
        const options = images.map(img =>
            `<option value="${img.id}">${escapeHtml(img.filename)}${img.aesthetic_score != null ? ' ★' + img.aesthetic_score.toFixed(1) : ''}</option>`
        ).join('');
        const defaultOpt = `<option value="">${this._t('promptlab.selectImage', 'Select image...')}</option>`;
        ['pl-compare-a', 'pl-compare-b'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = defaultOpt + options;
        });
        this._renderImagePreviewCard('pl-compare-a-preview', document.getElementById('pl-compare-a')?.value || '', 'promptlab.comparePreviewEmpty', 'Choose an image to preview it here.');
        this._renderImagePreviewCard('pl-compare-b-preview', document.getElementById('pl-compare-b')?.value || '', 'promptlab.comparePreviewEmpty', 'Choose an image to preview it here.');
        if (!this.imageCatalogLoaded) {
            this._ensureImageCatalog().then(() => this.populateImageSelectors()).catch(() => {});
        }
    },

    async runCompare() {
        const idA = document.getElementById('pl-compare-a')?.value;
        const idB = document.getElementById('pl-compare-b')?.value;
        if (!idA || !idB) {
            window.App?.showToast?.(this._t('promptlab.selectTwoImages', 'Select two images to compare'), 'warning');
            return;
        }
        try {
            const result = await window.App.API.get(`/api/prompts/compare?id_a=${idA}&id_b=${idB}`);
            const container = document.getElementById('pl-compare-result');
            if (!container) return;
            const renderTags = (tags, cls) => tags.map(t => `<span class="promptlab-diff-tag ${cls}">${escapeHtml(t)}</span>`).join('');
            const commonTokens = Array.isArray(result.prompt_common) ? result.prompt_common : [];
            container.innerHTML = `
                <div class="promptlab-diff-card" style="grid-column:1/-1;">
                    <h5 style="color:#86efac;">${this._t('promptlab.commonTokens', 'Common')} (${result.prompt_common.length})</h5>
                    <div class="promptlab-diff-tags">${renderTags(result.prompt_common, 'common') || `<span style="color:var(--text-muted)">${this._t('promptlab.none', 'None')}</span>`}</div>
                    <div class="promptlab-action-buttons" style="margin-top:10px;">
                        <button class="btn btn-primary btn-small" data-action="build-common" data-tokens="${escapeHtml(commonTokens.join('|'))}">${this._t('promptlab.buildFromCommon', 'Build from Common')}</button>
                    </div>
                </div>
                <div class="promptlab-diff-card">
                    <h5 style="color:#93c5fd;">${this._t('promptlab.onlyInImage', 'Only in {name}', { name: result.image_a.filename }).replace('{name}', escapeHtml(result.image_a.filename))} (${result.prompt_only_a.length})</h5>
                    <div class="promptlab-diff-tags">${renderTags(result.prompt_only_a, 'only-a') || `<span style="color:var(--text-muted)">${this._t('promptlab.none', 'None')}</span>`}</div>
                    <div class="promptlab-action-buttons" style="margin-top:10px;">
                        <button class="btn btn-secondary btn-small" data-action="build-image" data-image-id="${result.image_a.id}">${this._t('promptlab.openImageABuild', 'Open Image A in Build')}</button>
                    </div>
                </div>
                <div class="promptlab-diff-card">
                    <h5 style="color:#fcd34d;">${this._t('promptlab.onlyInImage', 'Only in {name}', { name: result.image_b.filename }).replace('{name}', escapeHtml(result.image_b.filename))} (${result.prompt_only_b.length})</h5>
                    <div class="promptlab-diff-tags">${renderTags(result.prompt_only_b, 'only-b') || `<span style="color:var(--text-muted)">${this._t('promptlab.none', 'None')}</span>`}</div>
                    <div class="promptlab-action-buttons" style="margin-top:10px;">
                        <button class="btn btn-secondary btn-small" data-action="build-image" data-image-id="${result.image_b.id}">${this._t('promptlab.openImageBBuild', 'Open Image B in Build')}</button>
                    </div>
                </div>`;
        } catch (e) {
            window.App?.showToast?.(`${this._t('promptlab.compareFailed', 'Compare failed')}: ${e.message || e}`, 'error');
        }
    },

    populateBuildSelector() {
        const images = this._getPromptLabImages();
        const options = images.map(img =>
            `<option value="${img.id}">${escapeHtml(img.filename)}${img.aesthetic_score != null ? ' ★' + img.aesthetic_score.toFixed(1) : ''}</option>`
        ).join('');
        const el = document.getElementById('pl-build-source');
        if (el) {
            const previousValue = el.value;
            el.innerHTML = `<option value="">${this._t('promptlab.selectTemplate', 'Select an image as template...')}</option>` + options;
            // innerHTML resets the selection; keep the current template alive
            // across the async catalog rebuild (including out-of-catalog
            // handoff options inserted by ensureBuildSourceOption).
            if (previousValue) {
                this.ensureBuildSourceOption(previousValue);
                el.value = previousValue;
            }
        }
        this._renderImagePreviewCard('pl-build-preview', el?.value || '', 'promptlab.buildPreviewEmpty', 'Choose a template image to see it here before loading the prompt.');
        if (!this.imageCatalogLoaded) {
            this._ensureImageCatalog().then(() => this.populateBuildSelector()).catch(() => {});
        }
    },

    // The Build template <select> only lists the newest-200 catalog, but
    // gallery/modal/similar handoffs can reference any library image. Insert
    // a one-off option so `select.value = id` does not silently reset to ''
    // (which hides the Build editor instead of loading the image).
    ensureBuildSourceOption(imageId, label = '') {
        const select = document.getElementById('pl-build-source');
        const numericId = Number(imageId);
        if (!select || !Number.isFinite(numericId) || numericId <= 0) return false;
        const value = String(numericId);
        if (Array.from(select.options).some((option) => option.value === value)) return true;
        const option = document.createElement('option');
        option.value = value;
        const record = this._getImageRecord(numericId);
        option.textContent = label
            || record?.filename
            || this._t('promptlab.imageOptionFallback', 'Image #{id}', { id: value }).replace('{id}', value);
        select.appendChild(option);
        return true;
    },

    _openBuildFromImageId(imageId) {
        window.App?.openPromptBuildFromImage?.(imageId);
    },

    _openBuildDraft(tokens) {
        const buildTab = document.querySelector('.promptlab-tab[data-mode="build"]');
        buildTab?.click();
        const editor = document.getElementById('pl-build-editor');
        const promptArea = document.getElementById('pl-build-prompt');
        const negativeArea = document.getElementById('pl-build-negative');
        const infoEl = document.getElementById('pl-build-info');
        if (editor) editor.style.display = '';
        if (promptArea) promptArea.value = (tokens || []).join(', ');
        if (negativeArea) negativeArea.value = '';
        if (infoEl) infoEl.textContent = this._t('promptlab.commonDraftLoaded', 'Loaded common prompt tokens into Build');
    },

    _openBuildRecipe(checkpoint, tokens) {
        const buildTab = document.querySelector('.promptlab-tab[data-mode="build"]');
        buildTab?.click();
        const editor = document.getElementById('pl-build-editor');
        const promptArea = document.getElementById('pl-build-prompt');
        const negativeArea = document.getElementById('pl-build-negative');
        const infoEl = document.getElementById('pl-build-info');
        if (editor) editor.style.display = '';
        if (promptArea) promptArea.value = (tokens || []).join(', ');
        if (negativeArea) negativeArea.value = '';
        if (infoEl) {
            infoEl.textContent = [
                checkpoint ? `🧠 ${checkpoint.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || checkpoint}` : '',
                this._t('promptlab.recipeLoaded', 'Loaded from recipe suggestion'),
            ].filter(Boolean).join(' · ');
        }
    },

    _appendBuildDraftTokens(tokens) {
        const buildTab = document.querySelector('.promptlab-tab[data-mode="build"]');
        buildTab?.click();
        const editor = document.getElementById('pl-build-editor');
        const promptArea = document.getElementById('pl-build-prompt');
        const infoEl = document.getElementById('pl-build-info');
        if (editor) editor.style.display = '';
        if (!promptArea) return;

        const currentTokens = String(promptArea.value || '')
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean);
        const merged = [...new Set([...currentTokens, ...(tokens || []).filter(Boolean)])];
        promptArea.value = merged.join(', ');
        if (infoEl) infoEl.textContent = this._t('promptlab.tagDraftLoaded', 'Added selected data insight to Build');
    },

    _defaultBuildGroupIds() {
        return ['appearance', 'clothing', 'pose', 'scenery', 'style'];
    },

    _getBuildGroupLabel(group) {
        return this._t(group.labelKey, group.fallback);
    },

    async _prepareBuildCategoryWorkbench(imageId, image, tags = []) {
        const workbench = document.getElementById('pl-build-category-workbench');
        const copy = window.TagCategoryCopy;
        if (!workbench || !copy?.getTagsFromSource || !copy?.classifyTags) {
            this.buildCategoryState = null;
            return;
        }

        const sourceTags = await copy.getTagsFromSource({
            imageId,
            image,
            tags,
            prompt: image?.prompt || '',
        });
        const classified = await copy.classifyTags(sourceTags);
        const checked = new Set(this._defaultBuildGroupIds());
        this.buildCategoryState = { imageId: Number(imageId), classified, checked };
        this._renderBuildCategoryWorkbench();
    },

    _renderBuildCategoryWorkbench() {
        const workbench = document.getElementById('pl-build-category-workbench');
        const groupsContainer = document.getElementById('pl-build-category-groups');
        const countEl = document.getElementById('pl-build-category-count');
        const copy = window.TagCategoryCopy;
        if (!workbench || !groupsContainer || !copy?.CATEGORY_GROUPS || !this.buildCategoryState?.classified) {
            if (workbench) workbench.hidden = true;
            if (groupsContainer) groupsContainer.innerHTML = '';
            return;
        }

        const { classified, checked } = this.buildCategoryState;
        const groups = copy.CATEGORY_GROUPS
            .map((group) => ({ group, tags: copy.tagsForGroup(classified, group) }))
            .filter(({ tags }) => tags.length > 0);
        if (countEl) countEl.textContent = String(classified.tags?.length || 0);
        if (!groups.length) {
            workbench.hidden = true;
            groupsContainer.innerHTML = '';
            return;
        }

        workbench.hidden = false;
        groupsContainer.innerHTML = groups.map(({ group, tags }) => {
            const label = this._getBuildGroupLabel(group);
            const encodedGroup = this._safeDataValue(group.id);
            const isChecked = checked.has(group.id);
            return `
                <section class="promptlab-build-category-group" data-group="${encodedGroup}">
                    <div class="promptlab-build-category-group-head">
                        <label class="promptlab-build-category-toggle">
                            <input type="checkbox" data-build-category-check="${encodedGroup}" ${isChecked ? 'checked' : ''}>
                            <span>${this._escapeValue(label)}</span>
                            <span class="tag-category-copy-count">${tags.length}</span>
                        </label>
                        <span class="promptlab-build-category-mini-actions">
                            <button class="btn btn-ghost btn-small" type="button" data-build-category-copy="${encodedGroup}">${this._escapeValue(this._t('reader.copy', 'Copy'))}</button>
                            <button class="btn btn-ghost btn-small" type="button" data-build-category-find="${encodedGroup}">${this._escapeValue(this._t('tagCategory.find', 'Find'))}</button>
                        </span>
                    </div>
                    <div class="promptlab-build-category-chip-list">
                        ${tags.length ? tags.map((tag) => `<span class="promptlab-build-category-chip">${this._escapeValue(tag)}</span>`).join('') : `<span class="promptlab-build-category-empty">${this._escapeValue(this._t('promptlab.categoryBoardDropHere', 'Drop tags here'))}</span>`}
                    </div>
                </section>
            `;
        }).join('');

        groupsContainer.querySelectorAll('[data-build-category-check]').forEach((input) => {
            input.addEventListener('change', () => {
                const groupId = this._decodeDataValue(input.dataset.buildCategoryCheck);
                if (input.checked) checked.add(groupId);
                else checked.delete(groupId);
            });
        });
        groupsContainer.querySelectorAll('[data-build-category-copy]').forEach((button) => {
            button.addEventListener('click', () => {
                const groupId = this._decodeDataValue(button.dataset.buildCategoryCopy);
                const item = groups.find(({ group }) => group.id === groupId);
                if (!item) return;
                copy.copyTags(item.tags, this._t('tagCategory.groupCopied', 'Copied {category} tags', { category: this._getBuildGroupLabel(item.group) }).replace('{category}', this._getBuildGroupLabel(item.group)));
            });
        });
        groupsContainer.querySelectorAll('[data-build-category-find]').forEach((button) => {
            button.addEventListener('click', () => {
                const groupId = this._decodeDataValue(button.dataset.buildCategoryFind);
                const item = groups.find(({ group }) => group.id === groupId);
                if (!item) return;
                copy.findGalleryByTags(item.tags, this._getBuildGroupLabel(item.group));
            });
        });
    },

    _getBuildTagsForGroupIds(groupIds) {
        const copy = window.TagCategoryCopy;
        const classified = this.buildCategoryState?.classified;
        if (!copy?.tagsForGroupIds || !classified) return [];
        return copy.tagsForGroupIds(classified, groupIds);
    },

    _useCheckedBuildCategories() {
        const checked = Array.from(this.buildCategoryState?.checked || []);
        const groupIds = checked.length ? checked : this._defaultBuildGroupIds();
        const tags = this._getBuildTagsForGroupIds(groupIds);
        if (!tags.length) {
            window.App?.showToast?.(this._t('tagCategory.noneFound', 'No tags found for that category.'), 'warning');
            return;
        }
        const promptArea = document.getElementById('pl-build-prompt');
        if (promptArea) promptArea.value = tags.join(', ');
        window.App?.showToast?.(this._t('promptlab.checkedCategoriesApplied', 'Applied checked categories to Build'), 'success');
    },

    _copyBuildTrainingCaption() {
        const tags = this._getBuildTagsForGroupIds(this._defaultBuildGroupIds());
        if (!tags.length) {
            window.App?.showToast?.(this._t('tagCategory.noneFound', 'No tags found for that category.'), 'warning');
            return;
        }
        window.TagCategoryCopy?.copyTags?.(tags, this._t('tagCategory.trainingCaptionCopied', 'Training caption copied'));
    },

    async _cleanBuildPrompt(options = {}) {
        const promptArea = document.getElementById('pl-build-prompt');
        if (!promptArea) return;
        const copy = window.TagCategoryCopy;
        const rawTags = copy?.parsePromptTags?.(promptArea.value) || this._parsePromptTags(promptArea.value);
        if (!rawTags.length) {
            window.App?.showToast?.(this._t('promptlab.addTagBeforeGenerate', 'Add at least one tag or apply a tag set before generating'), 'warning');
            return;
        }

        let nextTags = copy?.cleanPromptTags?.(rawTags, { spaces: Boolean(options.spaces) }) || this._mergePromptTags(rawTags);
        if ((options.dropQuality || options.reorder) && copy?.classifyTags && copy?.tagsForGroupIds) {
            const classified = await copy.classifyTags(nextTags);
            const orderedGroups = options.dropQuality
                ? [...this._defaultBuildGroupIds(), 'unclassified']
                : [...this._defaultBuildGroupIds(), 'qualityMeta', 'unclassified'];
            const orderedTags = copy.tagsForGroupIds(classified, orderedGroups);
            const orderedKeys = new Set(orderedTags.map((tag) => String(tag).toLowerCase()));
            const leftovers = options.dropQuality ? [] : nextTags.filter((tag) => !orderedKeys.has(String(tag).toLowerCase()));
            nextTags = [...orderedTags, ...leftovers];
        }
        if (options.spaces) {
            nextTags = nextTags.map((tag) => String(tag).replace(/_/g, ' '));
        }

        promptArea.value = this._mergePromptTags(nextTags).join(', ');
        window.App?.showToast?.(this._t('promptlab.promptCleaned', 'Prompt cleaned'), 'success');
    },

    _findCategoryForToken(token) {
        const normalized = String(token || '').trim().toLowerCase();
        if (!normalized) return null;

        for (const [category, tags] of Object.entries(this.categories || {})) {
            const match = (tags || []).find((tag) => String(tag || '').trim().toLowerCase() === normalized);
            if (match) {
                return { category, tag: match };
            }
        }

        return null;
    },

    async _openRandomFromTokens(tokens, checkpoint = '') {
        const randomTab = document.querySelector('.promptlab-tab[data-mode="random"]');
        randomTab?.click();

        const assigned = [];
        const unmatched = [];
        for (const token of tokens || []) {
            const match = this._findCategoryForToken(token);
            if (!match) {
                unmatched.push(token);
                continue;
            }
            if (!this.slots[match.category]) {
                this.slots[match.category] = [];
            }
            if (!this.slots[match.category].includes(match.tag)) {
                this.slots[match.category] = [...this.slots[match.category], match.tag];
                assigned.push(match.tag);
            }
        }

        this.invalidateGeneratedPrompt();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();

        if (assigned.length) {
            await this.generate();
        }

        const checkpointLabel = checkpoint
            ? (checkpoint.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || checkpoint)
            : '';
        const info = [
            checkpointLabel ? `🧠 ${checkpointLabel}` : '',
            this._t('promptlab.randomDraftLoaded', 'Loaded data insight into Random'),
            assigned.length ? `${assigned.length}` : '',
        ].filter(Boolean).join(' · ');

        const outputEl = document.getElementById('promptlab-output');
        if (outputEl && info) {
            outputEl.title = info;
        }

        if (assigned.length && unmatched.length) {
            window.App?.showToast?.(
                this._t('promptlab.randomDraftLoadedPartial', 'Loaded {assigned} tags into Random. {unmatched} did not match known categories.', {
                    assigned: assigned.length,
                    unmatched: unmatched.length,
                })
                    .replace('{assigned}', assigned.length)
                    .replace('{unmatched}', unmatched.length),
                'info'
            );
            return;
        }

        if (assigned.length) {
            window.App?.showToast?.(
                this._t('promptlab.randomDraftLoadedFull', 'Loaded {count} tags into Random and generated a draft.', { count: assigned.length })
                    .replace('{count}', assigned.length),
                'success'
            );
            return;
        }

        window.App?.showToast?.(this._t('promptlab.randomDraftNoMatch', 'Could not map these insights into the Random categories yet.'), 'warning');
    },

    _filterGalleryByTags(tags) {
        window.App?.applyTagFiltersFromExternal?.(tags, { replaceTags: false, tagMode: 'and' });
    },

    async loadBuildSource(imageId) {
        const editor = document.getElementById('pl-build-editor');
        this._renderImagePreviewCard('pl-build-preview', imageId, 'promptlab.buildPreviewEmpty', 'Choose a template image to see it here before loading the prompt.');
        if (!imageId) {
            if (editor) editor.style.display = 'none';
            this.buildCategoryState = null;
            this._renderBuildCategoryWorkbench();
            return;
        }
        try {
            const result = await window.App.API.get(`/api/images/${imageId}`);
            const img = result.image;
            if (editor) editor.style.display = '';
            document.getElementById('pl-build-prompt').value = img.prompt || '';
            document.getElementById('pl-build-negative').value = img.negative_prompt || '';
            const info = [];
            if (img.checkpoint) info.push(`🧠 ${img.checkpoint.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '')}`);
            if (img.width && img.height) info.push(`📐 ${img.width}×${img.height}`);
            if (img.aesthetic_score != null) info.push(`★ ${Number(img.aesthetic_score).toFixed(1)}`);
            document.getElementById('pl-build-info').textContent = info.join(' · ') || '';
            await this._prepareBuildCategoryWorkbench(imageId, img, result.tags || img.tags || []);
        } catch (e) {
            this.buildCategoryState = null;
            this._renderBuildCategoryWorkbench();
            window.App?.showToast?.(this._t('promptlab.loadImageFailed', 'Failed to load image'), 'error');
        }
    },
};

// Initialize when Prompt Lab tab is first activated
let promptLabInitialized = false;

function initPromptLab() {
    if (promptLabInitialized) return;
    promptLabInitialized = true;
    PromptLab.init();
}

window.PromptLab = PromptLab;
window.initPromptLab = initPromptLab;
