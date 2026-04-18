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

    showFirstUseGuide() {
        if (localStorage.getItem('promptlab-guide-seen')) return;

        const view = document.getElementById('view-promptlab');
        if (!view) return;

        const t = (key) => (window.I18n ? window.I18n.t(key) : key);
        const overlay = window.App.createGuideOverlay({
            id: 'promptlab-first-use-guide',
            storageKey: 'promptlab-guide-seen',
            title: t('guide.promptlabTitle'),
            description: t('guide.promptlabDescription'),
            steps: [
                { title: t('guide.promptlabStep1Title'), text: t('guide.promptlabStep1Text') },
                { title: t('guide.promptlabStep2Title'), text: t('guide.promptlabStep2Text') },
                { title: t('guide.promptlabStep3Title'), text: t('guide.promptlabStep3Text') },
                { title: t('guide.promptlabStep4Title'), text: t('guide.promptlabStep4Text') },
            ],
            closeLabel: t('guide.closeLabel'),
            maxWidth: '520px',
        });

        view.style.position = 'relative';
        view.appendChild(overlay);

        overlay.querySelector('[data-guide-close]')?.addEventListener('click', () => {
            overlay.remove();
            localStorage.setItem('promptlab-guide-seen', 'true');
        });
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
        return window.I18n?.t?.(key, params) || fallback || key;
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

            const allImages = [];
            let cursor = null;
            let hasMore = true;
            while (hasMore) {
                const result = await api.getImages({
                    sortBy: 'newest',
                    limit: 500,
                    cursor,
                });
                const rows = Array.isArray(result?.images) ? result.images : [];
                allImages.push(...rows);
                cursor = result?.next_cursor || null;
                hasMore = Boolean(result?.has_more && cursor);
            }

            this.imageCatalog = allImages;
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
                    <div class="promptlab-image-preview-meta">${escapeHtml(this._formatPromptlabImageMeta(image) || this._t('promptlab.noImageMeta', 'No quick metadata'))}</div>
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
        const images = this._getPromptLabImages().filter((image) => {
            if (!query) return true;
            const checkpoint = String(image.checkpoint || '').replace(/\\/g, '/').split('/').pop() || '';
            const haystack = [
                image.filename || '',
                image.prompt || '',
                image.negative_prompt || '',
                checkpoint,
            ].join(' ').toLowerCase();
            return haystack.includes(query);
        });

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
                    <div class="promptlab-image-picker-meta">${escapeHtml(this._formatPromptlabImageMeta(image) || this._t('promptlab.noImageMeta', 'No quick metadata'))}</div>
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

        if (searchInput) searchInput.disabled = !isReady;
        if (tagSetSelect) tagSetSelect.disabled = !isReady;
        if (applyTagSet) applyTagSet.disabled = !isReady;
        this.updateActionState();
    },

    invalidateGeneratedPrompt() {
        this.generatedPrompt = '';
        this.renderOutput();
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
                        ${selected.length > 0 ? selected.map((tag) => this._buildSlotTag(tag, cat)).join('') : '<span class="slot-empty">Click tags from browser to add</span>'}
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

        const defaultLabel = window.I18n?.t?.('promptlab.selectTagSet') || '-- Select Tag Set --';
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
            this.generatedPrompt = result.positive_prompt || result.prompt || '';
            this.renderOutput();

            if (result.warnings?.length > 0) {
                showToast(
                    this._t('promptlab.generatedWarnings', 'Generated with {count} warning(s)', { count: result.warnings.length })
                        .replace('{count}', result.warnings.length),
                    'info'
                );
            }
        } catch (e) {
            showToast(formatUserError(e, "Generation failed"), "error");
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
                    this._t('promptlab.conflictsFound', 'Found {count} conflict(s)', { count: violations.length })
                        .replace('{count}', violations.length),
                    'error'
                );
            } else {
                showToast(this._t('promptlab.noConflicts', 'No conflicts detected'), 'success');
            }
        } catch (e) {
            showToast(formatUserError(e, "Validation failed"), "error");
        }
    },

    // ============== Presets ==============

    async savePreset() {
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
                }
            });
            await this.loadPresets();
            this.renderPresetList();
            window.App.showToast(
                this._t('promptlab.presetSaved', 'Preset "{name}" saved', { name }).replace('{name}', name),
                'success'
            );
        } catch (e) {
            window.App.showToast(formatUserError(e, "Failed to save preset"), "error");
        }
    },

    async loadPreset(id) {
        try {
            const preset = this.presets.find(p => String(p.id) === String(id));
            if (!preset?.config) return;

            this.slots = { ...(preset.config.slots || {}) };
            this.weights = { ...(preset.config.weights || {}) };
            this.locked = { ...(preset.config.locked || {}) };

            this.invalidateGeneratedPrompt();
            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            window.App.showToast(
                this._t('promptlab.presetLoaded', 'Loaded preset "{name}"', { name: preset.name }).replace('{name}', preset.name),
                'success'
            );
        } catch (e) {
            window.App.showToast(this._t('promptlab.presetLoadFailed', 'Failed to load preset'), 'error');
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
                    showToast(this._t('promptlab.presetDeleteFailed', 'Failed to delete preset'), 'error');
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
            this._t('promptlab.tagSetApplied', 'Applied tag set "{name}"', { name: set.name }).replace('{name}', set.name),
            'success'
        );
    },

    // ============== Copy ==============

    usePromptInGallery() {
        if (!this.generatedPrompt) return;
        window.App.applyPromptFilter(this.generatedPrompt);
    },

    copyPrompt() {
        const output = document.getElementById('promptlab-output');
        if (!output?.value) return;
        copyTextToClipboard(output.value, 'Prompt copied to clipboard');
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

        btnGenerate?.addEventListener('click', () => this.generate());
        btnUseGallery?.addEventListener('click', () => this.usePromptInGallery());
        btnRandom?.addEventListener('click', () => this.randomize());
        btnValidate?.addEventListener('click', () => this.validate());
        btnCopy?.addEventListener('click', () => this.copyPrompt());
        btnClear?.addEventListener('click', () => this.clearAll());
        btnSavePreset?.addEventListener('click', () => this.savePreset());

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
                document.querySelectorAll('.promptlab-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.promptlab-mode').forEach(m => m.classList.remove('active'));
                tab.classList.add('active');
                const mode = tab.dataset.mode;
                const panel = document.getElementById(`promptlab-mode-${mode}`);
                if (panel) panel.classList.add('active');
                if (mode === 'stats') self.loadStats();
                if (mode === 'compare') self.populateImageSelectors();
                if (mode === 'build') self.populateBuildSelector();
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
                topTagsEl.innerHTML = visible.map(t =>
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
                ).join('');
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
                    : `<div style="color:var(--text-muted);font-size:12px;">${this._t('promptlab.noScoredImagesYet', 'No scored images yet')}</div>`;
            }

            const cpEl = document.getElementById('pl-top-checkpoints');
            if (cpEl && stats.top_checkpoints) {
                cpEl.innerHTML = stats.top_checkpoints.slice(0, this.statsVisibleCounts.checkpoints).map(c => {
                    const name = c.name.replace(/\\/g, '/').split('/').pop()?.replace(/\.(safetensors|ckpt)$/i, '') || c.name;
                    return `<div class="promptlab-tag-item"><span class="tag-name">🧠 ${escapeHtml(name)}</span><span class="tag-count">${c.count}</span></div>`;
                }).join('');
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
                    : `<div style="color:var(--text-muted);font-size:12px;">${this._t('promptlab.notEnoughScoredData', 'Not enough scored data yet')}</div>`;
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
                    : `<div style="color:var(--text-muted);font-size:12px;">${this._t('promptlab.noScoredExamples', 'No scored examples yet')}</div>`;
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
                    : `<div style="color:var(--text-muted);font-size:12px;">${this._t('promptlab.noRecipeSuggestions', 'No recipe suggestions yet')}</div>`;
            }

            this._syncStatsLoadMore('pl-top-tags-more', stats.top_tags_total ?? stats.top_tags?.length ?? 0, this.statsVisibleCounts.topTags);
            this._syncStatsLoadMore('pl-high-tags-more', stats.high_aesthetic_tags_total ?? stats.high_aesthetic_tags?.length ?? 0, this.statsVisibleCounts.highTags);
            this._syncStatsLoadMore('pl-top-checkpoints-more', stats.top_checkpoints_total ?? stats.top_checkpoints?.length ?? 0, this.statsVisibleCounts.checkpoints);
            this._syncStatsLoadMore('pl-best-checkpoints-more', stats.checkpoint_score_leaders_total ?? (stats.checkpoint_score_leaders || []).length, this.statsVisibleCounts.bestCheckpoints);
            this._syncStatsLoadMore('pl-top-scored-images-more', stats.top_scored_images_total ?? (stats.top_scored_images || []).length, this.statsVisibleCounts.scoredImages);
            this._syncStatsLoadMore('pl-recipe-suggestions-more', stats.checkpoint_recipes_total ?? (stats.checkpoint_recipes || []).length, this.statsVisibleCounts.recipes);
        } catch (e) {
            console.error('Failed to load prompt stats:', e);
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
        if (el) el.innerHTML = `<option value="">${this._t('promptlab.selectTemplate', 'Select an image as template...')}</option>` + options;
        this._renderImagePreviewCard('pl-build-preview', el?.value || '', 'promptlab.buildPreviewEmpty', 'Choose a template image to see it here before loading the prompt.');
        if (!this.imageCatalogLoaded) {
            this._ensureImageCatalog().then(() => this.populateBuildSelector()).catch(() => {});
        }
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
        const filters = window.App?.AppState?.filters;
        if (!filters) return;
        for (const tag of tags || []) {
            if (!filters.tags.includes(tag)) {
                filters.tags = [...filters.tags, tag];
            }
        }
        window.App?.updateFilterSummary?.();
        window.App?.loadImages?.();
        window.App?.switchView?.('gallery');
    },

    async loadBuildSource(imageId) {
        const editor = document.getElementById('pl-build-editor');
        this._renderImagePreviewCard('pl-build-preview', imageId, 'promptlab.buildPreviewEmpty', 'Choose a template image to see it here before loading the prompt.');
        if (!imageId) { if (editor) editor.style.display = 'none'; return; }
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
        } catch (e) {
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
