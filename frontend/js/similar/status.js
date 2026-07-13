/**
 * similar/status.js — similar.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut
 * lines 126-266 + 314-347 + 503-631 (of 1,517): getEmbeddingStats,
 * dismissFirstUseCard, refreshFirstUseCard, refreshContentVisibility,
 * refreshWorkflowStatus, updateActionAvailability, showFirstUseGuide,
 * loadModelStatus and loadStats (the '// ===== Data Loading =====' section
 * comment travels with it) — the workflow-status card state machine +
 * action-availability gates. Classic non-strict script: joins the ONE
 * unsealed window.SimilarImages object declared in similar/core.js, which
 * loads FIRST; boot.js publishes initSimilar LAST.
 */
Object.assign(window.SimilarImages, {
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

        // Building the index needs CLIP: don't leave the blue "Generate
        // Embeddings" primary enabled while the model is missing — the real next
        // action is Open Setup / Download (promoted to primary in the banner).
        const btnEmbed = document.getElementById('btn-similar-embed');
        if (btnEmbed) btnEmbed.disabled = !modelReady || this.isEmbedding || this.isCheckingEmbeddingStatus;

        if (searchInput) searchInput.disabled = disableSearchActions;
        if (btnSearch) btnSearch.disabled = disableSearchActions;
        const semanticInput = document.getElementById('similar-search-text');
        const btnSemantic = document.getElementById('btn-similar-search-text');
        if (semanticInput) semanticInput.disabled = disableSearchActions;
        if (btnSemantic) btnSemantic.disabled = disableSearchActions;
        if (btnUpload) btnUpload.disabled = disableSearchActions;
        if (btnDuplicates) btnDuplicates.disabled = disableDuplicateActions;
        if (uploadInput) uploadInput.disabled = disableSearchActions;
        if (uploadDropzone) {
            uploadDropzone.classList.toggle('disabled', disableSearchActions);
            uploadDropzone.setAttribute('aria-disabled', String(disableSearchActions));
        }
        this.refreshContentVisibility();
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
            if (result.message_key || result.message) {
                // Prefer the backend's message_key so the tech detail is
                // localized; raw message stays as the fallback (QA P3-7a).
                detailItems.push(result.message_key
                    ? this._t(result.message_key, result.message || '')
                    : result.message);
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
            // When CLIP is missing this IS the screen's next action, so it gets
            // the single blue primary — the Generate Embeddings button is
            // disabled (updateActionAvailability) because it can't succeed yet.
            const setupBtnHtml = result.available ? '' : `
                <button type="button" class="btn btn-primary btn-small model-health-setup-btn" data-action="open-model-guidance">
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

});
