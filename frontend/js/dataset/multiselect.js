/**
 * Dataset Maker — queue multi-select: selection summary, toggle/select-all/clear, remove-selected, shift/ctrl click, #dataset-multiselect-bar.
 * Moved VERBATIM from dataset-maker-part2.js L645-834.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---------- Queue multi-select ----------
    DM._selectionSummaryText = function (count = this._queueSelection.size) {
        const formatted = Number(count || 0).toLocaleString();
        return this._t('dataset.selectionCount', '{count} selected', { count: formatted })
            .replace(/\{count\}/g, formatted);
    };

    DM._setSelectionSummary = function () {
        const count = this._queueSelection.size;
        const text = this._selectionSummaryText(count);
        for (const id of ['dataset-queue-selection-summary', 'dataset-import-selection-summary']) {
            const el = document.getElementById(id);
            if (el) {
                el.removeAttribute('data-i18n');
                el.textContent = text;
            }
        }
        for (const id of [
            'btn-dataset-queue-clear-selection',
            'btn-dataset-import-clear-selection',
            'btn-dataset-queue-remove-selected',
            'btn-dataset-import-remove-selected',
        ]) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = count === 0;
        }
        for (const id of ['btn-dataset-queue-select-all', 'btn-dataset-import-select-all']) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = this.imageIds.length === 0 || count >= this.imageIds.length;
        }
    };

    DM._toggleQueueSelection = function (id) {
        const n = Number(id);
        if (!this.imageIds.includes(n)) return;
        if (this._queueSelection.has(n)) this._queueSelection.delete(n);
        else this._queueSelection.add(n);
        this._lastClickedId = n;
        this._updateMultiSelectUI();
    };

    DM._selectAllQueue = function () {
        this._queueSelection = new Set(this.imageIds.map(Number));
        this._lastClickedId = this.imageIds.length ? Number(this.imageIds[this.imageIds.length - 1]) : null;
        this._updateMultiSelectUI();
    };

    DM._clearQueueSelection = function () {
        this._queueSelection.clear();
        this._updateMultiSelectUI();
    };

    DM._removeSelectedImages = function () {
        const selected = Array.from(this._queueSelection).map(Number);
        if (selected.length === 0) return;
        const msg = this._t('dataset.confirmRemoveSelected',
            'Remove {count} selected images from the dataset? Original files are not affected.',
            { count: selected.length });
        if (!window.confirm(msg)) return;

        const removeSet = new Set(selected);
        this.imageIds = this.imageIds.filter((id) => !removeSet.has(Number(id)));
        for (const id of selected) {
            if (this.isLocalId?.(id)) this._markLocalManifestExcluded?.(id);
            this.captions.delete(id);
            if (typeof this._deleteCaptionEditForDatasetRemoval === 'function') {
                this._deleteCaptionEditForDatasetRemoval(id);
            } else {
                this.captionEdits.delete(id);
            }
            this._undoStacks?.delete?.(id);
            if (this.localItemPaths && this.isLocalId && this.isLocalId(id)) {
                this.localItemPaths.delete(id);
                this.localItemDsIds?.delete?.(id);
            }
        }
        this._queueSelection.clear();
        if (this.activeId != null && !this.imageIds.includes(Number(this.activeId))) {
            this.activeId = this.imageIds.length ? Number(this.imageIds[0]) : null;
        }
        this._renderQueue();
        this._renderImportGallery?.();
        this._updateCount();
        this._updateExportEnabled();
        this._updateMultiSelectUI();
        if (this.activeId != null) this._setActive(this.activeId);
        else this._renderEmptyEditor();
        this._saveSession?.();
    };

    DM._initQueueSelectionControls = function () {
        for (const id of ['btn-dataset-queue-select-all', 'btn-dataset-import-select-all']) {
            document.getElementById(id)?.addEventListener('click', () => this._selectAllQueue());
        }
        for (const id of ['btn-dataset-queue-clear-selection', 'btn-dataset-import-clear-selection']) {
            document.getElementById(id)?.addEventListener('click', () => this._clearQueueSelection());
        }
        for (const id of ['btn-dataset-queue-remove-selected', 'btn-dataset-import-remove-selected']) {
            document.getElementById(id)?.addEventListener('click', () => this._removeSelectedImages());
        }
        this._setSelectionSummary();
    };

    DM._handleMultiSelectClick = function (id, e) {
        if (e.shiftKey && this._lastClickedId != null) {
            const startIdx = this.imageIds.indexOf(Number(this._lastClickedId));
            const endIdx = this.imageIds.indexOf(Number(id));
            if (startIdx >= 0 && endIdx >= 0) {
                const lo = Math.min(startIdx, endIdx);
                const hi = Math.max(startIdx, endIdx);
                for (let i = lo; i <= hi; i++) {
                    this._queueSelection.add(this.imageIds[i]);
                }
            }
        } else {
            // Ctrl/Cmd+click toggles individual
            if (this._queueSelection.has(id)) {
                this._queueSelection.delete(id);
            } else {
                this._queueSelection.add(id);
            }
        }
        this._lastClickedId = id;
        this._updateMultiSelectUI();
    };

    DM._updateMultiSelectUI = function () {
        const list = document.getElementById('dataset-queue-list');
        if (list) {
            for (const el of list.querySelectorAll('.dataset-queue-item')) {
                const selected = this._queueSelection.has(Number(el.dataset.imageId));
                el.classList.toggle('multi-selected', selected);
                const toggle = el.querySelector('.dataset-queue-select-toggle');
                if (toggle) toggle.setAttribute('aria-checked', selected ? 'true' : 'false');
            }
        }
        const importGrid = document.getElementById('dataset-import-gallery-grid');
        if (importGrid) {
            for (const el of importGrid.querySelectorAll('.import-thumb')) {
                el.classList.toggle('multi-selected',
                    this._queueSelection.has(Number(el.dataset.imageId)));
            }
        }
        this._setSelectionSummary();
        let bar = document.getElementById('dataset-multiselect-bar');
        if (this._queueSelection.size === 0) {
            if (bar) bar.hidden = true;
            return;
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'dataset-multiselect-bar';
            bar.className = 'dataset-multiselect-bar';
            const queuePane = document.querySelector('#view-dataset .dataset-queue-pane');
            if (queuePane) queuePane.appendChild(bar);
        }
        bar.hidden = false;
        const n = this._queueSelection.size;
        bar.innerHTML = `
            <button type="button" class="btn btn-small btn-secondary" id="btn-multisel-remove">
                ${this._t('dataset.multiRemove', 'Remove {count} selected', { count: n })}
            </button>
            <button type="button" class="btn btn-small btn-ghost" id="btn-multisel-addtag">
                ${this._t('dataset.multiAddTag', 'Add tag to {count} selected', { count: n })}
            </button>
        `;
        bar.querySelector('#btn-multisel-remove').addEventListener('click', () => {
            this._removeSelectedImages();
        });
        bar.querySelector('#btn-multisel-addtag').addEventListener('click', () => {
            const tag = prompt(this._t('dataset.multiAddTagPrompt', 'Tag to add:'));
            if (!tag || !tag.trim()) return;
            const t = tag.trim();
            for (const sid of this._queueSelection) {
                const current = this.captionEdits.has(sid)
                    ? this.captionEdits.get(sid)
                    : (this.captions.get(sid) || '');
                const updated = current ? current + ', ' + t : t;
                this.captionEdits.set(sid, updated);
            }
            this._queueSelection.clear();
            this._updateMultiSelectUI();
            this._renderQueue();
            if (this.activeId != null) this._setActive(this.activeId);
            this._toast(this._t('dataset.multiAddTagDone',
                'Added tag to {count} images', { count: n }), 'success');
            this._saveSession?.();
        });
    };
})();
