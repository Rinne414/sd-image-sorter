/**
 * prompt-lab/builder-state.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 377-558 (of 2,485):
 * slot readers (hasBuilderSelection/getSelectedTags), updateActionState/
 * setReadyState, invalidateGeneratedPrompt, tag parse/normalize/merge, the
 * prepend/append affix apply/strip/sync round-trip, and the chip builders.
 * Classic script: joins the ONE unsealed window.PromptLab object declared
 * in prompt-lab/base.js (loads FIRST); prompt-lab/boot.js declares the
 * initPromptLab boot LAST; index.html lists the family in original line order.
 */
Object.assign(window.PromptLab, {
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

});
