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
            // DUR-1: localStorage, not sessionStorage. Caption edits are
            // hours of work — they must survive tab close, browser crash,
            // and the navbar 🔄 hard refresh (which clears sessionStorage).
            // Key name and payload format are FROZEN (restore-compat).
            const payload = JSON.stringify({
                imageIds: this.imageIds,
                captionEdits: Object.fromEntries(this.captionEdits),
                nlEdits: Object.fromEntries(this.nlEdits),
                captionType: Object.fromEntries(this.captionType),
                activeId: this.activeId,
                local: this._serializeLocalDatasetState?.() || null,
            });
            try {
                localStorage.setItem('sd-image-sorter-dataset-session', payload);
                return;
            } catch {
                // Quota exceeded or storage unavailable — degrade to the
                // old per-tab storage rather than silently losing edits.
            }
            try {
                sessionStorage.setItem('sd-image-sorter-dataset-session', payload);
            } catch {}
        },

        _restoreSession() {
            try {
                // DUR-1: durable draft first; legacy per-tab draft second so
                // a session written by a pre-DUR-1 build still restores once.
                let saved = null;
                try { saved = localStorage.getItem('sd-image-sorter-dataset-session'); } catch {}
                if (!saved) {
                    try { saved = sessionStorage.getItem('sd-image-sorter-dataset-session'); } catch {}
                }
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
            // contents are persisted to localStorage (DUR-1) and survive
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
    // Load the rest of the module in deterministic order. Browsers honor
    // ``async = false`` for dynamically-inserted scripts as a way to
    // request "execute these in DOM-insertion order, not parallel race"
    // (see HTML spec §"prepare a script", classic-script branch). This
    // matters because dataset-maker-local-import.js registers hooks and
    // decorators on registries defined in part2.js (_activeChangedHooks,
    // _queueItemDecorators) — without ordering, the registration can run
    // BEFORE the registry exists.
    function _appendOrderedScript(src) {
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        document.head.appendChild(s);
        return s;
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
    _appendOrderedScript('/static/js/dataset/gallery-import.js');
    _appendOrderedScript('/static/js/dataset/events.js');
    _appendOrderedScript('/static/js/dataset/queue-render.js');
    _appendOrderedScript('/static/js/dataset/active-editor.js');
    _appendOrderedScript('/static/js/dataset/multiselect.js');
    _appendOrderedScript('/static/js/dataset/split-view.js');
    _appendOrderedScript('/static/js/dataset/tags.js');
    _appendOrderedScript('/static/js/dataset/caption-fetch.js');
    _appendOrderedScript('/static/js/dataset/output-naming.js');
    _appendOrderedScript('/static/js/dataset/tag-all.js');
    _appendOrderedScript('/static/js/dataset/export-run.js');
    _appendOrderedScript('/static/js/dataset/tag-autocomplete.js');
    _appendOrderedScript('/static/js/dataset/local-import.js');
    _appendOrderedScript('/static/js/dataset/folder-import-ui.js');
    _appendOrderedScript('/static/js/dataset/lora-prune.js');
    _appendOrderedScript('/static/js/dataset/audit.js');
    _appendOrderedScript('/static/js/dataset/audit-run.js');
    _appendOrderedScript('/static/js/dataset/vocab.js');
    _appendOrderedScript('/static/js/dataset/defaults-pairchip.js');
    _appendOrderedScript('/static/js/dataset/export-preview.js');
    _appendOrderedScript('/static/js/dataset/custom-dropdown.js');
    // v3.2.2 T-power-PR2 (C): tag confidence pills inside the caption editor.
    _appendOrderedScript('/static/js/dataset-confidence-pills.js');
    // point 2/3: two-box caption editor (booru + natural-language) with a
    // per-image type toggle + bulk/auto helpers. Loaded last so its hooks /
    // decorators / _renderEmptyEditor wrappers compose over part2 + the
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
