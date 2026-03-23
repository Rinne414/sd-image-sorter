/**
 * SD Image Sorter - Main Application
 * Core app logic and API communication
 */

const API_BASE = '';  // Same origin

// Utility: Debounce function
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// Utility: Escape HTML to prevent XSS (pure string replacement for performance)
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Utility: Throttle function
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ============== Request Manager (Cancellation Support) ==============

const RequestManager = {
    pendingRequests: new Map(),
    requestId: 0,

    createAbortController(key) {
        // Cancel any existing request with the same key
        this.cancel(key);

        const controller = new AbortController();
        this.pendingRequests.set(key, controller);
        return controller;
    },

    cancel(key) {
        const controller = this.pendingRequests.get(key);
        if (controller) {
            controller.abort();
            this.pendingRequests.delete(key);
        }
    },

    cancelAll() {
        this.pendingRequests.forEach((controller, key) => {
            controller.abort();
        });
        this.pendingRequests.clear();
    },

    complete(key) {
        this.pendingRequests.delete(key);
    },

    isAbortedError(error) {
        return error.name === 'AbortError';
    }
};

const GALLERY_VIEW_MODE_KEY = 'gallery-view-mode';

// App State
const AppState = {
    currentView: 'gallery',
    viewMode: localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid',
    images: [],
    filters: {
        generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
        ratings: ['general', 'sensitive', 'questionable', 'explicit'],
        tags: [],
        checkpoints: [],
        loras: [],
        prompts: [],  // Multi-prompt filter
        artist: null,  // Artist filter
        favoritesOnly: false,
        search: '',
        sortBy: 'newest'
    },
    selectedImage: null,
    isLoading: false,

    // Multi-select state
    selectionMode: false,
    selectedIds: new Set(),

    // Analytics data
    analytics: {
        checkpoints: [],
        loras: [],
        top_tags: []
    },

    // Current modal selection state
    modalSelection: {
        type: null, // 'checkpoint' or 'lora'
        tempSelected: new Set(),
        search: ''
    }
};

// ============== API Functions ==============

const API = {
    async get(endpoint, options = {}) {
        const { signal, requestKey } = options;
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, { signal });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `API Error: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw { name: 'AbortError', cancelled: true };
            }
            if (error.name === 'SyntaxError') {
                throw new Error('Invalid JSON response from server');
            }
            throw error;
        }
    },

    // Cancellable GET request - use for filter operations
    async getCancellable(endpoint, requestKey) {
        const controller = RequestManager.createAbortController(requestKey);
        try {
            const result = await this.get(endpoint, { signal: controller.signal, requestKey });
            RequestManager.complete(requestKey);
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                return null; // Request was cancelled
            }
            throw error;
        }
    },

    async post(endpoint, data = {}, options = {}) {
        const { signal } = options;
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
                signal
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `API Error: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw { name: 'AbortError', cancelled: true };
            }
            if (error.name === 'SyntaxError') {
                throw new Error('Invalid JSON response from server');
            }
            throw error;
        }
    },

    async delete(endpoint, options = {}) {
        const { signal } = options;
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: 'DELETE',
                signal
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `API Error: ${response.status}`);
            }
            return response.json();
        } catch (error) {
            if (error.name === 'SyntaxError') {
                throw new Error('Invalid JSON response from server');
            }
            throw error;
        }
    },

    // Images - no limit by default (0 = all)
    async getImages(filters = {}, options = {}) {
        const params = new URLSearchParams();
        if (filters.generators?.length) params.set('generators', filters.generators.join(','));

        // Fix: Always send ratings if they are selected/changed
        // If all 4 selected, we still send them so backend includes untagged
        if (filters.ratings?.length) {
            params.set('ratings', filters.ratings.join(','));
        }

        if (filters.tags?.length) params.set('tags', filters.tags.join(','));
        if (filters.checkpoints?.length) params.set('checkpoints', filters.checkpoints.join(','));
        if (filters.loras?.length) params.set('loras', filters.loras.join(','));
        if (filters.prompts?.length) params.set('prompts', filters.prompts.join(','));
        if (filters.artist) params.set('artist', filters.artist);  // Artist filter
        if (filters.favoritesOnly) params.set('favorites_only', 'true');
        if (filters.search) params.set('search', filters.search);
        if (filters.sortBy) params.set('sort_by', filters.sortBy);
        params.set('limit', filters.limit ?? 500);  // Default 500 images, 0 means unlimited
        if (filters.offset) params.set('offset', filters.offset);

        // Dimension filters
        if (filters.minWidth) params.set('min_width', filters.minWidth);
        if (filters.maxWidth) params.set('max_width', filters.maxWidth);
        if (filters.minHeight) params.set('min_height', filters.minHeight);
        if (filters.maxHeight) params.set('max_height', filters.maxHeight);
        if (filters.aspectRatio) params.set('aspect_ratio', filters.aspectRatio);

        return this.get(`/api/images?${params}`, options);
    },

    async getAnalytics() {
        return this.get('/api/analytics');
    },

    async clearGallery() {
        return this.delete('/api/clear-gallery');
    },

    async getImage(id) {
        return this.get(`/api/images/${id}`);
    },

    async reparseImage(id) {
        return this.post(`/api/images/${id}/reparse`);
    },

    async getFavoritesSummary() {
        return this.get('/api/favorites');
    },

    async addToFavorites(id) {
        return this.post(`/api/favorites/${id}`);
    },

    async removeFromFavorites(id) {
        return this.delete(`/api/favorites/${id}`);
    },

    getImageUrl(id) {
        return `${API_BASE}/api/image-file/${id}`;
    },

    getThumbnailUrl(id, size = null) {
        const actualSize = size || (AppState.viewMode === 'large' ? 512 : AppState.viewMode === 'waterfall' ? 384 : 256);
        return `${API_BASE}/api/image-thumbnail/${id}?size=${actualSize}`;
    },

    // Tags & Generators
    async getTags() {
        return this.get('/api/tags');
    },

    async getTagsLibrary(sortBy = 'frequency', limit = 2000) {
        return this.get(`/api/tags/library?sort_by=${sortBy}&limit=${limit}`);
    },

    async importTags(images, overwrite = false) {
        return this.post('/api/tags/import', { images, overwrite });
    },

    async getPromptsLibrary(limit = 5000) {
        return this.get(`/api/prompts/library?limit=${limit}`);
    },

    async getGenerators() {
        return this.get('/api/generators');
    },

    // Stats
    async getStats() {
        return this.get('/api/stats');
    },

    // Scan
    async startScan(folderPath, recursive = true) {
        return this.post('/api/scan', { folder_path: folderPath, recursive });
    },

    async getScanProgress() {
        return this.get('/api/scan/progress');
    },

    // Tagging - with all new options
    async startTagging(options = {}) {
        return this.post('/api/tag/start', { // Unified with backend endpoint
            threshold: options.threshold || 0.35,
            character_threshold: options.characterThreshold || 0.85,
            model_name: options.modelName || null,
            model_path: options.modelPath || null,
            tags_path: options.tagsPath || null,
            image_ids: options.imageIds || null,
            retag_all: options.retagAll || false,
            use_gpu: options.useGpu ?? true
        });
    },

    async getTagProgress() {
        return this.get('/api/tag/progress');
    },

    // Move
    async moveImages(imageIds, destinationFolder) {
        return this.post('/api/move', { image_ids: imageIds, destination_folder: destinationFolder });
    },

    async batchMove(generators, tags, ratings, destinationFolder, checkpoints = null, loras = null, prompts = null, dimensions = null) {
        return this.post('/api/batch-move', {
            generators,
            tags,
            ratings,
            checkpoints,
            loras,
            prompts,
            min_width: dimensions?.minWidth || null,
            max_width: dimensions?.maxWidth || null,
            min_height: dimensions?.minHeight || null,
            max_height: dimensions?.maxHeight || null,
            aspect_ratio: dimensions?.aspectRatio || null,
            destination_folder: destinationFolder
        });
    },

    // Manual Sort
    async startSortSession(generators, tags, ratings, folders, checkpoints = null, loras = null, prompts = null, dimensions = null) {
        const params = new URLSearchParams();
        if (generators?.length) params.set('generators', generators.join(','));
        if (tags?.length) params.set('tags', tags.join(','));
        if (ratings?.length) params.set('ratings', ratings.join(','));
        if (checkpoints?.length) params.set('checkpoints', checkpoints.join(','));
        if (loras?.length) params.set('loras', loras.join(','));
        if (prompts?.length) params.set('prompts', prompts.join(','));
        if (dimensions?.minWidth) params.set('min_width', dimensions.minWidth);
        if (dimensions?.maxWidth) params.set('max_width', dimensions.maxWidth);
        if (dimensions?.minHeight) params.set('min_height', dimensions.minHeight);
        if (dimensions?.maxHeight) params.set('max_height', dimensions.maxHeight);
        if (dimensions?.aspectRatio) params.set('aspect_ratio', dimensions.aspectRatio);
        if (folders) params.set('folders', JSON.stringify(folders));
        return this.post(`/api/sort/start?${params}`);
    },

    async getCurrentSortImage() {
        return this.get('/api/sort/current');
    },

    async sortAction(action, folderKey = null) {
        const params = new URLSearchParams();
        params.set('action', action);
        if (folderKey) params.set('folder_key', folderKey);
        return this.post(`/api/sort/action?${params}`);
    },

    async setSortFolders(folders) {
        return this.post('/api/sort/set-folders', { folders });
    },

    // Batch Tag Export
    async exportTagsBatch(imageIds, outputFolder, blacklist = [], prefix = '') {
        return this.post('/api/export-tags-batch', {
            image_ids: imageIds,
            output_folder: outputFolder,
            blacklist: blacklist,
            prefix: prefix
        });
    },

    // Prompts Library — removed duplicate, kept single definition above
};

