/**
 * image-reader/metadata-editor.js — image-reader.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/image-reader.js pre-cut
 * lines 252-262 + 354-690 (of 1,749): _bindMetadataEditor (core's init still
 * calls it — both attach to the same object before init runs), the save-path
 * helpers (_isReaderTempSourcePath, _getBaseSourcePathForSuggestions,
 * _getCanonicalSourcePathForOverwrite, _getDefaultEditorFormat,
 * _getSuggestedOutputFilename, _getPreferredOutputDirectory, _joinPath,
 * _replacePathExtension, _normalizePathForComparison, _pathsReferToSameFile,
 * _confirmMetadataOverwrite, _markGalleryRefreshForIndexedOverwrite,
 * _buildSuggestedOutputPath) and the editor body
 * (_updateMetadataEditorFormatWarning/OutputHint/OutputPath,
 * _populateMetadataEditor, _collectEditedMetadataPayload,
 * _rememberMetadataEditorDirectory, _extractApiErrorMessage,
 * _saveEditedMetadata → POST /api/image-metadata/save-edited).
 * Classic script: joins the ONE unsealed window.ImageReader object declared in
 * image-reader/core.js, which loads FIRST; index.html lists the family in
 * original line order (boot.js invokes init() LAST).
 */
'use strict';

Object.assign(window.ImageReader, {
        _bindMetadataEditor() {
            document.getElementById('reader-edit-format')?.addEventListener('change', () => {
                this._updateMetadataEditorFormatWarning();
                this._updateMetadataEditorOutputPath();
            });

            document.getElementById('reader-save-metadata-as')?.addEventListener('click', () => {
                this._saveEditedMetadata(false);
            });
        },

        _isReaderTempSourcePath(path) {
            return /sd_image_sorter_reader_uploads/i.test(String(path || '').replace(/\\/g, '/'));
        },

        _getBaseSourcePathForSuggestions() {
            if (this._currentOriginalSourcePath) {
                return this._currentOriginalSourcePath;
            }
            if (this._currentSourcePath && !this._isReaderTempSourcePath(this._currentSourcePath)) {
                return this._currentSourcePath;
            }
            return '';
        },

        _getCanonicalSourcePathForOverwrite() {
            if (this._currentOriginalSourcePath) {
                return this._currentOriginalSourcePath;
            }
            return this._currentSourcePath || '';
        },

        _getDefaultEditorFormat() {
            const sourcePath = this._getBaseSourcePathForSuggestions() || this._currentImage?.name || this._currentSourcePath || '';
            const ext = String(sourcePath).split('.').pop()?.toLowerCase() || '';
            if (ext === 'jpeg') return 'jpg';
            if (['png', 'webp', 'jpg'].includes(ext)) return ext;
            return 'png';
        },

        _getSuggestedOutputFilename(format) {
            const sourcePath = this._getBaseSourcePathForSuggestions() || this._currentImage?.name || 'image.png';
            const filename = String(sourcePath).split(/[/\\]/).pop() || 'image.png';
            const stem = filename.replace(/\.[^.]+$/, '') || 'image';
            const ext = format === 'jpg' ? '.jpg' : `.${format}`;
            return `${stem}.edited${ext}`;
        },

        _getPreferredOutputDirectory() {
            const sourcePath = this._getBaseSourcePathForSuggestions();
            if (sourcePath) {
                const normalized = String(sourcePath);
                const cutIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
                if (cutIndex > 0) {
                    return normalized.slice(0, cutIndex);
                }
            }

            try {
                return localStorage.getItem(this._metadataEditorStorageKey) || '';
            } catch (_) {
                return '';
            }
        },

        _joinPath(directory, filename) {
            if (!directory) return '';
            const trimmed = String(directory).replace(/[\\/]+$/, '');
            const useBackslash = trimmed.includes('\\') && !trimmed.includes('/');
            return `${trimmed}${useBackslash ? '\\' : '/'}${filename}`;
        },

        _replacePathExtension(path, format) {
            if (!path) return '';
            const ext = format === 'jpg' ? '.jpg' : `.${format}`;
            const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
            const prefix = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
            const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
            const stem = filename.replace(/\.[^.]+$/, '') || filename;
            return `${prefix}${stem}${ext}`;
        },

        _normalizePathForComparison(path) {
            const normalized = String(path || '').trim().replace(/\\/g, '/');
            if (!normalized) return '';
            if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
                return normalized.toLowerCase();
            }
            return normalized;
        },

        _pathsReferToSameFile(left, right) {
            const normalizedLeft = this._normalizePathForComparison(left);
            const normalizedRight = this._normalizePathForComparison(right);
            return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
        },

        _confirmMetadataOverwrite(outputPath) {
            const title = this._t('reader.editOverwriteTitle', 'Replace this file?');
            const message = this._t(
                'reader.editOverwriteMessage',
                '{path} already exists, or it is the image you are editing. Replace it?',
                { path: outputPath },
            );
            if (window.App?.showConfirm) {
                window.App.showConfirm(title, message, () => this._saveEditedMetadata(true));
            } else if (window.confirm(message)) {
                this._saveEditedMetadata(true);
            }
        },

        _markGalleryRefreshForIndexedOverwrite(savedOutputPath, originalSourcePath = this._currentOriginalSourcePath) {
            const app = window.App;
            if (!app?.AppState) return;

            const matchesOriginalSource = this._pathsReferToSameFile(savedOutputPath, originalSourcePath);
            const matchesLoadedImagePath = Array.isArray(app.AppState.images) && app.AppState.images.some((image) =>
                this._pathsReferToSameFile(savedOutputPath, image?.path || '')
            );

            if (!matchesOriginalSource && !matchesLoadedImagePath) {
                return;
            }

            if (typeof app.markGalleryNeedsRefresh === 'function') {
                app.markGalleryNeedsRefresh();
            }
        },

        _buildSuggestedOutputPath(format) {
            const directory = this._getPreferredOutputDirectory();
            const filename = this._getSuggestedOutputFilename(format);
            return directory ? this._joinPath(directory, filename) : '';
        },

        _updateMetadataEditorFormatWarning() {
            const warningEl = document.getElementById('reader-edit-format-warning');
            const format = document.getElementById('reader-edit-format')?.value || 'png';
            if (!warningEl) return;

            let warning = '';
            if (format === 'jpg') {
                warning = this._t(
                    'reader.editFormatWarningJpg',
                    'JPG is great for sharing, but it will not keep the full image info. Transparent areas will also be flattened.',
                );
            } else if (format === 'webp') {
                warning = this._t(
                    'reader.editFormatWarningWebp',
                    'WebP usually keeps more image info than JPG, but some apps still fail to read every prompt field back.',
                );
            }

            warningEl.textContent = warning;
            warningEl.hidden = !warning;
        },

        _updateMetadataEditorOutputHint() {
            const hintEl = document.getElementById('reader-edit-output-hint');
            if (!hintEl) return;

            const directory = this._getPreferredOutputDirectory();
            hintEl.textContent = directory
                ? this._t(
                    'reader.editOutputHintUsingFolder',
                    'Default save folder: {path}',
                    { path: directory },
                )
                : this._t(
                    'reader.editOutputHint',
                    'If this image came from the browser, the app does not know the original folder yet. Enter one full save path once, and it will remember the folder.',
                );
        },

        _updateMetadataEditorOutputPath(force = false) {
            const format = document.getElementById('reader-edit-format')?.value || 'png';
            const outputInput = document.getElementById('reader-edit-output-path');
            if (!outputInput) return;

            const suggestedPath = this._buildSuggestedOutputPath(format);
            const currentValue = outputInput.value.trim();

            if (force) {
                outputInput.value = suggestedPath || '';
            } else if (!currentValue) {
                outputInput.value = suggestedPath || '';
            } else if (currentValue === this._lastSuggestedOutputPath) {
                outputInput.value = suggestedPath || '';
            } else {
                outputInput.value = this._replacePathExtension(currentValue, format);
            }

            outputInput.placeholder = this._getSuggestedOutputFilename(format);
            this._lastSuggestedOutputPath = suggestedPath || '';
            this._updateMetadataEditorOutputHint();
        },

        _populateMetadataEditor(result) {
            const editor = document.getElementById('reader-metadata-editor');
            const promptInput = document.getElementById('reader-edit-prompt');
            const negativeInput = document.getElementById('reader-edit-negative');
            const seedInput = document.getElementById('reader-edit-seed');
            const modelInput = document.getElementById('reader-edit-model');
            const samplerInput = document.getElementById('reader-edit-sampler');
            const stepsInput = document.getElementById('reader-edit-steps');
            const cfgInput = document.getElementById('reader-edit-cfg');
            const sizeInput = document.getElementById('reader-edit-size');
            const lorasInput = document.getElementById('reader-edit-loras');
            const formatSelect = document.getElementById('reader-edit-format');
            if (!editor || !promptInput || !negativeInput || !seedInput || !modelInput || !samplerInput || !stepsInput || !cfgInput || !sizeInput || !lorasInput || !formatSelect) {
                return;
            }

            const gp = this._getGenParams(result);
            const loras = this._getLoras(result);
            const format = this._getDefaultEditorFormat();

            editor.hidden = false;
            promptInput.value = result?.prompt || '';
            negativeInput.value = result?.negative_prompt || '';
            seedInput.value = gp.seed ?? gp.noise_seed ?? '';
            modelInput.value = result?.checkpoint || gp.model || '';
            samplerInput.value = gp.sampler || '';
            stepsInput.value = gp.steps ?? '';
            cfgInput.value = gp.cfg_scale ?? '';
            sizeInput.value = gp.size || ((result?.width && result?.height) ? `${result.width}x${result.height}` : '');
            lorasInput.value = Array.isArray(loras) ? loras.join(', ') : '';
            formatSelect.value = format;

            this._updateMetadataEditorOutputPath(true);
            this._updateMetadataEditorFormatWarning();
        },

        _collectEditedMetadataPayload() {
            const payload = {};
            const putText = (key, id) => {
                const value = document.getElementById(id)?.value?.trim();
                if (value) payload[key] = value;
            };

            putText('prompt', 'reader-edit-prompt');
            putText('negative_prompt', 'reader-edit-negative');
            putText('seed', 'reader-edit-seed');
            putText('model', 'reader-edit-model');
            putText('sampler', 'reader-edit-sampler');
            putText('size', 'reader-edit-size');
            putText('loras', 'reader-edit-loras');

            const stepsValue = document.getElementById('reader-edit-steps')?.value?.trim();
            if (stepsValue !== '') {
                payload.steps = Number.parseInt(stepsValue, 10);
            }

            const cfgValue = document.getElementById('reader-edit-cfg')?.value?.trim();
            if (cfgValue !== '') {
                payload.cfg_scale = Number.parseFloat(cfgValue);
            }

            return payload;
        },

        _rememberMetadataEditorDirectory(outputPath) {
            if (!outputPath) return;
            const cutIndex = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
            if (cutIndex <= 0) return;
            try {
                localStorage.setItem(this._metadataEditorStorageKey, outputPath.slice(0, cutIndex));
            } catch (_) {
                // Ignore storage failures in private/incognito contexts.
            }
        },

        _extractApiErrorMessage(payload, fallback) {
            return payload?.detail || payload?.error || payload?.message || fallback;
        },

        async _saveEditedMetadata(allowOverwrite = false) {
            const format = document.getElementById('reader-edit-format')?.value || 'png';
            const outputInput = document.getElementById('reader-edit-output-path');
            const outputPath = outputInput?.value?.trim() || '';

            if (!this._currentSourcePath) {
                window.App?.showToast?.(this._t('reader.editSaveMissingSource', 'This image no longer has a readable source to save from. Reload it first.'), 'error');
                return;
            }

            if (!outputPath) {
                window.App?.showToast?.(this._t('reader.editOutputNeedPath', 'Enter a full output path before saving.'), 'error');
                outputInput?.focus?.();
                return;
            }

            // Same-path overwrite is predictable on the client, so confirm first
            // instead of spamming a guaranteed 409 into the browser console.
            const overwriteComparisonSourcePath = this._getCanonicalSourcePathForOverwrite();
            if (!allowOverwrite && this._pathsReferToSameFile(outputPath, overwriteComparisonSourcePath)) {
                this._confirmMetadataOverwrite(outputPath);
                return;
            }

            try {
                const response = await fetch('/api/image-metadata/save-edited', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_path: this._currentSourcePath,
                        output_path: outputPath,
                        format,
                        metadata: this._collectEditedMetadataPayload(),
                        allow_overwrite: allowOverwrite,
                    }),
                });

                const payload = await response.json().catch(() => ({}));

                if (response.status === 409 && !allowOverwrite) {
                    this._confirmMetadataOverwrite(outputPath);
                    return;
                }

                if (!response.ok) {
                    throw new Error(this._extractApiErrorMessage(payload, this._t('reader.editSaveFailed', 'Failed to save edited image.')));
                }

                const savedOutputPath = payload.output_path || outputPath;
                const previousOriginalSourcePath = this._currentOriginalSourcePath;
                this._currentSourcePath = savedOutputPath;
                this._currentOriginalSourcePath = savedOutputPath;
                this._rememberMetadataEditorDirectory(savedOutputPath);
                this._lastSuggestedOutputPath = savedOutputPath;
                if (outputInput) {
                    outputInput.value = savedOutputPath;
                }
                this._updateMetadataEditorOutputHint();
                this._markGalleryRefreshForIndexedOverwrite(savedOutputPath, previousOriginalSourcePath);

                window.App?.showToast?.(this._t('reader.editSaveSuccess', 'Saved edited image copy'), 'success');
                if (Array.isArray(payload.warnings) && payload.warnings.length) {
                    window.App?.showToast?.(payload.warnings.join(' '), 'warning');
                }
            } catch (error) {
                window.App?.showToast?.(
                    this._extractApiErrorMessage(error, this._t('reader.editSaveFailed', 'Failed to save edited image.')),
                    'error',
                );
            }
        },

});
