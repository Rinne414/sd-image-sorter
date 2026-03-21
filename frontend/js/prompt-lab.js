/**
 * SD Image Sorter - Prompt Lab Module
 * Interactive prompt builder with category browser, tag sets, exclusion rules,
 * and weighted random generation.
 */

const PromptLab = {
    categories: {},
    tagSets: [],
    exclusionRules: [],
    presets: [],
    generatedPrompt: '',

    // Current builder state (slot-based)
    slots: {},       // { category: [selected tags] }
    weights: {},     // { category: weight 0-100 }
    locked: {},      // { category: bool } - locked slots survive randomize

    async init() {
        await this.loadCategories();
        await this.loadTagSets();
        await this.loadExclusionRules();
        await this.loadPresets();
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        this.renderPresetList();
        this.bindEvents();
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

    // ============== Rendering ==============

    renderCategoryBrowser() {
        const container = document.getElementById('promptlab-categories');
        if (!container) return;

        const categoryNames = Object.keys(this.categories);
        if (categoryNames.length === 0) {
            container.innerHTML = '<div class="empty-state">No categories loaded. Check backend connection.</div>';
            return;
        }

        const html = categoryNames.map(cat => {
            const tags = this.categories[cat] || [];
            const selectedTags = this.slots[cat] || [];
            const isExpanded = container.querySelector(`[data-cat="${cat}"]`)?.classList.contains('expanded');

            return `
                <div class="cat-group ${isExpanded ? 'expanded' : ''}" data-cat="${cat}">
                    <div class="cat-header" data-cat="${cat}">
                        <span class="cat-arrow">${isExpanded ? '▼' : '▶'}</span>
                        <span class="cat-name">${cat}</span>
                        <span class="cat-count">${tags.length}</span>
                        ${selectedTags.length > 0 ? `<span class="cat-selected">${selectedTags.length} selected</span>` : ''}
                    </div>
                    <div class="cat-tags" style="display: ${isExpanded ? 'flex' : 'none'};">
                        ${tags.map(tag => `
                            <span class="cat-tag ${selectedTags.includes(tag) ? 'selected' : ''}"
                                  data-tag="${tag}" data-cat="${cat}"
                                  title="Click to add to ${cat} slot">
                                ${tag}
                            </span>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        // Bind category toggle
        container.querySelectorAll('.cat-header').forEach(header => {
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

        // Bind tag click
        container.querySelectorAll('.cat-tag').forEach(tagEl => {
            tagEl.addEventListener('click', () => {
                const tag = tagEl.dataset.tag;
                const cat = tagEl.dataset.cat;
                this.toggleTagInSlot(cat, tag);
            });
        });
    },

    renderSlotBuilder() {
        const container = document.getElementById('promptlab-slots');
        if (!container) return;

        const categoryNames = Object.keys(this.categories);
        if (categoryNames.length === 0) {
            container.innerHTML = '<div class="empty-state">Load categories first</div>';
            return;
        }

        // Only show categories that have selections or are commonly used
        const activeCategories = categoryNames.filter(cat => {
            const selected = this.slots[cat] || [];
            return selected.length > 0;
        });

        // Always show core categories even if empty
        const coreCats = ['character', 'outfit', 'pose', 'expression', 'body', 'background', 'style', 'quality'];
        const displayCats = [...new Set([...coreCats.filter(c => categoryNames.includes(c)), ...activeCategories])];

        const html = displayCats.map(cat => {
            const selected = this.slots[cat] || [];
            const isLocked = this.locked[cat] || false;
            const weight = this.weights[cat] ?? 50;
            const hasConflict = this.checkConflicts(cat);

            return `
                <div class="slot-row ${hasConflict ? 'has-conflict' : ''}" data-slot="${cat}">
                    <div class="slot-header">
                        <button class="slot-lock ${isLocked ? 'locked' : ''}" data-cat="${cat}" title="${isLocked ? 'Unlock' : 'Lock'} (survives randomize)">
                            ${isLocked ? '🔒' : '🔓'}
                        </button>
                        <span class="slot-name">${cat}</span>
                        ${hasConflict ? '<span class="conflict-icon" title="Exclusion rule conflict">⚠️</span>' : ''}
                    </div>
                    <div class="slot-tags">
                        ${selected.length > 0 ? selected.map(tag => `
                            <span class="slot-tag" data-tag="${tag}" data-cat="${cat}">
                                ${tag}
                                <span class="slot-tag-remove" data-tag="${tag}" data-cat="${cat}">×</span>
                            </span>
                        `).join('') : '<span class="slot-empty">Click tags from browser to add</span>'}
                    </div>
                    <div class="slot-weight">
                        <input type="range" min="0" max="100" value="${weight}"
                               class="slot-weight-slider" data-cat="${cat}" title="Weight: ${weight}%">
                        <span class="slot-weight-value">${weight}%</span>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        // Bind remove buttons
        container.querySelectorAll('.slot-tag-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeTagFromSlot(btn.dataset.cat, btn.dataset.tag);
            });
        });

        // Bind lock buttons
        container.querySelectorAll('.slot-lock').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.dataset.cat;
                this.locked[cat] = !this.locked[cat];
                this.renderSlotBuilder();
            });
        });

        // Bind weight sliders
        container.querySelectorAll('.slot-weight-slider').forEach(slider => {
            slider.addEventListener('input', () => {
                const cat = slider.dataset.cat;
                this.weights[cat] = parseInt(slider.value);
                slider.nextElementSibling.textContent = slider.value + '%';
            });
        });
    },

    renderPresetList() {
        const container = document.getElementById('promptlab-presets');
        if (!container) return;

        if (this.presets.length === 0) {
            container.innerHTML = '<div class="preset-empty">No saved presets. Save your current configuration as a preset.</div>';
            return;
        }

        container.innerHTML = this.presets.map(preset => `
            <div class="preset-item" data-id="${preset.id}">
                <span class="preset-name">${preset.name}</span>
                <div class="preset-actions">
                    <button class="btn-preset-load" data-id="${preset.id}" title="Load preset">📂</button>
                    <button class="btn-preset-delete" data-id="${preset.id}" title="Delete preset">🗑️</button>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.btn-preset-load').forEach(btn => {
            btn.addEventListener('click', () => this.loadPreset(btn.dataset.id));
        });

        container.querySelectorAll('.btn-preset-delete').forEach(btn => {
            btn.addEventListener('click', () => this.deletePreset(btn.dataset.id));
        });
    },

    renderOutput() {
        const outputEl = document.getElementById('promptlab-output');
        if (!outputEl) return;

        outputEl.value = this.generatedPrompt;

        // Update conflict warnings
        const warningsEl = document.getElementById('promptlab-warnings');
        if (warningsEl) {
            const conflicts = this.getAllConflicts();
            if (conflicts.length > 0) {
                warningsEl.innerHTML = conflicts.map(c =>
                    `<div class="warning-item">⚠️ ${c}</div>`
                ).join('');
                warningsEl.style.display = 'block';
            } else {
                warningsEl.style.display = 'none';
            }
        }
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

        this.renderCategoryBrowser();
        this.renderSlotBuilder();
    },

    removeTagFromSlot(category, tag) {
        if (this.slots[category]) {
            this.slots[category] = this.slots[category].filter(t => t !== tag);
        }
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
    },

    // ============== Conflict Detection ==============

    checkConflicts(category) {
        const selected = this.slots[category] || [];
        if (selected.length === 0) return false;

        for (const rule of this.exclusionRules) {
            const conditionMet = rule.conditions?.some(cond => {
                const catTags = this.slots[cond.category] || [];
                return catTags.some(t => t.includes(cond.pattern));
            });

            if (conditionMet) {
                const hasExcluded = rule.excludes?.some(exc => {
                    if (exc.category === category) {
                        return selected.some(t => t.includes(exc.pattern));
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
            const conditionMet = rule.conditions?.some(cond => {
                const catTags = this.slots[cond.category] || [];
                return catTags.some(t => t.includes(cond.pattern));
            });

            if (conditionMet) {
                const excludedTags = [];
                for (const exc of (rule.excludes || [])) {
                    const catTags = this.slots[exc.category] || [];
                    const found = catTags.filter(t => t.includes(exc.pattern));
                    excludedTags.push(...found.map(t => `${t} (${exc.category})`));
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

        try {
            // Build config from slots
            const config = {
                categories: {},
                tag_sets: [],
                count: 1,
            };

            for (const [cat, tags] of Object.entries(this.slots)) {
                if (tags.length > 0) {
                    config.categories[cat] = {
                        tags: tags,
                        weight: (this.weights[cat] ?? 50) / 100,
                        locked: this.locked[cat] || false,
                    };
                }
            }

            const result = await window.App.API.post('/api/prompts/generate', config);
            this.generatedPrompt = result.prompt || '';
            this.renderOutput();

            if (result.warnings?.length > 0) {
                showToast(`Generated with ${result.warnings.length} warning(s)`, 'info');
            }
        } catch (e) {
            showToast('Generation failed: ' + e.message, 'error');
        }
    },

    async randomize() {
        // Randomize non-locked slots
        for (const cat of Object.keys(this.categories)) {
            if (this.locked[cat]) continue;

            const tags = this.categories[cat] || [];
            if (tags.length === 0) continue;

            const weight = (this.weights[cat] ?? 50) / 100;
            if (Math.random() > weight) {
                this.slots[cat] = [];
                continue;
            }

            // Pick 1-3 random tags
            const count = Math.min(tags.length, Math.floor(Math.random() * 3) + 1);
            const shuffled = [...tags].sort(() => Math.random() - 0.5);
            this.slots[cat] = shuffled.slice(0, count);
        }

        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        await this.generate();
    },

    async validate() {
        const { showToast } = window.App;

        try {
            const allTags = Object.values(this.slots).flat();
            const result = await window.App.API.post('/api/prompts/validate', { tags: allTags });

            if (result.conflicts?.length > 0) {
                showToast(`Found ${result.conflicts.length} conflict(s)`, 'error');
            } else {
                showToast('No conflicts detected', 'success');
            }
        } catch (e) {
            showToast('Validation failed: ' + e.message, 'error');
        }
    },

    // ============== Presets ==============

    async savePreset() {
        const name = prompt('Enter preset name:');
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
            window.App.showToast('Failed to save preset: ' + e.message, 'error');
        }
    },

    async loadPreset(id) {
        try {
            const preset = this.presets.find(p => String(p.id) === String(id));
            if (!preset?.config) return;

            this.slots = { ...preset.config.slots } || {};
            this.weights = { ...preset.config.weights } || {};
            this.locked = { ...preset.config.locked } || {};

            this.renderCategoryBrowser();
            this.renderSlotBuilder();
            window.App.showToast(`Loaded preset "${preset.name}"`, 'success');
        } catch (e) {
            window.App.showToast('Failed to load preset', 'error');
        }
    },

    async deletePreset(id) {
        if (!confirm('Delete this preset?')) return;

        try {
            await window.App.API.delete(`/api/prompts/presets/${id}`);
            await this.loadPresets();
            this.renderPresetList();
            window.App.showToast('Preset deleted', 'info');
        } catch (e) {
            window.App.showToast('Failed to delete preset', 'error');
        }
    },

    // ============== Tag Sets ==============

    applyTagSet(setId) {
        const set = this.tagSets.find(s => String(s.id) === String(setId));
        if (!set) return;

        // Apply all tags from the set into their respective category slots
        for (const member of (set.members || [])) {
            const cat = member.category || 'style';
            if (!this.slots[cat]) this.slots[cat] = [];
            if (!this.slots[cat].includes(member.tag)) {
                this.slots[cat] = [...this.slots[cat], member.tag];
            }
        }

        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        window.App.showToast(`Applied tag set "${set.name}"`, 'success');
    },

    // ============== Copy ==============

    copyPrompt() {
        const output = document.getElementById('promptlab-output');
        if (!output?.value) return;

        navigator.clipboard.writeText(output.value).then(() => {
            window.App.showToast('Prompt copied to clipboard', 'success');
        }).catch(() => {
            // Fallback
            output.select();
            document.execCommand('copy');
            window.App.showToast('Prompt copied', 'success');
        });
    },

    clearAll() {
        this.slots = {};
        this.weights = {};
        this.locked = {};
        this.generatedPrompt = '';
        this.renderCategoryBrowser();
        this.renderSlotBuilder();
        this.renderOutput();
    },

    // ============== Event Binding ==============

    bindEvents() {
        const btnGenerate = document.getElementById('btn-promptlab-generate');
        const btnRandom = document.getElementById('btn-promptlab-random');
        const btnValidate = document.getElementById('btn-promptlab-validate');
        const btnCopy = document.getElementById('btn-promptlab-copy');
        const btnClear = document.getElementById('btn-promptlab-clear');
        const btnSavePreset = document.getElementById('btn-promptlab-save-preset');

        btnGenerate?.addEventListener('click', () => this.generate());
        btnRandom?.addEventListener('click', () => this.randomize());
        btnValidate?.addEventListener('click', () => this.validate());
        btnCopy?.addEventListener('click', () => this.copyPrompt());
        btnClear?.addEventListener('click', () => this.clearAll());
        btnSavePreset?.addEventListener('click', () => this.savePreset());

        // Tag set selector
        const setSelector = document.getElementById('promptlab-set-select');
        setSelector?.addEventListener('change', (e) => {
            if (e.target.value) {
                this.applyTagSet(e.target.value);
                e.target.value = '';
            }
        });

        // Category search
        const searchInput = document.getElementById('promptlab-search');
        searchInput?.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            document.querySelectorAll('#promptlab-categories .cat-group').forEach(group => {
                const catName = group.dataset.cat.toLowerCase();
                const tags = group.querySelectorAll('.cat-tag');
                let hasMatch = catName.includes(query);

                tags.forEach(tag => {
                    const matches = tag.dataset.tag.toLowerCase().includes(query);
                    tag.style.display = query && !matches ? 'none' : '';
                    if (matches) hasMatch = true;
                });

                group.style.display = hasMatch || !query ? '' : 'none';

                // Auto-expand matching groups
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