// ============== UI Utilities ==============

function $(selector) {
    return document.querySelector(selector);
}

function $$(selector) {
    return document.querySelectorAll(selector);
}

function showToast(message, type = 'info') {
    let container = $('#toast-container');

    // Create container if it doesn't exist
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ'}</span>
        <span class="toast-message"></span>
    `;
    toast.querySelector('.toast-message').textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showModal(modalId) {
    const modal = $(`#${modalId}`);
    if (modal) {
        modal.classList.add('visible');
    }
}

function hideModal(modalId) {
    const modal = $(`#${modalId}`);
    if (modal) {
        modal.classList.remove('visible');
    }
}

// Custom input modal (replaces native prompt())
let inputModalResolve = null;

function showInputModal(title, message, defaultValue = '') {
    return new Promise((resolve) => {
        // Resolve previous if still pending
        if (inputModalResolve) {
            inputModalResolve(null);
        }
        inputModalResolve = resolve;

        // Set modal content
        const titleEl = $('#input-modal-title');
        const messageEl = $('#input-modal-message');
        const inputEl = $('#input-modal-field');

        if (titleEl) titleEl.textContent = title || 'Enter Value';
        if (messageEl) messageEl.textContent = message || '';
        if (inputEl) {
            inputEl.value = defaultValue;
            inputEl.placeholder = '';
        }

        // Show modal
        showModal('input-modal');

        // Focus input after modal is visible
        setTimeout(() => {
            inputEl?.focus();
            inputEl?.select();
        }, 100);
    });
}

function initInputModal() {
    const inputField = $('#input-modal-field');
    const okBtn = $('#btn-input-ok');
    const cancelBtn = $('#btn-input-cancel');
    const backdrop = $('#input-modal .modal-backdrop');

    const handleOk = () => {
        const value = inputField?.value || '';
        hideModal('input-modal');
        if (inputModalResolve) {
            inputModalResolve(value);
            inputModalResolve = null;
        }
    };

    const handleCancel = () => {
        hideModal('input-modal');
        if (inputModalResolve) {
            inputModalResolve(null);
            inputModalResolve = null;
        }
    };

    okBtn?.addEventListener('click', handleOk);
    cancelBtn?.addEventListener('click', handleCancel);
    backdrop?.addEventListener('click', handleCancel);

    // Handle Enter key in input field
    inputField?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleOk();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    });
}

// Global Loading Overlay
function showGlobalLoading(message = 'Loading...') {
    const overlay = $('#global-loading');
    const msgEl = $('#global-loading-msg');
    if (overlay) {
        if (msgEl) msgEl.textContent = message;
        overlay.style.display = 'flex';
    }
}

function hideGlobalLoading() {
    const overlay = $('#global-loading');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ============== View Navigation ==============

function setGalleryViewMode(mode) {
    const nextMode = ['grid', 'large', 'waterfall'].includes(mode) ? mode : 'grid';
    AppState.viewMode = nextMode;
    localStorage.setItem(GALLERY_VIEW_MODE_KEY, nextMode);

    $$('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.size === nextMode);
    });

    const grid = $('#gallery-grid');
    if (grid) {
        grid.classList.toggle('large', nextMode === 'large');
        grid.classList.toggle('waterfall', nextMode === 'waterfall');
    }

    if (window.VirtualGallery && typeof window.VirtualGallery.setViewMode === 'function') {
        window.VirtualGallery.setViewMode(nextMode);
    } else if (window.Gallery) {
        Gallery.render();
    }
}

