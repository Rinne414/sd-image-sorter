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
 *   - thumbnail render uses inline ``thumb_b64`` when present, otherwise
 *     lazily fetches ``/api/dataset/local-thumbnail`` for visible items
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
    DM.localManifestTokens = DM.localManifestTokens || new Map(); // scan_token -> {total, excludedPaths}
    DM._folderScanToken = null;
    DM._folderScanNextOffset = 0;
    DM._folderScanHasMore = false;
    DM._folderScanTotal = 0;
    DM._folderScanPreviewed = 0;

    // Keep preview hydration small. Folder scan returns a backend manifest
    // token, so export/audit can include unloaded images without sending a
    // million absolute paths to the browser.
    const FOLDER_SCAN_PAGE_SIZE = 5000;
    const UPLOAD_BATCH_SIZE = 250;
    const LARGE_BROWSER_DROP_WARNING_FILES = 5000;

    /** Negative-id helper: true iff the supplied id refers to a local-source item. */
    DM.isLocalId = function (id) {
        return Number(id) < 0;
    };

    /** Convert backend ``ds_id`` ("ds:abc123...") to a stable negative integer id. */
    DM._dsIdToNumericId = function (dsId) {
        // Use 52 bits, not the old 31-bit slice. At 100k local images a
        // 31-bit birthday collision is realistic; 52 bits keeps it negligible
        // while staying inside JavaScript's safe integer range.
        const hex = String(dsId || '').replace(/^ds:/, '').slice(0, 13);
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
        return -Math.min(n || 1, Number.MAX_SAFE_INTEGER);
    };

    function localThumbnailUrl(absPath, size = 256) {
        const path = String(absPath || '').trim();
        if (!path) return '';
        const px = Math.max(1, Math.min(4096, Math.round(Number(size) || 256)));
        return `/api/dataset/local-thumbnail?path=${encodeURIComponent(path)}&size=${px}`;
    }

    const original_thumbSrc = DM._thumbSrc;
    DM._thumbSrc = function (id, size = 128) {
        const numericId = Number(id);
        if (!this.isLocalId(numericId)) {
            return typeof original_thumbSrc === 'function'
                ? original_thumbSrc.call(this, numericId, size)
                : `/api/image-thumbnail/${numericId}?size=${size}`;
        }
        const meta = this.meta?.get?.(numericId) || {};
        if (meta.thumb_b64) return `data:image/jpeg;base64,${meta.thumb_b64}`;
        const absPath = meta.abs_path || this.localItemPaths?.get?.(numericId) || '';
        return localThumbnailUrl(absPath, size);
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

    DM._registerFolderManifest = function (data) {
        const token = String(data?.scan_token || '').trim();
        if (!token) return null;
        const existing = this.localManifestTokens.get(token) || {};
        this.localManifestTokens.set(token, {
            scan_token: token,
            folder_path: data.folder_path || existing.folder_path || '',
            total: Number(data.total_files_seen || existing.total || 0) || 0,
            excludedPaths: existing.excludedPaths instanceof Set ? existing.excludedPaths : new Set(),
        });
        return token;
    };

    DM._markLocalManifestExcluded = function (id) {
        const numericId = Number(id);
        const meta = this.meta?.get?.(numericId) || {};
        const token = String(meta.folder_scan_token || '').trim();
        const absPath = this.localItemPaths?.get?.(numericId) || meta.abs_path || '';
        if (!token || !absPath) return;
        const source = this.localManifestTokens.get(token);
        if (!source) return;
        source.excludedPaths = source.excludedPaths instanceof Set ? source.excludedPaths : new Set();
        source.excludedPaths.add(absPath);
    };

    DM._excludeLocalPathFromManifests = function (absPath) {
        const path = String(absPath || '').trim();
        if (!path || !this.localManifestTokens) return false;
        let touched = false;
        const sources = Array.from(this.localManifestTokens.values());
        for (const source of sources) {
            const root = String(source.folder_path || '').replace(/[\\/]+$/, '');
            const inSource = root
                ? (path === root || path.startsWith(root + '/') || path.startsWith(root + '\\'))
                : sources.length === 1;
            if (!inSource) continue;
            source.excludedPaths = source.excludedPaths instanceof Set ? source.excludedPaths : new Set();
            if (!source.excludedPaths.has(path)) {
                source.excludedPaths.add(path);
                touched = true;
            }
        }
        return touched;
    };

    DM._localIdUsesManifest = function (id) {
        const meta = this.meta?.get?.(Number(id)) || {};
        const token = String(meta.folder_scan_token || '').trim();
        return !!(token && this.localManifestTokens?.has?.(token));
    };

    DM._getDatasetScanTokenSources = function () {
        const out = [];
        for (const [token, source] of this.localManifestTokens.entries()) {
            if (!token) continue;
            out.push({
                scan_token: token,
                exclude_paths: Array.from(source.excludedPaths || []),
            });
        }
        return out;
    };

    DM._getLogicalDatasetCount = function () {
        let count = 0;
        for (const id of this.imageIds || []) {
            const numericId = Number(id);
            if (this.isLocalId(numericId) && this._localIdUsesManifest(numericId)) continue;
            count += 1;
        }
        for (const source of this.localManifestTokens.values()) {
            const total = Number(source.total || 0) || 0;
            const excluded = source.excludedPaths instanceof Set ? source.excludedPaths.size : 0;
            count += Math.max(0, total - excluded);
        }
        return count;
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
        const focusImportTab = options.focusImportTab === true;

        const before = this.imageIds.length;
        const seen = new Set(this.imageIds.map(Number));
        const localCaptions = this._loadLocalCaptions();
        let touchedActive = false;

        for (const item of (items || [])) {
            const dsId = String(item.ds_id || '');
            if (!dsId.startsWith('ds:')) continue;
            let numericId = this._dsIdToNumericId(dsId);
            const absPath = String(item.abs_path || '');
            if (!absPath) continue;

            // Extremely defensive collision handling for synthetic local IDs.
            while (seen.has(numericId) && this.localItemPaths.get(numericId) !== absPath) {
                numericId -= 1;
            }

            if (!seen.has(numericId)) {
                this.imageIds.push(numericId);
                seen.add(numericId);
            }
            this.localItemPaths.set(numericId, absPath);
            this.localItemDsIds.set(numericId, dsId);
            const existing = this.meta.get(numericId) || {};
            const scanIndex = Number(item.scan_index);
            this.meta.set(numericId, {
                ...existing,
                source: 'local',
                ds_id: dsId,
                abs_path: absPath,
                filename: item.filename || existing.filename || '',
                thumbnail_path: '',
                thumb_b64: item.thumb_b64 || existing.thumb_b64 || '',
                width: Number(item.width || existing.width || 0),
                height: Number(item.height || existing.height || 0),
                mtime: Number(item.mtime || existing.mtime || 0),
                size: Number(item.size || existing.size || 0),
                scan_index: Number.isFinite(scanIndex) ? scanIndex : existing.scan_index,
                folder_scan_token: item.folder_scan_token || existing.folder_scan_token || '',
            });
            if (Number(this.activeId) === Number(numericId)) touchedActive = true;
            // Restore any saved caption for this path so re-imports
            // pick the user's previous edit back up.
            const saved = localCaptions[absPath];
            if (saved && !this.captionEdits.has(numericId)) {
                this.captionEdits.set(numericId, saved);
            }
        }

        const added = this.imageIds.length - before;
        this._renderQueue();
        this._updateCount();
        this._updateExportEnabled();
        if (typeof this._renderImportGallery === 'function') {
            this._renderImportGallery();
        }
        if (added > 0 && focusImportTab && typeof this._setPipelineTab === 'function') {
            this._setPipelineTab('import');
        }
        if (this.activeId == null && this.imageIds.length) {
            this._setActive(this.imageIds[0]);
        } else if (touchedActive && this.activeId != null) {
            this._setActive(this.activeId);
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
        this._checkDuplicateFilenames();
        return added;
    };

    // -------- Queue + editor patches: render local thumbs lazily --------

    const original_buildQueueItem = DM._buildQueueItem;
    DM._buildQueueItem = function (id, orderIndex = null) {
        const node = original_buildQueueItem.call(this, id, orderIndex);
        if (!this.isLocalId(id)) return node;
        // Replace the ``/api/image-thumbnail/{id}`` request (which would 404
        // for negative ids) with either the inline scan thumb or the lazy
        // path-thumbnail endpoint.
        const meta = this.meta.get(id) || {};
        const img = node.querySelector('img.dataset-queue-thumb');
        if (img) {
            const src = this._thumbSrc(id, 160);
            if (src) {
                img.src = src;
                img.classList.remove('is-preview-pending');
                node.classList.remove('preview-pending');
            } else {
                img.removeAttribute('src');
                img.classList.add('is-preview-pending');
                node.classList.add('preview-pending');
            }
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
        // Local-source path: render the same lazy thumbnail path used by
        // queue/import/export previews. No DB row is required.
        if (!this.imageIds.includes(id)) return;
        this.activeId = id;
        const meta = this.meta.get(id) || {};
        const filename = meta.filename || `(local image)`;

        const img = document.getElementById('dataset-editor-image');
        const empty = document.getElementById('dataset-editor-empty');
        const ta = document.getElementById('dataset-editor-textarea');
        const actions = document.getElementById('dataset-editor-actions');
        const filenameEl = document.getElementById('dataset-editor-filename');
        const zoomBar = document.getElementById('dataset-zoom-toolbar');

        if (img) {
            const src = this._thumbSrc(id, 1024);
            if (src) img.src = src;
            else img.removeAttribute('src');
            img.alt = filename;
            img.hidden = !src;
            img.onerror = () => {
                img.removeAttribute('src');
                img.hidden = true;
                if (empty) empty.hidden = false;
            };
        }
        if (empty) {
            const hasPreview = !!this._thumbSrc(id, 256);
            empty.hidden = hasPreview;
            const text = empty.querySelector('.dataset-editor-empty-text');
            if (text && !hasPreview) {
                text.textContent = this._t('dataset.previewPending',
                    'Preview not loaded yet. Use "Load more previews" in Step 1 to hydrate this folder batch.');
            }
        }
        if (filenameEl) filenameEl.textContent = `📁 ${filename}`;
        if (zoomBar) zoomBar.hidden = false;
        this._zoomLevel = 1;
        this._applyZoom?.();

        const caption = this.captionEdits.has(id)
            ? this.captionEdits.get(id)
            : (this.captions.get(id) || '');
        if (ta) {
            ta.value = caption;
            ta.hidden = false;
        }
        if (actions) actions.hidden = false;

        this._highlightActiveQueueItem();
        this._scrollActiveQueueItemIntoView?.();
        this._renderTagPills?.();
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
    DM._deleteCaptionEditForDatasetRemoval = function (id) {
        return original_captionEdits_delete(id);
    };

    // -------- Removing items: clean up local maps --------

    const original_removeImageById = DM._removeImageById;
    DM._removeImageById = function (imageId, options = {}) {
        const id = Number(imageId);
        if (this.isLocalId(id)) this._markLocalManifestExcluded(id);
        return original_removeImageById.call(this, imageId, options);
    };

    const original_removeActive = DM._removeActive;
    DM._removeActive = function () {
        const id = Number(this.activeId);
        const wasLocal = this.isLocalId(id);
        if (wasLocal) this._markLocalManifestExcluded(id);
        original_removeActive.call(this);
        if (wasLocal) {
            this.localItemPaths.delete(id);
            this.localItemDsIds.delete(id);
            // Removing from the current dataset must not erase saved
            // path-keyed captions; re-importing the same folder should
            // restore the user's edits.
        }
    };

    const original_clearAll = DM._clearAll;
    DM._clearAll = function () {
        const localPathsBefore = Array.from(this.localItemPaths.values());
        original_clearAll.call(this);
        // If the user actually confirmed, the imageIds is now [] — drop
        // local maps. Keep localStorage captions so re-importing the same
        // folder restores edits instead of silently losing work.
        // If they cancelled, imageIds still
        // has entries; bail out without touching anything.
        if (this.imageIds.length === 0 && localPathsBefore.length) {
            this.localItemPaths.clear();
            this.localItemDsIds.clear();
            this.localManifestTokens.clear();
        }
    };

    // -------- Export: split into image_ids + image_paths + path overrides --------

    DM._buildExportPayload = function () {
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
                if (this._localIdUsesManifest(id)) continue;
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

        return {
            image_ids: galleryIds,
            image_paths: localPaths,
            dataset_scan_tokens: this._getDatasetScanTokenSources(),
            output_folder: folder,
            naming_pattern: pattern,
            trigger,
            image_op: imageOp,
            overwrite_policy: overwrite,
            normalize_tag_underscores: normalize,
            blacklist,
            common_tags: commonTags,
            image_overrides,
        };
    };

    const original_updateCount = DM._updateCount;
    DM._updateCount = function () {
        original_updateCount.call(this);
        const logical = this._getLogicalDatasetCount ? this._getLogicalDatasetCount() : this.imageIds.length;
        const num = document.getElementById('dataset-count-num');
        if (num) num.textContent = String(logical);
        const importCount = document.getElementById('dataset-import-gallery-count');
        if (importCount && logical !== this.imageIds.length) {
            importCount.textContent = this._t('dataset.importGalleryManifestCount',
                '{loaded} previews loaded / {count} images in dataset',
                { loaded: this.imageIds.length, count: logical });
        }
    };

    const original_isReadyToExport = DM._isReadyToExport;
    DM._isReadyToExport = function () {
        const logical = this._getLogicalDatasetCount ? this._getLogicalDatasetCount() : this.imageIds.length;
        if (logical <= 0) return false;
        return original_isReadyToExport.call({ ...this, imageIds: logical > 0 ? [1] : [] });
    };

    // -------- Folder-import modal wiring --------

    function $(id) { return document.getElementById(id); }

    DM._openFolderImport = function () {
        const status = $('dataset-folder-import-status');
        if (status) status.textContent = '';
        this._setFolderLoadMoreState(false);
        const input = $('dataset-folder-import-path');
        if (input) input.focus();
    };

    DM._setFolderLoadMoreState = function (visible, label) {
        const moreBtn = $('btn-dataset-folder-import-more');
        if (!moreBtn) return;
        moreBtn.hidden = !visible;
        if (label) moreBtn.textContent = label;
    };

    DM._setFolderImportBusy = function (busy) {
        const isBusy = !!busy;
        const row = document.querySelector('.dataset-folder-import-status-row');
        const grid = $('dataset-import-gallery-grid');
        const gallery = $('dataset-import-gallery');
        if (row) {
            row.classList.toggle('is-loading', isBusy);
            row.setAttribute('aria-busy', isBusy ? 'true' : 'false');
        }
        if (grid) grid.classList.toggle('is-loading', isBusy);
        if (gallery) gallery.classList.toggle('is-loading', isBusy);
    };

    DM._runFolderImport = async function (options = {}) {
        const append = options.append === true;
        const status = $('dataset-folder-import-status');
        const goBtn = $('btn-dataset-folder-import-go');
        const moreBtn = $('btn-dataset-folder-import-more');
        const path = ($('dataset-folder-import-path')?.value || '').trim();
        const recursive = !!$('dataset-folder-import-recursive')?.checked;
        if (!append && !path) {
            if (status) status.textContent = this._t('dataset.folderImportNeedPath',
                'Pick a folder first.');
            return;
        }
        if (append && !this._folderScanToken) return;

        if (goBtn) goBtn.disabled = true;
        if (moreBtn) moreBtn.disabled = true;
        if (!append) {
            this._folderScanToken = null;
            this._folderScanNextOffset = 0;
            this._folderScanHasMore = false;
            this._folderScanTotal = 0;
            this._folderScanPreviewed = 0;
            this._setFolderLoadMoreState(false);
        }
        if (status) status.textContent = append
            ? this._t('dataset.folderImportLoadingMore', 'Loading next batch...')
            : this._t('dataset.folderImportScanning', 'Scanning folder...');
        this._setFolderImportBusy(true);
        try {
            const body = append
                ? {
                    scan_token: this._folderScanToken,
                    offset: this._folderScanNextOffset || 0,
                    limit: FOLDER_SCAN_PAGE_SIZE,
                    include_thumbnails: false,
                }
                : {
                    folder_path: path,
                    recursive,
                    limit: FOLDER_SCAN_PAGE_SIZE,
                    include_thumbnails: false,
                };
            const r = await fetch('/api/dataset/folder-scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                if (status) {
                    status.textContent = body.detail || `${r.status} ${r.statusText}`;
                }
                return;
            }
            const data = await r.json();
            const token = this._registerFolderManifest(data) || this._folderScanToken || null;
            const items = (data.items || []).map((item) => ({ ...item, folder_scan_token: token || '' }));
            this._folderScanToken = token;
            this._folderScanNextOffset = Number(data.next_offset || 0) || 0;
            this._folderScanHasMore = Boolean(data.has_more);
            this._folderScanTotal = Number(data.total_files_seen || this._folderScanTotal || 0);
            this._folderScanPreviewed = Math.max(
                this._folderScanPreviewed || 0,
                Number(data.next_offset || this._folderScanTotal || items.length || 0) || 0
            );

            if (items.length > 0) {
                this.addLocalItems(items, { switchView: false, showToast: false, focusImportTab: !append });
            }

            if (items.length === 0 && !this._folderScanHasMore) {
                if (status) status.textContent = this._t('dataset.folderImportEmpty',
                    'No new images found in that folder.');
                this._setFolderLoadMoreState(false);
                return;
            }
            const total = Number(data.total_files_seen || 0);
            const previewed = Math.min(this._folderScanPreviewed || 0, total || this._folderScanPreviewed || 0);
            const addedToDataset = total || items.length;
            if (status) {
                if (!append && total > 0) {
                    status.textContent = this._folderScanHasMore
                        ? this._t('dataset.folderImportAddedManifest',
                            'Added {count} images to the dataset. Previewed {loaded}/{total}; load more previews to continue.',
                            { count: total, loaded: previewed, total })
                        : this._t('dataset.folderImportAdded',
                            'Added {count} local images (not added to main gallery)',
                            { count: total });
                } else {
                    status.textContent = this._folderScanHasMore
                        ? this._t('dataset.folderImportPreviewPage',
                            'Loaded {count} more previews. {loaded}/{total} previews ready; all {total} images are already in the dataset.',
                            { count: items.length, loaded: previewed, total })
                        : this._t('dataset.folderImportPreviewComplete',
                            'Loaded previews for all {total} dataset images.',
                            { total: total || addedToDataset });
                }
            }
            this._setFolderLoadMoreState(
                this._folderScanHasMore,
                this._t('dataset.folderImportLoadMore', 'Load more previews')
            );
            if (data.truncated || data.has_more) {
                this._toast(this._t('dataset.folderImportMoreAvailable',
                    'Large folder detected. Export and audit will use the backend manifest; previews load in batches so the UI stays responsive.'),
                    'info', 6000);
            } else if (!append && addedToDataset > 0) {
                this._toast(this._t('dataset.folderImportAdded',
                    'Added {count} local images (not added to main gallery)',
                    { count: addedToDataset }), 'success');
            }
            if (data.skipped_unreadable > 0) {
                this._toast(this._t('dataset.folderImportSkipped',
                    'Skipped {count} unreadable files in that folder.',
                    { count: data.skipped_unreadable }), 'warning', 5000);
            }
        } catch (e) {
            if (status) status.textContent = e.message || String(e);
        } finally {
            this._setFolderImportBusy(false);
            if (goBtn) goBtn.disabled = false;
            if (moreBtn) moreBtn.disabled = false;
        }
    };

    // -------- Drag-drop zone --------

    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'tif']);
    const ARCHIVE_EXTS = new Set(['zip']);

    function bindDropzone() {
        const dropzone = $('dataset-dropzone');
        if (!dropzone) return;

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('drag-over');
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('drag-over');
            handleDrop(e.dataTransfer).catch((err) => {
                DM._toast(err?.message || 'Drop import failed', 'error', 5000);
            });
        });

        // Click to open file picker
        dropzone.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'image/*,.zip';
            input.addEventListener('change', () => {
                if (input.files && input.files.length > 0) {
                    handleFileList(input.files).catch((err) => {
                        DM._toast(err?.message || 'Upload failed', 'error', 5000);
                    });
                }
            });
            input.click();
        });
    }

    async function handleDrop(dataTransfer) {
        if (!dataTransfer) return;
        const items = dataTransfer.items;
        if (items && items.length > 0) {
            const entries = [];
            for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
                if (entry) entries.push(entry);
            }
            if (entries.some((entry) => entry.isDirectory)) {
                const recursive = !!$('dataset-folder-import-recursive')?.checked;
                const files = await collectFilesFromEntries(entries, { recursive });
                if (files.length > 0) {
                    await handleFileList(files);
                } else {
                    DM._toast(DM._t('dataset.dropNoImages',
                        'No supported image files found in the drop.'), 'warning', 3000);
                }
                return;
            }
        }
        // Otherwise treat as image files
        if (dataTransfer.files && dataTransfer.files.length > 0) {
            await handleFileList(dataTransfer.files);
        }
    }

    function readDirectoryEntries(reader) {
        return new Promise((resolve, reject) => {
            reader.readEntries(resolve, reject);
        });
    }

    function entryFile(entry) {
        return new Promise((resolve, reject) => {
            entry.file(resolve, reject);
        });
    }

    async function collectFilesFromEntries(entries, { recursive }) {
        const out = [];
        async function walk(entry, depth = 0) {
            if (!entry) return;
            if (entry.isFile) {
                try { out.push(await entryFile(entry)); } catch { /* skip unreadable */ }
                return;
            }
            if (!entry.isDirectory) return;
            if (!recursive && depth > 0) return;
            const reader = entry.createReader();
            let batch = await readDirectoryEntries(reader);
            while (batch.length > 0) {
                for (const child of batch) {
                    if (child.isFile || recursive || depth === 0) {
                        await walk(child, depth + 1);
                    }
                }
                batch = await readDirectoryEntries(reader);
            }
        }
        for (const entry of entries) {
            await walk(entry, 0);
        }
        return out;
    }

    async function handleFileList(files) {
        const imageFiles = [];
        const archiveFiles = [];
        for (const f of files) {
            const ext = (f.name.split('.').pop() || '').toLowerCase();
            if (IMAGE_EXTS.has(ext)) imageFiles.push(f);
            else if (ARCHIVE_EXTS.has(ext)) archiveFiles.push(f);
        }
        const uploadFiles = [...imageFiles, ...archiveFiles];
        if (uploadFiles.length === 0) {
            DM._toast(DM._t('dataset.dropNoImages',
                'No supported image or ZIP files found in the drop.'), 'warning', 3000);
            return;
        }
        if (uploadFiles.length > LARGE_BROWSER_DROP_WARNING_FILES) {
            DM._toast(DM._t('dataset.dropCapped',
                'Large browser drop detected. The app will import all dropped files; the folder path bar is faster for very large folders.',
                { count: uploadFiles.length }), 'warning', 7000);
        }
        // Upload files to the backend for local-source import. Keep this
        // chunked so a large drop does not create one huge FormData request.
        const recursive = $('dataset-folder-import-recursive')?.checked ? 'true' : 'false';
        const batches = [];
        for (let i = 0; i < uploadFiles.length; i += UPLOAD_BATCH_SIZE) {
            batches.push(uploadFiles.slice(i, i + UPLOAD_BATCH_SIZE));
        }
        let totalAdded = 0;
        let skippedUnreadable = 0;
        let sawTruncated = false;
        const status = $('dataset-folder-import-status');
        if (status) {
            status.textContent = DM._t('dataset.uploadImporting',
                'Importing dropped files... 0/{total} batches',
                { total: batches.length });
        }
        DM._setFolderImportBusy?.(true);
        try {
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
                if (status) {
                    status.textContent = DM._t('dataset.uploadImporting',
                        'Importing dropped files... {current}/{total} batches',
                        { current: batchIndex + 1, total: batches.length });
                }
                const formData = new FormData();
                for (const f of batches[batchIndex]) formData.append('files', f);
                formData.append('recursive', recursive);
                const r = await fetch('/api/dataset/upload-files', {
                    method: 'POST',
                    body: formData,
                });
                if (!r.ok) {
                    const body = await r.json().catch(() => ({}));
                    DM._toast(body.detail || `Upload failed: ${r.status}`, 'error', 5000);
                    return;
                }
                const data = await r.json();
                const items = data.items || [];
                if (items.length > 0) {
                    totalAdded += DM.addLocalItems(items, { switchView: false, showToast: false });
                }
                skippedUnreadable += Number(data.skipped_unreadable || 0) || 0;
                sawTruncated = sawTruncated || Boolean(data.truncated);
            }
            if (totalAdded > 0) {
                if (status) {
                    status.textContent = DM._t('dataset.folderImportAdded',
                        'Added {count} local images (not added to main gallery)',
                        { count: totalAdded });
                }
                DM._toast(DM._t('dataset.folderImportAdded',
                    'Added {count} local images (not added to main gallery)',
                    { count: totalAdded }), 'success');
            }
            if (sawTruncated) {
                DM._toast(DM._t('dataset.uploadTruncated',
                    'Upload import was split into batches. Imported every returned image; use the folder path bar for very large folders.'),
                    'warning', 7000);
            }
            if (skippedUnreadable > 0) {
                DM._toast(DM._t('dataset.folderImportSkipped',
                    'Skipped {count} unreadable files in that folder.',
                    { count: skippedUnreadable }), 'warning', 5000);
            }
        } catch (e) {
            if (status) status.textContent = e.message || 'Upload failed';
            DM._toast(e.message || 'Upload failed', 'error', 5000);
        } finally {
            DM._setFolderImportBusy?.(false);
        }
    }

    function bindFolderImport() {
        $('btn-dataset-folder-import-go')?.addEventListener('click', () => DM._runFolderImport());
        $('btn-dataset-folder-import-more')?.addEventListener('click', () => DM._runFolderImport({ append: true }));

        const browseBtn = $('btn-dataset-folder-import-browse');
        const pathInput = $('dataset-folder-import-path');
        if (browseBtn && pathInput && typeof window.showFolderBrowser === 'function') {
            browseBtn.addEventListener('mousedown', () => {
                const container = document.getElementById('dataset-folder-import-browser');
                if (container && container.children.length > 0) {
                    if (typeof window.hideFolderBrowser === 'function') window.hideFolderBrowser();
                    else container.innerHTML = '';
                    return;
                }
                window.showFolderBrowser(pathInput);
            });
        }

        bindDropzone();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFolderImport, { once: true });
    } else {
        bindFolderImport();
    }
})();
