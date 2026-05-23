/**
 * Dataset Maker — local folder-import (T7b, "small gallery" frontend).
 *
 * Adds direct folder-import to Dataset Maker so the user can build a
 * LoRA training set from a folder of images WITHOUT first registering
 * those images in the main library DB. Items added this way are
 * "local-source" and live entirely in the Dataset Maker session.
 *
 * Implementation strategy
 * -----------------------
 * Local items get a NEGATIVE pseudo-ID derived from the ``ds_id``
 * returned by ``POST /api/dataset/folder-scan``. Negative IDs never
 * collide with the gallery's positive int row IDs, which lets the
 * existing ``imageIds: number[]`` array work for both sources without
 * a schema rewrite.
 *
 * The places that previously called ``/api/image-thumbnail/{id}`` or
 * ``/api/tags/export-preview`` with image IDs are wrapped here to
 * branch on ``id < 0``:
 *   - thumbnail render uses ``data:image/jpeg;base64,<thumb_b64>``
 *   - meta + caption fetch is skipped (local items are fully populated
 *     by the scan response; captions live in localStorage)
 *   - export request splits positive IDs (image_ids) from negative IDs
 *     (resolved to ``abs_path`` and shipped as ``image_paths``); user
 *     edits for local items are sent as path-keyed ``image_overrides``.
 *
 * Caption persistence for local items
 * -----------------------------------
 * Edits land in ``localStorage`` keyed by absolute path. Re-importing
 * the same folder restores the user's captions because the ``ds_id``
 * is deterministic (sha1(abs_path)) and the path-keyed localStorage
 * entry is the same.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const LOCAL_CAPTIONS_KEY = 'sd-image-sorter-dataset-local-captions';

    /** Local-only state (in addition to the shared ``imageIds`` / ``meta``). */
    DM.localItemPaths = DM.localItemPaths || new Map();   // negative id -> abs_path
    DM.localItemDsIds = DM.localItemDsIds || new Map();   // negative id -> ds_id (for completeness)

    /** Negative-id helper: true iff the supplied id refers to a local-source item. */
    DM.isLocalId = function (id) {
        return Number(id) < 0;
    };

    /** Convert backend ``ds_id`` ("ds:abc123...") to a stable negative integer id. */
    DM._dsIdToNumericId = function (dsId) {
        const hex = String(dsId || '').replace(/^ds:/, '').slice(0, 8);
        let n = parseInt(hex, 16);
        if (!Number.isFinite(n) || n <= 0) {
            // Fallback: hash the ds_id string with a small djb2 so we
            // still get a unique negative id even if the format shifts.
            let h = 5381;
            for (let i = 0; i < (dsId || '').length; i++) {
                h = ((h << 5) + h + dsId.charCodeAt(i)) | 0;
            }
            n = Math.abs(h) || 1;
        }
        return -((n & 0x7fffffff) || 1);
    };

    // -------- localStorage caption persistence (path-keyed) --------

    DM._loadLocalCaptions = function () {
        try {
            const raw = localStorage.getItem(LOCAL_CAPTIONS_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch { return {}; }
    };

    DM._saveLocalCaption = function (absPath, caption) {
        if (!absPath) return;
        const all = DM._loadLocalCaptions();
        if (caption == null || caption === '') {
            delete all[absPath];
        } else {
            all[absPath] = String(caption);
        }
        try { localStorage.setItem(LOCAL_CAPTIONS_KEY, JSON.stringify(all)); }
        catch { /* quota or sandbox; non-fatal */ }
    };

    DM._clearLocalCaption = function (absPath) {
        DM._saveLocalCaption(absPath, '');
    };

    // -------- Add local items from folder-scan response --------

    /**
     * Ingest folder-scan items into the queue. Each item is the shape
     * returned by ``POST /api/dataset/folder-scan``: ``{ds_id, abs_path,
     * filename, width, height, mtime, size, thumb_b64}``.
     *
     * Returns the number of NEW items added (after dedup).
     */
    DM.addLocalItems = function (items, options = {}) {
        const switchView = options.switchView !== false;
        const showToast = options.showToast !== false;

        const before = this.imageIds.length;
        const localCaptions = this._loadLocalCaptions();

        for (const item of (items || [])) {
            const dsId = String(item.ds_id || '');
            if (!dsId.startsWith('ds:')) continue;
            const numericId = this._dsIdToNumericId(dsId);
            const absPath = String(item.abs_path || '');
            if (!absPath) continue;
            if (this.imageIds.includes(numericId)) {
                // Already in the queue (could happen on a re-scan); update
                // meta in place but don't double-count.
                continue;
            }
            this.imageIds.push(numericId);
            this.localItemPaths.set(numericId, absPath);
            this.localItemDsIds.set(numericId, dsId);
            this.meta.set(numericId, {
                source: 'local',
                ds_id: dsId,
                abs_path: absPath,
                filename: item.filename || '',
                thumbnail_path: '',
                thumb_b64: item.thumb_b64 || '',
                width: Number(item.width || 0),
                height: Number(item.height || 0),
                mtime: Number(item.mtime || 0),
                size: Number(item.size || 0),
            });
            // Restore any saved caption for this path so re-imports
            // pick the user's previous edit back up.
            const saved = localCaptions[absPath];
            if (saved) {
                this.captionEdits.set(numericId, saved);
            }
        }

        const added = this.imageIds.length - before;
        this._renderQueue();
        this._updateCount();
        this._updateExportEnabled();
        if (this.activeId == null && this.imageIds.length) {
            this._setActive(this.imageIds[0]);
        }

        if (switchView && added > 0 && typeof window.switchView === 'function') {
            try { window.switchView('dataset'); } catch { /* ignore */ }
        }
        if (showToast) {
            if (added > 0) {
                this._toast(this._t('dataset.folderImportAdded',
                    'Added {count} local images (not added to main gallery)',
                    { count: added }), 'success');
            } else {
                this._toast(this._t('dataset.folderImportEmpty',
                    'No new images found in that folder.'), 'info');
            }
        }
        return added;
    };

    // -------- Queue + editor patches: render local thumbs from base64 --------

    const original_buildQueueItem = DM._buildQueueItem;
    DM._buildQueueItem = function (id) {
        const node = original_buildQueueItem.call(this, id);
        if (!this.isLocalId(id)) return node;
        // Replace the ``/api/image-thumbnail/{id}`` request (which would 404
        // for negative ids) with the inline base64 thumb from scan.
        const meta = this.meta.get(id) || {};
        const img = node.querySelector('img.dataset-queue-thumb');
        if (img && meta.thumb_b64) {
            img.src = `data:image/jpeg;base64,${meta.thumb_b64}`;
        }
        // Tag the item visually so the user can tell local vs gallery
        // apart at a glance.
        node.classList.add('source-local');
        const idLabel = node.querySelector('.dataset-queue-id');
        if (idLabel) idLabel.textContent = '📁 ' + (meta.filename || '').slice(-40);
        return node;
    };

    const original_setActive = DM._setActive;
    DM._setActive = function (imageId) {
        const id = Number(imageId);
        if (!this.isLocalId(id)) {
            return original_setActive.call(this, id);
        }
        // Local-source path: render inline base64 thumb in the editor.
        if (!this.imageIds.includes(id)) return;
        this.activeId = id;
        const meta = this.meta.get(id) || {};
        const filename = meta.filename || `(local image)`;

        const img = document.getElementById('dataset-editor-image');
        const empty = document.getElementById('dataset-editor-empty');
        const ta = document.getElementById('dataset-editor-textarea');
        const actions = document.getElementById('dataset-editor-actions');
        const filenameEl = document.getElementById('dataset-editor-filename');

        if (img) {
            // Use the scan thumbnail at 256 px — good enough for the editor
            // pane. We deliberately don't fetch the full image to avoid
            // streaming 10+ MB raw files into the DOM for 100-image queues.
            img.src = meta.thumb_b64
                ? `data:image/jpeg;base64,${meta.thumb_b64}`
                : '';
            img.alt = filename;
            img.hidden = false;
        }
        if (empty) empty.hidden = true;
        if (filenameEl) filenameEl.textContent = `📁 ${filename}`;

        const caption = this.captionEdits.has(id)
            ? this.captionEdits.get(id)
            : (this.captions.get(id) || '');
        if (ta) {
            ta.value = caption;
            ta.hidden = false;
        }
        if (actions) actions.hidden = false;

        this._highlightActiveQueueItem();
    };

    // -------- Skip backend fetches for local items --------

    const original_fetchMissingMeta = DM._fetchMissingMeta;
    DM._fetchMissingMeta = async function () {
        // Filter out local ids before delegating to the original backend
        // round-trip; local items are fully populated by the scan response.
        const realImageIds = this.imageIds.filter((id) => !this.isLocalId(id));
        const previous = this.imageIds;
        this.imageIds = realImageIds;
        try {
            await original_fetchMissingMeta.call(this);
        } finally {
            this.imageIds = previous;
        }
    };

    const original_fetchMissingCaptions = DM._fetchMissingCaptions;
    DM._fetchMissingCaptions = async function () {
        // Same trick: backend caption fetch only applies to gallery items.
        const realImageIds = this.imageIds.filter((id) => !this.isLocalId(id));
        const previous = this.imageIds;
        this.imageIds = realImageIds;
        try {
            await original_fetchMissingCaptions.call(this);
        } finally {
            this.imageIds = previous;
        }
    };

    const original_refreshAllCaptions = DM._refreshAllCaptions;
    DM._refreshAllCaptions = async function () {
        const realImageIds = this.imageIds.filter((id) => !this.isLocalId(id));
        const previous = this.imageIds;
        this.imageIds = realImageIds;
        try {
            await original_refreshAllCaptions.call(this);
        } finally {
            this.imageIds = previous;
        }
    };

    // -------- Caption edits: persist local-source edits to localStorage --------

    // The textarea input handler in dataset-maker.js writes to
    // ``captionEdits.set(id, ta.value)``. We monkey-patch ``set`` so any
    // local-source entry also lands in localStorage. Patching the
    // CaptionEdits Map via a property hook keeps the existing call sites
    // (revert, refresh, render) untouched.
    const original_captionEdits_set = DM.captionEdits.set.bind(DM.captionEdits);
    DM.captionEdits.set = function (id, val) {
        const result = original_captionEdits_set(id, val);
        if (DM.isLocalId(id)) {
            const absPath = DM.localItemPaths.get(Number(id));
            if (absPath) DM._saveLocalCaption(absPath, val);
        }
        return result;
    };
    const original_captionEdits_delete = DM.captionEdits.delete.bind(DM.captionEdits);
    DM.captionEdits.delete = function (id) {
        if (DM.isLocalId(id)) {
            const absPath = DM.localItemPaths.get(Number(id));
            if (absPath) DM._clearLocalCaption(absPath);
        }
        return original_captionEdits_delete(id);
    };

    // -------- Removing items: clean up local maps --------

    const original_removeActive = DM._removeActive;
    DM._removeActive = function () {
        const id = Number(this.activeId);
        const wasLocal = this.isLocalId(id);
        original_removeActive.call(this);
        if (wasLocal) {
            this.localItemPaths.delete(id);
            this.localItemDsIds.delete(id);
            // captionEdits.delete (above) already cleared localStorage.
        }
    };

    const original_clearAll = DM._clearAll;
    DM._clearAll = function () {
        const localPathsBefore = Array.from(this.localItemPaths.values());
        original_clearAll.call(this);
        // If the user actually confirmed, the imageIds is now [] — drop
        // local maps + localStorage. If they cancelled, imageIds still
        // has entries; bail out without touching anything.
        if (this.imageIds.length === 0 && localPathsBefore.length) {
            this.localItemPaths.clear();
            this.localItemDsIds.clear();
            try { localStorage.removeItem(LOCAL_CAPTIONS_KEY); } catch { /* */ }
        }
    };

    // -------- Export: split into image_ids + image_paths + path overrides --------

    const original_runExport = DM._runExport;
    DM._runExport = async function () {
        // If no local items present, the original path is fine.
        const hasLocal = this.imageIds.some((id) => this.isLocalId(id));
        if (!hasLocal) {
            return original_runExport.call(this);
        }

        // Mirror original_runExport but split the queue into the two
        // sources. We re-implement the request body so we don't have to
        // monkey-patch fetch.
        this._hideConfirmModal();

        const folder = document.getElementById('dataset-output-folder')?.value?.trim();
        const pattern = this._effectivePattern();
        const trigger = document.getElementById('dataset-trigger')?.value || '';
        const imageOp = document.getElementById('dataset-image-op')?.value || 'copy';
        const overwrite = document.getElementById('dataset-overwrite')?.value || 'unique';
        const normalize = !!document.getElementById('dataset-underscore-to-space')?.checked;
        const blacklist = (document.getElementById('dataset-blacklist')?.value || '')
            .split(',').map((s) => s.trim()).filter(Boolean);
        const commonTags = (document.getElementById('dataset-common-tags')?.value || '')
            .split(',').map((s) => s.trim()).filter(Boolean);

        const galleryIds = [];
        const localPaths = [];
        for (const id of this.imageIds) {
            if (this.isLocalId(id)) {
                const p = this.localItemPaths.get(Number(id));
                if (p) localPaths.push(p);
            } else {
                galleryIds.push(Number(id));
            }
        }

        // image_overrides accepts both str(image_id) keys (gallery) and
        // absolute path keys (local). Build a single dict.
        const image_overrides = {};
        for (const [id, val] of this.captionEdits.entries()) {
            if (this.isLocalId(id)) {
                const p = this.localItemPaths.get(Number(id));
                if (p) image_overrides[p] = val;
            } else {
                image_overrides[String(id)] = val;
            }
        }

        const btn = document.getElementById('btn-dataset-export');
        if (btn) {
            btn.disabled = true;
            btn.dataset.busy = '1';
        }

        try {
            const r = await fetch('/api/dataset/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: galleryIds,
                    image_paths: localPaths,
                    output_folder: folder,
                    naming_pattern: pattern,
                    trigger,
                    image_op: imageOp,
                    overwrite_policy: overwrite,
                    normalize_tag_underscores: normalize,
                    blacklist,
                    common_tags: commonTags,
                    image_overrides,
                }),
            });
            if (!r.ok) {
                const body = await r.text();
                this._showResultModal('failed', { errorMessages: [body.slice(0, 400)], output_folder: folder });
                return;
            }
            const data = await r.json();
            this._showResultModal(data.status || 'ok', data);
        } catch (e) {
            this._showResultModal('failed', { errorMessages: [e.message], output_folder: folder });
        } finally {
            if (btn) {
                btn.dataset.busy = '';
                this._updateExportEnabled();
            }
        }
    };

    // -------- Folder-import modal wiring --------

    function $(id) { return document.getElementById(id); }

    DM._openFolderImport = function () {
        const modal = $('dataset-folder-import-modal');
        if (modal) modal.hidden = false;
        const status = $('dataset-folder-import-status');
        if (status) status.textContent = '';
    };

    DM._closeFolderImport = function () {
        const modal = $('dataset-folder-import-modal');
        if (modal) modal.hidden = true;
    };

    DM._runFolderImport = async function () {
        const status = $('dataset-folder-import-status');
        const goBtn = $('btn-dataset-folder-import-go');
        const path = ($('dataset-folder-import-path')?.value || '').trim();
        const recursive = !!$('dataset-folder-import-recursive')?.checked;
        if (!path) {
            if (status) status.textContent = this._t('dataset.folderImportNeedPath',
                'Pick a folder first.');
            return;
        }
        if (goBtn) goBtn.disabled = true;
        if (status) status.textContent = this._t('dataset.folderImportScanning', 'Scanning folder...');
        try {
            const r = await fetch('/api/dataset/folder-scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder_path: path, recursive }),
            });
            if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                if (status) {
                    status.textContent = body.detail || `${r.status} ${r.statusText}`;
                }
                return;
            }
            const data = await r.json();
            const items = data.items || [];
            if (items.length === 0) {
                if (status) status.textContent = this._t('dataset.folderImportEmpty',
                    'No new images found in that folder.');
                return;
            }
            this.addLocalItems(items, { switchView: false, showToast: true });
            this._closeFolderImport();
            if (data.skipped_unreadable > 0) {
                this._toast(this._t('dataset.folderImportSkipped',
                    'Skipped {count} unreadable files in that folder.',
                    { count: data.skipped_unreadable }), 'warning', 5000);
            }
        } catch (e) {
            if (status) status.textContent = e.message || String(e);
        } finally {
            if (goBtn) goBtn.disabled = false;
        }
    };

    function bindFolderImport() {
        $('btn-dataset-import-folder')?.addEventListener('click', () => DM._openFolderImport());
        $('btn-dataset-folder-import-cancel')?.addEventListener('click', () => DM._closeFolderImport());
        $('btn-dataset-folder-import-go')?.addEventListener('click', () => DM._runFolderImport());

        const browseBtn = $('btn-dataset-folder-import-browse');
        const pathInput = $('dataset-folder-import-path');
        if (browseBtn && pathInput && typeof window.showFolderBrowser === 'function') {
            browseBtn.addEventListener('mousedown', () => window.showFolderBrowser(pathInput));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFolderImport, { once: true });
    } else {
        bindFolderImport();
    }
})();
