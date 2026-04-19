/**
 * SD Image Sorter - Image Reader Tab
 * Drag & drop image to instantly view metadata without scanning to library.
 * Supports drag-replace (drop new image anytime), shows all hashes, LoRAs, and model info.
 */

(function () {
    'use strict';

    const ImageReader = {
        _currentImage: null,
        _currentResult: null,
        _promptFormat: 'original', // 'original' | 'sd' | 'nai'
        _histogramMode: 'rgb',
        _languageBound: false,
        _currentSourceKind: 'file',
        _awaitingClipboardPaste: false,
        _collapsedState: {
            prompt: true,
            negative: false,
            params: false,
            modelAssets: false,
            loras: false,
            hashes: false,
        },

        init() {
            const dropZone = document.getElementById('reader-drop-zone');
            const fileInput = document.getElementById('reader-file-input');
            const container = document.getElementById('view-reader');
            if (!dropZone) return;

            this._bindWorkspaceTabs();

            // Drop zone handlers
            this._setupDropZone(dropZone, fileInput);

            // Allow drag-replace: the ENTIRE reader view accepts drops
            if (container) {
                container.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                });
                container.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const files = e.dataTransfer?.files;
                    if (files?.length > 0) {
                        this._handleFile(files[0], { sourceKind: 'file' });
                    }
                });
            }

            // Copy buttons
            document.getElementById('reader-copy-prompt')?.addEventListener('click', () => this._copy('prompt'));
            document.getElementById('reader-copy-negative')?.addEventListener('click', () => this._copy('negative'));
            document.getElementById('reader-copy-params')?.addEventListener('click', () => this._copy('params'));
            document.getElementById('reader-copy-all')?.addEventListener('click', () => this._copy('all'));
            document.getElementById('reader-copy-sd')?.addEventListener('click', () => this._copy('sd'));
            document.getElementById('reader-clear')?.addEventListener('click', () => this._clear());
            document.getElementById('reader-toggle-format')?.addEventListener('click', () => this._toggleFormat());

            // Paste button — stop propagation so clicking it doesn't also open the file picker
            const pasteBtn = document.getElementById('reader-paste-btn');
            if (pasteBtn) {
                pasteBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._handlePaste();
                });
            }

            // Global Ctrl+V listener — only acts when the reader view is active
            document.addEventListener('paste', (e) => {
                const readerView = document.getElementById('view-reader');
                if (!readerView || readerView.style.display === 'none') return;
                if (!this._isReaderToolActive()) return;

                const target = e.target;
                const tag = (target?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

                const items = e.clipboardData?.items;
                if (!items) {
                    if (this._awaitingClipboardPaste) {
                        this._setClipboardPasteState(false);
                        window.App?.showToast?.(this._t('reader.pasteNoImage', 'No image found in clipboard'), 'error');
                    }
                    return;
                }
                for (const item of items) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) {
                            e.preventDefault();
                            const sourceKind = this._awaitingClipboardPaste ? 'clipboard-button' : 'clipboard-shortcut';
                            this._setClipboardPasteState(false);
                            this._handleFile(file, { sourceKind });
                            return;
                        }
                    }
                }

                if (this._awaitingClipboardPaste) {
                    e.preventDefault();
                    this._setClipboardPasteState(false);
                    window.App?.showToast?.(this._t('reader.pasteNoImage', 'No image found in clipboard'), 'error');
                }
            });
            document.querySelectorAll('[data-reader-histogram-mode]').forEach((button) => {
                button.addEventListener('click', () => {
                    this._histogramMode = button.dataset.readerHistogramMode || 'rgb';
                    document.querySelectorAll('[data-reader-histogram-mode]').forEach((node) => {
                        node.classList.toggle('active', node === button);
                    });
                    this._renderReaderColorDistribution();
                });
            });
            this._bindSectionToggles();

            this._syncStaticLabels();

            if (!this._languageBound) {
                document.addEventListener('languageChanged', () => {
                    this._syncStaticLabels();
                    if (this._currentResult) {
                        this._renderResult(this._currentResult, this._currentImage?.name || '', { resetFormat: false });
                    }
                });
                this._languageBound = true;
            }
        },

        _bindWorkspaceTabs() {
            document.querySelectorAll('#view-reader .reader-tool-tab').forEach((tab) => {
                tab.addEventListener('click', () => {
                    const tool = tab.dataset.readerTool;
                    if (!tool) return;
                    this._switchWorkspaceTool(tool);
                });
            });
        },

        _switchWorkspaceTool(tool) {
            document.querySelectorAll('#view-reader .reader-tool-tab').forEach((tab) => {
                const active = tab.dataset.readerTool === tool;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', String(active));
            });

            document.querySelectorAll('#view-reader .reader-tool-panel').forEach((panel) => {
                const active = panel.id === `reader-tool-panel-${tool}`;
                panel.classList.toggle('active', active);
                panel.hidden = !active;
            });
        },

        _t(key, fallback, params) {
            return window.I18n?.t?.(key, params) || fallback;
        },

        _formatLabel(format) {
            const labels = {
                original: this._t('reader.formatOriginal', 'Original'),
                sd: this._t('reader.formatSd', 'SD / A1111'),
                nai: this._t('reader.formatNai', 'NAI'),
            };
            return this._t('reader.formatLabel', `Format: ${labels[format] || labels.original}`, {
                format: labels[format] || labels.original,
            });
        },

        _updateFormatButton() {
            const btn = document.getElementById('reader-toggle-format');
            if (btn) {
                btn.textContent = this._formatLabel(this._promptFormat);
            }
        },

        _syncStaticLabels() {
            this._updateFormatButton();
            const copySdBtn = document.getElementById('reader-copy-sd');
            if (copySdBtn) {
                copySdBtn.textContent = this._t('reader.copySd', 'Copy as SD Format');
            }
        },

        _bindSectionToggles() {
            document.querySelectorAll('#view-reader .reader-section-toggle').forEach((toggle) => {
                toggle.addEventListener('click', () => {
                    const key = toggle.dataset.collapseKey;
                    const target = document.getElementById(toggle.dataset.target);
                    if (!key || !target) return;
                    this._collapsedState[key] = !this._collapsedState[key];
                    this._applySectionState(toggle, target, this._collapsedState[key]);
                });
            });
        },

        _applySectionState(toggle, target, expanded) {
            target.style.display = expanded ? '' : 'none';
            toggle.classList.toggle('is-collapsed', !expanded);
            const icon = toggle.querySelector('.collapse-icon');
            if (icon) icon.textContent = expanded ? '▼' : '▶';
        },

        _syncSectionStates() {
            document.querySelectorAll('#view-reader .reader-section-toggle').forEach((toggle) => {
                const key = toggle.dataset.collapseKey;
                const target = document.getElementById(toggle.dataset.target);
                if (!key || !target) return;
                const expanded = this._collapsedState[key] !== false;
                this._applySectionState(toggle, target, expanded);
            });
        },

        /**
         * Strip path prefix and file extension from model name.
         * "Anima\\anime\\name.safetensors" → "name"
         */
        _cleanModelName(fullName) {
            if (!fullName) return '';
            let name = fullName.replace(/\\/g, '/').split('/').pop() || fullName;
            name = name.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
            return name;
        },

        _toggleFormat() {
            const formats = ['original', 'sd', 'nai'];
            const idx = formats.indexOf(this._promptFormat);
            this._promptFormat = formats[(idx + 1) % formats.length];
            this._updateFormatButton();

            if (this._currentResult) {
                this._renderPromptSection(this._currentResult);
            }
        },

        _buildGalleryPromptContext(result) {
            const metadata = result?.metadata && typeof result.metadata === 'object'
                ? result.metadata
                : {};
            return {
                image: {
                    generator: result?.generator || 'unknown',
                    prompt: result?.prompt || '',
                    negative_prompt: result?.negative_prompt || '',
                    checkpoint: result?.checkpoint || '',
                    metadata_json: metadata,
                },
                parsedData: metadata?._parsed || {
                    generation_params: {},
                    is_img2img: false,
                    img2img_info: {},
                    character_prompts: [],
                    prompt_nodes: [],
                },
            };
        },

        _buildPromptView(result, targetFormat) {
            const gallery = window.Gallery;
            const { image, parsedData } = this._buildGalleryPromptContext(result);

            if (gallery && typeof gallery._buildPromptView === 'function') {
                return gallery._buildPromptView(image, parsedData, targetFormat);
            }

            return {
                promptText: result?.prompt || '',
                negativeText: result?.negative_prompt || '',
                targetFormat: targetFormat || 'original',
                formatLabel: targetFormat || 'Original',
            };
        },

        _renderPromptSection(result, options = {}) {
            const t = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const promptView = this._buildPromptView(result, this._promptFormat);
            const clipboardMetadataMissing = Boolean(options.clipboardMetadataMissing);
            const promptText = clipboardMetadataMissing
                ? t(
                    'reader.clipboardWarningPromptFallback',
                    'Clipboard image likely lost SD metadata. Open the original PNG file to read the prompt.',
                )
                : (promptView?.promptText || t('reader.noPrompt', 'No prompt found'));
            this._setText('reader-prompt-text', promptText);
            this._setText('reader-negative-text', promptView?.negativeText || t('reader.noNegative', 'No negative prompt'));

            const negSection = document.getElementById('reader-negative-section');
            if (negSection) {
                negSection.style.display = (!clipboardMetadataMissing && promptView?.negativeText) ? '' : 'none';
            }
        },

        _renderReaderColorDistribution() {
            const preview = document.getElementById('reader-image-preview');
            const section = document.getElementById('reader-color-section');
            const histCanvas = document.getElementById('reader-color-histogram-canvas');
            const paletteEl = document.getElementById('reader-color-palette');
            if (!preview || !section || !histCanvas || !paletteEl || !preview.naturalWidth) return;

            document.querySelectorAll('[data-reader-histogram-mode]').forEach((button) => {
                button.classList.toggle('active', button.dataset.readerHistogramMode === this._histogramMode);
            });

            try {
                const sampleCanvas = document.createElement('canvas');
                const sampleSize = 128;
                sampleCanvas.width = sampleSize;
                sampleCanvas.height = sampleSize;
                const sampleCtx = sampleCanvas.getContext('2d');
                sampleCtx.drawImage(preview, 0, 0, sampleSize, sampleSize);
                const data = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;

                const rHist = new Uint32Array(256);
                const gHist = new Uint32Array(256);
                const bHist = new Uint32Array(256);
                const lHist = new Uint32Array(256);
                const buckets = {};

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    rHist[r]++;
                    gHist[g]++;
                    bHist[b]++;
                    lHist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;

                    const br = Math.round(r / 32) * 32;
                    const bg = Math.round(g / 32) * 32;
                    const bb = Math.round(b / 32) * 32;
                    const key = `${br},${bg},${bb}`;
                    if (!buckets[key]) buckets[key] = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
                    buckets[key].count++;
                    buckets[key].sumR += r;
                    buckets[key].sumG += g;
                    buckets[key].sumB += b;
                }

                const ctx = histCanvas.getContext('2d');
                const rect = histCanvas.parentElement.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                const width = Math.max(256, Math.floor(rect.width * dpr));
                const height = Math.max(96, Math.floor(96 * dpr));
                histCanvas.width = width;
                histCanvas.height = height;
                ctx.clearRect(0, 0, width, height);

                let maxVal = 1;
                for (let i = 1; i < 255; i++) {
                    maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i]);
                }

                const drawChannel = (hist, color) => {
                    ctx.beginPath();
                    ctx.moveTo(0, height);
                    for (let i = 0; i < 256; i++) {
                        const x = (i / 255) * width;
                        const barH = Math.min(height, (hist[i] / maxVal) * height * 0.92);
                        ctx.lineTo(x, height - barH);
                    }
                    ctx.lineTo(width, height);
                    ctx.closePath();
                    ctx.fillStyle = color;
                    ctx.fill();
                };

                const mode = this._histogramMode || 'rgb';
                if (mode === 'luma') {
                    drawChannel(lHist, 'rgba(255,255,255,0.2)');
                } else if (mode === 'split') {
                    const drawLine = (hist, color, bandIndex) => {
                        const bandHeight = height / 3;
                        const bandTop = bandHeight * bandIndex;
                        ctx.beginPath();
                        ctx.moveTo(0, bandTop + bandHeight);
                        for (let i = 0; i < 256; i++) {
                            const x = (i / 255) * width;
                            const barH = Math.min(bandHeight, (hist[i] / maxVal) * bandHeight * 0.92);
                            ctx.lineTo(x, bandTop + bandHeight - barH);
                        }
                        ctx.strokeStyle = color;
                        ctx.lineWidth = 2;
                        ctx.stroke();
                    };
                    drawLine(rHist, 'rgba(239,68,68,0.95)', 0);
                    drawLine(gHist, 'rgba(52,211,153,0.95)', 1);
                    drawLine(bHist, 'rgba(66,133,244,0.95)', 2);
                } else {
                    drawChannel(lHist, 'rgba(255,255,255,0.08)');
                    drawChannel(bHist, 'rgba(66,133,244,0.35)');
                    drawChannel(gHist, 'rgba(52,211,153,0.35)');
                    drawChannel(rHist, 'rgba(239,68,68,0.35)');
                }

                const sorted = Object.values(buckets)
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 9);
                const total = sorted.reduce((sum, bucket) => sum + bucket.count, 0) || 1;

                paletteEl.innerHTML = sorted.map((bucket) => {
                    const avgR = Math.round(bucket.sumR / bucket.count);
                    const avgG = Math.round(bucket.sumG / bucket.count);
                    const avgB = Math.round(bucket.sumB / bucket.count);
                    const hex = `#${[avgR, avgG, avgB].map(v => v.toString(16).padStart(2, '0')).join('')}`;
                    const pct = ((bucket.count / total) * 100).toFixed(1);
                    return `<div class="reader-color-swatch" onclick="navigator.clipboard.writeText('${hex}')" title="Click to copy ${hex}">
                        <span class="swatch-dot" style="background:${hex}"></span>
                        <span>${this._escapeHtml(hex)}</span>
                        <span class="reader-color-share">${this._escapeHtml(pct)}%</span>
                    </div>`;
                }).join('');

                section.style.display = '';
            } catch (_) {
                section.style.display = 'none';
            }
        },

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

        _isReaderToolActive() {
            const readerPanel = document.getElementById('reader-tool-panel-reader');
            if (!readerPanel) return true; // no tool tabs yet, assume reader is active
            return readerPanel.classList.contains('active');
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
                    'This clipboard image did not include original SD metadata. Drag or browse the PNG file itself to read prompt, checkpoint, and params.',
                );
            }

            return this._t(
                'reader.clipboardWarning',
                'Clipboard images may lose original SD PNG metadata. If prompt or checkpoint looks incomplete, drag-drop the original file instead.',
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
                    'Clipboard capture is ready. Press Ctrl+V now. Clipboard images may lose SD metadata; drag-drop the original PNG for guaranteed metadata.',
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

            // Show loading
            const statusEl = document.getElementById('reader-status');
            if (statusEl) {
                statusEl.textContent = this._t('reader.parsing', 'Parsing metadata...');
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
            } catch (error) {
                if (statusEl) {
                    statusEl.textContent = this._t('reader.parseFailed', `Failed to parse: ${error.message}`, {
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
                const response = await fetch(`/api/image-file/${id}`);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const blob = await response.blob();
                const safeFilename = filename || `image-${id}.${(blob.type || 'image/png').split('/').pop() || 'png'}`;
                const file = new File([blob], safeFilename, {
                    type: blob.type || 'image/png',
                    lastModified: Date.now(),
                });
                await this._handleFile(file, { sourceKind: 'library' });
                return true;
            } catch (error) {
                window.App?.showToast?.(
                    this._t('reader.loadLibraryFailed', 'Failed to load image into Reader'),
                    'error'
                );
                return false;
            }
        },

        _getGenParams(result) {
            const metadata = result.metadata;
            if (!metadata) return {};
            try {
                const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
                return parsed?._parsed?.generation_params || parsed?.generation_params || {};
            } catch (_) {
                return {};
            }
        },

        _getModelAssets(result) {
            const metadata = result?.metadata;
            if (!metadata) return null;
            try {
                const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
                return parsed?._parsed?.model_assets || null;
            } catch (_) {
                return null;
            }
        },

        _getLoras(result) {
            // Try direct loras field first
            let loras = result.loras;
            if (typeof loras === 'string') {
                try { loras = JSON.parse(loras); } catch (_) { loras = []; }
            }
            if (Array.isArray(loras) && loras.length > 0) return loras;

            // Fallback: extract from prompt <lora:name:weight> patterns
            const prompt = result.prompt || '';
            const matches = prompt.match(/<lora:([^:>]+)(?::[^>]+)?>/gi);
            if (matches) {
                return matches.map(m => {
                    const match = m.match(/<lora:([^:>]+)/i);
                    return match ? match[1] : null;
                }).filter(Boolean);
            }

            return [];
        },

        _getAllHashes(result) {
            const gp = this._getGenParams(result);
            const hashes = {};

            // Model hash
            if (gp.model_hash) hashes.model = gp.model_hash;

            // Lora hashes (WebUI format: "loraName: hash, loraName2: hash2")
            const loraHashStr = gp.lora_hashes || gp['Lora hashes'] || '';
            if (loraHashStr) {
                const pairs = loraHashStr.split(',').map(s => s.trim());
                for (const pair of pairs) {
                    const [name, hash] = pair.split(':').map(s => s.trim());
                    if (name && hash) hashes[`lora:${name}`] = hash;
                }
            }

            // TI hashes
            const tiHashStr = gp.ti_hashes || gp['TI hashes'] || '';
            if (tiHashStr) {
                const pairs = tiHashStr.split(',').map(s => s.trim());
                for (const pair of pairs) {
                    const [name, hash] = pair.split(':').map(s => s.trim());
                    if (name && hash) hashes[`ti:${name}`] = hash;
                }
            }

            return hashes;
        },

        _renderModelAssetsSection(result) {
            const section = document.getElementById('reader-model-assets-section');
            const container = document.getElementById('reader-model-assets');
            if (!section || !container) return;

            const assets = this._getModelAssets(result);
            const hasAssets = assets && (
                assets.primary_model_name ||
                (assets.loras && assets.loras.length) ||
                (assets.yolo_models && assets.yolo_models.length) ||
                (assets.checkpoint_candidates && assets.checkpoint_candidates.length) ||
                (assets.unet_candidates && assets.unet_candidates.length) ||
                (assets.diffusion_model_candidates && assets.diffusion_model_candidates.length) ||
                (assets.model_candidates && assets.model_candidates.length) ||
                (assets.yolo_candidates && assets.yolo_candidates.length) ||
                (assets.global_lora_candidates && assets.global_lora_candidates.length) ||
                (assets.global_yolo_candidates && assets.global_yolo_candidates.length)
            );

            if (!hasAssets) {
                section.style.display = 'none';
                container.innerHTML = '';
                return;
            }

            const blocks = [];
            const humanizeSource = (value) => {
                if (!value) return '';
                if (value === 'activity_subgraph_fallback') return this._t('reader.modelAssetsSourceActivity', 'Active subgraph fallback');
                if (value === 'global_candidate_fallback') return this._t('reader.modelAssetsSourceGlobal', 'Global candidate fallback');
                if (value === 'global_graph_fallback') return this._t('reader.modelAssetsSourceGraph', 'Full graph fallback');
                if (value === 'fast_path') return this._t('reader.modelAssetsSourceFastPath', 'Fast path');
                return String(value).replace(/_/g, ' ');
            };
            const humanizeConfidence = (value) => {
                if (value === 'high') return this._t('reader.modelAssetsConfidenceHigh', 'High confidence');
                if (value === 'medium') return this._t('reader.modelAssetsConfidenceMedium', 'Medium confidence');
                if (value === 'low') return this._t('reader.modelAssetsConfidenceLow', 'Low confidence');
                return '';
            };
            const addListBlock = (titleKey, titleFallback, values) => {
                if (!Array.isArray(values) || values.length === 0) return;
                const uniqueValues = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
                if (!uniqueValues.length) return;
                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t(titleKey, titleFallback))}</div>
                        <div class="reader-model-asset-list">
                            ${uniqueValues.map((value) => `<span class="reader-model-asset-pill">${this._escapeHtml(value)}</span>`).join('')}
                        </div>
                    </div>
                `);
            };
            const addCandidateBlock = (titleKey, titleFallback, items) => {
                if (!Array.isArray(items) || items.length === 0) return;
                const uniqueItems = [];
                const seenNames = new Set();
                for (const item of items) {
                    const name = String(item?.name || '').trim();
                    if (!name || seenNames.has(name)) continue;
                    seenNames.add(name);
                    uniqueItems.push(item);
                }
                if (!uniqueItems.length) return;

                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t(titleKey, titleFallback))}</div>
                        <div class="model-asset-candidate-list">
                            ${uniqueItems.map((item) => {
                                const confidence = String(item?.confidence || 'low').toLowerCase();
                                const metaParts = [
                                    humanizeSource(item?.source_mode),
                                    item?.node_id ? `${this._t('reader.modelAssetsNode', 'Node')} ${item.node_id}` : '',
                                    item?.class_type ? String(item.class_type) : '',
                                    item?.key_path ? String(item.key_path) : (item?.input_key ? String(item.input_key) : ''),
                                ].filter(Boolean);
                                return `
                                    <div class="model-asset-candidate model-asset-candidate-secondary">
                                        <div class="model-asset-candidate-head">
                                            <span class="reader-model-asset-pill">${this._escapeHtml(String(item?.name || ''))}</span>
                                            <span class="model-asset-confidence is-${this._escapeHtml(confidence)}">${this._escapeHtml(humanizeConfidence(confidence))}</span>
                                        </div>
                                        <div class="model-asset-candidate-meta">${this._escapeHtml(metaParts.join(' • '))}</div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `);
            };

            if (assets.primary_model_name) {
                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t('reader.primaryModel', 'Primary Model'))}</div>
                        <div class="reader-model-asset-value">${this._escapeHtml(assets.primary_model_name)}</div>
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t('reader.primaryModelType', 'Primary Model Type'))}: ${this._escapeHtml(assets.primary_model_type || 'unknown')}</div>
                    </div>
                `);
            }

            if (assets.source) {
                blocks.push(`
                    <div class="reader-model-asset-block">
                        <div class="reader-model-asset-title">${this._escapeHtml(this._t('reader.modelAssetsSource', 'Parser Source'))}</div>
                        <div class="reader-model-asset-value">${this._escapeHtml(humanizeSource(assets.source))}</div>
                    </div>
                `);
            }
            if (Array.isArray(assets.sources) && assets.sources.length > 1) {
                addListBlock('reader.modelAssetsSources', 'All Sources', assets.sources.map((value) => humanizeSource(value)));
            }

            addListBlock('reader.modelAssetsCheckpoints', 'Checkpoint Candidates', (assets.checkpoint_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsUnets', 'UNet Candidates', (assets.unet_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsDiffusion', 'Diffusion Candidates', (assets.diffusion_model_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsModels', 'Additional / Upscale / ControlNet Models', (assets.model_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsLoras', 'LoRA Candidates', (assets.lora_candidates || []).map((item) => item.name));
            addListBlock('reader.modelAssetsYolo', 'YOLO / Detector Models', assets.yolo_models || (assets.yolo_candidates || []).map((item) => item.name));
            addCandidateBlock('reader.modelAssetsGlobalLoras', 'Global LoRA Candidates', assets.global_lora_candidates || []);
            addCandidateBlock('reader.modelAssetsGlobalYolo', 'Full-graph YOLO Candidates', assets.global_yolo_candidates || []);

            container.innerHTML = blocks.join('');
            section.style.display = '';
        },

        _renderResult(result, filename, options = {}) {
            const t = (key, fallback) => window.I18n?.t?.(key) || fallback;
            const gp = this._getGenParams(result);
            const resetFormat = options.resetFormat !== false;

            // Generator badge
            const genEl = document.getElementById('reader-generator');
            if (genEl) {
                const gen = result.generator || 'unknown';
                genEl.textContent = gen.toUpperCase();
                genEl.className = `reader-generator-badge gen-${gen}`;
            }

            // File info
            const infoEl = document.getElementById('reader-file-info');
            if (infoEl) {
                const parts = [filename];
                if (result.width && result.height) parts.push(`${result.width}×${result.height}`);
                if (result.file_size) parts.push(this._formatSize(result.file_size));
                infoEl.textContent = parts.join(' • ');
            }

            // Prompt — use format-aware rendering
            if (resetFormat) {
                this._promptFormat = 'original';
            }
            this._updateFormatButton();
            const clipboardMetadataMissing = this._clipboardMetadataMissing(result, options.sourceKind || this._currentSourceKind);
            this._renderPromptSection(result, { clipboardMetadataMissing });

            // Checkpoint — strip path, show clean name, tooltip for full path
            const cpRaw = result.checkpoint || gp.model || '';
            const cpClean = this._cleanModelName(cpRaw);
            const cpEl = document.getElementById('reader-checkpoint');
            if (cpEl) {
                cpEl.textContent = cpClean || '-';
                cpEl.title = cpRaw || '';
            }

            // Model Hash — hide entirely for ComfyUI (no hashes available)
            const hashRow = document.querySelector('.reader-hash-row');
            const allHashes = this._getAllHashes(result);
            const hasAnyHash = Object.keys(allHashes).length > 0;
            if (hashRow) {
                if (hasAnyHash && allHashes.model) {
                    const hashEl = document.getElementById('reader-model-hash');
                    if (hashEl) hashEl.textContent = allHashes.model;
                    hashRow.style.display = '';
                } else {
                    hashRow.style.display = 'none';
                }
            }

            // LoRAs — strip paths, show clean names, tooltip for full path
            const lorasEl = document.getElementById('reader-loras');
            const loras = this._getLoras(result);

            if (lorasEl) {
                if (loras.length > 0) {
                    lorasEl.innerHTML = loras.map(l => {
                        const clean = this._cleanModelName(l);
                        const hash = allHashes[`lora:${l}`] || allHashes[`lora:${clean}`] || '';
                        const searchQuery = hash || clean;
                        const searchUrl = `https://civitai.com/search/models?sortBy=models_v9&query=${encodeURIComponent(searchQuery)}`;
                        const hashBadge = hash ? ` <span class="reader-hash-badge" title="${this._escapeHtml(hash)}">${this._escapeHtml(hash.slice(0, 10))}</span>` : '';
                        return `<a href="${searchUrl}" target="_blank" rel="noopener" class="reader-lora-tag" title="${this._escapeHtml(l)}">${this._escapeHtml(clean)}${hashBadge}</a>`;
                    }).join('');
                } else {
                    lorasEl.textContent = t('reader.noLoras', 'No LoRAs detected');
                }
            }

            // All Hashes section — only show if there are hashes (WebUI images)
            const hashesEl = document.getElementById('reader-hashes');
            if (hashesEl) {
                const hashEntries = Object.entries(allHashes);
                const hashSection = document.getElementById('reader-hashes-section');
                if (hashEntries.length > 0) {
                    hashesEl.innerHTML = hashEntries.map(([name, hash]) => {
                        const searchUrl = `https://civitai.com/search/models?sortBy=models_v9&query=${encodeURIComponent(hash)}`;
                        return `<div class="reader-hash-entry">
                            <span class="reader-hash-name">${this._escapeHtml(name)}</span>
                            <a href="${searchUrl}" target="_blank" rel="noopener" class="reader-hash-value" title="Search on Civitai">${this._escapeHtml(hash)}</a>
                        </div>`;
                    }).join('');
                    if (hashSection) hashSection.style.display = '';
                } else {
                    if (hashSection) hashSection.style.display = 'none';
                }
            }

            // Generation params
            const paramsEl = document.getElementById('reader-params');
            if (paramsEl) {
                // Filter out hash fields (shown separately) and empty values
                const skipKeys = new Set(['model_hash', 'lora_hashes', 'ti_hashes', 'Lora hashes', 'TI hashes']);
                const paramPairs = Object.entries(gp)
                    .filter(([k, v]) => v != null && v !== '' && !skipKeys.has(k))
                    .map(([k, v]) => `<div class="reader-param"><span class="reader-param-key">${this._escapeHtml(k)}</span><span class="reader-param-val">${this._escapeHtml(String(v))}</span></div>`);

                if (paramPairs.length > 0) {
                    paramsEl.innerHTML = paramPairs.join('');
                } else {
                    paramsEl.textContent = clipboardMetadataMissing
                        ? t(
                            'reader.clipboardWarningParamsFallback',
                            'Clipboard image likely lost SD generation parameters. Open the original PNG file to inspect them.',
                        )
                        : t('reader.noParams', 'No generation parameters');
                }
            }

            this._renderModelAssetsSection(result);

            const negativeSection = document.getElementById('reader-negative-section');
            if (negativeSection && !String(result.negative_prompt || '').trim()) {
                this._collapsedState.negative = false;
            }

            this._renderReaderColorDistribution();
            this._syncSectionStates();
        },

        _copy(what) {
            const r = this._currentResult;
            if (!r) return;

            let text = '';
            const gp = this._getGenParams(r);

            switch (what) {
                case 'prompt':
                    text = r.prompt || '';
                    break;
                case 'negative':
                    text = r.negative_prompt || '';
                    break;
                case 'params': {
                    text = Object.entries(gp)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    break;
                }
                case 'sd': {
                    const promptView = this._buildPromptView(r, 'sd');
                    const parts = [];
                    if (promptView?.promptText) parts.push(promptView.promptText);
                    if (promptView?.negativeText) parts.push(`Negative prompt: ${promptView.negativeText}`);
                    const paramStr = Object.entries(gp)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    if (paramStr) parts.push(paramStr);
                    text = parts.join('\n');
                    break;
                }
                case 'all': {
                    const parts = [];
                    parts.push(`Generator: ${r.generator || 'unknown'}`);
                    if (r.checkpoint) parts.push(`Checkpoint: ${r.checkpoint}`);
                    const loras = this._getLoras(r);
                    if (loras.length) parts.push(`LoRAs: ${loras.join(', ')}`);
                    parts.push('');
                    if (r.prompt) parts.push(r.prompt);
                    if (r.negative_prompt) parts.push(`\nNegative prompt: ${r.negative_prompt}`);
                    const paramStr = Object.entries(gp)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    if (paramStr) parts.push(`\n${paramStr}`);
                    text = parts.join('\n');
                    break;
                }
            }

            navigator.clipboard.writeText(text).then(() => {
                window.App?.showToast?.(this._t('reader.copied', 'Copied to clipboard'), 'success');
            }).catch(() => {
                window.App?.showToast?.(this._t('reader.copyFailed', 'Failed to copy'), 'error');
            });
        },

        _clear() {
            this._currentImage = null;
            this._currentResult = null;
            this._currentSourceKind = 'file';
            this._setClipboardPasteState(false);

            const preview = document.getElementById('reader-image-preview');
            const dropZone = document.getElementById('reader-drop-zone');
            const resultPanel = document.getElementById('reader-result-panel');
            const statusEl = document.getElementById('reader-status');

            if (preview) {
                if (preview._blobUrl) URL.revokeObjectURL(preview._blobUrl);
                preview.src = '';
                preview.style.display = 'none';
            }
            if (dropZone) dropZone.style.display = '';
            if (resultPanel) resultPanel.style.display = 'none';
            if (statusEl) {
                statusEl.textContent = '';
                statusEl.style.display = 'none';
            }
            const colorSection = document.getElementById('reader-color-section');
            if (colorSection) colorSection.style.display = 'none';
            const modelAssetsSection = document.getElementById('reader-model-assets-section');
            const modelAssets = document.getElementById('reader-model-assets');
            if (modelAssetsSection) modelAssetsSection.style.display = 'none';
            if (modelAssets) modelAssets.innerHTML = '';
            this._updateFormatButton();
        },

        _setText(id, text) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        },

        _escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },

        _formatSize(bytes) {
            if (!bytes) return '';
            const units = ['B', 'KB', 'MB', 'GB'];
            let i = 0;
            let size = bytes;
            while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
            return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
        }
    };

    window.ImageReader = ImageReader;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ImageReader.init());
    } else {
        ImageReader.init();
    }
})();
