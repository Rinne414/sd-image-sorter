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
    embedProgress: { current: 0, total: 0 },
    searchResults: [],
    duplicateResults: [],
    currentSearchId: null,

    init() {
        this.bindEvents();
        this.loadStats();
        this.showFirstUseGuide();
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

        const btnEmbed = document.getElementById('btn-similar-embed');
        if (btnEmbed) {
            btnEmbed.disabled = true;
            btnEmbed.textContent = 'Embedding...';
        }

        try {
            await window.App.API.post('/api/similarity/embed');
            showToast('Embedding started in background', 'info');
            this.pollEmbedProgress();
        } catch (e) {
            showToast(formatUserError(e, "Failed to start similarity processing"), "error");
            this.isEmbedding = false;
            if (btnEmbed) {
                btnEmbed.disabled = false;
                btnEmbed.textContent = 'Generate Embeddings';
            }
        }
    },

    async pollEmbedProgress() {
        const progressBar = document.getElementById('similar-embed-progress');
        const progressFill = document.getElementById('similar-embed-fill');
        const progressText = document.getElementById('similar-embed-text');

        if (progressBar) progressBar.style.display = 'block';

        try {
            const result = await window.App.API.get('/api/similarity/progress');
            this.embedProgress = result;

            const percent = result.total > 0 ? (result.current / result.total) * 100 : 0;
            if (progressFill) progressFill.style.width = percent + '%';
            if (progressText) progressText.textContent = result.message || `${result.current}/${result.total}`;

            if (result.status === 'running') {
                setTimeout(() => this.pollEmbedProgress(), 1000);
            } else {
                this.isEmbedding = false;
                const btnEmbed = document.getElementById('btn-similar-embed');
                if (btnEmbed) {
                    btnEmbed.disabled = false;
                    btnEmbed.textContent = 'Generate Embeddings';
                }
                if (progressBar) {
                    setTimeout(() => { progressBar.style.display = 'none'; }, 2000);
                }
                this.loadStats();
                if (result.status === 'done') {
                    window.App.showToast(result.message || 'Embedding complete', 'success');
                }
            }
        } catch (e) {
            this.isEmbedding = false;
        }
    },

    // ============== Search by Image ==============

    async searchByImage(imageId) {
        const { showToast, API } = window.App;
        this.currentSearchId = imageId;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

        resultsContainer.innerHTML = '<div class="spinner"></div>';

        try {
            const result = await API.get(`/api/similarity/search/${imageId}?limit=20`);
            this.searchResults = result.results || [];
            this.renderSearchResults();
        } catch (e) {
            resultsContainer.innerHTML = `<div class="empty-state">Search failed: ${escapeHtml(e.message)}</div>`;
            showToast('Similarity search failed', 'error');
        }
    },

    async searchByUpload(file) {
        const { showToast, API } = window.App;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

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

            this.searchResults = result.results || [];
            this.renderSearchResults();
        } catch (e) {
            resultsContainer.innerHTML = `<div class="empty-state">Upload search failed: ${escapeHtml(e.message)}</div>`;
            showToast('Upload search failed', 'error');
        }
    },

    // ============== Duplicate Finder ==============

    async findDuplicates() {
        const { showToast, API } = window.App;

        const threshold = parseFloat(document.getElementById('similar-dup-threshold')?.value || '0.95');
        const resultsContainer = document.getElementById('similar-duplicates');
        if (!resultsContainer) return;

        resultsContainer.innerHTML = '<div class="spinner"></div>';

        try {
            const result = await API.get(`/api/similarity/duplicates?threshold=${threshold}&limit=50`);
            this.duplicateResults = result.duplicates || [];
            this.renderDuplicateResults();
        } catch (e) {
            resultsContainer.innerHTML = `<div class="empty-state">Duplicate search failed: ${escapeHtml(e.message)}</div>`;
            showToast('Duplicate search failed', 'error');
        }
    },

    // ============== Rendering ==============

    renderSearchResults() {
        const container = document.getElementById('similar-results');
        if (!container) return;

        if (this.searchResults.length === 0) {
            container.innerHTML = '<div class="empty-state">No similar images found. Try generating embeddings first.</div>';
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
            container.innerHTML = '<div class="empty-state">No duplicates found at this threshold.</div>';
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
        btnUpload?.addEventListener('click', () => uploadInput?.click());
        uploadInput?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.searchByUpload(file);
        });

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
    if (similarInitialized) return;
    similarInitialized = true;
    SimilarImages.init();
}

window.SimilarImages = SimilarImages;
window.initSimilar = initSimilar;
