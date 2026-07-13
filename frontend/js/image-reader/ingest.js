/**
 * image-reader/ingest.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 931-960 + 967-1157 (of 1,749): _setupDropZone, _setClipboardPasteState,
 * _getClipboardWarning, _clipboardMetadataMissing, _handlePaste, _handleFile
 * (POST /api/parse-image) and openLibraryImage — the app/handoffs.js seam and
 * the ONLY external runtime entry point besides init().
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _setupDropZone(dropZone, fileInput) {
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('drag-over');
            });
            dropZone.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('drag-over');
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('drag-over');
                const files = e.dataTransfer?.files;
                if (files?.length > 0) {
                    this._handleFile(files[0], { sourceKind: 'file' });
                }
            });

            dropZone.addEventListener('click', () => fileInput?.click());
            fileInput?.addEventListener('change', (e) => {
                if (e.target.files?.length > 0) {
                    this._handleFile(e.target.files[0], { sourceKind: 'file' });
                    e.target.value = '';
                }
            });
        },

        _setClipboardPasteState(armed) {
            this._awaitingClipboardPaste = armed;
            const dropZone = document.getElementById('reader-drop-zone');
            if (dropZone) {
                dropZone.classList.toggle('paste-armed', armed);
            }
        },

        _getClipboardWarning(result, sourceKind) {
            if (!sourceKind || !sourceKind.startsWith('clipboard')) {
                return '';
            }

            const gp = this._getGenParams(result);
            const hasPrompt = Boolean(String(result?.prompt || '').trim());
            const hasCheckpoint = Boolean(String(result?.checkpoint || gp.model || '').trim());
            const hasParams = Object.keys(gp || {}).length > 0;
            const generator = String(result?.generator || 'unknown').toLowerCase();

            if (!hasPrompt && !hasCheckpoint && !hasParams && generator === 'unknown') {
                return this._t(
                    'reader.clipboardWarningMissingMeta',
                    'This clipboard image did not keep the original image info. Drag in the real PNG file to read the prompt, model, and settings.',
                );
            }

            return this._t(
                'reader.clipboardWarning',
                'Clipboard paste often loses the original image info. If something looks incomplete, open the original file instead.',
            );
        },

        _clipboardMetadataMissing(result, sourceKind) {
            if (!sourceKind || !sourceKind.startsWith('clipboard')) {
                return false;
            }

            const gp = this._getGenParams(result);
            const hasPrompt = Boolean(String(result?.prompt || '').trim());
            const hasCheckpoint = Boolean(String(result?.checkpoint || gp.model || '').trim());
            const hasParams = Object.keys(gp || {}).length > 0;
            const generator = String(result?.generator || 'unknown').toLowerCase();
            return !hasPrompt && !hasCheckpoint && !hasParams && generator === 'unknown';
        },

        async _handlePaste() {
            this._setClipboardPasteState(true);

            const dropZone = document.getElementById('reader-drop-zone');
            if (dropZone && typeof dropZone.focus === 'function') {
                dropZone.focus();
            }

            const statusEl = document.getElementById('reader-status');
            if (statusEl) {
                statusEl.textContent = this._t(
                    'reader.pasteArmed',
                    'Ready. Press Ctrl+V now. If you want the full prompt and image settings, the original PNG is still best.',
                );
                statusEl.className = 'reader-status warning';
                statusEl.style.display = 'block';
            }
        },

        async _handleFile(file, options = {}) {
            if (!file.type.startsWith('image/')) {
                window.App?.showToast?.(this._t('reader.invalidFile', 'Please drop an image file'), 'error');
                return;
            }

            const sourceKind = options.sourceKind || 'file';
            this._currentSourceKind = sourceKind;
            this._currentOriginalSourcePath = options.originalSourcePath || '';
            this._setClipboardPasteState(false);

            // Show preview immediately (no need to clear first)
            const preview = document.getElementById('reader-image-preview');
            const dropZone = document.getElementById('reader-drop-zone');
            const resultPanel = document.getElementById('reader-result-panel');

            if (preview) {
                if (preview._blobUrl) URL.revokeObjectURL(preview._blobUrl);
                const url = URL.createObjectURL(file);
                preview._blobUrl = url;
                preview.src = url;
                preview.style.display = 'block';
            }
            if (dropZone) dropZone.style.display = 'none';
            // Switch the layout out of its empty state so the metadata column
            // (which is empty/zero-width until now) gets its space instead of
            // leaving a large blank void next to a lone drop zone.
            const containerLoad = (dropZone || preview)?.closest('.reader-container');
            if (containerLoad) containerLoad.classList.add('reader-has-image');

            // Show loading
            const statusEl = document.getElementById('reader-status');
            if (statusEl) {
                statusEl.textContent = this._t('reader.parsing', 'Reading image info...');
                statusEl.className = 'reader-status';
                statusEl.style.display = 'block';
            }
            if (resultPanel) resultPanel.style.display = 'none';

            try {
                const formData = new FormData();
                formData.append('file', file);

                const response = await fetch('/api/parse-image', {
                    method: 'POST',
                    body: formData,
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.detail || err.error || `HTTP ${response.status}`);
                }

                const result = await response.json();
                this._currentResult = result;
                this._currentImage = file;
                this._currentLibraryImageId = null;
                this._currentReaderTags = [];
                this._currentSourcePath = result?.source_temp_path || '';
                this._renderResult(result, file.name, { resetFormat: true, sourceKind });

                const clipboardWarning = this._getClipboardWarning(result, sourceKind);
                if (statusEl) {
                    if (clipboardWarning) {
                        statusEl.textContent = clipboardWarning;
                        statusEl.className = 'reader-status warning';
                        statusEl.style.display = 'block';
                    } else {
                        statusEl.textContent = '';
                        statusEl.style.display = 'none';
                    }
                }
                if (resultPanel) resultPanel.style.display = 'block';
                this._restoreReaderScrollState(options.preserveScrollState);
            } catch (error) {
                if (statusEl) {
                    statusEl.textContent = this._t('reader.parseFailed', `Could not read this image: ${error.message}`, {
                        message: error.message,
                    });
                    statusEl.className = 'reader-status error';
                }
            }
        },

        async openLibraryImage(imageId, filename = '') {
            const id = Number(imageId);
            if (!Number.isFinite(id) || id <= 0) {
                return false;
            }

            try {
                this._switchWorkspaceTool('reader');
                const scrollState = this._currentResult ? this._captureReaderScrollState() : null;
                const [response, detailResponse] = await Promise.all([
                    fetch(`/api/image-file/${id}`),
                    fetch(`/api/images/${id}`),
                ]);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const blob = await response.blob();
                const detailPayload = detailResponse.ok ? await detailResponse.json().catch(() => null) : null;
                const safeFilename = filename || `image-${id}.${(blob.type || 'image/png').split('/').pop() || 'png'}`;
                const file = new File([blob], safeFilename, {
                    type: blob.type || 'image/png',
                    lastModified: Date.now(),
                });
                await this._handleFile(file, {
                    sourceKind: 'library',
                    originalSourcePath: detailPayload?.image?.path || '',
                    preserveScrollState: scrollState,
                });
                this._currentLibraryImageId = id;
                this._currentReaderTags = Array.isArray(detailPayload?.tags) ? detailPayload.tags : [];
                this._renderReaderCategoryTags(this._currentResult);
                this._restoreReaderScrollState(scrollState);
                return true;
            } catch (error) {
                window.App?.showToast?.(
                    this._t('reader.loadLibraryFailed', 'Could not open this image in Reader'),
                    'error'
                );
                return false;
            }
        },

});
