/**
 * prompt-lab/category-board.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 1218-1494 (of 2,485):
 * the category-board modal (groups/source tags/dedupe/status/changes/drag-drop
 * render, openCategoryBoard/submitCategoryBoard/closeCategoryBoard) and the
 * custom tag-set / exclusion-rule deletes.
 * Classic script: joins the ONE unsealed window.PromptLab object declared
 * in prompt-lab/base.js (loads FIRST); prompt-lab/boot.js declares the
 * initPromptLab boot LAST; index.html lists the family in original line order.
 */
Object.assign(window.PromptLab, {
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

});