function switchView(viewName) {
    const previousView = AppState.currentView;

    // Cleanup previous view
    if (previousView === 'gallery' && viewName !== 'gallery') {
        if (window.Gallery && typeof window.Gallery.destroy === 'function') {
            window.Gallery.destroy();
        }
        if (window.VirtualGallery && typeof window.VirtualGallery.destroy === 'function') {
            window.VirtualGallery.destroy();
        }
    }

    // Cleanup censor view listeners when leaving
    if (previousView === 'censor' && viewName !== 'censor') {
        if (typeof window.cleanupCensorView === 'function') {
            window.cleanupCensorView();
        }
    }

    AppState.currentView = viewName;

    // Update nav tabs
    $$('.nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    // Update views
    $$('.view').forEach(view => {
        view.classList.toggle('active', view.id === `view-${viewName}`);
    });

    // Hide selection FAB when not in Gallery view
    if (viewName !== 'gallery') {
        const selActions = $('#selection-actions');
        if (selActions) selActions.style.display = 'none';
    } else if (AppState.selectedIds && AppState.selectedIds.size > 0) {
        // Show FAB if we have selections and are returning to gallery
        const selActions = $('#selection-actions');
        if (selActions) selActions.style.display = 'flex';
    }

    // View-specific initialization
    if (viewName === 'gallery') {
        if (window.VirtualGallery && !window.VirtualGallery.initialized && typeof window.VirtualGallery.init === 'function') {
            window.VirtualGallery.init();
        }
        setGalleryViewMode(AppState.viewMode);
        // Re-render existing images immediately, only reload from API if needed
        if (AppState.images.length > 0 && window.Gallery) {
            Gallery.setImages(AppState.images);
        } else {
            loadImages();
        }
    } else if (viewName === 'similar') {
        if (typeof window.initSimilar === 'function') window.initSimilar();
    } else if (viewName === 'promptlab') {
        if (typeof window.initPromptLab === 'function') window.initPromptLab();
    } else if (viewName === 'artist') {
        if (window.ArtistIdent && typeof window.ArtistIdent.init === 'function') {
            window.ArtistIdent.init();
        }
    }
}

// ============== Event Listeners ==============

function initEventListeners() {
    // Nav tabs
    $$('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Scan button
    $('#btn-scan').addEventListener('click', () => showModal('scan-modal'));

    // Tag button
    $('#btn-tag').addEventListener('click', () => showModal('tag-modal'));

    // Modal backdrops
    $$('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            backdrop.parentElement.classList.remove('visible');
        });
    });

    // Scan modal
    $('#btn-cancel-scan').addEventListener('click', () => hideModal('scan-modal'));
    $('#btn-start-scan').addEventListener('click', startScan);

    // Tag modal
    $('#btn-cancel-tag').addEventListener('click', () => hideModal('tag-modal'));
    $('#btn-start-tag').addEventListener('click', startTagging);

    // Tag threshold sliders
    $('#tag-threshold').addEventListener('input', (e) => {
        $('#tag-threshold-value').textContent = e.target.value;
    });
    $('#tag-character-threshold').addEventListener('input', (e) => {
        $('#tag-character-threshold-value').textContent = e.target.value;
    });

    // Model selection toggle for custom model
    $('#tag-model-select').addEventListener('change', (e) => {
        const isCustom = e.target.value === 'custom';
        $('#custom-model-group').style.display = isCustom ? 'block' : 'none';
        $('#custom-tags-group').style.display = isCustom ? 'block' : 'none';
    });

    // Image modal
    $('#modal-close').addEventListener('click', () => hideModal('image-modal'));

    // Clear all filters button (sidebar)
    $('#btn-clear-filters').addEventListener('click', () => {
        resetAllFilters();
        hideModal('filter-modal');  // In case it's open
    });

    // View mode buttons
    $$('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setGalleryViewMode(btn.dataset.size);
        });
    });

    // --- New Features ---

    // Generator quick-filter tabs
    $$('.gen-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            // Update active state
            $$('.gen-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const gen = tab.dataset.gen;
            if (gen === 'all') {
                // Reset to show all generators
                AppState.filters.generators = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
            } else {
                // Filter by single generator
                AppState.filters.generators = [gen];
            }

            // Update filter modal checkboxes to stay in sync
            $$('#modal-generator-filters input').forEach(cb => {
                cb.checked = gen === 'all' || cb.value === gen;
            });

            updateFilterSummary();
            loadImages();
        });
    });

    // Gallery sort dropdown
    $('#gallery-sort').addEventListener('change', (e) => {
        AppState.filters.sortBy = e.target.value;
        loadImages();
    });




    // Clear DB button
    $('#btn-clear-db').addEventListener('click', () => {
        showConfirm(
            'Clear Gallery',
            'Are you sure you want to clear all images from the database? This will NOT delete your physical files.',
            async () => {
                try {
                    await API.clearGallery();
                    showToast('Gallery cleared successfully');
                    loadImages();
                    loadStats();
                } catch (e) {
                    showToast('Error clearing gallery: ' + e.message, 'error');
                }
            }
        );
    });

    // Random button
    $('#btn-random').addEventListener('click', showRandomImage);

    // Multi-select toggle
    $('#btn-toggle-select').addEventListener('click', () => {
        AppState.selectionMode = !AppState.selectionMode;
        $('#btn-toggle-select').classList.toggle('active', AppState.selectionMode);

        if (!AppState.selectionMode) {
            AppState.selectedIds.clear();
            updateSelectionUI();
        }

        Gallery.render();
    });

    // Export selected
    $('#btn-export-selected').addEventListener('click', showExportModal);

    $('#btn-toggle-favorites-filter')?.addEventListener('click', () => {
        AppState.filters.favoritesOnly = !AppState.filters.favoritesOnly;
        updateFilterSummary();
        loadImages();
    });

    $('#btn-add-favorites')?.addEventListener('click', async () => {
        if (AppState.selectedIds.size === 0) {
            showToast('Please select images first', 'error');
            return;
        }

        const results = await Promise.allSettled(Array.from(AppState.selectedIds).map(id => API.addToFavorites(id)));
        const successCount = results.filter(result => result.status === 'fulfilled').length;
        const failureCount = results.length - successCount;

        if (successCount > 0) {
            showToast(`Added ${successCount} image(s) to Favorites`, 'success');
            await loadImages();
        }
        if (failureCount > 0) {
            showToast(`${failureCount} image(s) failed to add to Favorites`, 'error');
        }
    });

    // Clear selection
    $('#btn-clear-selection').addEventListener('click', () => {
        AppState.selectedIds.clear();
        updateSelectionUI();
        Gallery.render();
    });

    // Select All - select all currently visible/filtered images
    $('#btn-select-all').addEventListener('click', () => {
        AppState.images.forEach(img => AppState.selectedIds.add(img.id));
        updateSelectionUI();
        Gallery.render();
    });


    // Confirm modal
    $('#btn-confirm-cancel').addEventListener('click', () => hideModal('confirm-modal'));

    // Note: #btn-select-checkpoints and #btn-select-loras removed - now handled in filter modal
    // Model selection modal handlers (for when opened from filter modal)
    $('#btn-cancel-model-select')?.addEventListener('click', () => hideModal('model-select-modal'));
    $('#btn-close-model-select')?.addEventListener('click', () => hideModal('model-select-modal'));
    $('#btn-confirm-model-select')?.addEventListener('click', confirmModelSelection);
    $('#model-select-search')?.addEventListener('input', (e) => {
        AppState.modalSelection.search = e.target.value.toLowerCase();
        renderModelSelectList();
    });

    // --- Export Modal ---
    $('#btn-close-export').addEventListener('click', () => hideModal('export-modal'));
    $('#btn-copy-export').addEventListener('click', () => {
        const text = $('#export-text').value;
        navigator.clipboard.writeText(text).then(() => {
            showToast('Copied to clipboard!', 'success');
        }).catch(() => {
            showToast('Failed to copy', 'error');
        });
    });
    // Toggle between prompts and tags
    $('#btn-export-tags').addEventListener('click', () => {
        const btn = $('#btn-export-tags');
        if (btn.textContent.includes('Tags')) {
            showExportTagsModal();
            btn.innerHTML = '📤 Export Prompts Instead';
        } else {
            showExportModal();
            btn.innerHTML = '🏷️ Export Tags Instead';
        }
    });

    // --- Export Tags from FAB ---
    $('#btn-export-tags-selected').addEventListener('click', () => {
        showExportTagsModal();
        $('#btn-export-tags').innerHTML = '📤 Export Prompts Instead';
    });

    // --- Unified Filter Modal ---
    $('#btn-open-filters').addEventListener('click', openFilterModal);
    $('#btn-close-filter-modal').addEventListener('click', () => hideModal('filter-modal'));
    $('#btn-apply-modal-filters').addEventListener('click', applyModalFilters);
    $('#btn-reset-filters').addEventListener('click', resetAllFilters);
    $('#btn-clear-artist')?.addEventListener('click', clearArtistFilter);

    // Modal tag search (debounced)
    const debouncedTagSearch = debounce((value) => searchModalTags(value), 300);
    $('#modal-tag-search')?.addEventListener('input', (e) => debouncedTagSearch(e.target.value));

    // Tag input Enter key - add comma-separated tags
    $('#modal-tag-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const input = e.target.value.trim();
            if (input) {
                const tags = input.split(',').map(t => t.trim()).filter(t => t.length > 0);
                tags.forEach(tag => {
                    if (!AppState.filters.tags.includes(tag)) {
                        AppState.filters.tags.push(tag);
                    }
                });
                renderModalActiveTags();
                e.target.value = '';
                $('#modal-tag-suggestions').innerHTML = '';
            }
        }
    });

    // Prompt input Enter key - add comma-separated prompts
    const promptSearchEl = $('#modal-prompt-search');
    if (promptSearchEl) {
        // Autocomplete suggestions on input (debounced)
        const debouncedPromptSearch = debounce((value) => searchModalPrompts(value), 300);
        promptSearchEl.addEventListener('input', (e) => {
            debouncedPromptSearch(e.target.value);
        });

        promptSearchEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const input = e.target.value.trim();
                if (input) {
                    const prompts = input.split(',').map(p => p.trim()).filter(p => p.length > 0);
                    prompts.forEach(prompt => {
                        if (!AppState.filters.prompts.includes(prompt)) {
                            AppState.filters.prompts.push(prompt);
                        }
                    });
                    renderModalActivePrompts();
                    e.target.value = '';
                    $('#modal-prompt-suggestions').innerHTML = '';
                }
            }
        });
    }

    // Library buttons
    $('#btn-tags-library')?.addEventListener('click', openTagsLibrary);
    $('#btn-open-library-from-filter')?.addEventListener('click', () => {
        hideModal('filter-modal');
        openTagsLibrary();
    });
    $('#btn-close-tags-library')?.addEventListener('click', () => hideModal('tags-library-modal'));
    $('#btn-close-tags-library-2')?.addEventListener('click', () => hideModal('tags-library-modal'));
    $('#library-search')?.addEventListener('input', filterLibraryContent);
    $('#library-sort')?.addEventListener('change', loadLibraryContent);
    // Library tab switching
    $('#library-tab-tags')?.addEventListener('click', () => switchLibraryTab('tags'));
    $('#library-tab-prompts')?.addEventListener('click', () => switchLibraryTab('prompts'));

    // Checkpoint search in filter modal
    $('#modal-checkpoint-search')?.addEventListener('input', (e) => {
        filterModalList('modal-checkpoint-list', e.target.value);
    });

    // Lora search in filter modal
    $('#modal-lora-search')?.addEventListener('input', (e) => {
        filterModalList('modal-lora-list', e.target.value);
    });

    // --- Batch Tag Export Modal ---
    $('#btn-batch-export-tags').addEventListener('click', showBatchExportModal);
    $('#btn-close-batch-export').addEventListener('click', () => hideModal('batch-export-modal'));
    $('#btn-cancel-batch-export').addEventListener('click', () => hideModal('batch-export-modal'));
    $('#btn-start-batch-export').addEventListener('click', executeBatchExport);

    // --- Import Tags (from Tag Modal) ---
    $('#btn-import-tags')?.addEventListener('click', () => {
        $('#import-tags-file').click();
    });
    $('#import-tags-file')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // Validate the data structure
            if (!data.images || !Array.isArray(data.images)) {
                throw new Error('Invalid format: expected { images: [...] }');
            }

            // Ask user about overwrite preference using custom modal
            showConfirm(
                'Import Tags',
                `Found ${data.images.length} images in file.\n\nOverwrite existing tags? (Cancel = skip already-tagged images)`,
                async () => {
                    // Overwrite = true
                    const result = await API.importTags(data.images, true);
                    showToast(`Imported tags for ${result.imported} images (${result.skipped} skipped)`, 'success');
                    loadImages();
                },
                async () => {
                    // Overwrite = false (skip already-tagged)
                    const result = await API.importTags(data.images, false);
                    showToast(`Imported tags for ${result.imported} images (${result.skipped} skipped)`, 'success');
                    loadImages();
                }
            );
        } catch (err) {
            showToast('Failed to import tags: ' + err.message, 'error');
        }
        e.target.value = ''; // Reset file input
    });

    // --- Censored Edit ---
    $('#btn-send-to-censor')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (AppState.selectedIds.size > 0 && typeof window.App.addToCensorQueue === 'function') {
            window.App.addToCensorQueue(Array.from(AppState.selectedIds));
        } else {
            switchView('censor');
            if (typeof window.initCensorEdit === 'function') window.initCensorEdit();
        }
    });
}

