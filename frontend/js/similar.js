/**
 * SD Image Sorter - Similar Images Module
 * Handles similarity search UI, duplicate finder, and embedding management.
 */

// escapeHtml fallback — main definition is in app.js
if (typeof escapeHtml === 'undefined') {
    var escapeHtml = (value) => String(value ?? '');
}

const SimilarImages = {
    isEmbedding: false,
    isCheckingEmbeddingStatus: false,
    embedProgress: { processed: 0, total: 0, errors: 0 },
    searchResults: [],
    duplicateResults: [],
    currentSearchId: null,
    requestSequence: 0,
    activeSearchToken: 0,
    activeDuplicateToken: 0,
    searchEmptyMessage: 'No similar images found. Try generating embeddings first.',
    duplicateEmptyMessage: 'No duplicates found at this threshold.',
    uploadDropzoneActive: false,

    _t(key, fallback, params) {
        return window.I18n?.t?.(key, params) || fallback || key;
    },

    init() {
        this.bindEvents();
        this.loadStats();
        this.resumeEmbeddingProgress();
        this.updateActionAvailability();
        this.showFirstUseGuide();
    },

    setEmbeddingUiState(isRunning, label = null) {
        const btnEmbed = document.getElementById('btn-similar-embed');
        if (!btnEmbed) return;

        btnEmbed.disabled = isRunning;
        btnEmbed.textContent = label || (isRunning ? 'Embedding...' : 'Generate Embeddings');
        this.updateActionAvailability();
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
    },

    updateActionAvailability() {
        const disableSearchActions = this.isEmbedding || this.isCheckingEmbeddingStatus;
        const searchInput = document.getElementById('similar-search-id');
        const btnSearch = document.getElementById('btn-similar-search');
        const btnUpload = document.getElementById('btn-similar-upload');
        const btnDuplicates = document.getElementById('btn-similar-duplicates');
        const uploadInput = document.getElementById('similar-upload-input');
        const uploadDropzone = document.getElementById('similar-upload-dropzone');

        if (searchInput) searchInput.disabled = disableSearchActions;
        if (btnSearch) btnSearch.disabled = disableSearchActions;
        if (btnUpload) btnUpload.disabled = disableSearchActions;
        if (btnDuplicates) btnDuplicates.disabled = disableSearchActions;
        if (uploadInput) uploadInput.disabled = disableSearchActions;
        if (uploadDropzone) {
            uploadDropzone.classList.toggle('disabled', disableSearchActions);
            uploadDropzone.setAttribute('aria-disabled', String(disableSearchActions));
        }
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
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    },

    renderDuplicateMessage(message) {
        const container = document.getElementById('similar-duplicates');
        if (!container) return;
        container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    },

    renderEmbeddingProgress(progress = {}) {
        const progressBar = document.getElementById('similar-embed-progress');
        const progressFill = document.getElementById('similar-embed-fill');
        const progressText = document.getElementById('similar-embed-text');
        const total = Number(progress.total || 0);
        const processed = Number(progress.processed || progress.current || 0);
        const errors = Number(progress.errors || 0);
        const completed = total > 0 ? Math.min(total, processed + errors) : 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

        if (progressBar) {
            progressBar.style.display = 'block';
        }
        if (progressFill) {
            progressFill.style.width = `${percent}%`;
        }
        if (progressText) {
            if (progress.message) {
                progressText.textContent = progress.message;
            } else if (total > 0) {
                const detail = errors > 0
                    ? `${processed} embedded, ${errors} error(s)`
                    : `${processed} embedded`;
                progressText.textContent = `${completed}/${total} images (${detail})`;
            } else if (progress.running) {
                progressText.textContent = 'Preparing embeddings...';
            } else {
                progressText.textContent = 'No pending images to embed.';
            }
        }
    },

    async resumeEmbeddingProgress({ optimistic = true } = {}) {
        if (this.isEmbedding || this.isCheckingEmbeddingStatus) return;

        this.isCheckingEmbeddingStatus = true;
        if (optimistic) {
            this.setEmbeddingUiState(true, 'Checking status...');
        }

        try {
            const progress = await window.App.API.get('/api/similarity/progress');
            this.embedProgress = progress;

            if (!progress?.running) {
                this.isEmbedding = false;
                this.setEmbeddingUiState(false);
                return;
            }

            this.isEmbedding = true;
            this.setEmbeddingUiState(true);
            this.renderEmbeddingProgress(progress);
            this.pollEmbedProgress();
        } catch (e) {
            this.setEmbeddingUiState(false);
            Logger.warn('Failed to resume similarity embedding progress:', e);
        } finally {
            this.isCheckingEmbeddingStatus = false;
            this.updateActionAvailability();
        }
    },

    showFirstUseGuide() {
        if (localStorage.getItem('similar-guide-seen')) return;

        const view = document.getElementById('view-similar');
        if (!view) return;

        const overlay = window.App.createGuideOverlay({
            id: 'similar-first-use-guide',
            storageKey: 'similar-guide-seen',
            title: '🔍 Similar Images Guide',
            description: 'Find visually similar images in your library using AI.',
            steps: [
                { title: 'Generate Embeddings', text: 'Creates visual fingerprints for all images (first time downloads ~200MB model)' },
                { title: 'Search by ID', text: 'Enter an image ID from your gallery' },
                { title: 'Upload Search', text: 'Drag & drop any image to find similar ones' },
                { title: 'Duplicates', text: 'Find near-duplicate images in your library' },
            ],
            maxWidth: '480px',
        });

        view.style.position = 'relative';
        view.appendChild(overlay);

        overlay.querySelector('[data-guide-close]')?.addEventListener('click', () => {
            overlay.remove();
            localStorage.setItem('similar-guide-seen', 'true');
        });
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
            statsEl.innerHTML = `
                <div class="stat-card">
                    <span class="stat-number">${result.total_images || 0}</span>
                    <span class="stat-label">Total Images</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.embedded_count ?? result.embedded_images ?? 0}</span>
                    <span class="stat-label">Embedded</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.pending_count ?? result.pending ?? 0}</span>
                    <span class="stat-label">Pending</span>
                </div>
            `;
        } catch (e) {
            if (e.message === 'App API is not ready yet') {
                setTimeout(() => this.loadStats(), 100);
                return;
            }
            statsEl.innerHTML = '<div class="stat-card"><span class="stat-label">Failed to load stats</span></div>';
        }
    },

    // ============== Embedding ==============

    async startEmbedding() {
        if (this.isEmbedding) return;

        const { showToast } = window.App;
        this.isEmbedding = true;

        this.setEmbeddingUiState(true);
        this.renderEmbeddingProgress({ running: true, total: 0, processed: 0, errors: 0 });

        try {
            const result = await window.App.API.post('/api/similarity/embed');
            this.embedProgress = result?.progress || this.embedProgress;
            if (result?.progress) {
                this.renderEmbeddingProgress(result.progress);
            }

            if (result?.status === 'already_running') {
                showToast('Embedding is already running in the background', 'info');
            } else {
                showToast('Embedding started in background', 'info');
            }
            this.pollEmbedProgress();
        } catch (e) {
            showToast(formatUserError(e, "Failed to start similarity processing"), "error");
            this.isEmbedding = false;
            this.resetEmbeddingUi();
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
                const errors = Number(result.errors || 0);
                const completed = total > 0 ? Math.min(total, processed + errors) : 0;
                const finalMessage = total > 0
                    ? `${completed}/${total} images (${processed} embedded${errors > 0 ? `, ${errors} error(s)` : ''})`
                    : 'No pending images to embed.';

                this.resetEmbeddingUi({ hideProgress: false, progressMessage: finalMessage });
                if (progressBar) {
                    setTimeout(() => { progressBar.style.display = 'none'; }, 2000);
                }
                this.loadStats();
                if (total === 0) {
                    window.App.showToast('No pending images to embed', 'info');
                } else if (errors > 0) {
                    window.App.showToast(`Embedding finished: ${processed} embedded, ${errors} failed`, 'warning');
                } else {
                    window.App.showToast(`Embedding complete: ${processed} images embedded`, 'success');
                }
            }
        } catch (e) {
            this.isEmbedding = false;
            this.resetEmbeddingUi();
            window.App.showToast(formatUserError(e, 'Failed to refresh embedding progress'), 'error');
        }
    },

    // ============== Search by Image ==============

    async searchByImage(imageId) {
        const { showToast, API } = window.App;
        this.currentSearchId = imageId;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

        if (this.isEmbedding || this.isCheckingEmbeddingStatus) {
            const message = 'Embeddings are still running. Wait until indexing finishes before searching.';
            this.renderSearchMessage(message);
            showToast(message, 'info');
            return;
        }

        const requestToken = this.beginSearchRequest();
        this.searchEmptyMessage = 'No similar images found for this image at the current threshold.';

        resultsContainer.innerHTML = '<div class="spinner"></div>';

        try {
            const result = await API.get(`/api/similarity/search/${imageId}?limit=20`);
            if (requestToken !== this.activeSearchToken) return;
            this.searchResults = result.results || [];
            this.renderSearchResults();
        } catch (e) {
            if (requestToken !== this.activeSearchToken) return;
            const message = String(e?.message || 'Similarity search failed');
            if (message.includes('was not found') || message.includes('has no embedding yet')) {
                this.searchResults = [];
                this.searchEmptyMessage = message;
                this.renderSearchResults();
                showToast(message, 'warning');
                return;
            }
            resultsContainer.innerHTML = `<div class="empty-state">Search failed: ${escapeHtml(message)}</div>`;
            showToast('Similarity search failed', 'error');
        }
    },

    async searchByUpload(file) {
        const { showToast, API } = window.App;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

        if (this.isEmbedding || this.isCheckingEmbeddingStatus) {
            const message = 'Embeddings are still running. Wait until indexing finishes before searching.';
            this.renderSearchMessage(message);
            showToast(message, 'info');
            return;
        }

        const requestToken = this.beginSearchRequest();
        this.searchEmptyMessage = 'No similar images found for the uploaded image at the current threshold.';

        resultsContainer.innerHTML = '<div class="spinner"></div>';

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch('/api/similarity/search-upload?limit=20', {
                method: 'POST',
                body: formData,
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `API Error: ${response.status}`);
            }
            const result = await response.json();
            if (requestToken !== this.activeSearchToken) return;

            this.searchResults = result.results || [];
            this.renderSearchResults();
        } catch (e) {
            if (requestToken !== this.activeSearchToken) return;
            const message = String(e?.message || 'Upload search failed');
            if (message.includes('Invalid image file')) {
                this.searchResults = [];
                this.searchEmptyMessage = message;
                this.renderSearchResults();
                showToast(message, 'warning');
                return;
            }
            resultsContainer.innerHTML = `<div class="empty-state">Upload search failed: ${escapeHtml(message)}</div>`;
            showToast('Upload search failed', 'error');
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
            window.App.showToast('Drop an image file to search', 'warning');
            return;
        }

        this.searchByUpload(imageFile);
    },

    // ============== Duplicate Finder ==============

    async findDuplicates() {
        const { showToast, API } = window.App;

        const threshold = parseFloat(document.getElementById('similar-dup-threshold')?.value || '0.95');
        const resultsContainer = document.getElementById('similar-duplicates');
        if (!resultsContainer) return;

        if (this.isEmbedding || this.isCheckingEmbeddingStatus) {
            const message = 'Embeddings are still running. Wait until indexing finishes before checking duplicates.';
            this.renderDuplicateMessage(message);
            showToast(message, 'info');
            return;
        }

        const requestToken = this.beginDuplicateRequest();
        this.duplicateEmptyMessage = 'No duplicates found at this threshold.';

        resultsContainer.innerHTML = '<div class="spinner"></div>';

        try {
            const result = await API.get(`/api/similarity/duplicates?threshold=${threshold}&limit=50`);
            if (requestToken !== this.activeDuplicateToken) return;
            this.duplicateResults = result.duplicates || [];
            if (result.reason === 'insufficient_embeddings') {
                this.duplicateEmptyMessage = this._t(
                    'similar.needMoreEmbeddings',
                    `Need at least ${result.minimum_required || 2} embedded images before duplicate search is meaningful.`,
                    { count: result.minimum_required || 2 },
                );
            }
            if (this.duplicateResults.length === 0) {
                resultsContainer.innerHTML = `<div class="empty-state">${escapeHtml(this.duplicateEmptyMessage)}</div>`;
                return;
            }
            this.renderDuplicateResults();
        } catch (e) {
            if (requestToken !== this.activeDuplicateToken) return;
            resultsContainer.innerHTML = `<div class="empty-state">Duplicate search failed: ${escapeHtml(e.message)}</div>`;
            showToast('Duplicate search failed', 'error');
        }
    },

    // ============== Rendering ==============

    renderSearchResults() {
        const container = document.getElementById('similar-results');
        if (!container) return;

        if (this.searchResults.length === 0) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(this.searchEmptyMessage)}</div>`;
            return;
        }

        const { API } = window.App;
        const getThumbnailUrl = (id) => API?.getThumbnailUrl?.(id) ?? `/api/image-thumbnail/${id}?size=256`;
        const fragment = document.createDocumentFragment();

        this.searchResults.forEach((result) => {
            fragment.appendChild(this._renderSearchResult(result, getThumbnailUrl));
        });

        container.replaceChildren(fragment);

        // Click to open preview
        container.querySelectorAll('.similar-result').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.id, 10);
                if (window.App && typeof window.App.openGalleryPreview === 'function') {
                    window.App.openGalleryPreview(id);
                } else if (window.Gallery) {
                    window.Gallery.openPreview(id);
                }
            });
        });
    },

    renderDuplicateResults() {
        const container = document.getElementById('similar-duplicates');
        if (!container) return;

        if (this.duplicateResults.length === 0) {
            container.innerHTML = `<div class="empty-state">${escapeHtml(this.duplicateEmptyMessage)}</div>`;
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
                if (window.App && typeof window.App.openGalleryPreview === 'function') {
                    window.App.openGalleryPreview(id);
                } else if (window.Gallery) {
                    window.Gallery.openPreview(id);
                }
            });
        });
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
        name.textContent = result.filename || 'Unknown';

        info.append(score, name);
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

        first.append(firstImg, firstName);

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

        second.append(secondImg, secondName);
        wrapper.append(first, score, second);
        return wrapper;
    },

    bindEvents() {
        // Embed button
        const btnEmbed = document.getElementById('btn-similar-embed');
        btnEmbed?.addEventListener('click', () => this.startEmbedding());

        // Search from gallery - accept image ID from input
        const btnSearch = document.getElementById('btn-similar-search');
        btnSearch?.addEventListener('click', () => {
            const idInput = document.getElementById('similar-search-id');
            const id = parseInt(idInput?.value, 10);
            if (id) {
                this.searchByImage(id);
            } else {
                window.App.showToast('Enter an image ID to search', 'info');
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

        // Duplicate finder
        const btnDuplicates = document.getElementById('btn-similar-duplicates');
        btnDuplicates?.addEventListener('click', () => this.findDuplicates());

        // Threshold slider
        const thresholdSlider = document.getElementById('similar-dup-threshold');
        const thresholdValue = document.getElementById('similar-dup-threshold-value');
        thresholdSlider?.addEventListener('input', () => {
            if (thresholdValue) thresholdValue.textContent = (parseFloat(thresholdSlider.value) * 100).toFixed(0) + '%';
        });

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
