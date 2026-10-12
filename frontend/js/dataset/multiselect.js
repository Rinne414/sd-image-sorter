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
        const importSelectAll = document.getElementById('btn-dataset-import-select-all');
        if (importSelectAll) {
            importSelectAll.disabled = this.imageIds.length === 0 || count >= this.imageIds.length;
        }
        const queueSelectAll = document.getElementById('btn-dataset-queue-select-all');
        if (queueSelectAll) {
            const shown = this._queueShownIdList();
            queueSelectAll.disabled = shown.length === 0
                || shown.every((id) => this._queueSelection.has(Number(id)));
        }
        if (this._captionScope?.() === 'selected') this._renderCaptionScopeSummary();
    };

    DM._toggleQueueSelection = function (id) {
        const n = Number(id);
        if (!this.imageIds.includes(n)) return;
        if (this._queueSelection.has(n)) this._queueSelection.delete(n);
        else this._queueSelection.add(n);
        this._lastClickedId = n;
        this._updateMultiSelectUI();
    };

    // The queue's Select all takes only the images its filter shows; the
    // import grid (no filter) passes every queued image.
    DM._selectAllQueue = function (ids = this._queueIdsForCurrentFilter()) {
        this._queueSelection = new Set(ids.map(Number));
        this._lastClickedId = ids.length ? Number(ids[ids.length - 1]) : null;
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

        this._supersedeCaptionFetch?.();
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
            // NL/type maps too — deterministic local ids resurface leaked
            // entries on re-import (2026-07 pin-sweep finding #2).
            this.nlCaptions?.delete?.(id);
            this.nlEdits?.delete?.(id);
            this.captionType?.delete?.(id);
            if (this.localItemPaths && this.isLocalId && this.isLocalId(id)) {
                this.localItemPaths.delete(id);
                this.localItemDsIds?.delete?.(id);
            }
        }
        this._queueSelection.clear();
        if (this.activeId != null && !this.imageIds.includes(Number(this.activeId))) {
            // First image the queue shows; the full order when it shows none.
            const first = this._queueIdsForCurrentFilter()[0] ?? this.imageIds[0];
            this.activeId = first != null ? Number(first) : null;
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
        document.getElementById('btn-dataset-queue-select-all')
            ?.addEventListener('click', () => this._selectAllQueue());
        document.getElementById('btn-dataset-import-select-all')
            ?.addEventListener('click', () => this._selectAllQueue(this.imageIds));
        for (const id of ['btn-dataset-queue-clear-selection', 'btn-dataset-import-clear-selection']) {
            document.getElementById(id)?.addEventListener('click', () => this._clearQueueSelection());
        }
        for (const id of ['btn-dataset-queue-remove-selected', 'btn-dataset-import-remove-selected']) {
            document.getElementById(id)?.addEventListener('click', () => this._removeSelectedImages());
        }
        this._setSelectionSummary();
    };

    DM._handleMultiSelectClick = function (id, e) {
        // A range covers what the filtered queue shows between the two clicks,
        // never the hidden images in between; an anchor the filter hides is no
        // anchor, so that click acts as a plain toggle.
        const shown = e.shiftKey && this._lastClickedId != null ? this._queueIdsForCurrentFilter() : [];
        const startIdx = shown.indexOf(Number(this._lastClickedId));
        const endIdx = shown.indexOf(Number(id));
        if (startIdx >= 0 && endIdx >= 0) {
            const lo = Math.min(startIdx, endIdx);
            const hi = Math.max(startIdx, endIdx);
            for (let i = lo; i <= hi; i++) {
                this._queueSelection.add(shown[i]);
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
            this._openAddTagField(bar);
        });
    };

    // The tag field opens inside the selection bar (no window.prompt). Typing
    // "a, b" adds each piece as its own tag. An image that already has a tag
    // (same _normalizeTagKey) is left alone for that tag.
    DM._openAddTagField = function (bar) {
        if (bar.querySelector('#dataset-multisel-tag-form')) return;
        const form = document.createElement('form');
        form.id = 'dataset-multisel-tag-form';
        form.className = 'dataset-multisel-tag-form';
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'dataset-multisel-tag-input';
        input.className = 'form-input';
        input.autocomplete = 'off';
        input.placeholder = this._t('dataset.multiAddTagPrompt', 'Tag to add:');
        input.setAttribute('aria-label', input.placeholder);
        const confirm = document.createElement('button');
        confirm.type = 'submit';
        confirm.className = 'btn btn-small btn-primary';
        confirm.textContent = this._t('dataset.multiAddTagConfirm', 'Add');
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn btn-small btn-ghost';
        cancel.textContent = this._t('dataset.multiAddTagCancel', 'Cancel');
        form.append(input, confirm, cancel);
        bar.appendChild(form);
        input.focus();
        cancel.addEventListener('click', () => form.remove());
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            form.remove();
        });
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const tags = input.value.split(',').map((t) => t.trim()).filter(Boolean);
            if (tags.length === 0) return;
            form.remove();
            this._addTagsToSelection(tags);
        });
    };

    DM._addTagsToSelection = function (tags) {
        const unique = [];
        const seen = new Set();
        for (const tag of tags) {
            const key = this._normalizeTagKey(tag);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            unique.push(tag);
        }
        let changed = 0;
        let alreadyHad = 0;
        for (const sid of this._queueSelection) {
            const current = this.captionEdits.has(sid)
                ? this.captionEdits.get(sid)
                : (this.captions.get(sid) || '');
            const have = new Set(String(current).split(',').map((p) => this._normalizeTagKey(p)));
            const missing = unique.filter((t) => !have.has(this._normalizeTagKey(t)));
            if (missing.length === 0) {
                alreadyHad += 1;
                continue;
            }
            const base = String(current).trim().replace(/,\s*$/, '');
            this.captionEdits.set(sid, base ? base + ', ' + missing.join(', ') : missing.join(', '));
            changed += 1;
        }
        this._queueSelection.clear();
        this._updateMultiSelectUI();
        this._renderQueue();
        if (this.activeId != null) this._setActive(this.activeId);
        this._toast(this._t('dataset.multiAddTagResult',
            'Added the tag to {added} images, {skipped} already had it',
            { added: changed, skipped: alreadyHad }), changed > 0 ? 'success' : 'info');
        if (changed > 0) this._saveSession?.();
    };
})();
