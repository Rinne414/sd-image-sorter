/**
 * SD Image Sorter - Similar Images Module
 * Handles similarity search UI, duplicate finder, and embedding management.
 */

const SimilarImages = {
    isEmbedding: false,
    embedProgress: { current: 0, total: 0 },
    searchResults: [],
    duplicateResults: [],
    currentSearchId: null,

    init() {
        this.bindEvents();
        this.loadStats();
    },

    // ============== Data Loading ==============

    async loadStats() {
        const statsEl = document.getElementById('similar-stats');
        if (!statsEl) return;

        try {
            const result = await window.App.API.get('/api/similarity/stats');
            statsEl.innerHTML = `
                <div class="stat-card">
                    <span class="stat-number">${result.total_images || 0}</span>
                    <span class="stat-label">Total Images</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.embedded_count || 0}</span>
                    <span class="stat-label">Embedded</span>
                </div>
                <div class="stat-card">
                    <span class="stat-number">${result.pending_count || 0}</span>
                    <span class="stat-label">Pending</span>
                </div>
            `;
        } catch (e) {
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
            showToast('Failed to start embedding: ' + e.message, 'error');
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
            resultsContainer.innerHTML = `<div class="empty-state">Search failed: ${e.message}</div>`;
            showToast('Similarity search failed', 'error');
        }
    },

    async searchByUpload(file) {
        const { showToast, API } = window.App;

        const resultsContainer = document.getElementById('similar-results');
        if (!resultsContainer) return;

        resultsContainer.innerHTML = '<div class="spinner"></div>';

        try {
            // Read file as base64
            const reader = new FileReader();
            const base64Data = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            const result = await API.post('/api/similarity/search-upload', {
                image_data: base64Data,
                limit: 20
            });

            this.searchResults = result.results || [];
            this.renderSearchResults();
        } catch (e) {
            resultsContainer.innerHTML = `<div class="empty-state">Upload search failed: ${e.message}</div>`;
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
            this.duplicateResults = result.pairs || [];
            this.renderDuplicateResults();
        } catch (e) {
            resultsContainer.innerHTML = `<div class="empty-state">Duplicate search failed: ${e.message}</div>`;
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
        container.innerHTML = this.searchResults.map(r => `
            <div class="similar-result" data-id="${r.id}">
                <div class="similar-thumb">
                    <img src="${API.getThumbnailUrl(r.id)}" alt="${r.filename || ''}" loading="lazy">
                </div>
                <div class="similar-info">
                    <span class="similar-score">${(r.similarity * 100).toFixed(1)}%</span>
                    <span class="similar-name" title="${r.filename || ''}">${r.filename || 'Unknown'}</span>
                </div>
            </div>
        `).join('');

        // Click to open preview
        container.querySelectorAll('.similar-result').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.id);
                if (window.Gallery) window.Gallery.openPreview(id);
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
        container.innerHTML = this.duplicateResults.map(pair => `
            <div class="duplicate-pair">
                <div class="dup-image" data-id="${pair.id1}">
                    <img src="${API.getThumbnailUrl(pair.id1)}" alt="" loading="lazy">
                    <span class="dup-name">${pair.filename1 || ''}</span>
                </div>
                <div class="dup-score">${(pair.similarity * 100).toFixed(1)}%</div>
                <div class="dup-image" data-id="${pair.id2}">
                    <img src="${API.getThumbnailUrl(pair.id2)}" alt="" loading="lazy">
                    <span class="dup-name">${pair.filename2 || ''}</span>
                </div>
            </div>
        `).join('');

        container.querySelectorAll('.dup-image').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.id);
                if (window.Gallery) window.Gallery.openPreview(id);
            });
        });
    },

    // ============== Event Binding ==============

    bindEvents() {
        // Embed button
        const btnEmbed = document.getElementById('btn-similar-embed');
        btnEmbed?.addEventListener('click', () => this.startEmbedding());

        // Search from gallery - accept image ID from input
        const btnSearch = document.getElementById('btn-similar-search');
        btnSearch?.addEventListener('click', () => {
            const idInput = document.getElementById('similar-search-id');
            const id = parseInt(idInput?.value);
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