function filterCollapsibleList(type, query) {
    const list = document.getElementById(`${type}-list`);
    const items = list.querySelectorAll('.checkbox-label');
    query = query.toLowerCase();

    items.forEach(item => {
        const text = item.querySelector('.checkbox-text').textContent.toLowerCase();
        item.style.display = text.includes(query) ? 'flex' : 'none';
    });
}

function filterModalList(listId, query) {
    const list = document.getElementById(listId);
    if (!list) return;

    const items = list.querySelectorAll('.checkbox-label');
    query = query.toLowerCase();

    items.forEach(item => {
        const textEl = item.querySelector('.checkbox-text');
        if (textEl) {
            const text = textEl.textContent.toLowerCase();
            item.style.display = text.includes(query) ? '' : 'none';
        }
    });
}


// ============== Scanning ==============

async function startScan() {
    const folderPath = $('#scan-folder-path').value.trim();
    if (!folderPath) {
        showToast('Please enter a folder path', 'error');
        return;
    }

    const recursive = $('#scan-recursive').checked;

    try {
        await API.startScan(folderPath, recursive);

        $('#scan-progress-container').style.display = 'block';
        $('#btn-start-scan').disabled = true;

        pollScanProgress();
    } catch (error) {
        showToast('Failed to start scan: ' + error.message, 'error');
    }
}

async function pollScanProgress(retryCount = 0) {
    try {
        const progress = await API.getScanProgress();

        const percent = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
        $('#scan-progress-fill').style.width = percent + '%';
        $('#scan-progress-text').textContent = progress.message || 'Processing...';

        if (progress.status === 'done') {
            showToast(progress.message, 'success');
            hideModal('scan-modal');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            promptsLibraryCache = null; // Invalidate cache after scan
            loadImages();
            loadStats();
        } else if (progress.status === 'running' || progress.status === 'idle') {
            // If idle, the background task might just be starting, keep polling
            setTimeout(() => pollScanProgress(0), 500);
        }
    } catch (error) {
        console.error('Poll error:', error);
        if (retryCount < 3) {
            setTimeout(() => pollScanProgress(retryCount + 1), 1000);
        } else {
            showToast('Error checking scan progress', 'error');
            $('#btn-start-scan').disabled = false;
        }
    }
}

// ============== Tagging ==============

async function startTagging() {
    const threshold = parseFloat($('#tag-threshold').value);
    const characterThreshold = parseFloat($('#tag-character-threshold').value);
    const modelSelect = $('#tag-model-select').value;

    const options = {
        threshold,
        characterThreshold
    };

    // Handle custom model
    if (modelSelect === 'custom') {
        const modelPath = $('#tag-model-path').value.trim();
        const tagsPath = $('#tag-tags-path').value.trim();

        if (!modelPath) {
            showToast('Please enter a model path', 'error');
            return;
        }

        if (!tagsPath) {
            showToast('Please enter a Tags CSV path', 'error');
            return;
        }

        options.modelPath = modelPath;
        options.tagsPath = tagsPath;
    } else {
        options.modelName = modelSelect;
    }

    options.retagAll = $('#tag-retag-all').checked;
    options.useGpu = $('#tag-use-gpu')?.checked ?? true; // Default to GPU if checkbox is checked or missing

    try {
        await API.startTagging(options);

        $('#tag-progress-container').style.display = 'block';
        $('#btn-start-tag').disabled = true;

        pollTagProgress();
    } catch (error) {
        showToast('Failed to start tagging: ' + error.message, 'error');
    }
}

async function pollTagProgress() {
    try {
        const progress = await API.getTagProgress();

        const percent = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
        $('#tag-progress-fill').style.width = percent + '%';
        $('#tag-progress-text').textContent = progress.message;

        if (progress.status === 'done') {
            showToast(progress.message, 'success');
            hideModal('tag-modal');
            $('#tag-progress-container').style.display = 'none';
            $('#btn-start-tag').disabled = false;
            promptsLibraryCache = null; // Invalidate cache after tagging
            loadImages();
        } else if (progress.status === 'running') {
            setTimeout(pollTagProgress, 500);
        } else if (progress.status === 'error') {
            showToast(progress.message, 'error');
            $('#tag-progress-container').style.display = 'none';
            $('#btn-start-tag').disabled = false;
        }
    } catch (error) {
        showToast('Error checking tag progress', 'error');
    }
}

// ============== Stats ==============

