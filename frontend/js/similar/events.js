/**
 * similar/events.js — similar.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut
 * lines 267-278 + 1364-1494 (of 1,517): init and bindEvents (all DOM
 * wiring: embed buttons, semantic text search, search-by-id, upload +
 * dropzone, load-more, duplicate finder, threshold sliders, scope select,
 * sub-tab switching, model-status-changed). Classic non-strict script:
 * joins the ONE unsealed window.SimilarImages object declared in
 * similar/core.js, which loads FIRST; boot.js publishes initSimilar LAST.
 */
Object.assign(window.SimilarImages, {
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

    bindEvents() {
        // Embed button
        const btnEmbed = document.getElementById('btn-similar-embed');
        btnEmbed?.addEventListener('click', () => this.startEmbedding());
        document.getElementById('btn-similar-status-embed')?.addEventListener('click', () => this.startEmbedding());

        // Semantic text search (CLIP text tower over the same embeddings).
        const semanticSearchInput = document.getElementById('similar-search-text');
        const semanticSearchBtn = document.getElementById('btn-similar-search-text');
        semanticSearchBtn?.addEventListener('click', () => this.searchByText(semanticSearchInput?.value || ''));
        semanticSearchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.searchByText(semanticSearchInput.value || '');
        });

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

        // v3.5.0 audit: bridge to the whole-library group-based Duplicate
        // Cleanup so the two dedup surfaces know about each other.
        document.getElementById('btn-similar-open-dup-cleaner')?.addEventListener('click', () => {
            window.DupCleaner?.open?.();
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
});
