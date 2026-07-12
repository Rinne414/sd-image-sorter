/**
 * Dataset Maker — folder-import UI: paged folder scan (POST /api/dataset/folder-scan), dropzone + browser uploads (POST /api/dataset/upload-files).
 * Moved VERBATIM from dataset-maker-local-import.js L52-57 + L761-1152.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;
    // Keep preview hydration small. Folder scan returns a backend manifest
    // token, so export/audit can include unloaded images without sending a
    // million absolute paths to the browser.
    const FOLDER_SCAN_PAGE_SIZE = 5000;
    const UPLOAD_BATCH_SIZE = 250;
    const LARGE_BROWSER_DROP_WARNING_FILES = 5000;

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
