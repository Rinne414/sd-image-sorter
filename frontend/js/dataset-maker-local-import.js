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
    const NativeSet = globalThis.Set;
    const isNativeSet = (value) => typeof NativeSet === 'function' && value instanceof NativeSet;
    const newNativeSet = (items = []) => typeof NativeSet === 'function'
        ? new NativeSet(items)
        : { add() {}, has() { return false; }, size: 0, [Symbol.iterator]: function* () {} };

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
            excludedPaths: isNativeSet(existing.excludedPaths) ? existing.excludedPaths : newNativeSet(),
        });
        this._scheduleSaveSession?.();
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
        source.excludedPaths = isNativeSet(source.excludedPaths) ? source.excludedPaths : newNativeSet();
        source.excludedPaths.add(absPath);
        this._scheduleSaveSession?.();
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
            source.excludedPaths = isNativeSet(source.excludedPaths) ? source.excludedPaths : newNativeSet();
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
            const excluded = isNativeSet(source.excludedPaths) ? source.excludedPaths.size : 0;
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
                source_kind: item.source_kind || existing.source_kind || 'folder_path',
                sidecar_capability: item.sidecar_capability || existing.sidecar_capability || 'beside_image',
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
        this._syncSourceCapabilityStatus?.();
        this._syncOutputModeUi?.();
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
        if (added > 0 || touchedActive) this._saveSession?.();
        return added;
    };

    DM._serializeLocalDatasetState = function () {
        const localItems = [];
        for (const [id, absPath] of this.localItemPaths.entries()) {
            const numericId = Number(id);
            const meta = { ...(this.meta.get(numericId) || {}) };
            delete meta.thumb_b64;
            localItems.push({
                id: numericId,
                abs_path: absPath,
                ds_id: this.localItemDsIds.get(numericId) || meta.ds_id || '',
                meta,
            });
        }
        const manifests = [];
        for (const [token, source] of this.localManifestTokens.entries()) {
            manifests.push({
                scan_token: token,
                folder_path: source?.folder_path || '',
                total: Number(source?.total || 0) || 0,
                excludedPaths: Array.from(source?.excludedPaths || []),
            });
        }
        return { localItems, manifests };
    };

    DM._restoreLocalSession = function (local = {}) {
        if (!local || typeof local !== 'object') return;
        this.localItemPaths.clear();
        this.localItemDsIds.clear();
        this.localManifestTokens.clear();

        for (const source of (local.manifests || [])) {
            const token = String(source?.scan_token || '').trim();
            if (!token) continue;
            this.localManifestTokens.set(token, {
                scan_token: token,
                folder_path: source.folder_path || '',
                total: Number(source.total || 0) || 0,
                excludedPaths: newNativeSet(Array.isArray(source.excludedPaths) ? source.excludedPaths : []),
            });
        }

        for (const item of (local.localItems || [])) {
            const id = Number(item?.id);
            const absPath = String(item?.abs_path || item?.meta?.abs_path || '').trim();
            if (!Number.isFinite(id) || id >= 0 || !absPath) continue;
            const meta = { ...(item.meta || {}) };
            meta.source = 'local';
            meta.abs_path = absPath;
            meta.ds_id = item.ds_id || meta.ds_id || '';
            meta.source_kind = meta.source_kind || 'folder_path';
            meta.sidecar_capability = meta.sidecar_capability || 'beside_image';
            this.localItemPaths.set(id, absPath);
            if (meta.ds_id) this.localItemDsIds.set(id, meta.ds_id);
            this.meta.set(id, meta);
        }
    };

    if (DM._pendingLocalSession) {
        DM._restoreLocalSession(DM._pendingLocalSession);
        DM._pendingLocalSession = null;
    }

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
            const absPath = meta.abs_path || this.localItemPaths?.get?.(id) || '';
            const src = absPath ? localThumbnailUrl(absPath, 2048) : this._thumbSrc(id, 1024);
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
    //
    // v3.4.5 race fix: the previous implementation swapped
    // ``this.imageIds`` to a filtered list across the ``await``, then
    // restored it in ``finally``. If any concurrent reader (the render
    // loop, export preview, another fetch) touched ``imageIds`` during
    // the await, it saw a truncated list and could drop local items
    // from the queue / preview. We now pass a snapshot of the real
    // (gallery) ids to the original method via a transient option
    // instead of mutating shared state.
    //
    // The originals read ``this.imageIds`` directly, so we still need
    // to constrain what they see — but we do it by stashing the full
    // list on a private field and restoring synchronously around the
    // call, with a guard that refuses to clobber a list that another
    // in-flight fetch has already stashed. This keeps the window
    // tightly bounded to the call itself rather than the whole await.

    const _LOCAL_FETCH_INFLIGHT = Symbol('localFetchInflight');

    function withGalleryIdsOnly(fn) {
        return async function () {
            if (this[_LOCAL_FETCH_INFLIGHT]) {
                // Another filtered fetch is already running; just call
                // through with the current (already-filtered) state.
                return fn.call(this);
            }
            const fullIds = this.imageIds;
            const galleryIds = fullIds.filter((id) => !this.isLocalId(id));
            this[_LOCAL_FETCH_INFLIGHT] = true;
            this.imageIds = galleryIds;
            try {
                return await fn.call(this);
            } finally {
                // Only restore if nobody else has replaced imageIds
                // underneath us (they would have had to clear
                // _LOCAL_FETCH_INFLIGHT first, which we guard above).
                if (this.imageIds === galleryIds) {
                    this.imageIds = fullIds;
                }
                this[_LOCAL_FETCH_INFLIGHT] = false;
            }
        };
    }

    const original_fetchMissingMeta = DM._fetchMissingMeta;
    DM._fetchMissingMeta = withGalleryIdsOnly(original_fetchMissingMeta);

    const original_fetchMissingCaptions = DM._fetchMissingCaptions;
    DM._fetchMissingCaptions = withGalleryIdsOnly(original_fetchMissingCaptions);

    const original_refreshAllCaptions = DM._refreshAllCaptions;
    DM._refreshAllCaptions = async function () {
        const fullIds = this.imageIds;
        const galleryIds = fullIds.filter((id) => !this.isLocalId(id));
        const alreadyInflight = !!this[_LOCAL_FETCH_INFLIGHT];
        if (!alreadyInflight) {
            this[_LOCAL_FETCH_INFLIGHT] = true;
            this.imageIds = galleryIds;
        }
        try {
            await original_refreshAllCaptions.call(this);
        } finally {
            if (!alreadyInflight) {
                if (this.imageIds === galleryIds) {
                    this.imageIds = fullIds;
                }
                this[_LOCAL_FETCH_INFLIGHT] = false;
            }
        }
        // Re-render the queue tiles + export preview with the FULL queue
        // restored so refreshed captions/tags appear without a re-import.
        // (Bug: gallery-source Smart Tag results updated this.captions but the
        // queue/preview kept showing the stale pre-tag state, so users had to
        // re-import from the gallery to see their tags.) _renderQueue must run
        // after imageIds is restored above, or local items would be dropped.
        this._renderQueue?.();
        this._refreshExportPreview?.();
    };

    // -------- Caption edits: persist local-source edits to localStorage --------

    // The textarea input handler in dataset-maker.js writes to
    // ``captionEdits.set(id, ta.value)``. We monkey-patch ``set`` so any
    // local-source entry also lands in localStorage. Patching the
    // CaptionEdits Map via a property hook keeps the existing call sites
    // (revert, refresh, render) untouched.
    //
    // NOTE: dataset-maker.js already patches captionEdits.set/.delete in
    // ``_installCaptionEditPersistence`` to schedule a session save. That
    // patch wraps the ORIGINAL Map methods. To compose correctly we must
    // patch the CURRENT (already-patched) ``set``/``delete`` here —
    // calling ``.bind(DM.captionEdits)`` captures the live method, so
    // when our wrapper calls ``original_captionEdits_set(...)`` it runs
    // the session-save patch, which in turn runs the real Map.set. Both
    // side effects (session save + localStorage persist) fire in order.
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

    DM._clearLocalDatasetState = function () {
        // Keep localStorage captions so re-importing the same folder restores
        // edits instead of silently losing work.
        this.localItemPaths.clear();
        this.localItemDsIds.clear();
        this.localManifestTokens.clear();
        this._scheduleSaveSession?.();
    };

    // -------- Export: split into image_ids + image_paths + path overrides --------

    DM._buildExportPayload = function () {
        const folder = document.getElementById('dataset-output-folder')?.value?.trim();
        const pattern = this._effectivePattern();
        const trigger = document.getElementById('dataset-trigger')?.value || '';
        const imageOp = document.getElementById('dataset-image-op')?.value || 'copy';
        const outputMode = this._outputMode?.() || 'folder';
        const overwrite = document.getElementById('dataset-overwrite')?.value || 'unique';
        const normalize = !!document.getElementById('dataset-underscore-to-space')?.checked;
        const contentMode = this._exportContentMode?.() || 'template';
        const prefix = document.getElementById('dataset-export-prefix')?.value || '';
        // Newline OR comma separated — #dataset-blacklist is newline by
        // convention (TraitPruner appends with '\n'); comma-only split dropped
        // trait-pruned entries on this local-import export path too.
        const blacklist = (document.getElementById('dataset-blacklist')?.value || '')
            .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        const commonTags = (document.getElementById('dataset-common-tags')?.value || '')
            .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

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
        // point 3: per-image NL type + edited NL text, same dual-key scheme.
        // Only non-default ('nl'/'both') and edited-NL entries are sent.
        const image_types = {};
        const image_nl_overrides = {};
        const _keyFor = (id) => {
            if (this.isLocalId(id)) {
                const p = this.localItemPaths.get(Number(id));
                return p || null;
            }
            return String(id);
        };
        for (const id of this.imageIds) {
            const key = _keyFor(id);
            if (!key) continue;
            const type = this._captionTypeFor ? this._captionTypeFor(id) : 'booru';
            if (type === 'nl' || type === 'both') image_types[key] = type;
            if (this.nlEdits.has(id)) image_nl_overrides[key] = this.nlEdits.get(id);
        }

        return {
            image_ids: galleryIds,
            image_paths: localPaths,
            dataset_scan_tokens: this._getDatasetScanTokenSources(),
            output_folder: outputMode === 'beside_image' ? '' : folder,
            output_mode: outputMode,
            naming_pattern: pattern,
            trigger,
            image_op: outputMode === 'beside_image' ? 'copy' : imageOp,
            overwrite_policy: overwrite,
            content_mode: contentMode,
            prefix,
            template_options: contentMode === 'template' ? this._datasetTemplateOptions?.() : null,
            caption_transforms: this._captionTransforms?.() || {},
            normalize_tag_underscores: normalize,
            blacklist,
            common_tags: commonTags,
            image_overrides,
            image_types,
            image_nl_overrides,
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

    // v3.4.5: the previous implementation probed the base readiness check
    // by temporarily setting ``this.imageIds = [1]`` (a magic placeholder)
    // so the base method's "non-empty dataset" guard would pass for a
    // local-only dataset, then restored the real list in ``finally``.
    // That mutated shared state across the call and coupled this patch to
    // the base method's internal use of ``imageIds.length``. We now read
    // the same readiness signals the base method reads — output folder,
    // disabled-reason, and a non-empty logical count — without the swap.
    const original_isReadyToExport = DM._isReadyToExport;
    DM._isReadyToExport = function () {
        const logical = this._getLogicalDatasetCount ? this._getLogicalDatasetCount() : this.imageIds.length;
        if (logical <= 0) return false;
        if (this._outputMode?.() === 'beside_image') {
            return !this._exportDisabledReason?.();
        }
        // Folder mode: the base check gates on (a) a non-empty dataset
        // and (b) no disabled-reason. We've already established (a) via
        // ``logical > 0`` above, so we only need (b). Calling the base
        // method with the real (possibly local-only) list works because
        // the base method's only use of imageIds beyond the emptiness
        // guard is the disabled-reason computation, which is
        // source-agnostic. No probe-swap needed.
        return !this._exportDisabledReason?.();
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
    // Both ZIP and RAR are unpacked server-side. RAR additionally needs the
    // optional ``rarfile`` Python package + system ``unrar`` binary; the
    // backend returns a clear toast when those are missing.
    const ARCHIVE_EXTS = new Set(['zip', 'rar']);

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
        // RAR is handled server-side alongside ZIP (optional rarfile dep).
        // The upload route surfaces a clear error if the runtime is
        // missing the unrar binary.
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
