/**
 * v321/preview-core.js - v321-ui.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 1104-1634
 * (of 3,164): (C) preview wiring, caption-editor modal, selection/queue windowing.
 * EXCEPTION (lead sign-off #1): renderPreviewList (pre-cut 1539-1560)
 * DELETED - zero runtime callers, zero test pins; superseded by
 * refreshPreview -> _renderPreviewWorkbench.
 * Classic script: joins the ONE unsealed window.V321Integration object
 * declared in v321/base.js (loads FIRST); v321/boot.js registers the
 * DOMContentLoaded init LAST; index.html lists the family in original
 * line order.
 */
Object.assign(window.V321Integration, {

    // ====================================================================
    // (C) Live preview with per-image edit
    // ====================================================================

    bindLivePreview() {
        document.getElementById('btn-refresh-preview')?.addEventListener('click', () => this.refreshPreview());

        // v3.2.1 task #33: open / close the dedicated full-screen Caption Editor modal
        document.getElementById('btn-open-caption-editor')?.addEventListener('click', () => this.openCaptionEditor());
        document.getElementById('btn-close-caption-editor')?.addEventListener('click', () => this.closeCaptionEditor());
        document.getElementById('btn-caption-editor-done')?.addEventListener('click', () => this.closeCaptionEditor());
        document.getElementById('btn-caption-editor-refresh')?.addEventListener('click', () => this.refreshPreview());
        // Click outside the modal-content (on the backdrop) closes the editor.
        document.querySelector('#caption-editor-modal .modal-backdrop')?.addEventListener('click', () => this.closeCaptionEditor());

        // Content-mode changes what the preview renders (tags / NL / both…) —
        // refresh immediately so the editor never shows a stale tags-only
        // render after the user switches to an NL-bearing mode.
        document.getElementById('batch-export-content-mode')?.addEventListener('change', () => this.refreshPreview());

        // Refresh when trigger / template changes
        const watchIds = ['lora-trigger-word', 'lora-template-override', 'lora-max-tags',
            'lora-append-text', 'batch-export-prefix', 'batch-export-blacklist'];
        for (const id of watchIds) {
            const el = document.getElementById(id);
            if (el) {
                let timer = null;
                el.addEventListener('input', () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => this.refreshPreview(), 600);
                });
            }
        }

        // v3.4.3: persist the custom template across page reloads — users keep
        // one format and shouldn't retype it every session. Stored on input,
        // restored only when the field is still empty (never clobbers HTML or
        // user-typed state).
        const templateOverride = document.getElementById('lora-template-override');
        if (templateOverride) {
            try {
                const storedTemplate = localStorage.getItem('batchExport.templateOverride');
                if (storedTemplate && !templateOverride.value) templateOverride.value = storedTemplate;
            } catch (_) { /* localStorage unavailable, keep default */ }
            templateOverride.addEventListener('input', () => {
                try { localStorage.setItem('batchExport.templateOverride', templateOverride.value); } catch (_) { /* noop */ }
            });
        }

        // v3.2.1 follow-up: refresh preview immediately when the user toggles
        // the LoRA underscore checkbox so they can see the difference in real
        // time. Also persist the choice so it survives modal close/reopen.
        const normalizeCheckbox = document.getElementById('batch-export-normalize-underscores');
        if (normalizeCheckbox) {
            try {
                const stored = localStorage.getItem('batchExport.normalizeUnderscores');
                if (stored === '0' || stored === 'false') normalizeCheckbox.checked = false;
                else if (stored === '1' || stored === 'true') normalizeCheckbox.checked = true;
            } catch (_) { /* localStorage unavailable, keep default */ }
            normalizeCheckbox.addEventListener('change', () => {
                try { localStorage.setItem('batchExport.normalizeUnderscores', normalizeCheckbox.checked ? '1' : '0'); } catch (_) { /* noop */ }
                this.refreshPreview();
            });
        }

        // P2-19 / P2-18: purpose filter + implication dedup re-render the
        // preview immediately and persist like the underscore checkbox, so a
        // recurring LoRA workflow keeps its setup across sessions.
        const purposeSelect = document.getElementById('batch-export-training-purpose');
        if (purposeSelect) {
            try {
                const storedPurpose = localStorage.getItem('batchExport.trainingPurpose');
                if (storedPurpose !== null) purposeSelect.value = storedPurpose;
            } catch (_) { /* localStorage unavailable, keep default */ }
            purposeSelect.addEventListener('change', () => {
                try { localStorage.setItem('batchExport.trainingPurpose', purposeSelect.value); } catch (_) { /* noop */ }
                this.refreshPreview();
            });
        }
        const implicationsCheckbox = document.getElementById('batch-export-dedupe-implications');
        if (implicationsCheckbox) {
            try {
                const storedDedupe = localStorage.getItem('batchExport.dedupeImplications');
                if (storedDedupe === '1' || storedDedupe === 'true') implicationsCheckbox.checked = true;
            } catch (_) { /* localStorage unavailable, keep default */ }
            implicationsCheckbox.addEventListener('change', () => {
                try { localStorage.setItem('batchExport.dedupeImplications', implicationsCheckbox.checked ? '1' : '0'); } catch (_) { /* noop */ }
                this.refreshPreview();
            });
        }

        // P1-17: trait-pruning checklist feeding the export blacklist.
        window.TraitPruner?.attach({
            button: document.getElementById('btn-export-trait-pruner'),
            textarea: document.getElementById('batch-export-blacklist'),
            separator: ', ',
            getSelectionToken: () => this.queueSelectionToken || this._getActiveSelectionTokenForExport(),
            getImageIds: () => this.queueImageIds.length
                ? this.queueImageIds
                : this._getExplicitSelectedImageIds(Infinity),
        });
    },

    /** v3.2.1 task #33: open the dedicated full-screen Caption Editor. */
    async openCaptionEditor() {
        const modal = document.getElementById('caption-editor-modal');
        if (!modal) return;
        modal.classList.add('visible');
        modal.style.display = 'flex';
        document.body.classList.add('modal-open');
        // If the inline preview hasn't been generated yet, fetch first; otherwise re-render in big container.
        if ((!this.queueImageIds || !this.queueImageIds.length) && (!this.previewResults || !this.previewResults.length)) {
            await this.refreshPreview();
        } else {
            this._renderPreviewWorkbench();
        }
        // P2-2 / P2-2b: keyboard shortcuts for caption editor
        this._captionEditorKeyHandler = (e) => this._handleCaptionEditorKey(e);
        document.addEventListener('keydown', this._captionEditorKeyHandler);
    },

    /** v3.2.1 task #33: close the editor. Edits are kept in this.editedCaptions. */
    closeCaptionEditor() {
        const modal = document.getElementById('caption-editor-modal');
        if (!modal) return;
        modal.classList.remove('visible');
        modal.style.display = '';
        if (!document.querySelector('.modal.visible')) {
            document.body.classList.remove('modal-open');
        }
        // Remove keyboard listener
        if (this._captionEditorKeyHandler) {
            document.removeEventListener('keydown', this._captionEditorKeyHandler);
            this._captionEditorKeyHandler = null;
        }
        // Re-render workbench in the small inline pane so the user sees their edits there too.
        this._renderPreviewWorkbench();
    },

    /** P2-2 / P2-2b: keyboard handler for caption editor modal */
    _handleCaptionEditorKey(e) {
        const modal = document.getElementById('caption-editor-modal');
        if (!modal || !modal.classList.contains('visible')) return;
        const inTextarea = e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT';

        if (e.key === 'Escape') {
            e.preventDefault();
            this.closeCaptionEditor();
            return;
        }
        // Ctrl+Enter / Cmd+Enter: save + next; Ctrl+Shift+Enter: save + prev
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this._navigateQueue(e.shiftKey ? -1 : 1);
            return;
        }
        // ArrowUp/ArrowDown without Ctrl: navigate queue (only when not typing in textarea)
        if (!inTextarea && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this._navigateQueue(e.key === 'ArrowUp' ? -1 : 1);
        }
    },

    /** Navigate to adjacent queue item by delta (-1 = prev, +1 = next) */
    async _navigateQueue(delta) {
        const total = this.queueTotalCount || this.queueImageIds.length;
        if (!total) return;
        const currentId = Number(this.activePreviewImageId);
        const curIdx = this.queueIndexById.has(currentId)
            ? this.queueIndexById.get(currentId)
            : Math.max(0, this.queueImageIds.indexOf(currentId));
        const nextIdx = Math.max(0, Math.min(total - 1, Number(curIdx || 0) + delta));
        const ids = await this._fetchQueueIdsWindow(nextIdx, 1);
        const newId = ids[0];
        if (newId == null || newId === Number(this.activePreviewImageId)) return;
        this.activePreviewImageId = newId;
        this.activePreviewIndex = nextIdx;
        this._onQueueItemClick(newId);
    },

    _getSelectionState() {
        const storeState = window.App?.SelectionStore?.getState?.();
        if (storeState) return storeState;
        const appState = window.App?.AppState;
        if (!appState) return null;
        return {
            selectedIds: appState.selectedIds,
            scope: appState.selectionScope,
            filterKey: appState.selectionFilterKey,
            selectionToken: appState.selectionToken,
            selectionTotal: appState.selectionTotal,
        };
    },

    _getExplicitSelectedImageIds(cap = Infinity) {
        const state = this._getSelectionState();
        const source = state?.selectedIds;
        const ids = source instanceof Set
            ? Array.from(source)
            : Array.isArray(source)
                ? source
                : Array.from(source || []);
        return ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .slice(0, cap);
    },

    _getActiveSelectionTokenForExport() {
        const state = this._getSelectionState();
        const token = state?.selectionToken;
        if ((state?.scope || 'visible') !== 'filtered' || !token) {
            return null;
        }
        if (typeof window.App?.isFilteredSelectionActiveForCurrentFilters === 'function') {
            return window.App.isFilteredSelectionActiveForCurrentFilters() ? token : null;
        }
        return token;
    },

    _getLoadedGalleryImageIds(cap = Infinity) {
        const state = window.App?.AppState || window.AppState || {};
        const rows = Array.isArray(state.images) ? state.images : [];
        return rows
            .map((item) => Number(item?.id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .slice(0, cap);
    },

    _selectionTotalFromState() {
        const state = this._getSelectionState();
        const total = Number(state?.selectionTotal ?? window.App?.AppState?.selectionTotal ?? 0);
        return Number.isFinite(total) && total > 0 ? total : 0;
    },

    _rememberQueueIds(ids, startIndex = 0) {
        ids.forEach((rawId, offset) => {
            const id = Number(rawId);
            if (!Number.isFinite(id) || id <= 0) return;
            const index = startIndex + offset;
            this.queueIdByIndex.set(index, id);
            this.queueIndexById.set(id, index);
        });
    },

    async _fetchQueueIdsWindow(startIndex = 0, limit = 80) {
        const start = Math.max(0, Number(startIndex) || 0);
        const size = Math.max(1, Math.min(Number(limit) || 80, 500));
        if (!this.queueSelectionToken || !window.App?.API?.getSelectionChunk) {
            return this.queueImageIds.slice(start, start + size);
        }
        const missing = [];
        const knownTotal = this.queueTotalCount || (start + size);
        for (let i = start; i < start + size && i < knownTotal; i += 1) {
            if (!this.queueIdByIndex.has(i)) missing.push(i);
        }
        if (missing.length) {
            const fetchStart = Math.max(0, missing[0]);
            const fetchLimit = Math.min(500, Math.max(size, missing[missing.length - 1] - fetchStart + 1));
            const chunk = await window.App.API.getSelectionChunk(this.queueSelectionToken, {
                offset: fetchStart,
                limit: fetchLimit,
            });
            const ids = Array.isArray(chunk?.image_ids) ? chunk.image_ids : [];
            this._rememberQueueIds(ids, fetchStart);
            const total = Number(chunk?.total ?? chunk?.count ?? 0);
            if (Number.isFinite(total) && total > 0) this.queueTotalCount = total;
        }
        const out = [];
        const readTotal = this.queueTotalCount || (start + size);
        for (let i = start; i < start + size && i < readTotal; i += 1) {
            const id = this.queueIdByIndex.get(i);
            if (id) out.push(id);
        }
        return out;
    },

    async _loadQueueSource() {
        this.queueSelectionToken = null;
        this.queueIdByIndex = new Map();
        this.queueIndexById = new Map();
        this.queueSourceMode = 'ids';

        const selectionToken = this._getActiveSelectionTokenForExport();
        if (selectionToken && window.App?.API?.getSelectionChunk) {
            this.queueSelectionToken = selectionToken;
            this.queueSourceMode = 'token';
            this.queueTotalCount = this._selectionTotalFromState();
            const firstIds = await this._fetchQueueIdsWindow(0, 80);
            this.queueImageIds = firstIds;
            if (!this.queueTotalCount) this.queueTotalCount = firstIds.length;
            return {
                mode: 'token',
                token: selectionToken,
                firstIds,
                total: this.queueTotalCount,
            };
        }

        const ids = this._getExplicitSelectedImageIds(Infinity);
        this.queueImageIds = ids;
        this._rememberQueueIds(ids, 0);
        this.queueTotalCount = ids.length;
        return { mode: 'ids', ids, firstIds: ids.slice(0, 80), total: ids.length };
    },

    async _resolveSelectionImageIds({ cap = 500, allowLoadedFallback = false } = {}) {
        const normalizedCap = Math.max(1, Math.min(Number(cap) || 500, 5000));
        if (this.queueSelectionToken) {
            return this._fetchQueueIdsWindow(0, normalizedCap);
        }
        const selectedIds = this._getExplicitSelectedImageIds(normalizedCap);
        if (selectedIds.length) return selectedIds;
        return allowLoadedFallback ? this._getLoadedGalleryImageIds(normalizedCap) : [];
    },

    async refreshPreview() {
        // v3.2.1 task #33: target the editor modal's container if it's open
        const editorOpen = document.getElementById('caption-editor-modal')?.classList.contains('visible');
        const targetId = editorOpen ? 'caption-editor-list' : 'export-preview-list';
        const list = document.getElementById(targetId);
        if (!list) return;
        const i18n = (key, fallback) => { const v = window.I18n?.t?.(key); return (v && v !== key) ? v : fallback; };

        const contentMode = document.getElementById('batch-export-content-mode')?.value;
        const source = await this._loadQueueSource();
        const ids = source.firstIds || source.ids || [];
        if (!ids.length) {
            list.style.display = 'block';
            list.innerHTML = `<p style="padding:12px;text-align:center;color:var(--text-muted)">${i18n('batchExport.previewNoSelection', 'No images selected. Select images in Gallery first.')}</p>`;
            return;
        }

        const opts = this._previewOptionsForContentMode(contentMode);

        list.style.display = 'block';
        list.innerHTML = `<p style="padding:8px;color:var(--text-muted)">${i18n('batchExport.previewRendering', 'Rendering preview…')}</p>`;

        // Set active image if not already in queue
        if (!this.activePreviewImageId || !this.queueIndexById.has(Number(this.activePreviewImageId))) {
            this.activePreviewImageId = ids[0] || null;
            this.activePreviewIndex = 0;
        }

        // Fetch captions for a small initial batch via export-preview (also gives us metadata)
        const initialBatch = ids.slice(0, 50);
        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: initialBatch, ...opts }),
            });
            if (!r.ok) {
                list.innerHTML = `<p style="padding:8px;color:var(--accent-danger)">Preview failed: HTTP ${r.status}</p>`;
                return;
            }
            const data = await r.json();
            for (const item of (data.results || [])) {
                this.previewCache.set(item.image_id, item.rendered || '');
                this.previewMetadata.set(item.image_id, { filename: item.filename || '', thumbnail_path: item.thumbnail_path || '' });
                this._seedNlFromPreviewItem(item);
            }
        } catch (e) {
            list.innerHTML = `<p style="padding:8px;color:var(--accent-danger)">Preview error: ${e.message}</p>`;
            return;
        }

        // Build legacy previewResults for compat with diagnostics/common-tags
        this.previewResults = initialBatch.map(id => {
            const meta = this.previewMetadata.get(id);
            return { image_id: id, filename: meta?.filename || '', rendered: this.previewCache.get(id) || '' };
        });

        this._renderPreviewWorkbench();
    },

    _getCurrentExportOptions() {
        const contentMode = document.getElementById('batch-export-content-mode')?.value || 'tags';
        return this._previewOptionsForContentMode(contentMode);
    },

    _previewOptionsForContentMode(contentMode) {
        // v3.2.1 follow-up: read the underscore checkbox once so both
        // template and non-template preview paths agree with the actual
        // export. The checkbox is the single source of truth for the
        // LoRA-friendly underscore convention.
        const normalizeCheckbox = document.getElementById('batch-export-normalize-underscores');
        const normalize = normalizeCheckbox ? normalizeCheckbox.checked : true;

        if (contentMode === 'template') {
            const opts = this.collectTemplateOptions();
            const transforms = this.collectCaptionTransforms();
            if (transforms) opts.caption_transforms = transforms;
            // For template mode the preset itself decides; only override
            // when the user explicitly toggles the checkbox to FALSE
            // (forces raw underscores for Pony / NoobAI workflows).
            if (!normalize) {
                opts.underscore_to_space_override = false;
                opts.preserve_underscore_prefixes_override = ['score_'];
            }
            this._applyTrainingFilterOptions(opts);
            return opts;
        }
        // P1-7 preview unification: non-template modes send the real
        // content_mode so the backend previews through build_sidecar_content —
        // the exact engine the export writes with. (Previously this built a
        // template that only approximated each mode, so the preview could
        // disagree with the exported sidecar.)
        const blacklistText = document.getElementById('batch-export-blacklist')?.value || '';
        const prefix = document.getElementById('batch-export-prefix')?.value || '';
        const blacklist = blacklistText.split(',').map(s => s.trim()).filter(Boolean);
        const opts = {
            content_mode: contentMode,
            prefix,
            blacklist,
            normalize_tag_underscores: normalize,
        };
        const transforms = this.collectCaptionTransforms();
        if (transforms) opts.caption_transforms = transforms;
        this._applyTrainingFilterOptions(opts);
        return opts;
    },

    /** P2-19 / P2-18: inject the training-purpose filter + implication-dedup
     *  flags into a preview/export options object. Single seam so every
     *  preview path stays WYSIWYG with the actual export payload. */
    _applyTrainingFilterOptions(opts) {
        const purpose = document.getElementById('batch-export-training-purpose')?.value || '';
        if (purpose) opts.training_purpose = purpose;
        if (document.getElementById('batch-export-dedupe-implications')?.checked) {
            opts.dedupe_implications = true;
        }
        return opts;
    },

    _renderPreviewWorkbench() {
        // v3.2.1 task #33: when the dedicated Caption Editor modal is open we
        // render the workbench INSIDE that modal instead of the small inline
        // preview, so the editor textarea has plenty of room. The inline
        // preview pane stays cleared while the editor is open to avoid
        // confusing dual UIs.
        const editorOpen = document.getElementById('caption-editor-modal')?.classList.contains('visible');
        const targetId = editorOpen ? 'caption-editor-list' : 'export-preview-list';
        const list = document.getElementById(targetId);
        if (!list) return;

        // v3.2.2 (issue #5 point 2): preserve the queue list's scroll position
        // across re-renders. Each click on a queue item used to call
        // _renderPreviewWorkbench, which destroyed the .export-preview-queue-list
        // div via list.innerHTML='' and rebuilt it from scratch with
        // scrollTop=0, so the user lost their scroll position every click.
        // Save the scroll position from the previous render before the wipe.
        let savedScrollTop = 0;
        if (this._queueScrollContainer && document.body.contains(this._queueScrollContainer)) {
            savedScrollTop = this._queueScrollContainer.scrollTop || 0;
        }

        list.innerHTML = '';

        // Also clear the OTHER container so we don't end up with duplicate stale workbenches.
        const otherId = editorOpen ? 'export-preview-list' : 'caption-editor-list';
        const otherList = document.getElementById(otherId);
        if (otherList) {
            if (editorOpen) {
                // While editor is open, hint the user that edits live in the popup.
                otherList.innerHTML = `<p style="padding:12px;text-align:center;color:var(--text-muted)">${this._i18n('batchExport.editorOpenHint', 'Editing in the Caption Editor window — close it to return.')}</p>`;
            } else {
                otherList.innerHTML = '';
            }
        }

        const hasItems = this.queueImageIds.length || this.previewResults.length;
        if (!hasItems) {
            list.innerHTML = '<p style="padding:12px;text-align:center;color:var(--text-muted)">No preview rows.</p>';
            return;
        }

        const workbench = document.createElement('div');
        workbench.className = 'export-preview-workbench';
        if (editorOpen) {
            workbench.classList.add('export-preview-workbench--full');
        }
        workbench.append(
            this._buildPreviewQueue(),
            this._buildPreviewEditor(),
            this._buildPreviewTools(),
        );
        const note = document.createElement('div');
        note.className = 'export-preview-save-note';
        note.textContent = this._i18n(
            'batchExport.previewTemporaryNote',
            'Temporary edits: nothing is auto-saved to images or the database. Export / Copy / Download uses these edits.'
        );
        list.append(note, workbench);

        // v3.2.2 (issue #5 point 2): restore the queue scroll position now
        // that the new ``.export-preview-queue-list`` body exists in the DOM.
        // The new body was created by ``_buildPreviewQueue`` and stored on
        // ``this._queueScrollContainer``; setting its scrollTop also triggers
        // the virtual-scroll renderVisible() so the right slice of items
        // appears immediately at the restored position.
        if (savedScrollTop > 0 && this._queueScrollContainer) {
            this._queueScrollContainer.scrollTop = savedScrollTop;
            if (typeof this._queueRenderVisible === 'function') {
                requestAnimationFrame(() => this._queueRenderVisible());
            }
        }
    },
});
