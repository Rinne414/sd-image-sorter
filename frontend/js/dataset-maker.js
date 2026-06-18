/**
 * Dataset Maker — Phase 2C (noob-friendly redesign).
 *
 * Drives the focused LoRA dataset workflow exposed by the 📦 Dataset
 * tab. Talks to /api/dataset/export, /api/tag/start,
 * /api/tags/export-preview, /api/image-thumbnail, and the gallery's
 * selection-token APIs.
 */
(function () {
    'use strict';

    const DM = {
        // ---- State ----
        imageIds: [],
        meta: new Map(),
        captions: new Map(),
        captionEdits: new Map(),
        // point 2/3: parallel natural-language channel. ``captions``/``captionEdits``
        // stay the booru-tags box (all tag tooling keeps using them unchanged);
        // ``nlCaptions`` is the NL baseline (from the preview's nl_caption) and
        // ``nlEdits`` the user's NL-box edits. ``captionType`` holds an explicit
        // per-image booru|nl|both choice; absence means "auto" (both when an NL
        // sentence exists, else booru) — see _captionTypeFor in caption-split.
        nlCaptions: new Map(),
        nlEdits: new Map(),
        captionType: new Map(),
        _undoStacks: new Map(),
        _queueSelection: new Set(),
        _lastClickedId: null,
        activeId: null,
        boundOnce: false,
        _captionInputTimer: null,
        _pendingCaptionEdit: null,
        _saveSessionTimer: null,
        _restoringSession: false,

        // ---- i18n helper ----
        _t(key, fallback, params) {
            if (typeof window.appT === 'function') return window.appT(key, fallback, params);
            return fallback || key;
        },
        _toast(msg, level = 'info', durationMs) {
            if (typeof window.showToast === 'function') {
                window.showToast(msg, level, durationMs);
            } else {
                (window.Logger?.info || console.log)(`[dataset] ${level}: ${msg}`);
            }
        },
        // Programmatically switch the active pipeline tab. The click handler
        // in dataset-maker-pipeline.js ``bindTabs`` owns the same DOM
        // attributes for user clicks; this method is the single shared
        // entry point for programmatic switches so the two paths can't
        // drift. ``bindTabs`` is kept as the listener binder, not a
        // second implementation of the switch.
        _setPipelineTab(tabName = 'import') {
            const dm = document.querySelector('.dataset-maker');
            if (dm) dm.setAttribute('data-active-tab', tabName);
            const tabs = document.querySelectorAll('.dataset-tabs [role="tab"]');
            for (const t of tabs) {
                t.setAttribute('aria-selected',
                    t.getAttribute('data-tab-target') === tabName ? 'true' : 'false');
            }
        },

        // ---- Session persistence ----
        _installCaptionEditPersistence() {
            if (this._captionEditPersistenceInstalled) return;
            this._captionEditPersistenceInstalled = true;
            const map = this.captionEdits;
            const originalSet = map.set.bind(map);
            const originalDelete = map.delete.bind(map);
            const originalClear = map.clear.bind(map);
            map.set = (key, value) => {
                const result = originalSet(key, value);
                if (!this._restoringSession) this._scheduleSaveSession();
                return result;
            };
            map.delete = (key) => {
                const result = originalDelete(key);
                if (!this._restoringSession) this._scheduleSaveSession();
                return result;
            };
            map.clear = () => {
                const result = originalClear();
                if (!this._restoringSession) this._scheduleSaveSession();
                return result;
            };
        },

        _scheduleSaveSession(delayMs = 250) {
            if (this._restoringSession) return;
            if (this._saveSessionTimer) clearTimeout(this._saveSessionTimer);
            this._saveSessionTimer = setTimeout(() => {
                this._saveSessionTimer = null;
                this._saveSession();
            }, delayMs);
        },

        _saveSession() {
            try {
                sessionStorage.setItem('sd-image-sorter-dataset-session', JSON.stringify({
                    imageIds: this.imageIds,
                    captionEdits: Object.fromEntries(this.captionEdits),
                    nlEdits: Object.fromEntries(this.nlEdits),
                    captionType: Object.fromEntries(this.captionType),
                    activeId: this.activeId,
                    local: this._serializeLocalDatasetState?.() || null,
                }));
            } catch {}
        },

        _restoreSession() {
            try {
                const saved = sessionStorage.getItem('sd-image-sorter-dataset-session');
                if (!saved) return false;
                const s = JSON.parse(saved);
                if (!s || !Array.isArray(s.imageIds) || s.imageIds.length === 0) return false;
                this._restoringSession = true;
                this.imageIds = s.imageIds.map(Number).filter(Number.isFinite);
                this.captionEdits.clear();
                if (s.captionEdits) {
                    for (const [k, v] of Object.entries(s.captionEdits)) {
                        const id = Number(k);
                        if (Number.isFinite(id)) this.captionEdits.set(id, v);
                    }
                }
                // point 2/3: restore the parallel NL-box edits + per-image type.
                this.nlEdits.clear();
                if (s.nlEdits) {
                    for (const [k, v] of Object.entries(s.nlEdits)) {
                        const id = Number(k);
                        if (Number.isFinite(id)) this.nlEdits.set(id, v);
                    }
                }
                this.captionType.clear();
                if (s.captionType) {
                    for (const [k, v] of Object.entries(s.captionType)) {
                        const id = Number(k);
                        if (Number.isFinite(id) && (v === 'booru' || v === 'nl' || v === 'both')) {
                            this.captionType.set(id, v);
                        }
                    }
                }
                const active = Number(s.activeId);
                this.activeId = Number.isFinite(active) && this.imageIds.includes(active) ? active : null;
                if (this._restoreLocalSession) this._restoreLocalSession(s.local || {});
                else this._pendingLocalSession = s.local || {};
                return true;
            } catch {
                return false;
            } finally {
                this._restoringSession = false;
            }
        },

        _flushPendingCaptionEdit() {
            const pending = this._pendingCaptionEdit;
            if (this._captionInputTimer) {
                clearTimeout(this._captionInputTimer);
                this._captionInputTimer = null;
            }
            if (!pending || pending.id == null) return;
            this._pendingCaptionEdit = null;
            const id = Number(pending.id);
            const value = String(pending.value ?? '');
            const prev = this.captionEdits.has(id)
                ? this.captionEdits.get(id)
                : (this.captions.get(id) || '');
            if (prev !== value) {
                const stack = this._undoStacks.get(id) || [];
                stack.push(prev);
                if (stack.length > 20) stack.shift();
                this._undoStacks.set(id, stack);
            }
            this.captionEdits.set(id, value);
            this._refreshQueueItem?.(id);
        },

        // ---- Lifecycle ----
        init() {
            if (this.boundOnce) return;
            this.boundOnce = true;
            this._installCaptionEditPersistence();

            this.imageIds.length === 0 && this._restoreSession();

            this._bindEvents();
            this._renderQueue();
            if (this.activeId != null && this.imageIds.includes(Number(this.activeId))) {
                this._setActive?.(this.activeId);
            } else {
                this._renderEmptyEditor();
            }
            this._onPresetChange?.();
            this._updateNamingPreview();
            this._updateExportEnabled();
            this._syncSourceCapabilityStatus?.();
            this._syncOutputModeUi?.();
            this._initCaptionHelpAutoOpen();
            this._bindBeforeUnload();
            this._resumeExportProgress?.();
        },

        _bindBeforeUnload() {
            // H2 fix: Chrome/Edge ignore preventDefault() on beforeunload
            // unless ``returnValue`` is also set on the event. Without
            // ``e.returnValue = ''`` this handler was a silent no-op on
            // the primary target browsers — users would F5 and lose all
            // caption edits with no prompt.
            //
            // Additionally, only prompt when there are UNSAVED edits
            // (``captionEdits.size > 0``). Just having images queued is
            // not a strong enough signal to nag every refresh; queue
            // contents are persisted to sessionStorage and survive
            // reload, but in-progress caption edits beyond what is
            // already saved would still be jarring to lose mid-typing.
            window.addEventListener('beforeunload', (e) => {
                const hasQueue = this.imageIds && this.imageIds.length > 0;
                const hasUnsavedEdits = this.captionEdits && this.captionEdits.size > 0;
                if (hasQueue && hasUnsavedEdits) {
                    e.preventDefault();
                    e.returnValue = '';
                }
            });
        },

        _initCaptionHelpAutoOpen() {
            if (document.querySelector('.dataset-maker')?.getAttribute('data-active-tab') !== 'workbench') {
                return;
            }
            // Auto-open the "what makes a good caption" popover once on
            // first visit so the knowledge hits new users at the right
            // moment, then remember the dismissal.
            const helpSeenKey = 'sd-image-sorter-dataset-caption-help-seen';
            const seenHelp = (() => {
                try { return localStorage.getItem(helpSeenKey) === '1'; }
                catch { return false; }
            })();
            if (seenHelp) return;
            const det = document.querySelector('.dataset-editor-help');
            if (!det) return;
            det.open = true;
            det.addEventListener('toggle', () => {
                if (!det.open) {
                    try { localStorage.setItem(helpSeenKey, '1'); } catch {}
                }
            }, { once: true });
        },

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
                        'Type a trigger word in the "Renumber" preset above first.'), 'warning', 4000);
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

        // ---- Import from Gallery ----
        async _importFromGallery() {
            const ids = await this._resolveGallerySelectionIds();
            if (!ids || ids.length === 0) {
                // P0 fix from issue #5 follow-up noob review: silent failure
                // here is the #1 confusion point. Take the user there
                // explicitly + show a sticky toast that survives the nav.
                this._toast(this._t('dataset.gallerySelectionEmpty',
                    '👈 Open the Gallery tab and select images first, then come back here and click this button again.'),
                    'warning', 8000);
                // Switch to the Gallery tab so the user sees the next step
                // without having to figure out where to click.
                const galleryTab = document.getElementById('nav-tab-gallery');
                if (galleryTab) {
                    setTimeout(() => galleryTab.click(), 600);
                }
                return;
            }
            await this.addImageIds(ids, { showToast: true });
        },

        /**
         * Public helper for external modules (gallery selection toolbar,
         * Tag modal, color analysis, future bridges) to push image IDs
         * into the Dataset Maker queue. Handles dedup, lazy meta fetch,
         * caption fetch, queue render, optional toast.
         *
         * Returns the number of NEW images actually added (after dedup).
         *
         * @param {Array<number|string>} ids
         * @param {{showToast?: boolean, switchView?: boolean}} options
         */
        async addImageIds(ids, options = {}) {
            const showToast = options.showToast !== false;
            const switchView = options.switchView !== false;

            const before = this.imageIds.length;
            const seen = new Set(this.imageIds);
            const newOnes = [];
            for (const id of (ids || [])) {
                const n = Number(id);
                if (!Number.isFinite(n) || n <= 0) continue;
                if (!seen.has(n)) {
                    this.imageIds.push(n);
                    seen.add(n);
                    newOnes.push(n);
                }
            }

            // Pull width/height from the gallery's already-loaded records
            // when possible to avoid per-image API calls. Same shape as
            // _importFromGallery's pre-flight enrichment.
            try {
                const galleryRecords = (window.AppState && window.AppState.images) || [];
                const byId = new Map();
                for (const rec of galleryRecords) {
                    if (rec && rec.id != null) byId.set(Number(rec.id), rec);
                }
                for (const id of newOnes) {
                    const rec = byId.get(Number(id));
                    if (!rec) continue;
                    const existing = this.meta.get(Number(id)) || {};
                    this.meta.set(Number(id), {
                        ...existing,
                        source: existing.source || 'gallery',
                        source_kind: existing.source_kind || 'gallery',
                        sidecar_capability: existing.sidecar_capability || 'beside_image',
                        filename: existing.filename || rec.filename || '',
                        thumbnail_path: existing.thumbnail_path || rec.thumbnail_path || '',
                        width: Number(rec.width || 0),
                        height: Number(rec.height || 0),
                    });
                }
            } catch { /* gallery state shape might shift; non-fatal */ }

            await this._fetchMissingMeta();
            await this._fetchMissingCaptions();
            for (const id of newOnes) {
                const existing = this.meta.get(Number(id)) || {};
                this.meta.set(Number(id), {
                    ...existing,
                    source: existing.source || 'gallery',
                    source_kind: existing.source_kind || 'gallery',
                    sidecar_capability: existing.sidecar_capability || 'beside_image',
                });
            }
            this._renderQueue();
            this._updateCount();
            this._updateExportEnabled();
            this._syncSourceCapabilityStatus?.();
            if (this.activeId == null && this.imageIds.length) {
                this._setActive(this.imageIds[0]);
            }

            const added = this.imageIds.length - before;

            if (switchView && added > 0 && typeof window.switchView === 'function') {
                try { window.switchView('dataset'); } catch (_e) { /* ignore */ }
            }

            // Ensure we stay on the import tab so the user sees the result
            if (added > 0) {
                this._setPipelineTab('import');
                this._renderImportGallery();
            }

            if (showToast) {
                if (added > 0) {
                    this._toast(this._t('dataset.gallerySelectionAdded',
                        'Added {count} images from Gallery selection',
                        { count: added }), 'success');
                } else {
                    this._toast(this._t('dataset.gallerySelectionAlreadyAdded',
                        'Those images are already in the Dataset Maker queue.'),
                        'info');
                }
            }
            this._checkDuplicateFilenames();
            this._saveSession();
            return added;
        },

        _checkDuplicateFilenames() {
            const stems = new Map();
            for (const id of this.imageIds) {
                const meta = this.meta.get(id) || {};
                const fn = (meta.filename || '').replace(/\.[^.]+$/, '').toLowerCase();
                if (!fn) continue;
                if (!stems.has(fn)) stems.set(fn, 0);
                stems.set(fn, stems.get(fn) + 1);
            }
            let dupCount = 0;
            for (const count of stems.values()) {
                if (count > 1) dupCount += count;
            }
            if (dupCount > 0) {
                this._toast(this._t('dataset.duplicateWarning',
                    'Found {count} images with similar filenames. You may want to review for duplicates.',
                    { count: dupCount }), 'warning', 6000);
            }
        },

        _getGallerySelectedIds() {
            if (typeof window.getSelectedGalleryIds === 'function') {
                try { return window.getSelectedGalleryIds() || []; } catch {}
            }
            if (window.AppState && window.AppState.selectedIds) {
                try { return Array.from(window.AppState.selectedIds); } catch {}
            }
            return [];
        },

        async _resolveGallerySelectionIds() {
            const explicit = this._getGallerySelectedIds();
            if (explicit.length > 0) return explicit;

            const app = window.App || {};
            const state = app.AppState || window.AppState || {};
            const token = state.selectionScope === 'filtered' ? state.selectionToken : null;
            const api = app.API;
            if (!token || !api || typeof api.getSelectionChunk !== 'function') {
                return [];
            }

            const out = [];
            let offset = 0;
            let hasMore = true;
            const chunkSize = 10000;
            while (hasMore) {
                const chunk = await api.getSelectionChunk(token, {
                    offset,
                    limit: chunkSize,
                });
                const ids = Array.isArray(chunk?.image_ids) ? chunk.image_ids : [];
                out.push(...ids.map(Number).filter((id) => Number.isFinite(id) && id > 0));
                hasMore = Boolean(chunk?.has_more);
                offset = Number(chunk?.next_offset || 0);
                if (!offset && hasMore) break;
            }
            return out;
        },

        _clearAll() {
            if (this.imageIds.length === 0) return;
            const count = this.imageIds.length;
            const title = this._t('dataset.confirmClearTitle', 'Clear Dataset Maker');
            const msg = this._t('dataset.confirmClear',
                'Remove all {count} images from the Dataset Maker queue? Original files and Gallery records will not be deleted.',
                { count });
            const doClear = () => {
                this.imageIds = [];
                this.captions.clear();
                this.captionEdits.clear();
                this._undoStacks.clear();
                this._queueSelection.clear();
                this.activeId = null;
                this._clearLocalDatasetState?.();
                sessionStorage.removeItem('sd-image-sorter-dataset-session');
                this._saveSession();
                this._renderQueue();
                this._renderImportGallery?.();
                this._renderEmptyEditor();
                this._updateCount();
                this._updateExportEnabled();
                this._syncSourceCapabilityStatus?.();
                // Notify derived caches (confidence pills, future
                // vocab/tag-zh caches) that the dataset membership
                // changed so they don't serve stale entries.
                window.dispatchEvent(new CustomEvent('dataset:changed'));
            };
            if (window.App?.showConfirm) {
                window.App.showConfirm(title, msg, doClear);
                return;
            }
            if (window.confirm(msg)) doClear();
        },

        // v3.4.4 fix #4: tiny "✓ preview updated" cue so users see the
        // debounced export-preview re-render fire after editing a
        // prefix/template/blacklist field. No-op if the cue element
        // isn't present.
        _flashPreviewUpdated() {
            const list = document.getElementById('dataset-export-preview-list');
            if (!list) return;
            list.classList.remove('dm-preview-just-updated');
            // reflow to restart the CSS animation
            void list.offsetWidth;
            list.classList.add('dm-preview-just-updated');
        },
    };

    window.DatasetMaker = DM;

    // Load the rest of the module in deterministic order. Browsers honor
    // ``async = false`` for dynamically-inserted scripts as a way to
    // request "execute these in DOM-insertion order, not parallel race"
    // (see HTML spec §"prepare a script", classic-script branch). This
    // matters because dataset-maker-local-import.js patches functions
    // defined in part2.js (e.g. _buildQueueItem) — without ordering, the
    // patch can land BEFORE the function exists and get overwritten.
    function _appendOrderedScript(src) {
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        document.head.appendChild(s);
        return s;
    }
    _appendOrderedScript('/static/js/dataset-maker-part2.js');
    _appendOrderedScript('/static/js/dataset-maker-part3.js');
    _appendOrderedScript('/static/js/dataset-maker-cleanups.js');
    // v3.2.2 task #7b: dual-source queue + folder-import (small gallery).
    _appendOrderedScript('/static/js/dataset-maker-local-import.js');
    // v3.2.2 task #8 + #9: 5-step stepper + Audit panel.
    _appendOrderedScript('/static/js/dataset-maker-pipeline.js');
    // v3.2.2 T-power-PR2 (C): tag confidence pills inside the caption editor.
    _appendOrderedScript('/static/js/dataset-confidence-pills.js');
    // point 2/3: two-box caption editor (booru + natural-language) with a
    // per-image type toggle + bulk/auto helpers. Loaded last so its _setActive /
    // _renderEmptyEditor / _buildQueueItem wrappers compose over part2 + the
    // local-import + pipeline patches.
    _appendOrderedScript('/static/js/dataset-maker-caption-split.js');

    // Hook into view activation
    function initWhenViewActivates() {
        const view = document.getElementById('view-dataset');
        if (!view) return;
        const observer = new MutationObserver(() => {
            if (view.classList.contains('active')) DM.init();
        });
        observer.observe(view, { attributes: true, attributeFilter: ['hidden', 'class'] });
        if (view.classList.contains('active')) DM.init();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenViewActivates);
    } else {
        initWhenViewActivates();
    }
})();
