/**
 * SD Image Sorter - Similar Images Module
 * Handles similarity search UI, duplicate finder, and embedding management.
 */

// escapeHtml fallback — main definition is in app.js
if (typeof escapeHtml === 'undefined') {
    var escapeHtml = function(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };
}

const SimilarImages = {
    isEmbedding: false,
    isCheckingEmbeddingStatus: false,
    embedProgress: { processed: 0, total: 0, errors: 0 },
    embedProgressTracker: null,
    modelStatus: null,
    stats: null,
    searchResults: [],
    duplicateResults: [],
    currentSearchId: null,
    searchPageSize: 100,
    duplicatePageSize: 500,
    currentSearchOffset: 0,
    currentDuplicateOffset: 0,
    currentSearchFile: null,
    currentSearchMode: null,
    currentSearchThreshold: 0.5,
    currentDuplicateThreshold: 0.95,
    lastSearchCount: 0,
    lastDuplicateCount: 0,
    searchHasMore: false,
    duplicateHasMore: false,
    totalSearchCount: 0,
    totalDuplicateCount: 0,
    requestSequence: 0,
    activeSearchToken: 0,
    activeDuplicateToken: 0,
    searchEmptyMessage: '',
    duplicateEmptyMessage: '',
    uploadDropzoneActive: false,
    collectionId: null,
    scopeCollections: [],

    _t(key, fallback, params) {
        const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : (fallback || key);
    },

    _applyLocalizedDefaults() {
        this.searchEmptyMessage = this._t(
            'similar.defaultSearchEmpty',
            'No similar images found. Try generating embeddings first.'
        );
        this.duplicateEmptyMessage = this._t(
            'similar.defaultDuplicateEmpty',
            'No duplicates found at this threshold.'
        );
    },

    // ============== Search Scope (Favorites / Collections) ==============

    // Build the "&collection_id=<id>" query suffix for the active scope.
    // Returns '' when searching the whole library (default), so request URLs
    // stay byte-for-byte identical to the pre-scope behavior.
    getScopeQuery() {
        return this.collectionId ? `&collection_id=${encodeURIComponent(this.collectionId)}` : '';
    },

    async loadScopeOptions() {
        const select = document.getElementById('similar-search-scope');
        if (!select) return;

        let collections = [];
        try {
            const result = await window.App?.API?.listCollections?.();
            collections = Array.isArray(result?.collections) ? result.collections : [];
        } catch (e) {
            Logger.warn('Failed to load collections for similarity scope:', e);
            collections = [];
        }
        this.scopeCollections = collections;

        const favoritesLabel = this._t('collections.favorites', 'Favorites');
        const allLabel = this._t('similar.scopeAll', 'All images');
        const favorites = collections.find((c) => c.slug === 'favorites');
        const others = collections.filter((c) => c.slug !== 'favorites');

        const options = [`<option value="">${escapeHtml(allLabel)}</option>`];
        if (favorites) {
            options.push(`<option value="${favorites.id}">${escapeHtml(favoritesLabel)}</option>`);
        }
        others.forEach((c) => {
            options.push(`<option value="${c.id}">${escapeHtml(c.name || `#${c.id}`)}</option>`);
        });
        select.innerHTML = options.join('');

        // Preserve a previously chosen scope across reloads when it still exists.
        if (this.collectionId && collections.some((c) => String(c.id) === String(this.collectionId))) {
            select.value = String(this.collectionId);
        } else {
            this.collectionId = null;
            select.value = '';
        }
    },

    onScopeChange(value) {
        const parsed = parseInt(value, 10);
        this.collectionId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        // Re-run the active search under the new scope, if there is one.
        if (this.currentSearchMode === 'id' && this.currentSearchId) {
            this.searchByImage(this.currentSearchId);
        } else if (this.currentSearchMode === 'upload' && this.currentSearchFile) {
            this.searchByUpload(this.currentSearchFile);
        }
    },

    getEmbeddingStats() {
        const stats = this.stats || {};
        const total = Number(stats.total_images || 0);
        const embedded = Number(stats.embedded_count ?? stats.embedded_images ?? 0);
        const pending = Number(stats.pending_count ?? stats.pending ?? Math.max(0, total - embedded));
        const unreadable = Number(stats.unreadable_count || 0);
        return { total, embedded, pending, unreadable };
    },

    dismissFirstUseCard() {
        localStorage.setItem('similar-guide-seen', 'true');
        const card = document.getElementById('similar-start-card');
        if (card) card.hidden = true;
    },

    refreshFirstUseCard() {
        const card = document.getElementById('similar-start-card');
        const dismissBtn = document.getElementById('similar-start-dismiss');
        if (!card) return;
        if (dismissBtn && dismissBtn.dataset.bound !== 'true') {
            dismissBtn.addEventListener('click', () => this.dismissFirstUseCard());
            dismissBtn.dataset.bound = 'true';
        }
        card.hidden = localStorage.getItem('similar-guide-seen') === 'true';
    },

    refreshContentVisibility() {
        const { total, embedded } = this.getEmbeddingStats();
        const progress = this.embedProgress || {};
        const running = Boolean(this.isEmbedding || this.isCheckingEmbeddingStatus || progress.running);
        const modelReady = this.modelStatus ? this.modelStatus.available !== false : true;
        const canUseSearch = modelReady && embedded > 0 && !running;
        const tabs = document.querySelector('#view-similar .similar-tabs');
        const body = document.querySelector('#view-similar .similar-body');
        const embedRow = document.querySelector('#view-similar .similar-embed-row');
        const workflowCard = document.getElementById('similar-workflow-status');

        if (tabs) tabs.hidden = !canUseSearch;
        if (body) body.hidden = !canUseSearch;
        if (embedRow) embedRow.hidden = !(modelReady && total > 0 && embedded > 0);
        workflowCard?.classList.toggle('similar-workflow-primary', !canUseSearch);
    },

    refreshWorkflowStatus() {
        const card = document.getElementById('similar-workflow-status');
        const badge = document.getElementById('similar-workflow-badge');
        const meta = document.getElementById('similar-workflow-meta');
        const detail = document.getElementById('similar-workflow-detail');
        const cta = document.getElementById('btn-similar-status-embed');
        if (!card || !badge || !meta || !detail || !cta) return;

        const { total, embedded, pending, unreadable } = this.getEmbeddingStats();
        const progress = this.embedProgress || {};
        const running = Boolean(this.isEmbedding || this.isCheckingEmbeddingStatus || progress.running);
        const modelReady = this.modelStatus ? this.modelStatus.available !== false : true;
        const skipped = Number(progress.skipped || 0);
        const failed = Number(progress.failed || progress.errors || 0);
        const setupNeedsDetail = this._t(
            'similar.setupNeedsDetail',
            'Finish the CLIP setup first, then come back to build the index.'
        );
        const issueBreakdown = this._t(
            'similar.statusIssueBreakdown',
            'Skipped {skipped} • unreadable {unreadable} • failed {failed}',
            { skipped, unreadable: Number(progress.unreadable || unreadable || 0), failed }
        );

        meta.textContent = this._t(
            'similar.statusCoverage',
            '{embedded}/{total} embedded • {pending} pending • {unreadable} unreadable',
            { embedded, total, pending, unreadable }
        );

        card.classList.remove('is-warning', 'is-synced');
        cta.hidden = false;
        cta.disabled = false;
        cta.textContent = this._t('similar.startIndexing', 'Start Indexing');

        if (!modelReady) {
            badge.textContent = this._t('similar.statusModelMissing', 'CLIP model is not ready');
            detail.textContent = setupNeedsDetail;
            card.classList.add('is-warning');
            cta.hidden = true;
        } else if (!total && !running) {
            badge.textContent = this._t('similar.statusEmptyLibrary', 'No images in the library yet');
            detail.textContent = this._t('similar.statusEmptyLibraryDetail', 'Scan a folder first, then start indexing.');
            card.classList.add('is-warning');
            cta.hidden = true;
        } else if (running) {
            badge.textContent = this._t('similar.statusIndexing', 'Indexing is running');
            detail.textContent = skipped || failed || unreadable
                ? `${this._t('similar.statusIndexingDetail', 'Search and duplicate checks stay disabled until indexing finishes.')} ${issueBreakdown}`
                : this._t('similar.statusIndexingDetail', 'Search and duplicate checks stay disabled until indexing finishes.');
            card.classList.add('is-warning');
            cta.disabled = true;
            cta.textContent = this._t('similar.indexingNow', 'Indexing...');
        } else if (embedded === 0) {
            badge.textContent = this._t('similar.statusNeedsIndex', 'Similarity search needs indexing first');
            detail.textContent = this._t(
                'similar.statusNeedsIndexDetail',
                'Start indexing to build the local similarity index before searching or finding duplicates.'
            );
            card.classList.add('is-warning');
        } else if (pending > 0) {
            badge.textContent = this._t('similar.statusPartial', 'Similarity index is only partially built');
            detail.textContent = this._t(
                'similar.statusPartialDetail',
                '{embedded} embedded, {pending} still pending. Search only covers indexed images until you finish indexing.',
                { embedded, pending }
            );
            card.classList.add('is-warning');
        } else {
            badge.textContent = this._t('similar.statusReady', 'Similarity index is ready');
            detail.textContent = this._t('similar.statusReadyDetail', 'Search and duplicate scan are ready to use.');
            card.classList.add('is-synced');
            cta.hidden = true;
        }

        if (this.searchResults.length === 0 && !this.currentSearchMode) {
            if (!modelReady) {
                this.renderSearchMessage(setupNeedsDetail);
            } else if (running) {
                this.renderSearchMessage(this._t('similar.searchBlockedRunning', 'Embeddings are still running. Wait until indexing finishes before searching.'));
            } else if (embedded === 0) {
                this.renderSearchMessage(this._t('similar.searchBlockedNeedsIndex', 'Similarity search is waiting for indexing. Start indexing first.'));
            }
        }

        if (this.duplicateResults.length === 0) {
            if (!modelReady) {
                this.renderDuplicateMessage(setupNeedsDetail);
            } else if (running) {
                this.renderDuplicateMessage(this._t('similar.duplicatesBlockedRunning', 'Embeddings are still running. Wait until indexing finishes before checking duplicates.'));
            } else if (embedded < 2) {
                this.renderDuplicateMessage(this._t('similar.duplicatesBlockedNeedsIndex', 'Duplicate search is waiting for more indexed images.'));
            }
        }

        this.refreshContentVisibility();
    },

    init() {
        this._applyLocalizedDefaults();
        this.bindEvents();
        this.loadModelStatus();
        this.loadStats();
        this.loadScopeOptions();
        this.resumeEmbeddingProgress();
        this.updateActionAvailability();
        this.refreshWorkflowStatus();
        this.showFirstUseGuide();
    },

    setEmbeddingUiState(isRunning, label = null) {
        const btnEmbed = document.getElementById('btn-similar-embed');
        if (!btnEmbed) return;
        const hasExistingIndex = this.getEmbeddingStats().embedded > 0;

        btnEmbed.disabled = isRunning;
        btnEmbed.textContent = label || (isRunning
            ? this._t('similar.indexingNow', 'Indexing...')
            : this._t(
                hasExistingIndex ? 'similar.rebuildIndex' : 'similar.generateEmbed',
                hasExistingIndex ? 'Rebuild Index' : 'Generate Embeddings'
            ));
        this.updateActionAvailability();
        this.refreshWorkflowStatus();
    },

    resetEmbeddingUi({ hideProgress = true, progressMessage = '' } = {}) {
        const progressBar = document.getElementById('similar-embed-progress');
        const progressFill = document.getElementById('similar-embed-fill');
        const progressText = document.getElementById('similar-embed-text');

        this.setEmbeddingUiState(false);
        if (progressFill) {
            progressFill.style.width = '0%';
        }
        if (progressText) {
            progressText.textContent = progressMessage;
        }
        if (progressBar && hideProgress) {
            progressBar.style.display = 'none';
        }
        this.updateActionAvailability();
        this.refreshWorkflowStatus();
    },

    updateActionAvailability() {
        const { embedded } = this.getEmbeddingStats();
        const modelReady = this.modelStatus ? this.modelStatus.available !== false : true;
        const disableSearchActions = this.isEmbedding || this.isCheckingEmbeddingStatus || embedded === 0 || !modelReady;
        const disableDuplicateActions = this.isEmbedding || this.isCheckingEmbeddingStatus || embedded < 2 || !modelReady;
        const searchInput = document.getElementById('similar-search-id');
        const btnSearch = document.getElementById('btn-similar-search');
        const btnUpload = document.getElementById('btn-similar-upload');
        const btnDuplicates = document.getElementById('btn-similar-duplicates');
        const uploadInput = document.getElementById('similar-upload-input');
        const uploadDropzone = document.getElementById('similar-upload-dropzone');

        if (searchInput) searchInput.disabled = disableSearchActions;
        if (btnSearch) btnSearch.disabled = disableSearchActions;
        if (btnUpload) btnUpload.disabled = disableSearchActions;
        if (btnDuplicates) btnDuplicates.disabled = disableDuplicateActions;
        if (uploadInput) uploadInput.disabled = disableSearchActions;
        if (uploadDropzone) {
            uploadDropzone.classList.toggle('disabled', disableSearchActions);
            uploadDropzone.setAttribute('aria-disabled', String(disableSearchActions));
        }
        this.refreshContentVisibility();
    },

    beginSearchRequest() {
        this.requestSequence += 1;
        this.activeSearchToken = this.requestSequence;
        return this.activeSearchToken;
    },

    beginDuplicateRequest() {
        this.requestSequence += 1;
        this.activeDuplicateToken = this.requestSequence;
        return this.activeDuplicateToken;
    },

    renderSearchMessage(message) {
        const container = document.getElementById('similar-results');
        const loadMoreBtn = document.getElementById('btn-similar-load-more');
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    },

    renderDuplicateMessage(message) {
        const container = document.getElementById('similar-duplicates');
        const loadMoreBtn = document.getElementById('btn-similar-duplicates-more');
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    },

    formatIssueSummary(progress = {}) {
        const issues = Array.isArray(progress.recent_issues) ? progress.recent_issues : [];
        if (!issues.length) return '';
        return issues
            .slice(-3)
            .map((issue) => {
                const idPart = issue.image_id ? `#${issue.image_id} ` : '';
                const reasonPart = issue.reason ? ` (${issue.reason})` : '';
                return `${issue.kind}: ${idPart}${issue.filename}${reasonPart}`;
            })
            .join(' | ');
    },

    async waitForEmbeddingStatusReady(timeoutMs = 10000) {
        const startedAt = Date.now();
        while (this.isCheckingEmbeddingStatus && (Date.now() - startedAt) < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return !this.isCheckingEmbeddingStatus;
    },

    renderEmbeddingProgress(progress = {}) {
        const progressBar = document.getElementById('similar-embed-progress');
        const progressFill = document.getElementById('similar-embed-fill');
        const progressText = document.getElementById('similar-embed-text');
        const total = Number(progress.total || 0);
        const processed = Number(progress.processed || progress.current || 0);
        const hasBreakdown = ['embedded', 'skipped', 'unreadable', 'failed'].some((key) => progress[key] != null);
        const embedded = Number(progress.embedded || 0);
        const errors = Number(progress.errors || 0);
        const skipped = Number(progress.skipped || 0);
        const unreadable = Number(progress.unreadable || 0);
        const failed = Number(progress.failed || 0);
        const completed = total > 0 ? Math.min(total, hasBreakdown ? processed : (processed + errors)) : 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        const issueSummary = this.formatIssueSummary(progress);
        const issueSuffix = issueSummary
            ? (window.I18n?.getLang?.() === 'zh-CN' ? `（${issueSummary}）` : ` (${issueSummary})`)
            : '';

        if (progressBar) {
            progressBar.style.display = 'block';
        }
        if (progressFill) {
            progressFill.style.width = `${percent}%`;
        }
        if (progressText) {
            if (!this.embedProgressTracker) {
                this.embedProgressTracker = window.App.createProgressTracker();
            }

            if (total > 0) {
                progressText.textContent = window.App.buildProgressText({
                    progress,
                    completed,
                    total,
                    tracker: this.embedProgressTracker,
                    defaultMessage: errors > 0
                        ? (hasBreakdown
                            ? this._t(
                                'similar.embedProgressBreakdown',
                                '{embedded} embedded, {skipped} skipped, {unreadable} unreadable, {failed} failed{issues}',
                                { embedded, skipped, unreadable, failed, issues: issueSuffix }
                            )
                            : this._t(
                                'similar.embedProgressSimple',
                                '{processed} embedded, {errors} failed',
                                { processed, errors }
                            ))
                        : this._t(
                            'similar.embedProgressCount',
                            '{count} embedded',
                            { count: hasBreakdown ? embedded : processed }
                        ),
                    primaryLabel: this._t('similar.embedProgressPrimary', 'Embedding')
                });
            } else if (progress.running) {
                progressText.textContent = this._t('similar.embedPreparing', 'Preparing embeddings...');
            } else {
                progressText.textContent = this._t('similar.embedNoPending', 'No pending images to index');
            }
        }
    },

    async resumeEmbeddingProgress({ optimistic = true } = {}) {
        if (this.isEmbedding || this.isCheckingEmbeddingStatus) return;

        this.isCheckingEmbeddingStatus = true;
        if (optimistic) {
            this.setEmbeddingUiState(true, this._t('similar.embedCheckingStatus', 'Checking status...'));
        }

        try {
            const progress = await window.App.API.get('/api/similarity/progress');
            this.embedProgress = progress;

            if (!progress?.running) {
                this.isEmbedding = false;
                this.setEmbeddingUiState(false);
                if (this.embedProgressTracker) {
                    window.App.resetProgressTracker(this.embedProgressTracker);
                }
                this.refreshWorkflowStatus();
                return;
            }

            if (!this.embedProgressTracker) {
                this.embedProgressTracker = window.App.createProgressTracker();
            } else {
                window.App.resetProgressTracker(this.embedProgressTracker);
            }
            this.isEmbedding = true;
            this.setEmbeddingUiState(true);
            this.renderEmbeddingProgress(progress);
            this.pollEmbedProgress();
            this.refreshWorkflowStatus();
        } catch (e) {
            this.setEmbeddingUiState(false);
            Logger.warn('Failed to resume similarity embedding progress:', e);
            this.refreshWorkflowStatus();
        } finally {
            this.isCheckingEmbeddingStatus = false;
            this.updateActionAvailability();
            this.refreshWorkflowStatus();
        }
    },

    showFirstUseGuide() {
        this.refreshFirstUseCard();
    },

    async loadModelStatus() {
        const banner = document.getElementById('similar-model-health');
        if (!banner) return;

        try {
            const result = await window.App.API.get('/api/similarity/model-status');
            this.modelStatus = result;

            const classes = ['model-health-banner', 'is-visible'];
            if (!result.available) {
                classes.push('model-health-banner-warning');
            }

            banner.className = classes.join(' ');
            const title = result.available
                ? this._t('similar.setupReadyTitle', 'Similarity setup is ready')
                : this._t('similar.setupNeedsTitle', 'Similarity setup needs one more step');
            const description = result.available
                ? this._t('similar.setupReadyDetail', 'You can search or rebuild the index any time after scanning more images.')
                : this._t('similar.setupNeedsDetail', 'Finish the CLIP setup first, then come back to build the index.');
            const detailItems = [];
            if (result.message) {
                detailItems.push(result.message);
            }
            if (result.model_path) {
                detailItems.push(result.model_path);
            }
            const detailsHtml = detailItems.length
                ? `
                    <details class="model-health-details">
                        <summary>${escapeHtml(this._t('similar.setupDetails', 'Technical details'))}</summary>
                        <ul>${detailItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    </details>
                `
                : '';
            // ENTRY-06: shared "needs setup -> open Model Manager" affordance.
            // The data-action button reuses the global delegated handler.
            const setupBtnHtml = result.available ? '' : `
                <button type="button" class="btn btn-secondary btn-small model-health-setup-btn" data-action="open-model-guidance">
                    ⚙️ ${escapeHtml(this._t('models.openSetup', 'Open Setup / Download'))}
                </button>
            `;
            banner.innerHTML = `
                <div class="model-health-copy">
                    <span class="model-health-title">${escapeHtml(title)}</span>
                    <span>${escapeHtml(description)}</span>
                    ${detailsHtml}
                    ${setupBtnHtml}
                </div>
            `;
            this.updateActionAvailability();
            this.refreshWorkflowStatus();
        } catch (e) {
            banner.className = 'model-health-banner is-visible model-health-banner-warning';
            banner.innerHTML = `
                <div class="model-health-copy">
                    <span class="model-health-title">${escapeHtml(this._t('similar.setupNeedsTitle', 'Similarity setup needs one more step'))}</span>
                    <span>${escapeHtml(this._t('similar.statusLoadFailed', 'Similarity setup could not be checked right now.'))}</span>
                    <button type="button" class="btn btn-secondary btn-small model-health-setup-btn" data-action="open-model-guidance">
                        ⚙️ ${escapeHtml(this._t('models.openSetup', 'Open Setup / Download'))}
                    </button>
                </div>
            `;
            this.modelStatus = {
                available: false,
                message: this._t('similar.statusLoadFailed', 'Similarity setup could not be checked right now.'),
            };
            this.updateActionAvailability();
            this.refreshWorkflowStatus();
        }
    },

    // ============== Data Loading ==============

    async loadStats() {
        const statsEl = document.getElementById('similar-stats');
        if (!statsEl) return;

        try {
            const app = window.App;
            if (!app?.API?.get) {
                throw new Error('App API is not ready yet');
            }

            const result = await app.API.get('/api/similarity/stats');
            this.stats = result;
            statsEl.innerHTML = `
                <div class="stat-card">
                    <span class="stat-number">${result.total_images || 0}</span>
                    <span class="stat-label">${escapeHtml(this._t('similar.statsTotal', 'Total Images'))}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.embedded_count ?? result.embedded_images ?? 0}</span>
                    <span class="stat-label">${escapeHtml(this._t('similar.statsEmbedded', 'Embedded'))}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.pending_count ?? result.pending ?? 0}</span>
                    <span class="stat-label">${escapeHtml(this._t('similar.statsPending', 'Pending'))}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.unreadable_count || 0}</span>
                    <span class="stat-label">${escapeHtml(this._t('similar.statsUnreadable', 'Unreadable'))}</span>
                </div>
            `;
            this.updateActionAvailability();
            this.refreshWorkflowStatus();
        } catch (e) {
            if (e.message === 'App API is not ready yet') {
                setTimeout(() => this.loadStats(), 100);
                return;
            }
            this.stats = null;
            statsEl.innerHTML = `<div class="stat-card"><span class="stat-label">${escapeHtml(this._t('similar.statusLoadFailed', 'Failed to load stats'))}</span></div>`;
            this.updateActionAvailability();
            this.refreshWorkflowStatus();
        }
    },

    // ============== Embedding ==============

    async startEmbedding() {
        if (this.isEmbedding) return;

        const { showToast } = window.App;
        this.isEmbedding = true;
        this.dismissFirstUseCard();
        this.embedProgressTracker = window.App.createProgressTracker();
        window.App.resetProgressTracker(this.embedProgressTracker);

        this.setEmbeddingUiState(true);
        this.renderEmbeddingProgress({ running: true, total: 0, processed: 0, errors: 0 });
        this.refreshWorkflowStatus();

        try {
            const result = await window.App.API.post('/api/similarity/embed');
            this.embedProgress = result?.progress || this.embedProgress;
            if (result?.progress) {
                this.renderEmbeddingProgress(result.progress);
            }

            if (result?.status === 'already_running') {
                showToast(this._t('similar.embedAlreadyRunning', 'Embedding is already running in the background'), 'info');
            } else {
                showToast(this._t('similar.embedStarted', 'Embedding started in background'), 'info');
            }
            this.pollEmbedProgress();
        } catch (e) {
            showToast(formatUserError(e, this._t('similar.failedToStart', 'Failed to start similarity processing')), 'error');
            this.isEmbedding = false;
            this.resetEmbeddingUi();
            this.refreshWorkflowStatus();
        }
    },

    async pollEmbedProgress() {
        const progressBar = document.getElementById('similar-embed-progress');

        try {
            const result = await window.App.API.get('/api/similarity/progress');
            this.embedProgress = result;
            this.renderEmbeddingProgress(result);

            if (result.running) {
                setTimeout(() => this.pollEmbedProgress(), 1000);
            } else {
                this.isEmbedding = false;
                this.setEmbeddingUiState(false);

                const total = Number(result.total || 0);
                const processed = Number(result.processed || result.current || 0);
                const hasBreakdown = ['embedded', 'skipped', 'unreadable', 'failed'].some((key) => result[key] != null);
                const embedded = Number(result.embedded || 0);
                const errors = Number(result.errors || 0);
                const skipped = Number(result.skipped || 0);
                const unreadable = Number(result.unreadable || 0);
                const failed = Number(result.failed || 0);
                const completed = total > 0 ? Math.min(total, hasBreakdown ? processed : (processed + errors)) : 0;
                const issueSummary = this.formatIssueSummary(result);
                const issueSuffix = issueSummary
                    ? (window.I18n?.getLang?.() === 'zh-CN' ? `（${issueSummary}）` : ` (${issueSummary})`)
                    : '';
                const extra = errors > 0
                    ? (hasBreakdown
                        ? (window.I18n?.getLang?.() === 'zh-CN'
                            ? `，已跳过 ${skipped} 张，不可读 ${unreadable} 张，失败 ${failed} 张${issueSuffix}`
                            : `, ${skipped} skipped, ${unreadable} unreadable, ${failed} failed${issueSuffix}`)
                        : (window.I18n?.getLang?.() === 'zh-CN'
                            ? `，失败 ${errors} 张`
                            : `, ${errors} failed`))
                    : '';
                const finalMessage = total > 0
                    ? this._t(
                        'similar.embedProgressFinal',
                        '{completed}/{total} images ({count} embedded{extra})',
                        {
                            completed,
                            total,
                            count: hasBreakdown ? embedded : processed,
                            extra,
                        }
                    )
                    : this._t('similar.embedNoPending', 'No pending images to index');

                this.resetEmbeddingUi({ hideProgress: false, progressMessage: finalMessage });
                if (this.embedProgressTracker) {
                    window.App.resetProgressTracker(this.embedProgressTracker);
                }
                if (progressBar) {
                    setTimeout(() => { progressBar.style.display = 'none'; }, 2000);
                }
                this.loadStats();
                if (total === 0) {
                    window.App.showToast(this._t('similar.embedNoPending', 'No pending images to index'), 'info');
                } else if (errors > 0) {
                    window.App.showToast(
                        hasBreakdown
                            ? this._t(
                                'similar.embedFinishedBreakdown',
                                'Indexing finished: {embedded} embedded, {skipped} skipped, {unreadable} unreadable, {failed} failed{issues}',
                                { embedded, skipped, unreadable, failed, issues: issueSuffix }
                            )
                            : this._t(
                                'similar.embedFinishedSimple',
                                'Indexing finished: {processed} embedded, {errors} failed',
                                { processed, errors }
                            ),
                        'warning',
                    );
                } else {
                    window.App.showToast(
                        this._t('similar.embedComplete', 'Indexing complete: {count} images embedded', {
                            count: hasBreakdown ? embedded : processed,
                        }),
                        'success'
                    );
                }
                this.refreshWorkflowStatus();
            }
        } catch (e) {
            this.isEmbedding = false;
            this.resetEmbeddingUi();
            if (this.embedProgressTracker) {
                window.App.resetProgressTracker(this.embedProgressTracker);
            }
            window.App.showToast(formatUserError(e, this._t('similar.refreshProgressFailed', 'Failed to refresh embedding progress')), 'error');
            this.refreshWorkflowStatus();
        }
    },

    // ============== Search by Image ==============

    async searchByImage(imageId, { append = false } = {}) {
        const { showToast, API } = window.App;
        this.currentSearchId = imageId;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

        if (this.isCheckingEmbeddingStatus) {
            await this.waitForEmbeddingStatusReady();
        }

        if (this.isEmbedding || this.isCheckingEmbeddingStatus) {
            const message = this._t(
                'similar.searchBlockedRunning',
                'Embeddings are still running. Wait until indexing finishes before searching.'
            );
            this.renderSearchMessage(message);
            showToast(message, 'info');
            return;
        }

        const requestToken = this.beginSearchRequest();
        this.searchEmptyMessage = this._t(
            'similar.searchEmptyById',
            'No similar images found for this image at the current threshold.'
        );
        if (!append) {
            this.currentSearchOffset = 0;
            this.searchResults = [];
            this.searchHasMore = false;
            this.totalSearchCount = 0;
            resultsContainer.innerHTML = '<div class="spinner"></div>';
        }

        try {
            const thresholdEl = document.getElementById('similar-search-threshold');
            const threshold = thresholdEl ? parseFloat(thresholdEl.value) : 0.5;
            this.currentSearchId = imageId;
            this.currentSearchMode = 'id';
            this.currentSearchThreshold = threshold;
            const requestOffset = append ? this.currentSearchOffset : 0;
            const result = await API.get(
                `/api/similarity/search/${imageId}?limit=${this.searchPageSize}&offset=${requestOffset}&threshold=${threshold}${this.getScopeQuery()}`
            );
            if (requestToken !== this.activeSearchToken) return;
            const pageResults = Array.isArray(result.results) ? result.results : [];
            this.searchResults = append ? [...this.searchResults, ...pageResults] : pageResults;
            this.lastSearchCount = pageResults.length;
            this.currentSearchOffset = requestOffset + pageResults.length;
            this.searchHasMore = Boolean(result.has_more);
            this.totalSearchCount = Number(result.total || this.searchResults.length);
            this.renderSearchResults();
        } catch (e) {
            if (requestToken !== this.activeSearchToken) return;
            const message = String(e?.message || this._t('similar.searchFailed', 'Similarity search failed'));
            if (message.includes('was not found') || message.includes('has no embedding yet')) {
                this.searchResults = [];
                this.searchEmptyMessage = message;
                this.renderSearchResults();
                showToast(message, 'warning');
                return;
            }
            resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(this._t('similar.searchFailedMessage', 'Search failed: {message}', { message }))}</div>`;
            showToast(this._t('similar.searchFailed', 'Similarity search failed'), 'error');
        }
    },

    async searchByUpload(file, { append = false } = {}) {
        const { showToast, API } = window.App;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

        if (this.isCheckingEmbeddingStatus) {
            await this.waitForEmbeddingStatusReady();
        }

        if (this.isEmbedding || this.isCheckingEmbeddingStatus) {
            const message = this._t(
                'similar.searchBlockedRunning',
                'Embeddings are still running. Wait until indexing finishes before searching.'
            );
            this.renderSearchMessage(message);
            showToast(message, 'info');
            return;
        }

        const requestToken = this.beginSearchRequest();
        this.searchEmptyMessage = this._t(
            'similar.searchEmptyByUpload',
            'No similar images found for the uploaded image at the current threshold.'
        );
        if (!append) {
            this.currentSearchOffset = 0;
            this.searchResults = [];
            this.searchHasMore = false;
            this.totalSearchCount = 0;
            resultsContainer.innerHTML = '<div class="spinner"></div>';
        }

        try {
            const formData = new FormData();
            formData.append('file', file);

            const thresholdEl = document.getElementById('similar-search-threshold');
            const searchThreshold = thresholdEl ? parseFloat(thresholdEl.value) : 0.5;
            this.currentSearchMode = 'upload';
            this.currentSearchFile = file;
            this.currentSearchThreshold = searchThreshold;
            const requestOffset = append ? this.currentSearchOffset : 0;
            const response = await fetch(
                `/api/similarity/search-upload?limit=${this.searchPageSize}&offset=${requestOffset}&threshold=${searchThreshold}${this.getScopeQuery()}`,
                {
                method: 'POST',
                body: formData,
                }
            );
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `API Error: ${response.status}`);
            }
            const result = await response.json();
            if (requestToken !== this.activeSearchToken) return;

            const pageResults = Array.isArray(result.results) ? result.results : [];
            this.searchResults = append ? [...this.searchResults, ...pageResults] : pageResults;
            this.lastSearchCount = pageResults.length;
            this.currentSearchOffset = requestOffset + pageResults.length;
            this.searchHasMore = Boolean(result.has_more);
            this.totalSearchCount = Number(result.total || this.searchResults.length);
            this.renderSearchResults();
        } catch (e) {
            if (requestToken !== this.activeSearchToken) return;
            const message = String(e?.message || this._t('similar.uploadSearchFailed', 'Upload search failed'));
            if (message.includes('Invalid image file')) {
                this.searchResults = [];
                this.searchEmptyMessage = message;
                this.renderSearchResults();
                showToast(message, 'warning');
                return;
            }
            resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(this._t('similar.uploadSearchFailedMessage', 'Upload search failed: {message}', { message }))}</div>`;
            showToast(this._t('similar.uploadSearchFailed', 'Upload search failed'), 'error');
        }
    },

    setUploadDropzoneActive(isActive) {
        this.uploadDropzoneActive = Boolean(isActive);
        const dropzone = document.getElementById('similar-upload-dropzone');
        dropzone?.classList.toggle('is-active', this.uploadDropzoneActive);
    },

    handleUploadInputChange(event) {
        const input = event.target;
        const file = input?.files?.[0];
        if (file) {
            this.searchByUpload(file);
        }
        if (input) {
            input.value = '';
        }
    },

    handleUploadDrop(event) {
        event.preventDefault();
        this.setUploadDropzoneActive(false);

        const files = Array.from(event.dataTransfer?.files || []);
        const imageFile = files.find((file) => file.type.startsWith('image/'));
        if (!imageFile) {
            window.App.showToast(this._t('similar.dropImageToSearch', 'Drop an image file to search'), 'warning');
            return;
        }

        this.searchByUpload(imageFile);
    },

    // ============== Duplicate Finder ==============

    async findDuplicates({ append = false } = {}) {
        const { showToast, API } = window.App;

        const threshold = parseFloat(document.getElementById('similar-dup-threshold')?.value || '0.95');
        this.currentDuplicateThreshold = threshold;
        const resultsContainer = document.getElementById('similar-duplicates');
        if (!resultsContainer) return;

        if (this.isCheckingEmbeddingStatus) {
            await this.waitForEmbeddingStatusReady();
        }

        if (this.isEmbedding || this.isCheckingEmbeddingStatus) {
            const message = this._t(
                'similar.duplicatesBlockedRunning',
                'Embeddings are still running. Wait until indexing finishes before checking duplicates.'
            );
            this.renderDuplicateMessage(message);
            showToast(message, 'info');
            return;
        }

        const requestToken = this.beginDuplicateRequest();
        this.duplicateEmptyMessage = this._t(
            'similar.duplicateEmptyCurrentThreshold',
            'No duplicates found at this threshold.'
        );
        if (!append) {
            this.currentDuplicateOffset = 0;
            this.duplicateResults = [];
            this.duplicateHasMore = false;
            this.totalDuplicateCount = 0;
            resultsContainer.innerHTML = '<div class="spinner"></div>';
        }

        try {
            const requestOffset = append ? this.currentDuplicateOffset : 0;
            const result = await API.get(
                `/api/similarity/duplicates?threshold=${threshold}&limit=${this.duplicatePageSize}&offset=${requestOffset}`
            );
            if (requestToken !== this.activeDuplicateToken) return;
            const pageResults = Array.isArray(result.duplicates) ? result.duplicates : [];
            this.duplicateResults = append ? [...this.duplicateResults, ...pageResults] : pageResults;
            this.lastDuplicateCount = pageResults.length;
            this.currentDuplicateOffset = requestOffset + pageResults.length;
            this.duplicateHasMore = Boolean(result.has_more);
            this.totalDuplicateCount = Number(result.total || this.duplicateResults.length);
            if (result.reason === 'insufficient_embeddings') {
                this.duplicateEmptyMessage = this._t(
                    'similar.needMoreEmbeddings',
                    `Need at least ${result.minimum_required || 2} embedded images before duplicate search is meaningful.`,
                    { count: result.minimum_required || 2 },
                );
            } else if (result.reason === 'too_many_embeddings') {
                this.duplicateEmptyMessage = this._t(
                    'similar.tooManyEmbeddingsForSyncDuplicates',
                    `Duplicate search is limited to ${result.max_embeddings || 5000} embedded images for this synchronous tool. Narrow the library or use a staged/background duplicate workflow.`,
                    { count: result.embedded_count || 0, max: result.max_embeddings || 5000 },
                );
            }
            if (this.duplicateResults.length === 0) {
                resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(this.duplicateEmptyMessage)}</div>`;
                return;
            }
            this.renderDuplicateResults();
        } catch (e) {
            if (requestToken !== this.activeDuplicateToken) return;
            resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(this._t('similar.duplicateSearchFailedMessage', 'Duplicate search failed: {message}', { message: e.message }))}</div>`;
            showToast(this._t('similar.duplicateSearchFailed', 'Duplicate search failed'), 'error');
        }
    },

    // ============== Rendering ==============

    renderSearchResults() {
        const container = document.getElementById('similar-results');
        const loadMoreBtn = document.getElementById('btn-similar-load-more');
        if (!container) return;

        if (this.searchResults.length === 0) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(this.searchEmptyMessage)}</div>`;
            if (loadMoreBtn) loadMoreBtn.style.display = 'none';
            return;
        }

        const { API } = window.App;
        const getThumbnailUrl = (id) => API?.getThumbnailUrl?.(id) ?? `/api/image-thumbnail/${id}?size=256`;
        const fragment = document.createDocumentFragment();

        this.searchResults.forEach((result) => {
            fragment.appendChild(this._renderSearchResult(result, getThumbnailUrl));
        });

        container.replaceChildren(fragment);

        container.querySelectorAll('.similar-result').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.id, 10);
                this._previewImage(id);
            });
        });

        container.querySelectorAll('.similar-action-btn').forEach(btn => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const action = btn.dataset.action;
                const id = parseInt(btn.dataset.id, 10);
                if (!id) return;
                if (action === 'preview') this._previewImage(id);
                if (action === 'reader') this._openInReader(id, btn.dataset.filename || '');
                if (action === 'edit') this._sendToEdit(id);
                if (action === 'build') this._openInBuild(id);
            });
        });

        if (loadMoreBtn) {
            loadMoreBtn.style.display = this.searchHasMore ? 'inline-flex' : 'none';
        }
    },

    renderDuplicateResults() {
        const container = document.getElementById('similar-duplicates');
        const loadMoreBtn = document.getElementById('btn-similar-duplicates-more');
        if (!container) return;

        if (this.duplicateResults.length === 0) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(this.duplicateEmptyMessage)}</div>`;
            if (loadMoreBtn) loadMoreBtn.style.display = 'none';
            return;
        }

        const { API } = window.App;
        const getThumbnailUrl = (id) => API?.getThumbnailUrl?.(id) ?? `/api/image-thumbnail/${id}?size=256`;
        const fragment = document.createDocumentFragment();

        this.duplicateResults.forEach((pair) => {
            fragment.appendChild(this._renderDuplicatePair(pair, getThumbnailUrl));
        });

        container.replaceChildren(fragment);

        container.querySelectorAll('.dup-image').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.id, 10);
                this._previewImage(id);
            });
        });

        container.querySelectorAll('.similar-action-btn').forEach(btn => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const action = btn.dataset.action;
                const id = parseInt(btn.dataset.id, 10);
                if (!id) return;
                if (action === 'preview') this._previewImage(id);
                if (action === 'reader') this._openInReader(id, btn.dataset.filename || '');
                if (action === 'edit') this._sendToEdit(id);
                if (action === 'build') this._openInBuild(id);
            });
        });

        if (loadMoreBtn) {
            loadMoreBtn.style.display = this.duplicateHasMore ? 'inline-flex' : 'none';
        }
    },

    async loadMoreSearchResults() {
        if (this.currentSearchMode === 'id' && this.currentSearchId) {
            await this.searchByImage(this.currentSearchId, { append: true });
            return;
        }
        if (this.currentSearchMode === 'upload' && this.currentSearchFile) {
            await this.searchByUpload(this.currentSearchFile, { append: true });
        }
    },

    async loadMoreDuplicateResults() {
        await this.findDuplicates({ append: true });
    },

    _previewImage(id) {
        if (window.App && typeof window.App.openGalleryPreview === 'function') {
            window.App.openGalleryPreview(id);
        } else if (window.Gallery) {
            window.Gallery.openPreview(id);
        }
    },

    _sendToEdit(id) {
        if (window.App?.addToCensorQueue) {
            window.App.addToCensorQueue([id]);
        }
    },

    _openInReader(id, filename = '') {
        window.App?.openReaderFromImage?.(id, filename);
    },

    _openInBuild(id) {
        window.App?.openPromptBuildFromImage?.(id);
    },

    _renderSearchResult(result, getThumbnailUrl) {
        const card = document.createElement('div');
        card.className = 'similar-result';
        card.dataset.id = String(result.id);

        const thumb = document.createElement('div');
        thumb.className = 'similar-thumb';

        const img = document.createElement('img');
        img.src = getThumbnailUrl(result.id);
        img.alt = result.filename || '';
        img.loading = 'lazy';
        thumb.appendChild(img);

        const info = document.createElement('div');
        info.className = 'similar-info';

        const score = document.createElement('span');
        score.className = 'similar-score';
        score.textContent = `${(result.similarity * 100).toFixed(1)}%`;

        const name = document.createElement('span');
        name.className = 'similar-name';
        name.title = result.filename || '';
        name.textContent = result.filename || this._t('similar.itemUnknown', 'Unknown');

        const actions = document.createElement('div');
        actions.className = 'similar-actions';
        actions.innerHTML = `
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="preview" data-id="${result.id}">👁 ${this._t('similar.preview', 'Preview')}</button>
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="reader" data-id="${result.id}" data-filename="${escapeHtml(result.filename || '')}">📖 ${this._t('similar.reader', 'Reader')}</button>
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="edit" data-id="${result.id}">🔳 ${this._t('similar.edit', 'Edit')}</button>
            <button class="btn btn-secondary btn-small similar-action-btn" data-action="build" data-id="${result.id}">✏️ ${this._t('similar.build', 'Build')}</button>
        `;

        info.append(score, name, actions);
        card.append(thumb, info);
        return card;
    },

    _renderDuplicatePair(pair, getThumbnailUrl) {
        const wrapper = document.createElement('div');
        wrapper.className = 'duplicate-pair';

        // Backend returns {image_a: {id, filename}, image_b: {id, filename}, similarity}
        // Legacy shape: {id1, filename1, id2, filename2, similarity}
        const id1 = pair.id1 ?? pair.image_a?.id;
        const id2 = pair.id2 ?? pair.image_b?.id;
        const filename1 = pair.filename1 ?? pair.image_a?.filename ?? '';
        const filename2 = pair.filename2 ?? pair.image_b?.filename ?? '';
        const similarity = pair.similarity ?? 0;

        const first = document.createElement('div');
        first.className = 'dup-image';
        if (id1 != null) first.dataset.id = String(id1);

        const firstImg = document.createElement('img');
        firstImg.src = id1 != null ? getThumbnailUrl(id1) : '';
        firstImg.alt = '';
        firstImg.loading = 'lazy';

        const firstName = document.createElement('span');
        firstName.className = 'dup-name';
        firstName.textContent = filename1;

        const firstActions = document.createElement('div');
        firstActions.className = 'similar-actions';
        firstActions.innerHTML = `
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="preview" data-id="${id1}" title="${this._t('similar.preview', 'Preview')}">👁</button>
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="reader" data-id="${id1}" data-filename="${escapeHtml(filename1 || '')}" title="${this._t('similar.reader', 'Reader')}">📖</button>
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="edit" data-id="${id1}" title="${this._t('similar.edit', 'Edit')}">🔳</button>
            <button class="btn btn-secondary btn-small similar-action-btn" data-action="build" data-id="${id1}" title="${this._t('similar.build', 'Build')}">✏️</button>
        `;

        first.append(firstImg, firstName, firstActions);

        const score = document.createElement('div');
        score.className = 'dup-score';
        score.textContent = `${(similarity * 100).toFixed(1)}%`;

        const second = document.createElement('div');
        second.className = 'dup-image';
        if (id2 != null) second.dataset.id = String(id2);

        const secondImg = document.createElement('img');
        secondImg.src = id2 != null ? getThumbnailUrl(id2) : '';
        secondImg.alt = '';
        secondImg.loading = 'lazy';

        const secondName = document.createElement('span');
        secondName.className = 'dup-name';
        secondName.textContent = filename2;

        const secondActions = document.createElement('div');
        secondActions.className = 'similar-actions';
        secondActions.innerHTML = `
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="preview" data-id="${id2}" title="${this._t('similar.preview', 'Preview')}">👁</button>
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="reader" data-id="${id2}" data-filename="${escapeHtml(filename2 || '')}" title="${this._t('similar.reader', 'Reader')}">📖</button>
            <button class="btn btn-ghost btn-small similar-action-btn" data-action="edit" data-id="${id2}" title="${this._t('similar.edit', 'Edit')}">🔳</button>
            <button class="btn btn-secondary btn-small similar-action-btn" data-action="build" data-id="${id2}" title="${this._t('similar.build', 'Build')}">✏️</button>
        `;

        second.append(secondImg, secondName, secondActions);
        wrapper.append(first, score, second);
        return wrapper;
    },

    bindEvents() {
        // Embed button
        const btnEmbed = document.getElementById('btn-similar-embed');
        btnEmbed?.addEventListener('click', () => this.startEmbedding());
        document.getElementById('btn-similar-status-embed')?.addEventListener('click', () => this.startEmbedding());

        // Search from gallery - accept image ID from input
        const btnSearch = document.getElementById('btn-similar-search');
        btnSearch?.addEventListener('click', () => {
            const idInput = document.getElementById('similar-search-id');
            const id = parseInt(idInput?.value, 10);
            if (id) {
                this.searchByImage(id);
            } else {
                window.App.showToast(this._t('similar.searchByIdRequired', 'Enter an image ID to search'), 'info');
            }
        });

        // Upload search
        const uploadInput = document.getElementById('similar-upload-input');
        const btnUpload = document.getElementById('btn-similar-upload');
        const uploadDropzone = document.getElementById('similar-upload-dropzone');

        btnUpload?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (uploadInput) {
                uploadInput.value = '';
                uploadInput.click();
            }
        });

        uploadDropzone?.addEventListener('click', () => {
            if (uploadInput) {
                uploadInput.value = '';
                uploadInput.click();
            }
        });

        uploadDropzone?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (uploadInput) {
                    uploadInput.value = '';
                    uploadInput.click();
                }
            }
        });

        ['dragenter', 'dragover'].forEach((eventName) => {
            uploadDropzone?.addEventListener(eventName, (event) => {
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'copy';
                }
                this.setUploadDropzoneActive(true);
            });
        });

        uploadDropzone?.addEventListener('dragleave', (event) => {
            if (event.currentTarget?.contains(event.relatedTarget)) {
                return;
            }
            this.setUploadDropzoneActive(false);
        });
        uploadDropzone?.addEventListener('dragend', () => this.setUploadDropzoneActive(false));
        uploadDropzone?.addEventListener('drop', (event) => this.handleUploadDrop(event));
        uploadInput?.addEventListener('change', (event) => this.handleUploadInputChange(event));
        document.getElementById('btn-similar-load-more')?.addEventListener('click', () => this.loadMoreSearchResults());
        document.getElementById('btn-similar-duplicates-more')?.addEventListener('click', () => this.loadMoreDuplicateResults());

        // Duplicate finder
        const btnDuplicates = document.getElementById('btn-similar-duplicates');
        btnDuplicates?.addEventListener('click', () => {
            this.findDuplicates();
        });

        // Threshold slider
        const thresholdSlider = document.getElementById('similar-dup-threshold');
        const thresholdValue = document.getElementById('similar-dup-threshold-value');
        thresholdSlider?.addEventListener('input', () => {
            if (thresholdValue) thresholdValue.textContent = (parseFloat(thresholdSlider.value) * 100).toFixed(0) + '%';
        });

        // Search threshold slider
        const searchThresholdSlider = document.getElementById('similar-search-threshold');
        const searchThresholdValue = document.getElementById('similar-search-threshold-value');
        searchThresholdSlider?.addEventListener('input', () => {
            if (searchThresholdValue) searchThresholdValue.textContent = (parseFloat(searchThresholdSlider.value) * 100).toFixed(0) + '%';
        });

        // Search scope selector (All / Favorites / collections)
        const scopeSelect = document.getElementById('similar-search-scope');
        scopeSelect?.addEventListener('change', (event) => this.onScopeChange(event.target.value));

        // Tab switching within Similar view
        document.querySelectorAll('.similar-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.similar-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const target = tab.dataset.target;
                document.querySelectorAll('.similar-panel').forEach(p => {
                    p.style.display = p.id === target ? 'block' : 'none';
                });
            });
        });

        // Refresh model status when a model is prepared/downloaded from Model Manager
        document.addEventListener('model-status-changed', (event) => {
            const modelId = event.detail?.modelId;
            if (!modelId || modelId === 'clip') {
                this.loadModelStatus();
                this.loadStats();
            }
        });
    }
};

// Initialize when Similar tab is first activated
let similarInitialized = false;

function initSimilar() {
    if (similarInitialized) {
        SimilarImages.resumeEmbeddingProgress();
        return;
    }
    similarInitialized = true;
    SimilarImages.init();
}

window.SimilarImages = SimilarImages;
window.initSimilar = initSimilar;
document.addEventListener('languageChanged', () => {
    SimilarImages._applyLocalizedDefaults();
    if (!similarInitialized) return;
    SimilarImages.loadStats();
    SimilarImages.loadScopeOptions();
    SimilarImages.refreshWorkflowStatus();
});
