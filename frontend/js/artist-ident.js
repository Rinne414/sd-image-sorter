/**
 * SD Image Sorter - Artist Identification Module
 * Identifies artist/style of images using LSNet-style classification.
 */

const ArtistIdent = {
    isIdentifying: false,
    progress: { current: 0, total: 0 },
    selectedArtist: null,
    selectedArtistPageSize: 120,
    selectedArtistOffset: 0,
    selectedArtistHasMore: false,
    selectedArtistImages: [],
    artistRequestToken: 0,
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

    tKey(key, enText, zhText = enText, params = null) {
        const translated = window.I18n?.t?.(key, params || undefined);
        if (translated && translated !== key) return translated;
        let fallback = this.tText(enText, zhText);
        if (params && typeof params === 'object') {
            Object.entries(params).forEach(([token, value]) => {
                fallback = fallback.replaceAll(`{${token}}`, String(value));
            });
        }
        return fallback;
    },

    localizeDiagnosticsMessage(message) {
        const raw = String(message || '').trim();
        if (!raw) return '';

        if (raw === 'Kaloscope runtime is ready.') {
            return this.tText(raw, 'Kaloscope 运行环境已就绪。');
        }
        if (raw === 'Artist identification still needs the LSNet runtime, Kaloscope files, or Python dependencies.') {
            return this.tText(raw, '还缺少 LSNet / Kaloscope / Python 依赖。');
        }
        if (raw === "On Windows, comfyui-lsnet may log 'SkaFn failed; falling back to PyTorchSkaFn'. That fallback is usually okay if artist predictions still appear.") {
            return this.tText(
                raw,
                'Windows 下若出现 “SkaFn failed; falling back to PyTorchSkaFn”，但结果仍能出来，通常可以先忽略。'
            );
        }

        return raw;
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

    dismissFirstUseCard() {
        localStorage.setItem('artist-guide-seen', 'true');
        const card = document.getElementById('artist-start-card');
        if (card) card.hidden = true;
    },

    refreshFirstUseCard() {
        const card = document.getElementById('artist-start-card');
        const dismissBtn = document.getElementById('artist-start-dismiss');
        if (!card) return;
        if (dismissBtn && dismissBtn.dataset.bound !== 'true') {
            dismissBtn.addEventListener('click', () => this.dismissFirstUseCard());
            dismissBtn.dataset.bound = 'true';
        }
        card.hidden = localStorage.getItem('artist-guide-seen') === 'true';
    },

    formatConfidencePercent(value) {
        const numeric = Number(value || 0);
        return `${(numeric * 100).toFixed(1)}%`;
    },

    init() {
        this.bindEvents();
        this._syncControls();
        this.refreshAvailabilityState();
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

        this.refreshAvailabilityState();
    },

    syncSelectionActionState() {
        const identifySelectedBtn = document.getElementById('btn-identify-selected');
        if (!identifySelectedBtn) return;

        const selectedIds = window.App?.AppState?.selectedIds;
        const normalizedSelectedIds = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
        const hasSelection = normalizedSelectedIds.size > 0;
        const isAvailable = this.diagnostics ? this.diagnostics.available !== false : true;
        const disabled = this.isIdentifying || !hasSelection || !isAvailable;

        identifySelectedBtn.disabled = disabled;
        identifySelectedBtn.setAttribute('aria-disabled', String(disabled));

        if (this.isIdentifying) {
            identifySelectedBtn.dataset.dynamicTitle = 'true';
            identifySelectedBtn.title = this.tText(
                'Artist identification is already running',
                '画师识别已经在运行中'
            );
        } else if (!isAvailable) {
            identifySelectedBtn.dataset.dynamicTitle = 'true';
            identifySelectedBtn.title = this.tText(
                'Finish the setup in the status card above before identifying images.',
                '请先按上方状态卡完成准备，再开始识别。'
            );
        } else if (!hasSelection) {
            identifySelectedBtn.dataset.dynamicTitle = 'true';
            identifySelectedBtn.title = this.tText(
                'Select images in Gallery first',
                '请先在图库里选中图片'
            );
        } else {
            delete identifySelectedBtn.dataset.dynamicTitle;
            identifySelectedBtn.removeAttribute('title');
        }
    },

    refreshAvailabilityState() {
        const isAvailable = this.diagnostics ? this.diagnostics.available !== false : true;
        const identifyAllBtn = document.getElementById('btn-identify-all');
        const controls = document.querySelector('#view-artist .artist-controls');

        controls?.classList.toggle('is-disabled', !isAvailable);

        if (identifyAllBtn) {
            const disabled = this.isIdentifying || !isAvailable;
            identifyAllBtn.disabled = disabled;
            identifyAllBtn.setAttribute('aria-disabled', String(disabled));
            if (!isAvailable) {
                identifyAllBtn.dataset.dynamicTitle = 'true';
                identifyAllBtn.title = this.tText(
                    'Finish the setup in the status card above before identifying images.',
                    '请先按上方状态卡完成准备，再开始识别。'
                );
            } else if (!this.isIdentifying) {
                delete identifyAllBtn.dataset.dynamicTitle;
                identifyAllBtn.removeAttribute('title');
            }
        }

        this.syncSelectionActionState();
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

            const title = result.available
                ? this.tText('Style Finder is ready', '画师识别已就绪')
                : this.tText('Style Finder needs setup first', '画师识别还需要先完成准备');
            const summary = result.available
                ? this.tText(
                    'You can start identification now, then review the strongest matches in the center panel.',
                    '现在可以开始识别，然后在中间结果区查看最强匹配。'
                )
                : this.tText(
                    'Finish the missing runtime or model setup first. Do not start a full library run before it is ready.',
                    '先补齐缺少的运行环境或模型，再回来开始识别。不要在没准备好时直接跑整库。'
                );
            const detailItems = [];
            if (result.message) detailItems.push(this.localizeDiagnosticsMessage(result.message));
            if (result.missing_dependencies?.length) {
                detailItems.push(`${this.tText('Missing dependencies', '缺少依赖')}: ${result.missing_dependencies.join(', ')}`);
            }
            if (result.runtime_note) detailItems.push(this.localizeDiagnosticsMessage(result.runtime_note));
            if (result.runtime_path) detailItems.push(`${this.tText('Runtime path', '运行时路径')}: ${result.runtime_path}`);
            if (result.checkpoint_path) detailItems.push(`${this.tText('Checkpoint path', '检查点路径')}: ${result.checkpoint_path}`);
            banner.className = classes.join(' ');
            banner.innerHTML = `
                <div class="model-health-copy">
                    <span class="model-health-title">${this._escapeHtml(title)}</span>
                    <span>${this._escapeHtml(summary)}</span>
                    ${detailItems.length ? `
                        <details class="model-health-details">
                            <summary>${this._escapeHtml(this.tText('Technical details', '技术细节'))}</summary>
                            <ul>${detailItems.map((item) => `<li>${this._escapeHtml(item)}</li>`).join('')}</ul>
                        </details>
                    ` : ''}
                </div>
            `;
            this.refreshAvailabilityState();
        } catch (e) {
            banner.className = 'model-health-banner is-visible model-health-banner-warning';
            banner.innerHTML = `
                <div class="model-health-copy">
                    <span class="model-health-title">${this._escapeHtml(this.tText('Style Finder needs setup first', '画师识别还需要先完成准备'))}</span>
                    <span>${this._escapeHtml(this.tText('Artist runtime status could not be loaded.', '画师识别运行状态无法加载。'))}</span>
                </div>
            `;
            this.diagnostics = { available: false };
            this.refreshAvailabilityState();
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
        const useGpuEl = document.getElementById('artist-use-gpu');
        const modelSource = String(modelSourceEl?.value || 'huggingface').trim() || 'huggingface';
        const modelPath = String(modelPathEl?.value || '').trim();

        if (modelSource === 'local' && !modelPath) {
            throw new Error('Local model path is required when using the local model source');
        }

        return {
            model_source: modelSource,
            model_path: modelSource === 'local' ? modelPath : null,
            // Default checked = use GPU (matches backend ARTIST_USE_GPU default).
            // Unchecked forces CPU for GPU stacks that freeze under CUDA load.
            use_gpu: useGpuEl ? !!useGpuEl.checked : null,
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


    async selectArtist(artist, { append = false } = {}) {
        const safeArtist = String(artist ?? '');
        const escapeHtml = this._escapeHtml.bind(this);
        const isSameArtist = this.selectedArtist === safeArtist;
        if (!append || !isSameArtist) {
            this.selectedArtistOffset = 0;
            this.selectedArtistHasMore = false;
            this.selectedArtistImages = [];
        }
        this.selectedArtist = safeArtist;
        this.artistRequestToken += 1;
        const requestToken = this.artistRequestToken;
        const requestOffset = append && isSameArtist ? this.selectedArtistOffset : 0;

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
            const detailResponse = await window.App.API.get(
                `/api/artists/images/${encodeURIComponent(safeArtist)}?limit=${this.selectedArtistPageSize}&offset=${requestOffset}`
            );
            if (requestToken !== this.artistRequestToken) return;

            const pageImages = Array.isArray(detailResponse.images) ? detailResponse.images : [];
            this.selectedArtistImages = append
                ? [...this.selectedArtistImages, ...pageImages]
                : pageImages;
            this.selectedArtistOffset = requestOffset + pageImages.length;
            this.selectedArtistHasMore = Boolean(detailResponse.has_more);

            const previewCards = this.selectedArtistImages.map((image) => `
                <button class="artist-image-card" data-image-id="${image.image_id}" data-filename="${escapeHtml(image.filename)}" type="button" title="${escapeHtml(image.filename)}">
                    <img src="${window.App.API.getThumbnailUrl(image.image_id, 256)}" alt="${escapeHtml(image.filename)}" loading="lazy">
                    <span class="artist-image-confidence">${escapeHtml(String(image.confidence_percent))}%</span>
                    <span class="artist-image-name">${escapeHtml(image.filename)}</span>
                    <span class="artist-image-actions">
                        <span class="artist-image-action" data-action="preview">${escapeHtml(this.tText('Preview', '预览'))}</span>
                        <span class="artist-image-action" data-action="reader">${escapeHtml(this.tText('Reader', 'Reader'))}</span>
                        <span class="artist-image-action" data-action="edit">${escapeHtml(this.tText('Edit', '编辑'))}</span>
                        <span class="artist-image-action" data-action="build">${escapeHtml(this.tText('Build', 'Build'))}</span>
                    </span>
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
                card.addEventListener('click', (event) => {
                    const imageId = Number(card.dataset.imageId);
                    const filename = String(card.dataset.filename || '');
                    if (!Number.isFinite(imageId)) return;

                    const action = event.target?.dataset?.action;
                    if (action === 'reader') {
                        window.App?.openReaderFromImage?.(imageId, filename);
                        return;
                    }
                    if (action === 'edit') {
                        window.App?.addToCensorQueue?.([imageId]);
                        return;
                    }
                    if (action === 'build') {
                        window.App?.openPromptBuildFromImage?.(imageId);
                        return;
                    }

                    if (window.Gallery?.openPreview) {
                        window.Gallery.openPreview(imageId);
                    }
                });
            });

            const loadMoreBtn = document.getElementById('btn-artist-load-more');
            if (loadMoreBtn) {
                loadMoreBtn.style.display = this.selectedArtistHasMore ? 'inline-flex' : 'none';
            }

        } catch (e) {
            detailContent.innerHTML = `<p class="error">${this.tText('Failed to load artist details', '加载画师详情失败')}</p>`;
        }
    },


    filterGalleryByArtist(artist) {
        if (!window.App?.AppState?.filters) return;

        window.App.updateFilters?.((filters) => {
            filters.artist = artist;
        });
        if (typeof window.App.updateFilterSummary === 'function') {
            window.App.updateFilterSummary();
        }
        if (typeof window.App.switchView === 'function') {
            window.App.switchView('gallery');
        }
        if (typeof window.App.loadImages === 'function') {
            window.App.loadImages();
        }

        window.App.showToast(
            this.tText(`Filtering by artist: ${this.formatArtistName(artist)}`, `正在按画师筛选：${this.formatArtistName(artist)}`),
            'success'
        );
    },

    clearArtistFilter() {
        if (!window.App?.AppState?.filters) return;

        window.App.updateFilters?.((filters) => {
            filters.artist = null;
        });
        if (typeof window.App.updateFilterSummary === 'function') {
            window.App.updateFilterSummary();
        }
        if (typeof window.App.switchView === 'function') {
            window.App.switchView('gallery');
        }
        if (typeof window.App.loadImages === 'function') {
            window.App.loadImages();
        }

        window.App.showToast(this.tText('Artist filter cleared', '已清除画师筛选'), 'info');
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
            this.refreshAvailabilityState();
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
            this.refreshAvailabilityState();
            if (this.progressTracker) {
                window.App.resetProgressTracker(this.progressTracker);
            }
            document.getElementById('artist-progress-container').style.display = 'none';
        }
    },

    async identifyAll() {
        if (this.isIdentifying) return;

        const { showToast, hideGlobalLoading } = window.App;
        const progressContainer = document.getElementById('artist-progress-container');
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');

        if (this.diagnostics && this.diagnostics.available === false) {
            showToast(this.tText('Finish setup first, then start identification.', '请先完成准备，再开始识别。'), 'warning');
            return;
        }

        this.isIdentifying = true;
        this.dismissFirstUseCard();
        this.refreshAvailabilityState();
        this.progressTracker = window.App.createProgressTracker();
        window.App.resetProgressTracker(this.progressTracker);

        // Show progress bar immediately instead of a blocking overlay
        if (progressContainer) progressContainer.style.display = 'block';
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) progressText.textContent = this.tText(
            'Collecting image list...', '正在收集图片列表...'
        );

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

                if (progressText) {
                    progressText.textContent = this.tText(
                        `Collected ${imageIds.length} images...`,
                        `已收集 ${imageIds.length} 张图片...`
                    );
                }

                if (!imagesResult.has_more || !imagesResult.next_cursor) {
                    break;
                }
                cursor = imagesResult.next_cursor;
            }

            if (imageIds.length === 0) {
                showToast(this.tKey('artist.noImagesToIdentify', 'No images to identify', '没有可识别的图片'), 'warning');
                return;
            }

            if (progressText) {
                progressText.textContent = this.tText(
                    `Starting identification of ${imageIds.length} images...`,
                    `正在启动 ${imageIds.length} 张图片的识别...`
                );
            }

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
                showToast(this.tText(
                    'Artist identification is already running in the background',
                    '画师识别已经在后台运行中'
                ), 'info');
                await this.resumeBatchProgress();
            } else {
                showToast(formatUserError(e, this.tKey('artist.identificationFailed', 'Artist identification failed', '画师识别失败')), "error");
            }
        } finally {
            if (!handedOffToExistingTask) {
                this.isIdentifying = false;
                this.refreshAvailabilityState();
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
                        if (processed === 0 && progress.step === 'loading_runtime') {
                            progressText.textContent = progress.message || this.tKey('artist.loadingModel', 'Loading artist model...', '正在载入画师模型...');
                        } else {
                            const progressLabel = window.App.buildProgressText({
                                progress,
                                completed,
                                total: Number(progress.total || 0),
                                tracker: this.progressTracker,
                                defaultMessage: errors > 0
                                    ? this.tKey('artist.progressDefault', '{processed} identified, {errors} failed', '已识别 {processed} 张，失败 {errors} 张', {
                                        processed,
                                        errors,
                                    })
                                    : this.tKey('artist.progressDefault', '{processed} identified, {errors} failed', '已识别 {processed} 张，失败 {errors} 张', {
                                        processed,
                                        errors: 0,
                                    }),
                                primaryLabel: this.tKey('artist.progressPrimary', 'Artist ID', '画师识别')
                            });
                            const currentItem = progress.current_item ? ` · ${progress.current_item}` : '';
                            progressText.textContent = `${progressLabel}${currentItem}`;
                        }
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
            showToast(this.tText('No images selected', '没有选中图片'), 'warning');
            return;
        }

        if (this.isIdentifying) {
            showToast(this.tText('Identification already in progress', '识别任务已在进行中'), 'warning');
            return;
        }

        if (this.diagnostics && this.diagnostics.available === false) {
            showToast(this.tText('Finish setup first, then start identification.', '请先完成准备，再开始识别。'), 'warning');
            return;
        }

        this.isIdentifying = true;
        this.dismissFirstUseCard();
        this.refreshAvailabilityState();
        this.progressTracker = window.App.createProgressTracker();
        window.App.resetProgressTracker(this.progressTracker);

        let handedOffToExistingTask = false;

        try {
            if (progressContainer) progressContainer.style.display = 'block';
            if (progressFill) progressFill.style.width = '0%';
            if (progressText) {
                progressText.textContent = this.tKey(
                    'artist.identifyingSelected',
                    'Identifying {count} selected image(s)...',
                    '正在识别 {count} 张已选图片...',
                    { count: normalizedSelectedIds.size }
                );
            }

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
                showToast(this.tText(
                    'Artist identification is already running in the background',
                    '画师识别已经在后台运行中'
                ), 'info');
                await this.resumeBatchProgress();
            } else {
                showToast(formatUserError(e, this.tKey('artist.identificationFailed', 'Artist identification failed', '画师识别失败')), "error");
            }
        } finally {
            if (!handedOffToExistingTask) {
                this.isIdentifying = false;
                this.refreshAvailabilityState();
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
            this.tKey('artist.clearConfirmTitle', 'Clear Artist Predictions', '清空画师识别结果'),
            this.tKey('artist.clearConfirmMessage', 'Clear all artist predictions? This cannot be undone.', '要清空全部画师识别结果吗？此操作无法撤销。'),
            async () => {
                try {
                    await API.delete('/api/artists/clear');
                    showToast(this.tText('All predictions cleared', '已清除所有预测'), 'success');
                    this.loadStats();
                } catch (e) {
                    showToast(formatUserError(e, this.tKey('artist.clearDataFailed', 'Failed to clear data', '清空数据失败')), "error");
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
                '#btn-identify-all, #btn-identify-selected, #btn-refresh-artist-stats, #btn-clear-artist-data, #btn-artist-load-more'
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
                case 'btn-artist-load-more':
                    if (this.selectedArtist && this.selectedArtistHasMore) {
                        this.selectArtist(this.selectedArtist, { append: true });
                    }
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
            this.refreshAvailabilityState();
        });

        document.addEventListener('languageChanged', () => {
            requestAnimationFrame(() => this.refreshAvailabilityState());
        });
    },


    // ============== First Use Guide ==============

    showFirstUseGuide() {
        this.refreshFirstUseCard();
    },

};

// Export
window.ArtistIdent = ArtistIdent;
