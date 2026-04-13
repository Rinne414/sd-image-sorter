/**
 * SD Image Sorter - Artist Identification Module
 * Identifies artist/style of images using LSNet-style classification.
 */

const ArtistIdent = {
    isIdentifying: false,
    progress: { current: 0, total: 0 },
    selectedArtist: null,
    viewMode: 'grid',
    stats: {},
    diagnostics: null,
    eventsBound: false,
    progressTracker: null,
    thresholdDefaults: {
        value: 0.03,
        suggestedLow: 0.02,
        suggestedHigh: 0.08,
    },

    tText(enText, zhText) {
        return window.I18n?.getLang?.() === 'zh-CN' ? zhText : enText;
    },

    getThresholdValue() {
        const rawValue = parseFloat(document.getElementById('artist-threshold')?.value || this.thresholdDefaults.value);
        return Number.isFinite(rawValue) ? rawValue : this.thresholdDefaults.value;
    },

    syncThresholdDisplay() {
        const thresholdSlider = document.getElementById('artist-threshold');
        const thresholdValue = document.getElementById('artist-threshold-value');
        if (!thresholdSlider || !thresholdValue) return;
        thresholdValue.textContent = this.getThresholdValue().toFixed(2);
    },

    getArtistStat(artist) {
        return this.stats?.artist_stats?.[artist] || { count: 0, avg_confidence: 0, max_confidence: 0 };
    },

    formatConfidencePercent(value) {
        const numeric = Number(value || 0);
        return `${(numeric * 100).toFixed(1)}%`;
    },

    init() {
        this.bindEvents();
        this._syncControls();
        this.syncSelectionActionState();
        this.loadDiagnostics();
        this.loadStats();
        this.resumeBatchProgress();
        this.showFirstUseGuide();
    },

    // ============== Data Loading ==============

    async loadStats() {
        const statsEl = document.getElementById('artist-stats');
        if (!statsEl) return;

        try {
            const result = await window.App.API.get('/api/artists/stats');
            this.stats = result;

            const cards = [
                [this.tText('Total Images', '总图片数'), Number(result.total_images) || 0],
                [this.tText('Identified', '已识别'), Number(result.identified_images) || 0],
                [this.tText('Undefined', '未定义'), Number(result.undefined_count) || 0],
                [this.tText('Artists Found', '发现画师'), Object.keys(result.artist_counts || {}).length],
            ].map(([label, value]) => {
                const card = document.createElement('div');
                card.className = 'stat-card';

                const number = document.createElement('span');
                number.className = 'stat-number';
                number.textContent = String(value);

                const text = document.createElement('span');
                text.className = 'stat-label';
                text.textContent = label;

                card.append(number, text);
                return card;
            });

            statsEl.replaceChildren(...cards);

            // Render artist grid
            this.renderArtistGrid(result.artist_counts || {}, this.viewMode);
        } catch (e) {
            const fallback = document.createElement('div');
            fallback.className = 'stat-card';

            const label = document.createElement('span');
            label.className = 'stat-label';
            label.textContent = this.tText('Failed to load stats', '加载统计失败');

            fallback.appendChild(label);
            statsEl.replaceChildren(fallback);
        }
    },


    renderArtistGrid(artistCounts, viewMode = this.viewMode) {
        const grid = document.getElementById('artist-results-grid');
        if (!grid) return;

        const normalizedViewMode = viewMode === 'list' ? 'list' : 'grid';
        this.viewMode = normalizedViewMode;
        grid.classList.toggle('list-mode', normalizedViewMode === 'list');

        document.querySelectorAll('.view-toggle .toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === normalizedViewMode);
        });

        const entries = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]);

        if (entries.length === 0) {
            const identifiedImages = Number(this.stats?.identified_images || 0);
            const undefinedCount = Number(this.stats?.undefined_count || 0);
            const currentThreshold = this.getThresholdValue().toFixed(2);
            const allUndefined = identifiedImages > 0 && undefinedCount >= identifiedImages;
            const emptyTitle = allUndefined
                ? this.tText('Kaloscope finished, but every result fell below the threshold.', 'Kaloscope 已经跑完了，但结果全部低于当前阈值。')
                : this.tText('No artists identified yet.', '还没有识别到画师。');
            const emptyHint = allUndefined
                ? this.tText(
                    `Lower the threshold from ${currentThreshold} to around ${this.thresholdDefaults.suggestedLow.toFixed(2)}-${this.thresholdDefaults.suggestedHigh.toFixed(2)} and run again.`,
                    `把阈值从 ${currentThreshold} 降到大约 ${this.thresholdDefaults.suggestedLow.toFixed(2)}-${this.thresholdDefaults.suggestedHigh.toFixed(2)}，再跑一次。`
                )
                : this.tText('Click "Identify All Images" to start.', '点击“识别所有图片”开始。');
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🎨</div>
                    <p>${emptyTitle}</p>
                    <p class="empty-hint">${emptyHint}</p>
                </div>
            `;
            return;
        }

        const escapeHtml = this._escapeHtml.bind(this);
        const maxCount = entries[0][1];

        grid.innerHTML = entries.map(([artist, count], index) => {
            const encodedArtist = encodeURIComponent(String(artist ?? ''));
            const displayName = escapeHtml(this.formatArtistName(artist));
            const initials = escapeHtml(this.getInitials(artist));
            const countLabel = escapeHtml(String(count));
            const width = Math.max(0, Math.min(100, (count / maxCount) * 100));
            const stat = this.getArtistStat(artist);
            const avgConfidence = escapeHtml(this.formatConfidencePercent(stat.avg_confidence));
            const maxConfidence = escapeHtml(this.formatConfidencePercent(stat.max_confidence));
            const rankLabel = escapeHtml(`#${index + 1}`);

            if (normalizedViewMode === 'list') {
                return `
                <div class="artist-card artist-card-list" data-artist="${encodedArtist}" role="button" tabindex="0" aria-pressed="false">
                    <div class="artist-rank">${rankLabel}</div>
                    <div class="artist-avatar">${initials}</div>
                    <div class="artist-info">
                        <span class="artist-name">${displayName}</span>
                        <span class="artist-count">${countLabel} images</span>
                    </div>
                    <div class="artist-metrics">
                        <span class="artist-metric"><strong>${escapeHtml(this.tText('Avg', '平均'))}</strong> ${avgConfidence}</span>
                        <span class="artist-metric"><strong>${escapeHtml(this.tText('Peak', '最高'))}</strong> ${maxConfidence}</span>
                    </div>
                    <div class="artist-progress artist-progress-list" aria-hidden="true">
                        <span class="artist-bar" style="width: ${width}%"></span>
                    </div>
                </div>
            `;
            }

            return `
            <div class="artist-card" data-artist="${encodedArtist}" role="button" tabindex="0" aria-pressed="false">
                <div class="artist-avatar">${initials}</div>
                <div class="artist-info">
                    <span class="artist-name">${displayName}</span>
                    <span class="artist-count">${countLabel} images</span>
                    <span class="artist-confidence-summary">${escapeHtml(this.tText('Avg', '平均'))} ${avgConfidence} · ${escapeHtml(this.tText('Peak', '最高'))} ${maxConfidence}</span>
                </div>
                <div class="artist-progress" aria-hidden="true">
                    <span class="artist-bar" style="width: ${width}%"></span>
                </div>
            </div>
        `;
        }).join('');

        grid.querySelectorAll('.artist-card').forEach(card => {
            const activate = () => this.selectArtist(this._decodeArtistValue(card.dataset.artist));

            card.addEventListener('click', activate);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                }
            });
        });
    },


    getInitials(name) {
        const safeName = String(name ?? '').trim();
        if (!safeName || safeName === 'undefined') return '?';

        const parts = safeName
            .replace(/_/g, ' ')
            .split(/\s+/)
            .filter(Boolean);

        if (parts.length === 0) return '?';
        if (parts.length === 1) {
            return parts[0].substring(0, 2).toUpperCase();
        }

        return parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
    },

    formatArtistName(name) {
        const safeName = String(name ?? '').trim();
        if (!safeName || safeName === 'undefined') return 'Undefined';

        return safeName
            .replace(/_/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    },

    _syncControls() {
        this.syncThresholdDisplay();

        const modelSource = document.getElementById('artist-model-source');
        const localModelGroup = document.getElementById('artist-local-model-group');
        if (modelSource && localModelGroup) {
            localModelGroup.style.display = modelSource.value === 'local' ? 'block' : 'none';
        }

        this.syncSelectionActionState();
    },

    syncSelectionActionState() {
        const identifySelectedBtn = document.getElementById('btn-identify-selected');
        if (!identifySelectedBtn) return;

        const selectedIds = window.App?.AppState?.selectedIds;
        const normalizedSelectedIds = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
        const hasSelection = normalizedSelectedIds.size > 0;
        const disabled = this.isIdentifying || !hasSelection;

        identifySelectedBtn.disabled = disabled;
        identifySelectedBtn.setAttribute('aria-disabled', String(disabled));

        if (this.isIdentifying) {
            identifySelectedBtn.title = 'Artist identification is already running';
        } else if (!hasSelection) {
            identifySelectedBtn.title = 'Select images in Gallery first';
        } else {
            identifySelectedBtn.removeAttribute('title');
        }
    },

    async loadDiagnostics() {
        const banner = document.getElementById('artist-model-health');
        if (!banner) return;

        try {
            const result = await window.App.API.get('/api/artists/diagnostics');
            this.diagnostics = result;

            const classes = ['model-health-banner', 'is-visible'];
            if (!result.available) {
                classes.push('model-health-banner-warning');
            }

            const extras = [];
            if (result.runtime_path) extras.push(`Runtime: ${result.runtime_path}`);
            if (result.checkpoint_path) extras.push(`Checkpoint: ${result.checkpoint_path}`);
            if (result.missing_dependencies?.length) {
                extras.push(`Missing: ${result.missing_dependencies.join(', ')}`);
            }
            if (result.runtime_note) {
                extras.push(result.runtime_note);
            }

            banner.className = classes.join(' ');
            banner.innerHTML = `<strong>Kaloscope</strong> ${this._escapeHtml(result.message || '')}${
                extras.length ? `<br><small>${this._escapeHtml(extras.join(' | '))}</small>` : ''
            }`;
        } catch (e) {
            banner.className = 'model-health-banner is-visible model-health-banner-warning';
            banner.textContent = this.tText('Artist runtime status could not be loaded.', '画师识别运行状态无法加载。');
        }
    },

    _escapeHtml(value) {
        // Delegate to global escapeHtml from modules/utils/escape.js
        return window.escapeHtml(value);
    },

    _decodeArtistValue(value) {
        try {
            return decodeURIComponent(String(value ?? ''));
        } catch (e) {
            return String(value ?? '');
        }
    },

    _getIdentifyModelConfig() {
        const modelSourceEl = document.getElementById('artist-model-source');
        const modelPathEl = document.getElementById('artist-model-path');
        const modelSource = String(modelSourceEl?.value || 'huggingface').trim() || 'huggingface';
        const modelPath = String(modelPathEl?.value || '').trim();

        if (modelSource === 'local' && !modelPath) {
            throw new Error('Local model path is required when using the local model source');
        }

        return {
            model_source: modelSource,
            model_path: modelSource === 'local' ? modelPath : null,
        };
    },

    _getIdentifyPayload(imageIds) {
        return {
            image_ids: imageIds,
            threshold: this.getThresholdValue(),
            top_k: 5,
            ...this._getIdentifyModelConfig(),
        };
    },

    _buildCompletionToast(progress, requestedCount = 0) {
        const results = Array.isArray(progress?.results) ? progress.results : [];
        const errors = Number(progress?.errors || 0);
        const allUndefined = results.length > 0 && results.every(result => String(result?.artist || '').toLowerCase() === 'undefined');
        const targetCount = requestedCount || Number(progress?.total || 0) || results.length;

        if (errors > 0) {
            return {
                level: 'warning',
                message: this.tText(
                    `Artist identification finished with ${errors} error(s).`,
                    `画师识别完成，但有 ${errors} 个错误。`
                ),
            };
        }

        if (allUndefined) {
            return {
                level: 'warning',
                message: this.tText(
                    `The run completed, but the current threshold turned all ${results.length} result(s) into "undefined". Try ${this.thresholdDefaults.suggestedLow.toFixed(2)}-${this.thresholdDefaults.suggestedHigh.toFixed(2)}.`,
                    `这轮识别完成了，但当前阈值把 ${results.length} 个结果全压成了“未定义”。建议改成 ${this.thresholdDefaults.suggestedLow.toFixed(2)}-${this.thresholdDefaults.suggestedHigh.toFixed(2)} 再试。`
                ),
            };
        }

        if (targetCount > 0) {
            return {
                level: 'success',
                message: this.tText(
                    `Identified ${targetCount} image(s).`,
                    `已完成 ${targetCount} 张图片的画师识别。`
                ),
            };
        }

        return {
            level: 'success',
            message: this.tText('Artist identification complete!', '画师识别完成。'),
        };
    },


    async selectArtist(artist) {
        const safeArtist = String(artist ?? '');
        const escapeHtml = this._escapeHtml.bind(this);
        this.selectedArtist = safeArtist;

        // Highlight selected card
        document.querySelectorAll('.artist-card').forEach(card => {
            const isSelected = this._decodeArtistValue(card.dataset.artist) === safeArtist;
            card.classList.toggle('selected', isSelected);
            card.setAttribute('aria-pressed', String(isSelected));
        });

        // Load artist's images
        const detailContent = document.getElementById('artist-detail-content');
        const imagesPreview = document.getElementById('artist-images-preview');
        if (!detailContent || !imagesPreview) return;

        detailContent.innerHTML = `<p class="loading">Loading images for ${escapeHtml(this.formatArtistName(safeArtist))}...</p>`;

        try {
            // Get count from stats
            const count = this.stats.artist_counts?.[safeArtist] || 0;
            const stat = this.getArtistStat(safeArtist);
            const artistLabel = escapeHtml(this.formatArtistName(safeArtist));
            const countLabel = escapeHtml(String(count));
            const avgConfidence = escapeHtml(this.formatConfidencePercent(stat.avg_confidence));
            const maxConfidence = escapeHtml(this.formatConfidencePercent(stat.max_confidence));
            const detailResponse = await window.App.API.get(`/api/artists/images/${encodeURIComponent(safeArtist)}?limit=18`);
            const previewCards = (detailResponse.images || []).map((image) => `
                <button class="artist-image-card" data-image-id="${image.image_id}" type="button" title="${escapeHtml(image.filename)}">
                    <img src="${window.App.API.getThumbnailUrl(image.image_id, 256)}" alt="${escapeHtml(image.filename)}" loading="lazy">
                    <span class="artist-image-confidence">${escapeHtml(String(image.confidence_percent))}%</span>
                    <span class="artist-image-name">${escapeHtml(image.filename)}</span>
                </button>
            `).join('');

            detailContent.innerHTML = `
                <h4>${artistLabel}</h4>
                <p class="artist-stats-detail">${countLabel} ${escapeHtml(this.tText('images identified', '张图匹配到该画师'))}</p>
                <p class="artist-stats-detail">${escapeHtml(this.tText('Average confidence', '平均置信度'))} ${avgConfidence}</p>
                <p class="artist-stats-detail">${escapeHtml(this.tText('Peak confidence', '最高置信度'))} ${maxConfidence}</p>
            `;

            // Show action button
            imagesPreview.innerHTML = `
                <div class="preview-placeholder">
                    <button class="btn btn-primary btn-small" id="btn-filter-by-artist">
                        🔍 ${escapeHtml(this.tText(`View ${countLabel} images in Gallery`, `在图库中查看这 ${countLabel} 张图`))}
                    </button>
                    <button class="btn btn-ghost btn-small" id="btn-clear-artist-filter" style="margin-top: 8px;">
                        ✕ ${escapeHtml(this.tText('Clear Artist Filter', '清除画师筛选'))}
                    </button>
                </div>
                <div class="artist-images-grid">
                    ${previewCards || `<div class="empty-state"><p>${this.tText('No preview images available yet.', '暂时还没有可预览的图片。')}</p></div>`}
                </div>
            `;

            // Bind filter button
            document.getElementById('btn-filter-by-artist')?.addEventListener('click', () => {
                this.filterGalleryByArtist(safeArtist);
            });

            // Bind clear filter button
            document.getElementById('btn-clear-artist-filter')?.addEventListener('click', () => {
                this.clearArtistFilter();
            });

            imagesPreview.querySelectorAll('.artist-image-card').forEach(card => {
                card.addEventListener('click', () => {
                    const imageId = Number(card.dataset.imageId);
                    if (Number.isFinite(imageId) && window.Gallery?.openPreview) {
                        window.Gallery.openPreview(imageId);
                    }
                });
            });

        } catch (e) {
            detailContent.innerHTML = `<p class="error">Failed to load artist details</p>`;
        }
    },


    filterGalleryByArtist(artist) {
        if (!window.App?.AppState?.filters) return;

        window.App.AppState.filters.artist = artist;
        if (typeof window.App.updateFilterSummary === 'function') {
            window.App.updateFilterSummary();
        }
        if (typeof window.App.switchView === 'function') {
            window.App.switchView('gallery');
        }
        if (typeof window.App.loadImages === 'function') {
            window.App.loadImages();
        }

        window.App.showToast(`Filtering by artist: ${this.formatArtistName(artist)}`, 'success');
    },

    clearArtistFilter() {
        if (!window.App?.AppState?.filters) return;

        window.App.AppState.filters.artist = null;
        if (typeof window.App.updateFilterSummary === 'function') {
            window.App.updateFilterSummary();
        }
        if (typeof window.App.switchView === 'function') {
            window.App.switchView('gallery');
        }
        if (typeof window.App.loadImages === 'function') {
            window.App.loadImages();
        }

        window.App.showToast('Artist filter cleared', 'info');
    },

    // ============== Identification ==============

    updateProgressUi(progress = {}) {
        const progressContainer = document.getElementById('artist-progress-container');
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');
        const total = Number(progress.total || 0);
        const processed = Number(progress.processed || 0);
        const errors = Number(progress.errors || 0);
        const completed = total > 0 ? Math.min(total, processed + errors) : 0;
        const percent = total > 0 ? Math.round(completed / total * 100) : 0;

        if (progressContainer) progressContainer.style.display = 'block';
        if (progressFill) progressFill.style.width = `${percent}%`;
        if (progressText) {
            if (!this.progressTracker) {
                this.progressTracker = window.App.createProgressTracker();
            }

            const progressLabel = total > 0
                ? window.App.buildProgressText({
                    progress,
                    completed,
                    total,
                    tracker: this.progressTracker,
                    defaultMessage: `${processed} identified${errors > 0 ? `, ${errors} error(s)` : ''}`,
                    primaryLabel: 'Artist ID'
                })
                : (progress.message || 'Preparing artist identification...');
            const currentItem = progress.current_item ? ` · ${progress.current_item}` : '';
            progressText.textContent = `${progressLabel}${currentItem}`;
        }
    },

    async resumeBatchProgress() {
        if (this.isIdentifying) return;

        try {
            const progress = await window.App.API.get('/api/artists/batch-progress');
            if (!progress?.running) {
                return;
            }

            this.progressTracker = window.App.createProgressTracker();
            window.App.resetProgressTracker(this.progressTracker);
            this.isIdentifying = true;
            this.syncSelectionActionState();
            this.updateProgressUi(progress);

            const finalProgress = await this.pollProgress();
            await this.loadStats();
            const completion = this._buildCompletionToast(finalProgress);
            window.App.showToast(completion.message, completion.level);
        } catch (e) {
            Logger.warn('Failed to resume artist identification progress:', e);
        } finally {
            if (!document.getElementById('artist-progress-container')) {
                return;
            }

            this.isIdentifying = false;
            this.syncSelectionActionState();
            if (this.progressTracker) {
                window.App.resetProgressTracker(this.progressTracker);
            }
            document.getElementById('artist-progress-container').style.display = 'none';
        }
    },

    async identifyAll() {
        if (this.isIdentifying) return;

        const { showToast, showGlobalLoading, hideGlobalLoading } = window.App;
        const progressContainer = document.getElementById('artist-progress-container');
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');

        this.isIdentifying = true;
        this.syncSelectionActionState();
        this.progressTracker = window.App.createProgressTracker();
        window.App.resetProgressTracker(this.progressTracker);

        // Show global loading for initial setup
        showGlobalLoading('Starting artist identification...');

        let handedOffToExistingTask = false;

        try {
            const pageSize = 1000;
            let cursor = null;
            let imageIds = [];

            while (true) {
                const query = new URLSearchParams({ limit: String(pageSize) });
                if (cursor) query.set('cursor', cursor);
                const imagesResult = await window.App.API.get(`/api/images?${query.toString()}`);
                imageIds = imageIds.concat((imagesResult.images || []).map(img => img.id));

                if (!imagesResult.has_more || !imagesResult.next_cursor) {
                    break;
                }
                cursor = imagesResult.next_cursor;
            }

            if (imageIds.length === 0) {
                showToast('No images to identify', 'warning');
                return;
            }

            hideGlobalLoading();

            // Show progress
            if (progressContainer) progressContainer.style.display = 'block';
            if (progressFill) progressFill.style.width = '0%';
            if (progressText) progressText.textContent = `Identifying ${imageIds.length} images...`;

            // Start batch identification
            await window.App.API.post('/api/artists/identify-batch', this._getIdentifyPayload(imageIds));

            // Poll progress
            const progress = await this.pollProgress();
            await this.loadStats();
            const completion = this._buildCompletionToast(progress, imageIds.length);
            showToast(completion.message, completion.level);

        } catch (e) {
            if (/already in progress/i.test(String(e?.message || ''))) {
                handedOffToExistingTask = true;
                showToast('Artist identification is already running in the background', 'info');
                await this.resumeBatchProgress();
            } else {
                showToast(formatUserError(e, "Artist identification failed"), "error");
            }
        } finally {
            if (!handedOffToExistingTask) {
                this.isIdentifying = false;
                this.syncSelectionActionState();
                if (this.progressTracker) {
                    window.App.resetProgressTracker(this.progressTracker);
                }
                if (progressContainer) progressContainer.style.display = 'none';
            }
            hideGlobalLoading();
        }
    },

    async pollProgress() {
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');
        let lastProgress = null;

        while (this.isIdentifying) {
            try {
                const progress = await window.App.API.get('/api/artists/batch-progress');
                lastProgress = progress;

                if (progress.total > 0) {
                    const processed = Number(progress.processed || 0);
                    const errors = Number(progress.errors || 0);
                    const completed = Math.min(progress.total, processed + errors);
                    const percent = Math.round(completed / progress.total * 100);
                    if (progressFill) progressFill.style.width = `${percent}%`;
                    if (progressText) {
                        const progressLabel = window.App.buildProgressText({
                            progress,
                            completed,
                            total: Number(progress.total || 0),
                            tracker: this.progressTracker,
                            defaultMessage: `${processed} identified${errors > 0 ? `, ${errors} error(s)` : ''}`,
                            primaryLabel: 'Artist ID'
                        });
                        const currentItem = progress.current_item ? ` · ${progress.current_item}` : '';
                        progressText.textContent = `${progressLabel}${currentItem}`;
                    }
                }

                if (!progress.running) {
                    return progress;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                Logger.error('Progress poll error:', e);
                throw e;
            }
        }

        return lastProgress;
    },

    async identifySelected() {
        const { showToast } = window.App;
        const progressContainer = document.getElementById('artist-progress-container');
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');
        const selectedIds = window.App?.AppState?.selectedIds;
        const normalizedSelectedIds = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);

        if (normalizedSelectedIds.size === 0) {
            showToast('No images selected', 'warning');
            return;
        }

        if (this.isIdentifying) {
            showToast('Identification already in progress', 'warning');
            return;
        }

        this.isIdentifying = true;
        this.syncSelectionActionState();
        this.progressTracker = window.App.createProgressTracker();
        window.App.resetProgressTracker(this.progressTracker);

        let handedOffToExistingTask = false;

        try {
            if (progressContainer) progressContainer.style.display = 'block';
            if (progressFill) progressFill.style.width = '0%';
            if (progressText) progressText.textContent = `Identifying ${normalizedSelectedIds.size} selected image(s)...`;

            await window.App.API.post(
                '/api/artists/identify-batch',
                this._getIdentifyPayload(Array.from(normalizedSelectedIds)),
            );

            const progress = await this.pollProgress();
            await this.loadStats();
            const completion = this._buildCompletionToast(progress, normalizedSelectedIds.size);
            showToast(completion.message, completion.level);

        } catch (e) {
            if (/already in progress/i.test(String(e?.message || ''))) {
                handedOffToExistingTask = true;
                showToast('Artist identification is already running in the background', 'info');
                await this.resumeBatchProgress();
            } else {
                showToast(formatUserError(e, "Artist identification failed"), "error");
            }
        } finally {
            if (!handedOffToExistingTask) {
                this.isIdentifying = false;
                this.syncSelectionActionState();
                if (this.progressTracker) {
                    window.App.resetProgressTracker(this.progressTracker);
                }
                if (progressContainer) progressContainer.style.display = 'none';
            }
        }
    },


    async clearAllData() {
        const { showToast, showConfirm, API } = window.App;

        showConfirm(
            'Clear Artist Predictions',
            'Clear all artist predictions? This cannot be undone.',
            async () => {
                try {
                    await API.delete('/api/artists/clear');
                    showToast('All predictions cleared', 'success');
                    this.loadStats();
                } catch (e) {
                    showToast(formatUserError(e, "Failed to clear data"), "error");
                }
            }
        );
    },

    // ============== Event Binding ==============

    bindEvents() {
        if (this.eventsBound) return;
        this.eventsBound = true;

        document.addEventListener('input', (event) => {
            if (event.target?.id === 'artist-threshold') {
                this.syncThresholdDisplay();
            }
        });

        document.addEventListener('change', (event) => {
            if (event.target?.id === 'artist-model-source') {
                const localModelGroup = document.getElementById('artist-local-model-group');
                if (localModelGroup) {
                    localModelGroup.style.display = event.target.value === 'local' ? 'block' : 'none';
                }
            }
        });

        document.addEventListener('click', (event) => {
            const actionButton = event.target?.closest?.(
                '#btn-identify-all, #btn-identify-selected, #btn-refresh-artist-stats, #btn-clear-artist-data'
            );
            const id = actionButton?.id;
            switch (id) {
                case 'btn-identify-all':
                    this.identifyAll();
                    return;
                case 'btn-identify-selected':
                    this.identifySelected();
                    return;
                case 'btn-refresh-artist-stats':
                    this.loadStats();
                    return;
                case 'btn-clear-artist-data':
                    this.clearAllData();
                    return;
                default:
                    break;
            }

            const toggleBtn = event.target.closest?.('.view-toggle .toggle-btn');
            if (toggleBtn) {
                const nextMode = toggleBtn.dataset.view || 'grid';
                document.querySelectorAll('.view-toggle .toggle-btn').forEach(btn => {
                    btn.classList.toggle('active', btn === toggleBtn);
                });
                this.renderArtistGrid(this.stats.artist_counts || {}, nextMode);
            }
        });

        document.addEventListener('selection-state-changed', () => {
            this.syncSelectionActionState();
        });
    },


    // ============== First Use Guide ==============

    showFirstUseGuide() {
        if (localStorage.getItem('artist-guide-seen')) return;
        if (document.getElementById('artist-first-use-guide')) return;

        const view = document.getElementById('view-artist');
        if (!view) return;

        const overlay = window.App.createGuideOverlay({
            id: 'artist-first-use-guide',
            storageKey: 'artist-guide-seen',
            title: '🎨 Artist Identification',
            description: 'Identify the artist/style of your images using AI classification.',
            steps: [
                { title: 'Configure', text: 'Select model source and start with a low threshold like 0.03' },
                { title: 'Runtime', text: 'Check the runtime banner first. If it says ready, you can run Kaloscope directly.' },
                { title: 'Identify', text: 'Click "Identify All Images" to analyze your library' },
                { title: 'Explore', text: 'Browse identified artists and their images' },
                { title: 'Filter', text: 'Use artist names to filter in Gallery' },
            ],
            note: 'Kaloscope usually needs a low threshold such as 0.02-0.08. Higher values often turn everything into "undefined".',
            maxWidth: '480px',
        });

        view.style.position = 'relative';
        view.appendChild(overlay);
    },

};

// Export
window.ArtistIdent = ArtistIdent;
