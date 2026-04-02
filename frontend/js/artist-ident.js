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
    eventsBound: false,

    init() {
        this.bindEvents();
        this._syncControls();
        this.loadStats();
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
                ['Total Images', Number(result.total_images) || 0],
                ['Identified', Number(result.identified_images) || 0],
                ['Undefined', Number(result.undefined_count) || 0],
                ['Artists Found', Object.keys(result.artist_counts || {}).length],
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
            label.textContent = 'Failed to load stats';

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
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🎨</div>
                    <p>No artists identified yet.</p>
                    <p class="empty-hint">Click "Identify All Images" to start.</p>
                </div>
            `;
            return;
        }

        const escapeHtml = this._escapeHtml.bind(this);
        const maxCount = entries[0][1];

        grid.innerHTML = entries.map(([artist, count]) => {
            const encodedArtist = encodeURIComponent(String(artist ?? ''));
            const displayName = escapeHtml(this.formatArtistName(artist));
            const initials = escapeHtml(this.getInitials(artist));
            const countLabel = escapeHtml(String(count));
            const width = Math.max(0, Math.min(100, (count / maxCount) * 100));

            return `
            <div class="artist-card${normalizedViewMode === 'list' ? ' artist-card-list' : ''}" data-artist="${encodedArtist}" role="button" tabindex="0" aria-pressed="false">
                <div class="artist-avatar">${initials}</div>
                <div class="artist-info">
                    <span class="artist-name">${displayName}</span>
                    <span class="artist-count">${countLabel} images</span>
                </div>
                <div class="artist-bar" style="width: ${width}%"></div>
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
        return String(name ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    },

    _syncControls() {
        const thresholdSlider = document.getElementById('artist-threshold');
        const thresholdValue = document.getElementById('artist-threshold-value');
        if (thresholdSlider && thresholdValue) {
            thresholdValue.textContent = thresholdSlider.value;
        }

        const modelSource = document.getElementById('artist-model-source');
        const localModelGroup = document.getElementById('artist-local-model-group');
        if (modelSource && localModelGroup) {
            localModelGroup.style.display = modelSource.value === 'local' ? 'block' : 'none';
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
            const artistLabel = escapeHtml(this.formatArtistName(safeArtist));
            const countLabel = escapeHtml(String(count));

            detailContent.innerHTML = `
                <h4>${artistLabel}</h4>
                <p class="artist-stats-detail">${countLabel} images identified</p>
            `;

            // Show action button
            imagesPreview.innerHTML = `
                <div class="preview-placeholder">
                    <button class="btn btn-primary btn-small" id="btn-filter-by-artist">
                        🔍 View ${countLabel} images in Gallery
                    </button>
                    <button class="btn btn-ghost btn-small" id="btn-clear-artist-filter" style="margin-top: 8px;">
                        ✕ Clear Artist Filter
                    </button>
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

        } catch (e) {
            detailContent.innerHTML = `<p class="error">Failed to load artist details</p>`;
        }
    },


    filterGalleryByArtist(artist) {
        // Set the artist filter in AppState
        if (window.App && window.App.AppState) {
            window.App.AppState.filters.artist = artist;
        }

        // Switch to gallery view
        const galleryTab = document.querySelector('[data-view="gallery"]');
        if (galleryTab) {
            galleryTab.click();
        }

        // Update filter summary to show artist filter
        this.updateFilterSummary(artist);

        // Trigger image reload with artist filter
        if (window.App && typeof window.App.loadImages === 'function') {
            window.App.loadImages();
        }

        window.App.showToast(`Filtering by artist: ${this.formatArtistName(artist)}`, 'success');
    },

    clearArtistFilter() {
        // Clear the artist filter
        if (window.App && window.App.AppState) {
            window.App.AppState.filters.artist = null;
        }

        // Switch to gallery view
        const galleryTab = document.querySelector('[data-view="gallery"]');
        if (galleryTab) {
            galleryTab.click();
        }

        // Trigger image reload without artist filter
        if (window.App && typeof window.App.loadImages === 'function') {
            window.App.loadImages();
        }

        window.App.showToast('Artist filter cleared', 'info');
    },

    updateFilterSummary(artist) {
        // Update the filter summary in the sidebar to show artist filter
        const summaryEl = document.getElementById('summary-artist');
        if (summaryEl) {
            summaryEl.textContent = this.formatArtistName(artist);
        }
    },

    // ============== Identification ==============

    async identifyAll() {
        if (this.isIdentifying) return;

        const { showToast, showGlobalLoading, hideGlobalLoading } = window.App;
        const progressContainer = document.getElementById('artist-progress-container');
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');

        this.isIdentifying = true;

        // Show global loading for initial setup
        showGlobalLoading('Starting artist identification...');

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
            await window.App.API.post('/api/artists/identify-batch', {
                image_ids: imageIds,
                threshold: parseFloat(document.getElementById('artist-threshold')?.value || 0.35),
                top_k: 5,
            });

            // Poll progress
            await this.pollProgress();

            showToast('Artist identification complete!', 'success');
            this.loadStats();

        } catch (e) {
            showToast(formatUserError(e, "Artist identification failed"), "error");
        } finally {
            this.isIdentifying = false;
            if (progressContainer) progressContainer.style.display = 'none';
            hideGlobalLoading();
        }
    },

    async pollProgress() {
        const progressFill = document.getElementById('artist-progress-fill');
        const progressText = document.getElementById('artist-progress-text');

        while (this.isIdentifying) {
            try {
                const progress = await window.App.API.get('/api/artists/batch-progress');

                if (progress.total > 0) {
                    const percent = Math.round(progress.processed / progress.total * 100);
                    if (progressFill) progressFill.style.width = `${percent}%`;
                    if (progressText) {
                        progressText.textContent = `${progress.processed}/${progress.total} images (${percent}%)`;
                    }
                }

                if (!progress.running) {
                    break;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                Logger.error('Progress poll error:', e);
                break;
            }
        }
    },

    async identifySelected() {
        const { showToast } = window.App;
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

        try {
            await window.App.API.post('/api/artists/identify-batch', {
                image_ids: Array.from(normalizedSelectedIds),
                threshold: parseFloat(document.getElementById('artist-threshold')?.value || 0.35),
                top_k: 5,
            });

            await this.pollProgress();
            showToast(`Identified ${normalizedSelectedIds.size} images`, 'success');
            this.loadStats();

        } catch (e) {
            showToast(formatUserError(e, "Artist identification failed"), "error");
        } finally {
            this.isIdentifying = false;
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
                const thresholdValue = document.getElementById('artist-threshold-value');
                if (thresholdValue) {
                    thresholdValue.textContent = event.target.value;
                }
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
            const id = event.target?.id;
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
                { title: 'Configure', text: 'Select model source and confidence threshold' },
                { title: 'Identify', text: 'Click "Identify All Images" to analyze your library' },
                { title: 'Explore', text: 'Browse identified artists and their images' },
                { title: 'Filter', text: 'Use artist names to filter in Gallery' },
            ],
            note: 'Images below the confidence threshold will be labeled as "undefined"',
            maxWidth: '480px',
        });

        view.style.position = 'relative';
        view.appendChild(overlay);

        overlay.querySelector('[data-guide-close]')?.addEventListener('click', () => {
            overlay.remove();
            localStorage.setItem('artist-guide-seen', 'true');
        });
    },

};

// Export
window.ArtistIdent = ArtistIdent;