async function loadStats() {
    try {
        const stats = await API.getStats();

        // Update generator counts in tabs
        let totalCount = 0;
        const genCounts = {};
        stats.generators.forEach(gen => {
            genCounts[gen.generator] = gen.count;
            totalCount += gen.count;

            // Legacy checkbox count update
            const countEl = $(`.checkbox-count[data-generator="${gen.generator}"]`);
            if (countEl) {
                countEl.textContent = gen.count;
            }
        });

        // Update generator tab counts
        const countAll = $('#count-all');
        if (countAll) countAll.textContent = totalCount;

        ['nai', 'comfyui', 'forge', 'webui', 'unknown'].forEach(gen => {
            const countEl = $(`#count-${gen}`);
            if (countEl) countEl.textContent = genCounts[gen] || 0;
        });

        // Store analytics for later use
        AppState.analytics = {
            checkpoints: stats.checkpoints || [],
            loras: stats.loras || [],
            top_tags: stats.top_tags || [],
            generatorCounts: genCounts,
            totalImages: totalCount
        };

        // Update model filters summary UI
        updateModelSelectionSummaries();

    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// ============== Image Loading ==============

const IMAGE_LOAD_KEY = 'images-load';

async function loadImages() {
    // Cancel any pending image load request
    RequestManager.cancel(IMAGE_LOAD_KEY);

    AppState.isLoading = true;
    $('#gallery-loading').style.display = 'flex';
    $('#image-count').textContent = 'Loading...';

    try {
        const controller = RequestManager.createAbortController(IMAGE_LOAD_KEY);
        const result = await API.getImages(AppState.filters, { signal: controller.signal });
        RequestManager.complete(IMAGE_LOAD_KEY);

        // Check if request was cancelled
        if (result === null) return;

        AppState.images = result.images;
        $('#image-count').textContent = `${result.count} images`;

        // Clean stale selections: remove IDs that no longer exist in the current image set
        if (AppState.selectedIds && AppState.selectedIds.size > 0) {
            const validIds = new Set(result.images.map(img => img.id));
            const staleIds = [...AppState.selectedIds].filter(id => !validIds.has(id));
            if (staleIds.length > 0) {
                staleIds.forEach(id => AppState.selectedIds.delete(id));
                if (typeof updateSelectionUI === 'function') updateSelectionUI();
            }
        }

        // Invalidate tags cache when images change (tags may have changed)
        tagsLibraryCache = null;

        if (window.Gallery) {
            Gallery.setImages(AppState.images);
        }
    } catch (error) {
        // Don't show error if request was cancelled
        if (error.name === 'AbortError' || error.cancelled) {
            return;
        }
        showToast('Error loading images: ' + error.message, 'error');
    } finally {
        AppState.isLoading = false;
        $('#gallery-loading').style.display = 'none';
    }
}

// ============== UI Components ==============

function openModelSelect(type) {
    AppState.modalSelection.type = type;
    AppState.modalSelection.search = '';
    AppState.modalSelection.tempSelected = new Set(AppState.filters[`${type}s`]);

    $('#model-select-title').textContent = type === 'checkpoint' ? 'Select Checkpoints' : 'Select Loras';
    $('#model-select-search').value = '';

    renderModelSelectList();
    showModal('model-select-modal');
}

function renderModelSelectList() {
    const { type, tempSelected, search } = AppState.modalSelection;
    const items = type === 'checkpoint' ? AppState.analytics.checkpoints : AppState.analytics.loras;
    const list = $('#model-select-list');

    if (!items || items.length === 0) {
        list.innerHTML = '<div class="filter-empty" style="text-align: center; padding: 20px; color: var(--text-muted);">No models found</div>';
        return;
    }

    const filtered = items.filter(item => {
        const val = type === 'checkpoint' ? item.checkpoint : item.lora;
        return val.toLowerCase().includes(search);
    });

    list.innerHTML = filtered.map(item => {
        const value = type === 'checkpoint' ? item.checkpoint : item.lora;
        const isSelected = tempSelected.has(value);

        return `
            <div class="model-select-item ${isSelected ? 'selected' : ''}" data-value="${value}">
                <div class="checkbox-custom" style="background: ${isSelected ? 'var(--accent-primary)' : 'transparent'}; border-color: ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}">
                    ${isSelected ? '✓' : ''}
                </div>
                <div class="item-text" title="${value}">${value}</div>
                <div class="item-count">${item.count}</div>
            </div>
        `;
    }).join('');

    // Add click handlers
    list.querySelectorAll('.model-select-item').forEach(el => {
        el.addEventListener('click', () => {
            const val = el.dataset.value;
            if (tempSelected.has(val)) {
                tempSelected.delete(val);
            } else {
                tempSelected.add(val);
            }
            renderModelSelectList();
        });
    });
}

function confirmModelSelection() {
    const { type, tempSelected } = AppState.modalSelection;
    AppState.filters[`${type}s`] = Array.from(tempSelected);

    updateModelSelectionSummaries();
    hideModal('model-select-modal');
}

function updateModelSelectionSummaries() {
    const cpCount = AppState.filters.checkpoints?.length || 0;
    const lrCount = AppState.filters.loras?.length || 0;

    // These elements may not exist in compact sidebar - use optional chaining
    const cpSummary = $('#selection-summary-checkpoints');
    const loraSummary = $('#selection-summary-loras');

    if (cpSummary) {
        cpSummary.textContent = cpCount === 0 ? 'No checkpoints selected' :
            (cpCount === 1 ? AppState.filters.checkpoints[0] : `${cpCount} checkpoints selected`);
    }

    if (loraSummary) {
        loraSummary.textContent = lrCount === 0 ? 'No Loras selected' :
            (lrCount === 1 ? AppState.filters.loras[0] : `${lrCount} Loras selected`);
    }
}

function updateCollapsibleFilterUI(type, items) {
    // Legacy support, now using summaries
    updateModelSelectionSummaries();
}

// ============== Tags & Prompts Library ==============

const libraryData = {
    currentTab: 'tags',
    tags: [],
    prompts: []
};

function openTagsLibrary() {
    showModal('tags-library-modal');
    loadLibraryContent();
}

function switchLibraryTab(tab) {
    libraryData.currentTab = tab;
    // Update tab button active states
    const tagsTab = $('#library-tab-tags');
    const promptsTab = $('#library-tab-prompts');
    if (tagsTab) {
        tagsTab.classList.toggle('active', tab === 'tags');
        tagsTab.classList.toggle('btn-secondary', tab === 'tags');
        tagsTab.classList.toggle('btn-ghost', tab !== 'tags');
    }
    if (promptsTab) {
        promptsTab.classList.toggle('active', tab === 'prompts');
        promptsTab.classList.toggle('btn-secondary', tab === 'prompts');
        promptsTab.classList.toggle('btn-ghost', tab !== 'prompts');
    }
    loadLibraryContent();
}

async function loadLibraryContent() {
    const content = $('#library-content');
    const statsText = $('#library-stats-text');
    const sortBy = $('#library-sort')?.value || 'frequency';

    content.innerHTML = '<div class="spinner"></div>';

    try {
        if (libraryData.currentTab === 'tags') {
            const result = await API.getTagsLibrary(sortBy, 2000);
            libraryData.tags = result.tags;
            renderLibraryTags(result.tags);
            statsText.textContent = `${result.total} unique tags found`;
        } else {
            const result = await API.getPromptsLibrary(99999);
            libraryData.prompts = result.prompts;
            renderLibraryPrompts(result.prompts);
            statsText.textContent = `${result.total} unique prompts found`;
        }
    } catch (error) {
        content.innerHTML = '<p style="color: var(--accent-danger);">Failed to load library</p>';
        console.error('Library load error:', error);
    }
}

function renderLibraryTags(tags) {
    const content = $('#library-content');
    content.style.flexDirection = 'row';
    content.innerHTML = tags.map(t => `
        <div class="library-tag" data-tag="${escapeHtml(t.tag)}" title="Click to add as filter">
            <span class="tag-name">${escapeHtml(t.tag)}</span>
            <span class="tag-count">${t.count}</span>
        </div>
    `).join('');

    content.querySelectorAll('.library-tag').forEach(el => {
        el.addEventListener('click', () => {
            const tag = el.dataset.tag;
            if (!AppState.filters.tags.includes(tag)) {
                AppState.filters.tags.push(tag);
                updateFilterSummary();
                hideModal('tags-library-modal');
                loadImages();
                showToast(`Added "${tag}" to filters`, 'success');
            }
        });
    });
}

function renderLibraryPrompts(prompts) {
    const content = $('#library-content');
    content.style.flexDirection = 'row';
    content.innerHTML = prompts.map(p => `
        <div class="library-tag" data-prompt="${escapeHtml(p.prompt)}" title="Click to add as filter">
            <span class="tag-name">${escapeHtml(p.prompt)}</span>
            <span class="tag-count">${p.count}</span>
        </div>
    `).join('');

    content.querySelectorAll('.library-tag').forEach(el => {
        el.addEventListener('click', () => {
            const prompt = el.dataset.prompt;
            if (!AppState.filters.prompts.includes(prompt)) {
                AppState.filters.prompts.push(prompt);
                updateFilterSummary();
                hideModal('tags-library-modal');
                loadImages();
                showToast(`Added "${prompt}" to filters`, 'success');
            }
        });
    });
}

function filterLibraryContent() {
    const query = $('#library-search')?.value.toLowerCase() || '';

    if (libraryData.currentTab === 'tags') {
        const filtered = libraryData.tags.filter(t => t.tag.toLowerCase().includes(query));
        renderLibraryTags(filtered);
    } else {
        const filtered = libraryData.prompts.filter(p => p.prompt.toLowerCase().includes(query));
        renderLibraryPrompts(filtered);
    }
}

// ============== Modal Tag/Prompt Autocomplete ==============

// searchModalTags and searchModalPrompts are defined in the Filter Modal section below
// (single definition, using direct API.getTags() / cached API.getPromptsLibrary())

// renderModalActiveTags and renderModalActivePrompts are defined in the Filter Modal section below

function updateSelectionUI() {
    const fab = $('#selection-actions');
    const countEl = $('#selection-count');

    if (AppState.selectedIds.size > 0) {
        fab.style.display = 'flex';
        countEl.textContent = `${AppState.selectedIds.size} items selected`;
    } else {
        fab.style.display = 'none';
    }
}

// AbortController for confirm modal to prevent listener accumulation
let _confirmAbort = null;

function showConfirm(title, message, onOk, onCancel) {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;

    // Abort previous confirm listeners
    if (_confirmAbort) _confirmAbort.abort();
    _confirmAbort = new AbortController();
    const signal = _confirmAbort.signal;

    const okBtn = $('#btn-confirm-ok');
    // Remove old listeners by cloning
    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);

    newOkBtn.addEventListener('click', () => {
        hideModal('confirm-modal');
        if (onOk) onOk();
    }, { signal });

    // Handle cancel callback if provided
    const cancelBtn = $('#btn-confirm-cancel');
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener('click', () => {
            hideModal('confirm-modal');
            if (onCancel) onCancel();
        }, { signal });
    }

    showModal('confirm-modal');
}

function showRandomImage() {
    if (AppState.images.length === 0) {
        showToast('No images available', 'info');
        return;
    }

    const randomIndex = Math.floor(Math.random() * AppState.images.length);
    const randomImage = AppState.images[randomIndex];

    if (window.Gallery) {
        Gallery.openPreview(randomImage.id);
    }
}

