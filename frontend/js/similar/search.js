/**
 * similar/search.js — similar.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut
 * lines 348-353 + 360-367 + 763-1028 (of 1,517): beginSearchRequest,
 * renderSearchMessage, searchByImage (the '// ===== Search by Image ====='
 * section comment travels with it), _renderSearchStateNode, searchByText,
 * searchByUpload, setUploadDropzoneActive, handleUploadInputChange,
 * handleUploadDrop. beginSearchRequest and duplicates.js's
 * beginDuplicateRequest deliberately advance the SAME this.requestSequence
 * counter (one shared token space — a text search must supersede an
 * in-flight image search; pins 4 + 6 guard this). Classic non-strict
 * script: joins the ONE unsealed window.SimilarImages object declared in
 * similar/core.js, which loads FIRST; boot.js publishes initSimilar LAST.
 */
Object.assign(window.SimilarImages, {
    beginSearchRequest() {
        this.requestSequence += 1;
        this.activeSearchToken = this.requestSequence;
        return this.activeSearchToken;
    },

    renderSearchMessage(message) {
        const container = document.getElementById('similar-results');
        const loadMoreBtn = document.getElementById('btn-similar-load-more');
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
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

    _renderSearchStateNode(className, text) {
        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;
        resultsContainer.textContent = '';
        const node = document.createElement('div');
        node.className = className;
        if (text) node.textContent = text;
        resultsContainer.appendChild(node);
    },

    async searchByText(query, { append = false } = {}) {
        const { showToast } = window.App;
        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;
        const value = String(query || '').trim();
        if (!value) return;

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
            'similar.searchEmptyByText',
            'No embedded images matched this description. Run Generate Embeddings first if the library is new.'
        );
        if (!append) {
            this.currentSearchOffset = 0;
            this.searchResults = [];
            this.searchHasMore = false;
            this.totalSearchCount = 0;
            this._renderSearchStateNode('spinner', '');
        }

        try {
            // Cross-modal CLIP cosine sits ~0.2-0.35 for matches, so the
            // image-search threshold slider does not apply here — text
            // search is pure top-k ranking (threshold 0).
            this.currentSearchMode = 'text';
            this.currentSearchText = value;
            const requestOffset = append ? this.currentSearchOffset : 0;
            const body = {
                query: value,
                limit: this.searchPageSize,
                offset: requestOffset,
                threshold: 0,
            };
            if (this.collectionId) body.collection_id = this.collectionId;
            const response = await fetch('/api/similarity/search-text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || errorData.detail || `API Error: ${response.status}`);
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
            const message = String(e?.message || this._t('similar.textSearchFailed', 'Semantic search failed'));
            this._renderSearchStateNode(
                'empty-state',
                this._t('similar.textSearchFailedMessage', 'Semantic search failed: {message}', { message })
            );
            showToast(this._t('similar.textSearchFailed', 'Semantic search failed'), 'error');
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

});
