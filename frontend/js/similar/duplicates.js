/**
 * similar/duplicates.js — similar.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut
 * lines 354-359 + 368-375 + 1029-1102 (of 1,517): beginDuplicateRequest,
 * renderDuplicateMessage and findDuplicates (the '// ===== Duplicate
 * Finder =====' section comment travels with it). beginDuplicateRequest
 * shares the ONE this.requestSequence counter with search.js's
 * beginSearchRequest (pins 4 + 6). Classic non-strict script: joins the
 * ONE unsealed window.SimilarImages object declared in similar/core.js,
 * which loads FIRST; boot.js publishes initSimilar LAST.
 */
Object.assign(window.SimilarImages, {
    beginDuplicateRequest() {
        this.requestSequence += 1;
        this.activeDuplicateToken = this.requestSequence;
        return this.activeDuplicateToken;
    },

    renderDuplicateMessage(message) {
        const container = document.getElementById('similar-duplicates');
        const loadMoreBtn = document.getElementById('btn-similar-duplicates-more');
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
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

});
