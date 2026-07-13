/**
 * prompt-lab/events.js - prompt-lab.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 1560-1872 (of 2,485):
 * bindEvents (random-mode buttons/inputs, category board, resource deletes,
 * affix + search wiring) and bindIntelligenceEvents (mode tabs, compare/build
 * pickers, stats data-action delegation; includes the pin-sweep BUG-1 fix
 * comment where the duplicate picker-binding block used to sit).
 * Classic script: joins the ONE unsealed window.PromptLab object declared
 * in prompt-lab/base.js (loads FIRST); prompt-lab/boot.js declares the
 * initPromptLab boot LAST; index.html lists the family in original line order.
 */
Object.assign(window.PromptLab, {
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

});