async function showAnalytics() {
    try {
        // Stats are already updated via loadStats regularly, but we can refresh
        await loadStats();
        const data = AppState.analytics;

        $('#analytics-checkpoints').innerHTML = data.checkpoints.length ?
            data.checkpoints.map(c => `
                <div class="analytics-item clickable" data-type="checkpoint" data-value="${escapeHtml(c.checkpoint)}">
                    <span class="item-name">${escapeHtml(c.checkpoint)}</span>
                    <span class="item-count">${c.count}</span>
                </div>
            `).join('') : '<p>No checkpoints found</p>';

        $('#analytics-loras').innerHTML = data.loras.length ?
            data.loras.map(l => `
                <div class="analytics-item clickable" data-type="lora" data-value="${escapeHtml(l.lora)}">
                    <span class="item-name">${escapeHtml(l.lora)}</span>
                    <span class="item-count">${l.count}</span>
                </div>
            `).join('') : '<p>No Loras found</p>';

        $('#analytics-tags').innerHTML = data.top_tags.length ?
            data.top_tags.map(t => `
                <div class="analytics-item clickable" data-type="tag" data-value="${t.tag}">
                    <span class="item-name">${t.tag}</span>
                    <span class="item-count">${t.count}</span>
                </div>
            `).join('') : '<p>No tags found</p>';

        // Add click handlers to all analytics items
        $$('#analytics-modal .analytics-item.clickable').forEach(el => {
            el.addEventListener('click', () => {
                const type = el.dataset.type;
                const value = el.dataset.value;
                applyAnalyticsFilter(type, value);
            });
        });

        showModal('analytics-modal');
    } catch (e) {
        showToast('Error loading analytics: ' + e.message, 'error');
    }
}

function applyAnalyticsFilter(type, value) {
    if (type === 'checkpoint') {
        AppState.filters.checkpoints = [value];
        updateModelSelectionSummaries();
    } else if (type === 'lora') {
        AppState.filters.loras = [value];
        updateModelSelectionSummaries();
    } else if (type === 'tag') {
        if (!AppState.filters.tags.includes(value)) {
            AppState.filters.tags.push(value);
            addTagToUI(value);
        }
    }
    hideModal('analytics-modal');
    loadImages();
    showToast(`Filter applied: ${value}`, 'success');
}

function addTagToUI(tag) {
    const container = $('#active-tags');
    const tagEl = document.createElement('span');
    tagEl.className = 'active-tag';
    tagEl.appendChild(document.createTextNode(`${tag} `));
    const removeEl = document.createElement('span');
    removeEl.className = 'remove-tag';
    removeEl.dataset.tag = tag;
    removeEl.textContent = '×';
    removeEl.addEventListener('click', () => removeTagFilter(tag));
    tagEl.appendChild(removeEl);
    container.appendChild(tagEl);
}


async function showExportModal() {
    if (AppState.selectedIds.size === 0) return;

    $('#export-title').textContent = '📤 Export Prompts';
    $('#export-count').textContent = `${AppState.selectedIds.size} images selected`;
    $('#btn-export-tags').innerHTML = '🏷️ Export Tags Instead';
    const textArea = $('#export-text');
    textArea.value = 'Loading prompts...';

    showModal('export-modal');

    try {
        const ids = Array.from(AppState.selectedIds);

        // Fetch all images in parallel for better performance
        const results = await Promise.all(ids.map(id => API.getImage(id)));
        const prompts = results
            .filter(r => r.image.prompt)
            .map(r => r.image.prompt);

        textArea.value = prompts.join('\n\n');
    } catch (e) {
        textArea.value = 'Error loading prompts: ' + e.message;
    }
}

async function showExportTagsModal() {
    if (AppState.selectedIds.size === 0) return;

    $('#export-title').textContent = '🏷️ Export Tags';
    $('#export-count').textContent = `${AppState.selectedIds.size} images selected`;
    $('#btn-export-tags').innerHTML = '📤 Export Prompts Instead';
    const textArea = $('#export-text');
    textArea.value = 'Loading tags...';

    showModal('export-modal');
    try {
        const allTags = new Set();
        const ids = Array.from(AppState.selectedIds);

        // Fetch all images in parallel for better performance
        const results = await Promise.all(ids.map(id => API.getImage(id)));
        results.forEach(result => {
            if (result.tags) {
                result.tags.forEach(t => allTags.add(t.tag));
            }
        });

        // Sort alphabetically and join
        const sortedTags = Array.from(allTags).sort();
        textArea.value = sortedTags.join(', ');
    } catch (e) {
        textArea.value = 'Error loading tags: ' + e.message;
    }
}

function showBatchExportModal() {
    if (AppState.selectedIds.size === 0) {
        showToast('Please select images first', 'error');
        return;
    }

    $('#batch-export-count').textContent = `${AppState.selectedIds.size} images selected`;
    $('#batch-export-progress').style.display = 'none';
    $('#btn-start-batch-export').disabled = false;
    showModal('batch-export-modal');
}

async function executeBatchExport() {
    const outputFolder = $('#batch-export-folder').value.trim();
    if (!outputFolder) {
        showToast('Please enter an output folder', 'error');
        return;
    }

    const prefix = $('#batch-export-prefix').value;
    const blacklistText = $('#batch-export-blacklist').value;
    const blacklist = blacklistText ? blacklistText.split(',').map(t => t.trim()).filter(t => t) : [];

    const imageIds = Array.from(AppState.selectedIds);

    // Show progress
    $('#batch-export-progress').style.display = 'block';
    $('#batch-export-progress-fill').style.width = '0%';
    $('#batch-export-progress-text').textContent = 'Exporting...';
    $('#btn-start-batch-export').disabled = true;

    try {
        const result = await API.exportTagsBatch(imageIds, outputFolder, blacklist, prefix);

        $('#batch-export-progress-fill').style.width = '100%';

        if (result.status === 'ok') {
            showToast(`Exported ${result.exported} tag files successfully!`, 'success');
            hideModal('batch-export-modal');
        } else {
            showToast('Export failed: ' + (result.errors?.join(', ') || 'Unknown error'), 'error');
        }
    } catch (e) {
        showToast('Export failed: ' + e.message, 'error');
    } finally {
        $('#batch-export-progress').style.display = 'none';
        $('#btn-start-batch-export').disabled = false;
    }
}

// ============== Filters ==============

function updateFiltersFromUI() {
    // Get generators
    const generators = [];
    $$('#modal-generator-filters input[type="checkbox"]:checked').forEach(cb => {
        generators.push(cb.value);
    });
    AppState.filters.generators = generators;

    // Get ratings
    const ratings = [];
    $$('#modal-rating-filters input[type="checkbox"]:checked').forEach(cb => {
        ratings.push(cb.value);
    });
    AppState.filters.ratings = ratings;
}

function applyFilters() {
    updateFiltersFromUI();
    loadImages();
}

function clearFilters() {
    $$('#modal-generator-filters input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
    });
    $$('#modal-rating-filters input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
    });
    AppState.filters.generators = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    AppState.filters.ratings = ['general', 'sensitive', 'questionable', 'explicit'];
    AppState.filters.tags = [];
    AppState.filters.search = '';
    const tagSearch = $('#tag-search');
    if (tagSearch) tagSearch.value = '';
    const promptSearch = $('#prompt-search');
    if (promptSearch) promptSearch.value = '';
    const activeTags = $('#active-tags');
    if (activeTags) activeTags.innerHTML = '';
    loadImages();
}

async function searchTags(e) {
    const query = e.target.value.trim();
    if (query.length < 2) {
        $('#tag-suggestions').classList.remove('visible');
        return;
    }

    try {
        // Use cached tags to avoid repeated API calls on every keystroke
        const now = Date.now();
        if (!tagsLibraryCache || (now - tagsLibraryCacheTime) > TAGS_CACHE_TTL) {
            tagsLibraryCache = await API.getTags();
            tagsLibraryCacheTime = now;
        }
        const result = tagsLibraryCache;
        const filtered = result.tags
            .filter(t => t.tag.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10);

        const suggestionsEl = $('#tag-suggestions');
        suggestionsEl.innerHTML = filtered.map(t => `
            <div class="tag-suggestion" data-tag="${escapeHtml(t.tag)}">
                ${escapeHtml(t.tag)} <span style="color: var(--text-muted)">(${t.count})</span>
            </div>
        `).join('');

        suggestionsEl.classList.add('visible');

        // Add click handlers
        suggestionsEl.querySelectorAll('.tag-suggestion').forEach(el => {
            el.addEventListener('click', () => {
                addTagFilter(el.dataset.tag);
                $('#tag-search').value = '';
                suggestionsEl.classList.remove('visible');
            });
        });
    } catch (error) {
        // Tag search failed silently - non-critical autocomplete
    }
}

