/**
 * Dataset Maker — core: shared state, session persistence, lifecycle (init), the ordered async=false module loader, and the view-activation hook.
 * Moved VERBATIM from dataset-maker.js L1-266 + L788-837 (god-file split);
 * the loader call list is the one section rewritten for the new dataset/
 * module paths. Also hosts the two hook registries relocated from
 * dataset-maker-part2.js L105-114 / L450-457 (lead-approved deviation —
 * see the inline comment above them).
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
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

    const DATASET_DRAFT_SESSION_KEY = 'sd-image-sorter-dataset-session';
    const DATASET_PROJECT_SESSION_PREFIX = 'sd-image-sorter-dataset-project-session';

    function requireSessionRecord(value, fieldName) {
        if (value === undefined || value === null) return {};
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError(`Dataset draft ${fieldName} must be an object.`);
        }
        return { ...value };
    }

    function parseSessionStringMap(value, fieldName) {
        const record = requireSessionRecord(value, fieldName);
        for (const [key, entry] of Object.entries(record)) {
            if (typeof entry !== 'string') {
                throw new TypeError(`Dataset draft ${fieldName}.${key} must be a string.`);
            }
        }
        return record;
    }

    function parseSessionCaptionTypes(value) {
        const record = parseSessionStringMap(value, 'captionType');
        for (const [key, entry] of Object.entries(record)) {
            if (entry !== 'booru' && entry !== 'nl' && entry !== 'both') {
                throw new TypeError(
                    `Dataset draft captionType.${key} must be booru, nl, or both.`,
                );
            }
        }
        return record;
    }

    function normalizeManagedTrigger(value) {
        return String(value || '').replace(/[\s_]+/g, ' ').trim().toLowerCase();
    }

    function parseSessionQuickfilledTrigger(value) {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'string') {
            throw new TypeError('Dataset draft quickfilledTrigger must be a string.');
        }
        return value.trim();
    }

    function inferLegacyQuickfilledTrigger(settings) {
        const captionRender = settings?.caption_render;
        const trigger = String(captionRender?.trigger || '').trim();
        const triggerKey = normalizeManagedTrigger(trigger);
        const commonTags = Array.isArray(captionRender?.common_tags)
            ? captionRender.common_tags
            : [];
        return triggerKey && commonTags.some((tag) => normalizeManagedTrigger(tag) === triggerKey)
            ? trigger
            : '';
    }

    function parseSessionLocalState(value) {
        const local = requireSessionRecord(value, 'local');
        const localItems = local.localItems === undefined ? [] : local.localItems;
        const manifests = local.manifests === undefined ? [] : local.manifests;
        if (!Array.isArray(localItems)) {
            throw new TypeError('Dataset draft local.localItems must be an array.');
        }
        if (!Array.isArray(manifests)) {
            throw new TypeError('Dataset draft local.manifests must be an array.');
        }
        for (const [index, item] of localItems.entries()) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new TypeError(`Dataset draft local.localItems[${index}] must be an object.`);
            }
            if (
                item.meta !== undefined
                && (!item.meta || typeof item.meta !== 'object' || Array.isArray(item.meta))
            ) {
                throw new TypeError(
                    `Dataset draft local.localItems[${index}].meta must be an object.`,
                );
            }
            if (item.caption_baseline !== undefined && typeof item.caption_baseline !== 'string') {
                throw new TypeError(
                    `Dataset draft local.localItems[${index}].caption_baseline must be a string.`,
                );
            }
        }
        for (const [index, source] of manifests.entries()) {
            if (!source || typeof source !== 'object' || Array.isArray(source)) {
                throw new TypeError(`Dataset draft local.manifests[${index}] must be an object.`);
            }
            if (source.excludedPaths !== undefined && !Array.isArray(source.excludedPaths)) {
                throw new TypeError(
                    `Dataset draft local.manifests[${index}].excludedPaths must be an array.`,
                );
            }
        }
        return {
            localItems: localItems.map((item) => ({
                ...item,
                ...(item.meta === undefined ? {} : { meta: { ...item.meta } }),
            })),
            manifests: manifests.map((source) => ({
                ...source,
                ...(source.excludedPaths === undefined
                    ? {}
                    : { excludedPaths: [...source.excludedPaths] }),
            })),
        };
    }

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
        _nlCaptionInputTimer: null,
        _pendingNlCaptionEdit: null,
        _saveSessionTimer: null,
        _restoringSession: false,
        _quickfilledTrigger: '',

        _inferLegacyQuickfilledTrigger(settings) {
            return inferLegacyQuickfilledTrigger(settings);
        },

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
        _datasetSessionKey(project) {
            if (project === null) return DATASET_DRAFT_SESSION_KEY;
            const projectId = Number(project?.id);
            const revision = Number(project?.revision);
            if (!Number.isSafeInteger(projectId) || projectId <= 0) {
                throw new TypeError('Dataset project session id must be a positive safe integer.');
            }
            if (!Number.isSafeInteger(revision) || revision <= 0) {
                throw new TypeError('Dataset project session revision must be a positive safe integer.');
            }
            return `${DATASET_PROJECT_SESSION_PREFIX}-${projectId}-r${revision}`;
        },

        _currentDatasetSessionKey() {
            return this._datasetSessionKey(this._activeProject || null);
        },

        _removeDatasetSession(project) {
            const storageKey = this._datasetSessionKey(project);
            try { localStorage.removeItem(storageKey); } catch {}
            try { sessionStorage.removeItem(storageKey); } catch {}
        },

        _installCaptionEditPersistence() {
            if (this._captionEditPersistenceInstalled) return;
            this._captionEditPersistenceInstalled = true;
            const installMapPersistence = (map) => {
                const originalSet = map.set.bind(map);
                const originalDelete = map.delete.bind(map);
                const originalClear = map.clear.bind(map);
                map.set = (key, value) => {
                    const changed = !map.has(key) || map.get(key) !== value;
                    const result = originalSet(key, value);
                    if (!this._restoringSession && changed) {
                        this._supersedeCaptionFetch?.();
                        this._scheduleSaveSession();
                        this._markReadinessStale?.();
                    }
                    return result;
                };
                map.delete = (key) => {
                    const changed = map.has(key);
                    const result = originalDelete(key);
                    if (!this._restoringSession && changed) {
                        this._supersedeCaptionFetch?.();
                        this._scheduleSaveSession();
                        this._markReadinessStale?.();
                    }
                    return result;
                };
                map.clear = () => {
                    const changed = map.size > 0;
                    const result = originalClear();
                    if (!this._restoringSession && changed) {
                        this._supersedeCaptionFetch?.();
                        this._scheduleSaveSession();
                        this._markReadinessStale?.();
                    }
                    return result;
                };
            };
            installMapPersistence(this.captionEdits);
            installMapPersistence(this.nlEdits);
            installMapPersistence(this.captionType);
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
            // DUR-1: localStorage, not sessionStorage. Caption edits are
            // hours of work — they must survive tab close, browser crash,
            // and the navbar 🔄 hard refresh (which clears sessionStorage).
            // Key name and payload format are FROZEN (restore-compat).
            const settings = this._pendingProjectSettings
                || this._serializeDatasetDraftSettings?.()
                || this._serializeProjectSettings?.()
                || null;
            const payload = JSON.stringify({
                imageIds: this.imageIds,
                captionEdits: Object.fromEntries(this.captionEdits),
                nlEdits: Object.fromEntries(this.nlEdits),
                captionType: Object.fromEntries(this.captionType),
                quickfilledTrigger: this._quickfilledTrigger,
                activeId: this.activeId,
                local: this._serializeLocalDatasetState?.() || null,
                settings,
            });
            const storageKey = this._currentDatasetSessionKey();
            try {
                localStorage.setItem(storageKey, payload);
                return;
            } catch {
                // Quota exceeded or storage unavailable — degrade to the
                // old per-tab storage rather than silently losing edits.
            }
            try {
                sessionStorage.setItem(storageKey, payload);
            } catch {}
        },

        _readDatasetSession(project) {
            const storageKey = this._datasetSessionKey(project);
            let saved = null;
            try { saved = localStorage.getItem(storageKey); } catch {}
            if (!saved) {
                try { saved = sessionStorage.getItem(storageKey); } catch {}
            }
            if (!saved) return null;
            const session = JSON.parse(saved);
            if (!session || typeof session !== 'object' || Array.isArray(session)) {
                throw new TypeError('Dataset draft session must be an object.');
            }
            if (!Array.isArray(session.imageIds)) {
                throw new TypeError('Dataset draft imageIds must be an array.');
            }
            const imageIds = session.imageIds.map((value, index) => {
                if (!Number.isSafeInteger(value) || value === 0) {
                    throw new TypeError(
                        `Dataset draft imageIds[${index}] must be a non-zero safe integer.`,
                    );
                }
                return value;
            });
            if (new Set(imageIds).size !== imageIds.length) {
                throw new TypeError('Dataset draft imageIds must not contain duplicates.');
            }
            const rawSettings = session.settings === undefined
                ? this._defaultProjectSettings?.()
                : session.settings;
            if (!rawSettings || typeof this._parseProjectSettings !== 'function') {
                throw new TypeError('Dataset draft settings parser is unavailable.');
            }
            const settings = this._parseProjectSettings(rawSettings);
            const storedQuickfilledTrigger = parseSessionQuickfilledTrigger(
                session.quickfilledTrigger,
            );
            const activeId = session.activeId === null || session.activeId === undefined
                ? null
                : session.activeId;
            if (
                activeId !== null
                && (!Number.isSafeInteger(activeId) || !imageIds.includes(activeId))
            ) {
                throw new TypeError('Dataset draft activeId must be null or an imageIds member.');
            }
            return Object.freeze({
                imageIds,
                captionEdits: parseSessionStringMap(session.captionEdits, 'captionEdits'),
                nlEdits: parseSessionStringMap(session.nlEdits, 'nlEdits'),
                captionType: parseSessionCaptionTypes(session.captionType),
                quickfilledTrigger: storedQuickfilledTrigger === null
                    ? inferLegacyQuickfilledTrigger(settings)
                    : storedQuickfilledTrigger,
                activeId,
                local: parseSessionLocalState(session.local),
                settings,
            });
        },

        _applyDatasetSession(session) {
            this._pendingProjectSettings = session.settings;
            this._restoringSession = true;
            try {
                this.imageIds = [...session.imageIds];
                this.captionEdits.clear();
                for (const [key, value] of Object.entries(session.captionEdits)) {
                    this.captionEdits.set(Number(key), value);
                }
                this.nlEdits.clear();
                for (const [key, value] of Object.entries(session.nlEdits)) {
                    this.nlEdits.set(Number(key), value);
                }
                this.captionType.clear();
                for (const [key, value] of Object.entries(session.captionType)) {
                    this.captionType.set(Number(key), value);
                }
                this._quickfilledTrigger = session.quickfilledTrigger;
                this.activeId = session.activeId;
                if (this._restoreLocalSession) this._restoreLocalSession(session.local);
                else this._pendingLocalSession = session.local;
                this._saveManagedTriggerForLocalIds?.(
                    this.imageIds,
                    this._quickfilledTrigger,
                    null,
                );
            } finally {
                this._restoringSession = false;
            }
        },

        _restoreSession(project) {
            try {
                const session = this._readDatasetSession(project);
                if (!session) return false;
                this._applyDatasetSession(session);
                return true;
            } catch (error) {
                window.Logger?.error?.('dataset_session_restore_failed', {
                    error_type: error?.constructor?.name || typeof error,
                    message: error instanceof Error ? error.message : String(error),
                });
                this._toast(
                    `Dataset draft could not be restored: ${error instanceof Error ? error.message : String(error)}`,
                    'error',
                );
                return false;
            }
        },

        _flushPendingCaptionEdit() {
            const pending = this._pendingCaptionEdit;
            if (this._captionInputTimer) {
                clearTimeout(this._captionInputTimer);
                this._captionInputTimer = null;
            }
            if (!pending || pending.id == null) return;
            const id = Number(pending.id);
            const value = String(pending.value ?? '');
            const prev = this.captionEdits.has(id)
                ? this.captionEdits.get(id)
                : (this.captions.get(id) || '');
            this.captionEdits.set(id, value);
            this._pendingCaptionEdit = null;
            if (prev !== value) {
                const stack = this._undoStacks.get(id) || [];
                stack.push(prev);
                if (stack.length > 20) stack.shift();
                this._undoStacks.set(id, stack);
            }
            this._refreshQueueItem?.(id);
        },

        _flushPendingDatasetEdits() {
            this._flushPendingCaptionEdit();
            this._flushPendingNlCaptionEdit?.();
        },

        _discardPendingDatasetEdits() {
            if (this._captionInputTimer) {
                clearTimeout(this._captionInputTimer);
                this._captionInputTimer = null;
            }
            if (this._nlCaptionInputTimer) {
                clearTimeout(this._nlCaptionInputTimer);
                this._nlCaptionInputTimer = null;
            }
            this._pendingCaptionEdit = null;
            this._pendingNlCaptionEdit = null;
        },

        // ---- Lifecycle ----
        init() {
            if (this.boundOnce) return;
            this.boundOnce = true;
            this._installCaptionEditPersistence();

            this._initTrainerSelector?.();

            const restoredDraft = this.imageIds.length === 0 && this._restoreSession(null);
            if (!restoredDraft && !this._pendingProjectSettings) {
                this._pendingProjectSettings = this._defaultProjectSettings?.() || null;
            }

            this._bindEvents();
            this._initProjectSettingsPersistence?.();
            this._initProjectStore?.();
            this._renderQueue();
            if (this.activeId != null && this.imageIds.includes(Number(this.activeId))) {
                this._setActive?.(this.activeId);
            } else {
                this._renderEmptyEditor();
            }
            this._onPresetChange?.();
            this._updateNamingPreview();
            this._initReadiness?.();
            this._updateExportEnabled();
            this._syncSourceCapabilityStatus?.();
            this._syncOutputModeUi?.();
            this._initCaptionHelpAutoOpen();
            this._bindBeforeUnload();
            this._resumeExportProgress?.();
            void this._restorePendingProjectSettings?.().then(async () => {
                await this._fetchMissingMeta?.();
                await this._fetchMissingCaptions?.();
                this._renderQueue?.();
                if (this.activeId !== null) this._setActive?.(this.activeId);
            }).catch((error) => {
                window.Logger?.error?.('dataset_project_settings_restore_failed', {
                    error_type: error?.constructor?.name || typeof error,
                    message: error instanceof Error ? error.message : String(error),
                });
                this._toast(
                    `Dataset settings could not be restored: ${error instanceof Error ? error.message : String(error)}`,
                    'error',
                );
            });
        },

        _bindBeforeUnload() {
            // H2 fix: Chrome/Edge ignore preventDefault() on beforeunload
            // unless ``returnValue`` is also set on the event. Without
            // ``e.returnValue = ''`` this handler was a silent no-op on
            // the primary target browsers — users would F5 and lose all
            // caption edits with no prompt.
            //
            // Additionally, only prompt when there are UNSAVED caption edits.
            // Booru, NL, and caption-type maps are all browser-owned drafts.
            // Just having images queued is
            // not a strong enough signal to nag every refresh; queue
            // contents are persisted to localStorage (DUR-1) and survive
            // reload, but in-progress caption edits beyond what is
            // already saved would still be jarring to lose mid-typing.
            window.addEventListener('beforeunload', (e) => {
                this._flushPendingDatasetEdits();
                this._saveSession();
                const hasQueue = this.imageIds && this.imageIds.length > 0;
                const hasUnsavedEdits = [this.captionEdits, this.nlEdits, this.captionType]
                    .some((draftMap) => draftMap && draftMap.size > 0);
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
    };

    window.DatasetMaker = DM;


    // Lead-approved deviation from the strictly-verbatim split: these two
    // registry initializers moved here from dataset-maker-part2.js (L114 /
    // L457) so no later-loaded module's top-level `.push(...)` (split-view,
    // caption-diff, local-import, caption-split, confidence-pills,
    // Separation Console) can ever run before the registry exists — the
    // split's one real load-order hazard. The initializer lines and their
    // original explanation comments below are verbatim; only the home moved.

    // FE-1 2b: active-image side-effect registry. The former _setActive
    // monkey-patch chain (split-view refresh, caption diff, confidence
    // pills, caption boxes, Separation Console seen-marking) registers
    // hooks here instead of re-wrapping DM._setActive. Hooks run in
    // registration order AFTER the core logic — the same order the old
    // wrapper chain produced — and run even when the core early-returns
    // (wrapper post-code always ran). Each hook receives the numeric id
    // that was requested with `this` bound to DM.
    DM._activeChangedHooks = [];

    // FE-1 2b: queue-item decorator registry. Former _buildQueueItem
    // monkey-patch wrappers (local-import thumb/label swap, caption-split
    // type chip) register decorators here instead of re-wrapping. Each
    // decorator mutates the built element in place and runs in
    // registration order after the base item is fully assembled (event
    // listeners included), exactly like the old wrapper chain.
    DM._queueItemDecorators = [];
    // Append every module in declaration order before awaiting readiness.
    // Dynamic classic scripts with async=false fetch in parallel while the
    // browser preserves their insertion order for execution.
    function _appendOrderedScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = false;
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', () => {
                reject(new Error(`Dataset Maker module failed to load: ${src}`));
            }, { once: true });
            document.head.appendChild(script);
        });
    }
    // Split note: the modules below are the by-feature decomposition of the
    // old part2/part3/cleanups/local-import/pipeline god-files. ORDER IS
    // LOAD-BEARING — later modules override/wrap methods defined by earlier
    // ones (later-wins), push into the core registries above, and
    // audit-run.js reads audit.js exports at load time. Keep:
    //   * queue-render/active-editor/caption-fetch/output-naming BEFORE
    //     local-import (overrides _thumbSrc/_fetchMissingMeta/
    //     _fetchMissingCaptions/_refreshAllCaptions/_removeImageById/
    //     _removeActive/_updateCount/_isReadyToExport and owns the single
    //     _buildExportPayload — never resurrect the removed part3 copy);
    //   * gallery-import BEFORE tag-autocomplete (wraps DM.addImageIds);
    //   * lora-prune wraps DM.init — no other module may wrap init;
    //   * audit BEFORE audit-run (AUDIT_STATE + renderResults bridges);
    //   * audit -> audit-run -> vocab -> defaults-pairchip -> export-preview
    //     preserves the old pipeline init() binder order.
    const datasetModuleSources = [
        '/static/js/dataset/gallery-import.js',
        '/static/js/dataset/project-settings.js',
        '/static/js/dataset/project-store.js',
        '/static/js/dataset/events.js',
        '/static/js/dataset/queue-render.js',
        '/static/js/dataset/active-editor.js',
        '/static/js/dataset/multiselect.js',
        '/static/js/dataset/split-view.js',
        '/static/js/dataset/tags.js',
        '/static/js/dataset/caption-fetch.js',
        '/static/js/dataset/output-naming.js',
        '/static/js/dataset/trainer-selector.js',
        '/static/js/dataset/readiness.js',
        '/static/js/dataset/tag-all.js',
        '/static/js/dataset/export-run.js',
        '/static/js/dataset/tag-autocomplete.js',
        '/static/js/dataset/local-import.js',
        '/static/js/dataset/folder-import-ui.js',
        '/static/js/dataset/lora-prune.js',
        '/static/js/dataset/audit.js',
        '/static/js/dataset/audit-run.js',
        '/static/js/dataset/vocab.js',
        '/static/js/dataset/defaults-pairchip.js',
        '/static/js/dataset/export-preview.js',
        '/static/js/dataset/custom-dropdown.js',
        // v3.2.2 T-power-PR2 (C): tag confidence pills inside the caption editor.
        '/static/js/dataset-confidence-pills.js',
        // Two-box caption editor loads before the revision ledger so saved
        // content can wrap its effective-caption helpers.
        '/static/js/dataset-maker-caption-split.js',
        '/static/js/dataset/annotation-ledger.js',
    ];

    const datasetModulesReady = Promise.all(
        datasetModuleSources.map((source) => _appendOrderedScript(source)),
    );
    let datasetModuleLoadError = null;
    let datasetModuleLoadErrorLogged = false;
    let datasetInitPending = false;

    function recordDatasetModuleLoadError(error) {
        if (!datasetModuleLoadError) {
            datasetModuleLoadError = error instanceof Error ? error : new Error(String(error));
        }
        if (!datasetModuleLoadErrorLogged) {
            datasetModuleLoadErrorLogged = true;
            const details = { message: datasetModuleLoadError.message };
            window.Logger?.error?.('dataset_module_load_failed', details);
        }
        return datasetModuleLoadError;
    }

    function showDatasetModuleLoadError(error) {
        DM._toast(recordDatasetModuleLoadError(error).message, 'error');
    }

    datasetModulesReady.catch(recordDatasetModuleLoadError);

    // Hook into view activation
    function initWhenViewActivates() {
        const view = document.getElementById('view-dataset');
        if (!view) return;
        const initActiveView = () => {
            if (!view.classList.contains('active') || DM.boundOnce || datasetInitPending) return;
            if (datasetModuleLoadError) {
                showDatasetModuleLoadError(datasetModuleLoadError);
                return;
            }
            datasetInitPending = true;
            datasetModulesReady.then(() => {
                datasetInitPending = false;
                if (view.classList.contains('active') && !DM.boundOnce) DM.init();
            }, (error) => {
                datasetInitPending = false;
                showDatasetModuleLoadError(error);
            });
        };
        const observer = new MutationObserver(() => {
            initActiveView();
        });
        observer.observe(view, { attributes: true, attributeFilter: ['hidden', 'class'] });
        initActiveView();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenViewActivates);
    } else {
        initWhenViewActivates();
    }
})();
