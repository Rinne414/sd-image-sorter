/**
 * Dataset Maker — event wiring: toolbar / caption editor / preset / output / export button bindings (_bindEvents).
 * Moved VERBATIM from dataset-maker.js L267-555.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;
    // The members below are VERBATIM object-literal members lifted from
    // dataset-maker.js's original `const DM = {...}` literal. Object.assign
    // attaches them to the same window.DatasetMaker instance; call-time
    // `this` binding (DM.method() -> this === DM) is identical.
    Object.assign(DM, {

        _bindEvents() {
            // Toolbar
            document.getElementById('btn-dataset-import-gallery')?.addEventListener('click', () => this._importFromGallery());
            document.getElementById('btn-dataset-clear')?.addEventListener('click', () => this._clearAll());

            // Tag all
            document.getElementById('btn-dataset-tag-all')?.addEventListener('click', () => this._tagAll());

            // Smart Tag button - opens the Smart Tag modal (reuses Gallery's modal)
            document.getElementById('btn-dataset-smart-tag')?.addEventListener('click', () => {
                if (typeof window.SmartTag?.open === 'function') {
                    window.SmartTag.open();
                } else {
                    this._toast(this._t('dataset.smartTagUnavailable',
                        'Smart Tag feature is not available.'), 'error', 3000);
                }
            });

            // P10: Add to collection button
            document.getElementById('btn-dataset-add-to-collection')?.addEventListener('click', () => {
                if (this.imageIds.length === 0) {
                    this._toast(this._t('dataset.queueEmptyHeadline', 'No images yet'), 'warning');
                    return;
                }
                // Filter out local-source images (negative IDs) as they cannot be added to collections
                const galleryIds = this.imageIds.filter((id) => !(this.isLocalId && this.isLocalId(id)));
                if (galleryIds.length === 0) {
                    this._toast(this._t('dataset.addToCollectionOnlyGallery',
                        'Only gallery-source images can be added to collections. Scan the folder into the main library first.'),
                        'warning', 6000);
                    return;
                }
                if (typeof window.CollectionsUI?.openAddToCollectionPicker === 'function') {
                    window.CollectionsUI.openAddToCollectionPicker(galleryIds);
                } else {
                    this._toast(this._t('dataset.addToCollectionUnavailable',
                        'Collections feature is not available.'), 'error', 3000);
                }
            });

            // Quality-tags quick-fill: one click adds common LoRA quality
            // tags to the "Common tags" field. Also exposes a "use my
            // trigger word here" shortcut so users don't have to figure
            // out the filename-vs-caption distinction on their own.
            document.getElementById('btn-dataset-quickfill-quality')?.addEventListener('click', () => {
                const ta = document.getElementById('dataset-common-tags');
                if (!ta) return;
                const recommended = 'masterpiece, best_quality';
                const current = (ta.value || '').trim();
                const tokens = new Set(current.split(',').map(s => s.trim()).filter(Boolean));
                for (const tok of recommended.split(',').map(s => s.trim())) tokens.add(tok);
                ta.value = Array.from(tokens).join(', ');
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                this._toast(this._t('dataset.quickfillQualityDone',
                    'Added recommended quality tags to "Common tags".'), 'success', 3000);
            });
            document.getElementById('btn-dataset-quickfill-trigger')?.addEventListener('click', () => {
                const trigger = (document.getElementById('dataset-trigger')?.value || '').trim();
                if (!trigger) {
                    this._toast(this._t('dataset.quickfillTriggerEmpty',
                        'Type a trigger word in LoRA setup first.'), 'warning', 4000);
                    return;
                }
                const ta = document.getElementById('dataset-common-tags');
                if (!ta) return;
                const current = (ta.value || '').trim();
                const tokens = new Set(current.split(',').map(s => s.trim()).filter(Boolean));
                tokens.add(trigger);
                ta.value = Array.from(tokens).join(', ');
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                this._toast(this._t('dataset.quickfillTriggerDone',
                    'Added "{trigger}" to "Common tags". It will appear in every caption .txt.',
                    { trigger }), 'success', 4000);
            });

            // Caption editor actions
            document.getElementById('btn-dataset-prev-image')?.addEventListener('click', () => this._stepActive(-1));
            document.getElementById('btn-dataset-next-image')?.addEventListener('click', () => this._stepActive(1));
            document.getElementById('btn-dataset-revert-caption')?.addEventListener('click', () => this._revertActiveCaption());
            document.getElementById('btn-dataset-undo-caption')?.addEventListener('click', () => {
                const ta = document.getElementById('dataset-editor-textarea');
                if (!ta || this.activeId == null) return;
                const stack = this._undoStacks.get(this.activeId);
                if (!stack || stack.length === 0) return;
                const prev = stack.pop();
                ta.value = prev;
                this.captionEdits.set(this.activeId, prev);
                this._refreshQueueItem(this.activeId);
                this._renderTagPills();
            });
            document.getElementById('btn-dataset-remove-image')?.addEventListener('click', () => this._removeActive());
            document.getElementById('btn-dataset-dedupe-tags')?.addEventListener('click', () => this._dedupeCaptionTags?.());

            // Caption textarea
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) {
                let lastSaved = null;
                ta.addEventListener('input', () => {
                    if (this.activeId == null) return;
                    if (this._captionInputTimer) clearTimeout(this._captionInputTimer);
                    const id = Number(this.activeId);
                    const value = ta.value;
                    this._pendingCaptionEdit = { id, value };
                    this._captionInputTimer = setTimeout(() => {
                        this._captionInputTimer = null;
                        this._pendingCaptionEdit = null;
                        const prev = this.captionEdits.has(id)
                            ? this.captionEdits.get(id)
                            : (this.captions.get(id) || '');
                        if (prev !== value && prev !== lastSaved) {
                            const stack = this._undoStacks.get(id) || [];
                            stack.push(prev);
                            if (stack.length > 20) stack.shift();
                            this._undoStacks.set(id, stack);
                        }
                        lastSaved = value;
                        this.captionEdits.set(id, value);
                        this._refreshQueueItem(id);
                        this._renderTagPills();
                    }, 200);
                });
                ta.addEventListener('keydown', (e) => {
                    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
                        const id = this.activeId;
                        if (id == null) return;
                        const stack = this._undoStacks.get(id);
                        if (!stack || stack.length === 0) return;
                        e.preventDefault();
                        const prev = stack.pop();
                        ta.value = prev;
                        lastSaved = prev;
                        this.captionEdits.set(id, prev);
                        this._refreshQueueItem(id);
                        this._renderTagPills();
                    }
                });
            }

            // Naming preset radios
            document.querySelectorAll('input[name="dataset-naming-preset"]').forEach(radio => {
                radio.addEventListener('change', () => this._onPresetChange());
            });

            // P2 fix: Copy vs Move radios mirror to the (now hidden) select
            // that backend code reads from. The new radios are the visible
            // source of truth; the select acts as a compatibility shim.
            document.querySelectorAll('input[name="dataset-image-op-radio"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    const hidden = document.getElementById('dataset-image-op');
                    if (hidden) hidden.value = radio.value;
                    this._syncOutputModeUi?.();
                });
            });
            document.querySelectorAll('input[name="dataset-output-mode"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    this._syncOutputModeUi?.();
                    this._updateExportEnabled();
                });
            });

            // Trigger + custom pattern -> live preview
            for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
                document.getElementById(id)?.addEventListener('input', () => this._updateNamingPreview());
            }
            // Pass-3 review fix: keep the trigger-quickfill button in sync
            // with the trigger field so it's visibly disabled when empty.
            // Without this the user would click and only learn via toast
            // that the field was empty.
            document.getElementById('dataset-trigger')?.addEventListener('input', () => {
                const btn = document.getElementById('btn-dataset-quickfill-trigger');
                if (btn) btn.disabled = !((document.getElementById('dataset-trigger')?.value || '').trim());
            });

            // v3.4.3: the custom template survives page reloads — users keep
            // one format and shouldn't retype it every session. Restore before
            // wiring the recompute listeners; save on every edit.
            const templateField = document.getElementById('dataset-template-override');
            if (templateField) {
                try {
                    const storedTemplate = localStorage.getItem('datasetMaker.templateOverride');
                    if (storedTemplate) templateField.value = storedTemplate;
                } catch (_) { /* localStorage unavailable, keep HTML default */ }
                templateField.addEventListener('input', () => {
                    try { localStorage.setItem('datasetMaker.templateOverride', templateField.value); } catch (_) { /* noop */ }
                });
            }
            const dispatchFieldEdit = (el, eventName = 'input') => {
                if (!el) return;
                el.dispatchEvent(new Event(eventName, { bubbles: true }));
            };
            document.getElementById('btn-dataset-clear-prefix')?.addEventListener('click', () => {
                const input = document.getElementById('dataset-export-prefix');
                if (!input) return;
                input.value = '';
                dispatchFieldEdit(input, 'input');
                this._refreshExportPreview?.();
            });
            document.getElementById('btn-dataset-reset-template')?.addEventListener('click', () => {
                const field = document.getElementById('dataset-template-override');
                if (!field) return;
                field.value = '{trigger}, {tags:filtered}, {append}';
                try { localStorage.setItem('datasetMaker.templateOverride', field.value); } catch (_) { /* noop */ }
                dispatchFieldEdit(field, 'input');
                this._refreshExportPreview?.();
            });
            document.getElementById('btn-dataset-refresh-zh-aid')?.addEventListener('click', () => {
                const toggle = document.getElementById('dataset-translation-show-zh');
                this._tagZhCache?.clear?.();
                if (toggle && !toggle.checked) {
                    toggle.checked = true;
                    dispatchFieldEdit(toggle, 'change');
                } else {
                    this._renderTagPills?.();
                }
            });

            // Bulk caption ops -> recompute captions on the fly (debounced)
            for (const id of [
                'dataset-common-tags',
                'dataset-blacklist',
                'dataset-underscore-to-space',
                'dataset-export-content-mode',
                'dataset-export-prefix',
                'dataset-template-override',
                'dataset-replace-rules',
                'dataset-max-tags',
            ]) {
                const el = document.getElementById(id);
                if (!el) continue;
                let t = null;
                const evt = (el.tagName.toLowerCase() === 'input' && el.type === 'checkbox') || el.tagName.toLowerCase() === 'select'
                    ? 'change'
                    : 'input';
                el.addEventListener(evt, () => {
                    if (t) clearTimeout(t);
                    t = setTimeout(() => {
                        if (['dataset-common-tags', 'dataset-blacklist', 'dataset-underscore-to-space'].includes(id)) {
                            this._refreshAllCaptions();
                        }
                        this._refreshExportPreview?.();
                        const templateWrap = document.getElementById('dataset-template-options');
                        if (templateWrap) templateWrap.hidden = this._exportContentMode?.() !== 'template';
                        // v3.4.4 fix #4: flash a small "✓ preview updated" cue
                        // so the user sees the debounced re-render fire instead
                        // of wondering whether the edit took effect.
                        this._flashPreviewUpdated?.();
                    }, 400);
                });
            }

            // P1-17: trait-pruning checklist feeding the dataset blacklist.
            // Local-import items have no gallery tag rows, so only real
            // gallery ids go to the endpoint. Newline separator matches the
            // #dataset-blacklist convention (line breaks, not commas).
            window.TraitPruner?.attach({
                button: document.getElementById('btn-dataset-trait-pruner'),
                textarea: document.getElementById('dataset-blacklist'),
                separator: '\n',
                getImageIds: () => (this.imageIds || [])
                    .filter((id) => !(this.isLocalId && this.isLocalId(id)))
                    .map(Number)
                    .filter(Number.isFinite),
            });

            // Output folder validation + export-button enable
            document.getElementById('dataset-output-folder')?.addEventListener('input', () => {
                this._validateOutputFolder();
                this._updateExportEnabled();
                this._syncOutputModeUi?.();
            });
            document.getElementById('btn-dataset-browse-output')?.addEventListener('click', (event) => {
                event.preventDefault();
                const input = document.getElementById('dataset-output-folder');
                if (input && typeof window.showFolderBrowser === 'function') {
                    window.showFolderBrowser(input);
                }
            });

            // Export flow
            document.getElementById('btn-dataset-export')?.addEventListener('click', () => this._showConfirmModal());
            document.getElementById('btn-dataset-confirm-cancel')?.addEventListener('click', () => this._hideConfirmModal());
            document.getElementById('btn-dataset-confirm-go')?.addEventListener('click', () => this._runExport());
            document.getElementById('btn-dataset-export-cancel')?.addEventListener('click', () => this._cancelExportJob?.());

            // Result modal
            document.getElementById('btn-dataset-result-close')?.addEventListener('click', () => this._hideResultModal());
            document.getElementById('btn-dataset-open-folder')?.addEventListener('click', () => this._openOutputFolder());
        },
    });
})();