function addTagFilter(tag) {
    if (!AppState.filters.tags.includes(tag)) {
        AppState.filters.tags.push(tag);
        renderActiveTagFilters();
    }
}

function removeTagFilter(tag) {
    AppState.filters.tags = AppState.filters.tags.filter(t => t !== tag);
    renderActiveTagFilters();
}

function renderActiveTagFilters() {
    const container = $('#active-tags');
    if (!container) return;
    container.innerHTML = '';

    AppState.filters.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'active-tag';
        tagEl.appendChild(document.createTextNode(`${tag} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-tag';
        removeEl.dataset.tag = tag;
        removeEl.textContent = '✕';
        removeEl.addEventListener('click', () => removeTagFilter(tag));

        tagEl.appendChild(removeEl);
        container.appendChild(tagEl);
    });
}

// ============== Unified Filter Modal ==============

async function openFilterModal() {
    // Sync modal state with current AppState
    $$('#modal-generator-filters input').forEach(cb => {
        cb.checked = AppState.filters.generators.includes(cb.value);
    });
    $$('#modal-rating-filters input').forEach(cb => {
        cb.checked = AppState.filters.ratings.includes(cb.value);
    });
    // Don't prefill prompt search bar with AppState.filters.search —
    // the prompt search is for adding prompt filters, not for text search
    $('#modal-prompt-search').value = '';

    // Show active tags and prompts
    renderModalActiveTags();
    renderModalActivePrompts();

    // Load checkpoints and loras into modal lists
    await loadModalFilterLists();

    showModal('filter-modal');
}

function renderModalActiveTags() {
    const container = $('#modal-active-tags');
    if (!container) return;
    container.innerHTML = '';

    AppState.filters.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'active-tag';
        tagEl.appendChild(document.createTextNode(`${tag} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-modal-tag';
        removeEl.dataset.tag = tag;
        removeEl.textContent = '×';
        removeEl.addEventListener('click', () => {
            AppState.filters.tags = AppState.filters.tags.filter(t => t !== tag);
            renderModalActiveTags();
        });

        tagEl.appendChild(removeEl);
        container.appendChild(tagEl);
    });
}

