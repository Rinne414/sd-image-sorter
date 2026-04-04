/**
 * SD Image Sorter - Prompt Lab Module
 * Interactive prompt builder with category browser, tag sets, exclusion rules,
 * and weighted random generation.
 */

// escapeHtml fallback — main definition is in app.js
if (typeof escapeHtml === 'undefined') {
    var escapeHtml = (value) => String(value ?? '');
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

    // Current builder state (slot-based)
    slots: {},       // { category: [selected tags] }
    weights: {},     // { category: weight 0-100 }
    locked: {},      // { category: bool } - locked slots survive randomize

    async init() {
        if (!this.eventsBound) {
            this.bindEvents();
            this.eventsBound = true;
        }

        this.setReadyState(false);

        try {
            await this.loadCategories();
            await this.loadTagSets();
            await this.loadExclusionRules();
            await this.loadPresets();
            this.renderTagSetOptions();
            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            this.renderPresetList();
            this.showFirstUseGuide();
        } finally {
            this.setReadyState(true);
        }
    },

    showFirstUseGuide() {
        if (localStorage.getItem('promptlab-guide-seen')) return;

        const view = document.getElementById('view-promptlab');
        if (!view) return;

        const overlay = window.App.createGuideOverlay({
            id: 'promptlab-first-use-guide',
            storageKey: 'promptlab-guide-seen',
            title: '🧪 Prompt Lab Guide',
            description: 'Generate random prompts with intelligent tag selection.',
            steps: [
                { title: 'Randomize', text: 'Generate a random prompt with smart tag selection' },
                { title: 'Tag Sets', text: 'Apply pre-built outfit combinations' },
                { title: 'Lock Slots', text: 'Keep specific tags during randomization' },
                { title: 'Exclusions', text: 'Auto-prevent conflicting tags' },
            ],
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

    _t(key, fallback) {
        return window.I18n?.t?.(key) || fallback || key;
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
            showToast('Prompt Lab is still loading. Please wait a moment.', 'info');
            return;
        }

        if (!this.hasBuilderSelection()) {
            showToast('Add at least one tag or apply a tag set before generating', 'warning');
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
                showToast(`Generated with ${result.warnings.length} warning(s)`, 'info');
            }
        } catch (e) {
            showToast(formatUserError(e, "Generation failed"), "error");
        }
    },

    async randomize() {
        if (!this.isReady) {
            window.App.showToast('Prompt Lab is still loading. Please wait a moment.', 'info');
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
            showToast('Prompt Lab is still loading. Please wait a moment.', 'info');
            return;
        }

        if (!this.hasBuilderSelection()) {
            showToast('Add at least one tag before validating conflicts', 'warning');
            return;
        }

        try {
            const allTags = this.getSelectedTags();
            const result = await window.App.API.post('/api/prompts/validate', { tags: allTags });
            const violations = result.violations || result.conflicts || [];

            if (violations.length > 0 || result.valid === false) {
                showToast(`Found ${violations.length} conflict(s)`, 'error');
            } else {
                showToast('No conflicts detected', 'success');
            }
        } catch (e) {
            showToast(formatUserError(e, "Validation failed"), "error");
        }
    },

    // ============== Presets ==============

    async savePreset() {
        const name = await window.App.showInputModal(
            'Save Preset',
            'Enter a name for this preset:',
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
            window.App.showToast(`Preset "${name}" saved`, 'success');
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
            window.App.showToast(`Loaded preset "${preset.name}"`, 'success');
        } catch (e) {
            window.App.showToast('Failed to load preset', 'error');
        }
    },

    async deletePreset(id) {
        const { showConfirm, API, showToast } = window.App;

        showConfirm(
            'Delete Preset',
            'Delete this preset? This cannot be undone.',
            async () => {
                try {
                    await API.delete(`/api/prompts/presets/${id}`);
                    await this.loadPresets();
                    this.renderPresetList();
                    showToast('Preset deleted', 'info');
                } catch (e) {
                    showToast('Failed to delete preset', 'error');
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
        window.App.showToast(`Applied tag set "${set.name}"`, 'success');
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
    }
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