function renderModalActivePrompts() {
    let container = document.getElementById('modal-active-prompts');
    if (!container) {
        const promptSearch = document.getElementById('modal-prompt-search');
        if (promptSearch) {
            container = document.createElement('div');
            container.id = 'modal-active-prompts';
            container.className = 'active-tags';
            container.style.marginTop = '8px';
            promptSearch.parentNode.insertBefore(container, promptSearch.nextSibling);
        } else {
            return;
        }
    }

    container.innerHTML = '';
    AppState.filters.prompts.forEach(prompt => {
        const promptEl = document.createElement('span');
        promptEl.className = 'active-tag';
        promptEl.appendChild(document.createTextNode(`${prompt} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-modal-prompt';
        removeEl.dataset.prompt = prompt;
        removeEl.textContent = '×';
        removeEl.addEventListener('click', () => {
            AppState.filters.prompts = AppState.filters.prompts.filter(p => p !== prompt);
            renderModalActivePrompts();
        });

        promptEl.appendChild(removeEl);
        container.appendChild(promptEl);
    });
}

async function loadModalFilterLists() {
    try {
        // Use cached analytics data if available, otherwise fetch from API
        const data = AppState.analytics || await API.getStats();

        // Render checkpoints
        const cpList = $('#modal-checkpoint-list');
        cpList.innerHTML = (data.checkpoints || []).map(cp => `
            <label class="checkbox-label">
                <input type="checkbox" value="${escapeHtml(cp.checkpoint)}" ${AppState.filters.checkpoints?.includes(cp.checkpoint) ? 'checked' : ''}>
                <span class="checkbox-custom"></span>
                <span class="checkbox-text">${escapeHtml(cp.checkpoint)}</span>
                <span class="checkbox-count">${cp.count}</span>
            </label>
        `).join('');

        // Render loras
        const loraList = $('#modal-lora-list');
        loraList.innerHTML = (data.loras || []).map(l => `
            <label class="checkbox-label">
                <input type="checkbox" value="${escapeHtml(l.lora)}" ${AppState.filters.loras?.includes(l.lora) ? 'checked' : ''}>
                <span class="checkbox-custom"></span>
                <span class="checkbox-text">${escapeHtml(l.lora)}</span>
                <span class="checkbox-count">${l.count}</span>
            </label>
        `).join('');
    } catch (e) {
        console.error('Failed to load filter lists:', e);
    }
}

// searchModalTags - debounced wrapper for tag autocomplete in filter modal
const _debouncedTagSearch = debounce(async (query) => {
    const suggestionsEl = $('#modal-tag-suggestions');
    if (!query || query.length < 2) {
        suggestionsEl.innerHTML = '';
        suggestionsEl.classList.remove('visible');
        return;
    }

    try {
        // Use cached tags to avoid repeated API calls on every keystroke
        const now = Date.now();
        if (!tagsLibraryCache || (now - tagsLibraryCacheTime) > TAGS_CACHE_TTL) {
            tagsLibraryCache = await API.getTags();
            tagsLibraryCacheTime = now;
        }
        const result = tagsLibraryCache;
        const filtered = result.tags
            .filter(t => t.tag.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 8);

        suggestionsEl.innerHTML = filtered.map(t => `
            <div class="tag-suggestion" data-tag="${escapeHtml(t.tag)}">
                ${escapeHtml(t.tag)} <span style="color: var(--text-muted)">(${t.count})</span>
            </div>
        `).join('');

        if (filtered.length > 0) {
            suggestionsEl.classList.add('visible');
        } else {
            suggestionsEl.classList.remove('visible');
        }

        suggestionsEl.querySelectorAll('.tag-suggestion').forEach(el => {
            el.addEventListener('click', () => {
                if (!AppState.filters.tags.includes(el.dataset.tag)) {
                    AppState.filters.tags.push(el.dataset.tag);
                    renderModalActiveTags();
                }
                $('#modal-tag-search').value = '';
                suggestionsEl.innerHTML = '';
                suggestionsEl.classList.remove('visible');
            });
        });
    } catch (e) {
        // Tag search failed silently - non-critical autocomplete
    }
}, 250);

function searchModalTags(query) {
    _debouncedTagSearch(query);
}

// Cache for prompts library to avoid repeated API calls
let promptsLibraryCache = null;
// Cache for tags to avoid repeated API calls on every keystroke
let tagsLibraryCache = null;
let tagsLibraryCacheTime = 0;
const TAGS_CACHE_TTL = 30000; // 30 seconds

// searchModalPrompts - debounced wrapper for prompt autocomplete in filter modal
const _debouncedPromptSearch = debounce(async (query) => {
    const suggestionsEl = $('#modal-prompt-suggestions');
    if (!suggestionsEl) return;

    if (!query || query.length < 2) {
        suggestionsEl.innerHTML = '';
        suggestionsEl.classList.remove('visible');
        return;
    }

    try {
        // Cache the prompts library for better performance
        if (!promptsLibraryCache) {
            const result = await API.getPromptsLibrary(5000);
            promptsLibraryCache = result.prompts || [];
        }

        const filtered = promptsLibraryCache
            .filter(p => p.prompt.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10);

        suggestionsEl.innerHTML = filtered.map(p => `
            <div class="tag-suggestion" data-prompt="${escapeHtml(p.prompt)}">
                ${escapeHtml(p.prompt)} <span style="color: var(--text-muted)">(${p.count})</span>
            </div>
        `).join('');

        if (filtered.length > 0) {
            suggestionsEl.classList.add('visible');
        } else {
            suggestionsEl.classList.remove('visible');
        }

        suggestionsEl.querySelectorAll('.tag-suggestion').forEach(el => {
            el.addEventListener('click', () => {
                const prompt = el.dataset.prompt;
                if (!AppState.filters.prompts.includes(prompt)) {
                    AppState.filters.prompts.push(prompt);
                    renderModalActivePrompts();
                }
                $('#modal-prompt-search').value = '';
                suggestionsEl.innerHTML = '';
                suggestionsEl.classList.remove('visible');
            });
        });
    } catch (e) {
        // Prompt search failed silently - non-critical autocomplete
    }
}, 250);

function searchModalPrompts(query) {
    _debouncedPromptSearch(query);
}

function applyModalFilters() {
    // Get generators
    const generators = [];
    $$('#modal-generator-filters input:checked').forEach(cb => generators.push(cb.value));
    AppState.filters.generators = generators;

    // Get ratings
    const ratings = [];
    $$('#modal-rating-filters input:checked').forEach(cb => ratings.push(cb.value));
    AppState.filters.ratings = ratings;

    // Get checkpoints
    const checkpoints = [];
    $$('#modal-checkpoint-list input:checked').forEach(cb => checkpoints.push(cb.value));
    AppState.filters.checkpoints = checkpoints;

    // Get loras
    const loras = [];
    $$('#modal-lora-list input:checked').forEach(cb => loras.push(cb.value));
    AppState.filters.loras = loras;

    // Prompts: don't use search bar - prompts array is built via Enter key
    // Clear search bar since prompts are in the array now
    AppState.filters.search = '';
    $('#modal-prompt-search').value = '';

    // Get dimension filters
    const minWidth = parseInt($('#filter-min-width').value) || null;
    const maxWidth = parseInt($('#filter-max-width').value) || null;
    const minHeight = parseInt($('#filter-min-height').value) || null;
    const maxHeight = parseInt($('#filter-max-height').value) || null;
    AppState.filters.minWidth = minWidth;
    AppState.filters.maxWidth = maxWidth;
    AppState.filters.minHeight = minHeight;
    AppState.filters.maxHeight = maxHeight;

    // Get aspect ratio
    const aspectRadio = $('input[name="aspect-ratio"]:checked');
    AppState.filters.aspectRatio = aspectRadio ? aspectRadio.value : '';

    // Update all filter summaries (gallery sidebar + view-specific)
    updateFilterSummary();
    // Also update Auto-Separate and Manual Sort summaries if their functions exist
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();

    hideModal('filter-modal');
    syncGenTabsWithFilters();
    loadImages();
    showToast('Filters applied', 'success');
}

// Sync generator tab active state with current filter state
function syncGenTabsWithFilters() {
    const gens = AppState.filters.generators;
    $$('.gen-tab').forEach(t => {
        if (gens.length === 5) {
            t.classList.toggle('active', t.dataset.gen === 'all');
        } else if (gens.length === 1) {
            t.classList.toggle('active', t.dataset.gen === gens[0]);
        } else {
            t.classList.remove('active');
        }
    });
}

function resetAllFilters() {
    AppState.filters = {
        generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
        ratings: ['general', 'sensitive', 'questionable', 'explicit'],
        tags: [],
        checkpoints: [],
        loras: [],
        prompts: [],
        artist: null,  // Clear artist filter
        favoritesOnly: false,
        search: '',
        sortBy: 'newest',
        limit: 0,
        minWidth: null,
        maxWidth: null,
        minHeight: null,
        maxHeight: null,
        aspectRatio: ''
    };

    // Reset modal checkboxes
    $$('#modal-generator-filters input').forEach(cb => cb.checked = true);
    $$('#modal-rating-filters input').forEach(cb => cb.checked = true);
    $$('#modal-checkpoint-list input').forEach(cb => cb.checked = false);
    $$('#modal-lora-list input').forEach(cb => cb.checked = false);
    $('#modal-prompt-search').value = '';
    renderModalActiveTags();
    renderModalActivePrompts();

    // Reset dimension filters
    $('#filter-min-width').value = '';
    $('#filter-max-width').value = '';
    $('#filter-min-height').value = '';
    $('#filter-max-height').value = '';
    $$('input[name="aspect-ratio"]').forEach(r => r.checked = r.value === '');

    // Hide artist filter row
    const artistRow = $('#artist-filter-row');
    if (artistRow) artistRow.style.display = 'none';

    // Update all filter summaries
    updateFilterSummary();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();

    hideModal('filter-modal');
    syncGenTabsWithFilters();
    loadImages();
    showToast('Filters cleared', 'success');
}

function initMissingFilterMarkup() {
    const generatorSection = document.getElementById('modal-generator-filters');
    if (generatorSection && !document.getElementById('modal-rating-filters')) {
        const ratingSection = document.createElement('div');
        ratingSection.className = 'filter-section';
        ratingSection.innerHTML = `
            <h4>Ratings</h4>
            <div class="filter-options" id="modal-rating-filters">
                <label class="checkbox-label"><input type="checkbox" value="general" checked><span class="checkbox-custom"></span><span class="checkbox-text">General</span></label>
                <label class="checkbox-label"><input type="checkbox" value="sensitive" checked><span class="checkbox-custom"></span><span class="checkbox-text">Sensitive</span></label>
                <label class="checkbox-label"><input type="checkbox" value="questionable" checked><span class="checkbox-custom"></span><span class="checkbox-text">Questionable</span></label>
                <label class="checkbox-label"><input type="checkbox" value="explicit" checked><span class="checkbox-custom"></span><span class="checkbox-text">Explicit</span></label>
            </div>
        `;
        generatorSection.parentElement.insertBefore(ratingSection, generatorSection.nextElementSibling);
    }
}

// Clear only the artist filter
function clearArtistFilter() {
    AppState.filters.artist = null;
    const artistRow = $('#artist-filter-row');
    if (artistRow) artistRow.style.display = 'none';
    updateFilterSummary();
    loadImages();
    showToast('Artist filter cleared', 'info');
}

function updateFilterSummary() {
    const f = AppState.filters;
    const allGens = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];

    // Generators
    $('#summary-generators').textContent =
        f.generators.length === allGens.length ? 'All' :
            f.generators.length === 0 ? 'None' :
                f.generators.length > 2 ? `${f.generators.length} selected` : f.generators.join(', ');

    // Ratings
    $('#summary-ratings').textContent =
        f.ratings.length === allRatings.length ? 'All' :
            f.ratings.length === 0 ? 'None' :
                f.ratings.length > 2 ? `${f.ratings.length} selected` : f.ratings.join(', ');

    // Tags
    $('#summary-tags').textContent =
        f.tags.length === 0 ? 'None' :
            f.tags.length > 2 ? `${f.tags.length} tags` : f.tags.join(', ');

    // Checkpoints
    $('#summary-checkpoints').textContent =
        (!f.checkpoints || f.checkpoints.length === 0) ? 'None' :
            `${f.checkpoints.length} selected`;

    // Loras
    $('#summary-loras').textContent =
        (!f.loras || f.loras.length === 0) ? 'None' :
            `${f.loras.length} selected`;

    // Prompt (now uses prompts array)
    const promptSummary = $('#summary-prompt');
    if (promptSummary) {
        promptSummary.textContent =
            (!f.prompts || f.prompts.length === 0) ? 'None' :
                f.prompts.length > 2 ? `${f.prompts.length} prompts` : f.prompts.join(', ');
    }

    const favoritesSummary = $('#summary-favorites');
    if (favoritesSummary) {
        favoritesSummary.textContent = f.favoritesOnly ? 'Only favorites' : 'All images';
    }
    $('#btn-toggle-favorites-filter')?.classList.toggle('active', !!f.favoritesOnly);

    // Artist filter
    const artistRow = $('#artist-filter-row');
    const artistSummary = $('#summary-artist');
    if (artistRow && artistSummary) {
        if (f.artist) {
            artistRow.style.display = 'flex';
            // Format artist name (replace underscores with spaces, capitalize)
            const formattedArtist = f.artist.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            artistSummary.textContent = formattedArtist;
        } else {
            artistRow.style.display = 'none';
        }
    }
}

// ============== Initialization ==============

document.addEventListener('DOMContentLoaded', () => {
    initMissingFilterMarkup();
    initEventListeners();
    initInputModal();
    setGalleryViewMode(AppState.viewMode);
    switchView('gallery');
    loadStats();
    updateFilterSummary();

    // Initialize Censor Edit module so addToCensorQueue is available from Gallery
    if (typeof window.initCensorEdit === 'function') {
        window.initCensorEdit();
    }
});


// Export for other modules
window.App = {
    API,
    AppState,
    showToast,
    showModal,
    hideModal,
    showInputModal,
    showGlobalLoading,
    hideGlobalLoading,
    formatSize,
    loadImages,
    loadStats,
    updateSelectionUI,
    showConfirm,
    showRandomImage,
    showAnalytics,
    showExportModal,
    showExportTagsModal,
    updateCollapsibleFilterUI,
    openModelSelect,
    renderModelSelectList,
    confirmModelSelection,
    updateModelSelectionSummaries,
    openFilterModal,
    applyModalFilters,
    resetAllFilters,
    updateFilterSummary,
    openTagsLibrary,
    switchLibraryTab,
    filterLibraryContent,
    $,
    $$
};
