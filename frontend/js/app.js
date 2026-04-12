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

// HTML escape utility
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

// i18n helper for tagger strings (top-level, available to all tagger functions)
function tText(key, fallback) {
    const val = window.I18n?.t?.(key);
    return (val && val !== key) ? val : (fallback || key);
}

// ============== Request Manager (Cancellation Support) ==============

const RequestManager = {
    pendingRequests: new Map(),
    requestId: 0,

    createAbortController(key) {
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
        this.pendingRequests.forEach((controller) => controller.abort());
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
const FILTER_STATE_KEY = 'sd-image-sorter-filter-state';

// Load saved filter state from localStorage
function loadSavedFilterState() {
    try {
        const saved = localStorage.getItem(FILTER_STATE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        Logger.warn('Failed to load saved filter state:', e);
    }
    return null;
}

const savedFilters = loadSavedFilterState();

// App State
const AppState = {
    currentView: 'gallery',
    viewMode: localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid',
    images: [],
    filters: savedFilters || {
        generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
        ratings: ['general', 'sensitive', 'questionable', 'explicit'],
        tags: [],
        checkpoints: [],
        loras: [],
        prompts: [],  // Multi-prompt filter
        artist: null,  // Artist filter
        search: '',
        sortBy: 'newest'
    },
    selectedImage: null,
    isLoading: false,

    // Pagination state
    pagination: {
        cursor: null,
        offset: 0,
        hasMore: true,
        total: 0,
        pageSize: 200
    },

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

function supportsCursorPagination(sortBy = AppState.filters.sortBy) {
    return sortBy === 'newest' || sortBy === 'oldest';
}

// ============== API Functions ==============

/**
 * Format error messages for user-friendly display
 * @param {number} status - HTTP status code
 * @param {object} errorData - Error response data
 * @returns {string} User-friendly error message
 */
function formatApiError(status, errorData = {}) {
    // Use error detail if provided
    if (errorData.detail) return errorData.detail;
    if (errorData.error) return errorData.error;

    // Default messages based on status code
    const statusMessages = {
        400: 'Invalid request. Please check your input and try again.',
        401: 'Authentication required. Please refresh the page.',
        403: 'Access denied. You do not have permission for this action.',
        404: 'The requested resource was not found.',
        409: 'This operation conflicts with an existing one. Please wait and try again.',
        422: 'Invalid data provided. Please check your input.',
        429: 'Too many requests. Please wait a moment and try again.',
        500: 'Server error. Please try again later or check the logs.',
        502: 'Server is temporarily unavailable. Please try again.',
        503: 'Service unavailable. The server may be starting up.',
    };

    return statusMessages[status] || `Request failed (${status}). Please try again.`;
}

const API = {
    async get(endpoint, options = {}) {
        const { signal, requestKey } = options;
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, { signal });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const message = formatApiError(response.status, errorData);
                throw new Error(message);
            }
            return response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw { name: 'AbortError', cancelled: true };
            }
            if (error.name === 'SyntaxError') {
                throw new Error('Server returned invalid data. Please try again.');
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
                const message = formatApiError(response.status, errorData);
                throw new Error(message);
            }
            return response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw { name: 'AbortError', cancelled: true };
            }
            if (error.name === 'SyntaxError') {
                throw new Error('Server returned invalid data. Please try again.');
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

    // Images with cursor-based pagination
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
        if (filters.search) params.set('search', filters.search);
        if (filters.sortBy) params.set('sort_by', filters.sortBy);
        params.set('limit', filters.limit ?? 200);
        if (filters.cursor) params.set('cursor', filters.cursor);
        if (Number.isFinite(filters.offset)) params.set('offset', filters.offset);

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
            use_gpu: options.useGpu ?? true,
            allow_unsafe_acceleration: options.allowUnsafeAcceleration ?? false,
            batch_size: options.batchSize || null
        });
    },

    async getTagProgress() {
        return this.get('/api/tag/progress');
    },

    async cancelTagging() {
        return this.post('/api/tag/cancel');
    },

    async exportAllTags() {
        return this.get('/api/tags/export');
    },

    async getTaggerModels() {
        return this.get('/api/tagger/models');
    },

    // Move
    async moveImages(imageIds, destinationFolder) {
        return this.post('/api/move', { image_ids: imageIds, destination_folder: destinationFolder });
    },

    async batchMove(generators, tags, ratings, destinationFolder, checkpoints = null, loras = null, prompts = null, dimensions = null, search = null) {
        return this.post('/api/batch-move', {
            generators,
            tags,
            ratings,
            checkpoints,
            loras,
            prompts,
            search,
            min_width: dimensions?.minWidth || null,
            max_width: dimensions?.maxWidth || null,
            min_height: dimensions?.minHeight || null,
            max_height: dimensions?.maxHeight || null,
            aspect_ratio: dimensions?.aspectRatio || null,
            destination_folder: destinationFolder
        });
    },

    // Manual Sort
    async startSortSession(generators, tags, ratings, folders, checkpoints = null, loras = null, prompts = null, dimensions = null, search = null) {
        const params = new URLSearchParams();
        if (generators?.length) params.set('generators', generators.join(','));
        if (tags?.length) params.set('tags', tags.join(','));
        if (ratings?.length) params.set('ratings', ratings.join(','));
        if (checkpoints?.length) params.set('checkpoints', checkpoints.join(','));
        if (loras?.length) params.set('loras', loras.join(','));
        if (prompts?.length) params.set('prompts', prompts.join(','));
        if (search) params.set('search', search);
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
        return this.post('/api/tags/export-batch', {
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

// Recent folders management
const RECENT_FOLDERS_KEY = 'sd-image-sorter-recent-folders';
const MAX_RECENT_FOLDERS = 5;

function getRecentFolders() {
    try {
        const saved = localStorage.getItem(RECENT_FOLDERS_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch (e) { return []; }
}

function addRecentFolder(path) {
    if (!path || typeof path !== 'string') return;
    const folders = getRecentFolders().filter(f => f !== path);
    const updated = [path, ...folders].slice(0, MAX_RECENT_FOLDERS);
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(updated));
}

function showToast(message, type = 'info') {
    let container = $('#toast-container');

    // Create container if it doesn't exist
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(container);
    }


    // Deduplicate: skip if identical message+type toast already visible
    const existingToasts = container.querySelectorAll('.toast');
    for (const existing of existingToasts) {
        const existingMsg = existing.querySelector('.toast-message');
        if (existingMsg && existingMsg.textContent === message && existing.classList.contains(type)) {
            return; // Already showing
        }
    }
    // Limit max visible toasts
    while (container.children.length >= 5) {
        container.firstChild.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', 'alert');

    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${icons[type] || 'ℹ'}</span>
        <span class="toast-message"></span>
    `;
    toast.querySelector('.toast-message').textContent = message;

    container.appendChild(toast);

    // Announce to screen readers using A11y module
    if (window.A11y && typeof window.A11y.announce === 'function') {
        const priority = type === 'error' ? 'assertive' : 'polite';
        window.A11y.announce(message, priority);
    }

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function createGuideOverlay({ id, title, description, steps = [], note = '', maxWidth = '520px', storageKey, closeLabel = 'Got it!' }) {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'first-use-overlay';

    const stepsHtml = steps.length > 0
        ? `<ol class="guide-steps">${steps.map(step => `<li><strong>${escapeHtml(step.title)}</strong><span>${escapeHtml(step.text)}</span></li>`).join('')}</ol>`
        : '';

    const noteHtml = note ? `<p class="guide-note">${escapeHtml(note)}</p>` : '';

    overlay.innerHTML = `
        <div class="guide-backdrop"></div>
        <div class="guide-card" style="--guide-max-width: ${maxWidth};">
            <h3>${escapeHtml(title)}</h3>
            <p class="guide-description">${escapeHtml(description)}</p>
            ${stepsHtml}
            ${noteHtml}
            <button class="btn btn-primary guide-close-btn" data-guide-close="${escapeHtml(id)}">${escapeHtml(closeLabel)}</button>
        </div>
    `;

    overlay.dataset.storageKey = storageKey || '';
    let cleanedUp = false;

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        document.removeEventListener('keydown', handleEscape);
        removalObserver.disconnect();
    };

    const closeOverlay = () => {
        if (storageKey) {
            localStorage.setItem(storageKey, 'true');
        }
        cleanup();
        overlay.remove();
    };

    const handleEscape = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeOverlay();
        }
    };

    const removalObserver = new MutationObserver(() => {
        if (!overlay.isConnected) {
            cleanup();
        }
    });

    overlay.querySelector('.guide-backdrop')?.addEventListener('click', closeOverlay);
    overlay.querySelector('[data-guide-close]')?.addEventListener('click', closeOverlay);
    document.addEventListener('keydown', handleEscape);
    removalObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });

    return overlay;
}

function copyTextToClipboard(text, successMessage = 'Copied to clipboard') {
    const value = String(text ?? '');
    if (!value) return Promise.resolve(false);

    const fallbackCopy = () => {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
    };

    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(value)
            .then(() => {
                showToast(successMessage, 'success');
                return true;
            })
            .catch(() => {
                const copied = fallbackCopy();
                if (copied) showToast(successMessage, 'success');
                return copied;
            });
    }

    const copied = fallbackCopy();
    if (copied) showToast(successMessage, 'success');
    return Promise.resolve(copied);
}

// Focus trap for accessibility
let _lastFocusedElement = null;
let _focusTrapHandler = null;

function trapFocus(modal) {
    const focusableElements = modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    // Remove existing trap if any
    if (_focusTrapHandler) {
        document.removeEventListener('keydown', _focusTrapHandler);
    }

    _focusTrapHandler = (e) => {
        if (e.key !== 'Tab') return;

        if (e.shiftKey) {
            if (document.activeElement === firstFocusable) {
                e.preventDefault();
                lastFocusable.focus();
            }
        } else {
            if (document.activeElement === lastFocusable) {
                e.preventDefault();
                firstFocusable.focus();
            }
        }
    };

    document.addEventListener('keydown', _focusTrapHandler);
}

function releaseFocus() {
    if (_focusTrapHandler) {
        document.removeEventListener('keydown', _focusTrapHandler);
        _focusTrapHandler = null;
    }
    if (_lastFocusedElement) {
        _lastFocusedElement.focus();
        _lastFocusedElement = null;
    }
}

function showModal(modalId) {
    const modal = $(`#${modalId}`);
    if (modal) {
        // Store the element that had focus before opening modal
        _lastFocusedElement = document.activeElement;
        modal.classList.add('visible');

        // Populate recent folders datalist when scan modal opens
        if (modalId === 'scan-modal') {
            const recentFolders = getRecentFolders();
            const scanInput = document.getElementById('scan-folder-path');
            if (scanInput && recentFolders.length > 0) {
                let datalist = document.getElementById('recent-folders-list');
                if (!datalist) {
                    datalist = document.createElement('datalist');
                    datalist.id = 'recent-folders-list';
                    scanInput.parentNode.appendChild(datalist);
                    scanInput.setAttribute('list', 'recent-folders-list');
                }
                datalist.innerHTML = recentFolders
                    .map(f => '<option value="' + f.replace(/"/g, '&quot;') + '">')
                    .join('');
            }
        }

        // Load system hardware info when tag modal opens
        if (modalId === 'tag-modal') {
            if (typeof loadSystemInfo === 'function') loadSystemInfo();
        }

        // Set up focus trap
        trapFocus(modal);

        // Add escape key handler to close modal
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                hideModal(modalId);
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);

        // Store escape handler for cleanup
        modal._escapeHandler = escapeHandler;

        // Focus the close button for accessibility
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            setTimeout(() => closeBtn.focus(), 100);
        }
    }
}

function hideModal(modalId) {
    const modal = $(`#${modalId}`);
    if (modal) {
        // Quick exit animation (non-blocking — remove class immediately for E2E compatibility)
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.transition = 'opacity 120ms ease, transform 120ms ease';
            content.style.opacity = '0';
            content.style.transform = 'scale(0.97)';
        }
        // Remove visible immediately so Playwright/tests can detect closure
        modal.classList.remove('visible');

        // Clean up animation styles after transition
        if (content) {
            setTimeout(() => {
                content.style.transition = '';
                content.style.opacity = '';
                content.style.transform = '';
            }, 130);
        }

        // Remove escape key handler
        if (modal._escapeHandler) {
            document.removeEventListener('keydown', modal._escapeHandler);
            modal._escapeHandler = null;
        }

        // Release focus trap and restore focus
        releaseFocus();
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

function createProgressTracker(maxSamples = 12) {
    return {
        maxSamples,
        startedAt: null,
        samples: [],
    };
}

function resetProgressTracker(tracker) {
    if (!tracker) return;
    tracker.startedAt = null;
    tracker.samples = [];
}

function formatDurationCompact(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const secs = safeSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

function updateProgressTracker(tracker, completed, total) {
    if (!tracker) return { elapsedText: '', etaText: '' };

    const safeCompleted = Math.max(0, Number(completed) || 0);
    const safeTotal = Math.max(0, Number(total) || 0);
    const now = Date.now();

    if (!tracker.startedAt && safeCompleted > 0) {
        tracker.startedAt = now;
    }

    if (tracker.startedAt) {
        tracker.samples.push({ time: now, completed: safeCompleted });
        if (tracker.samples.length > tracker.maxSamples) {
            tracker.samples.shift();
        }
    }

    const elapsedSeconds = tracker.startedAt ? Math.max(0, (now - tracker.startedAt) / 1000) : 0;
    let etaSeconds = null;
    if (safeTotal > 0 && tracker.samples.length >= 3) {
        const first = tracker.samples[0];
        const last = tracker.samples[tracker.samples.length - 1];
        const completedDelta = last.completed - first.completed;
        const secondsDelta = (last.time - first.time) / 1000;
        if (completedDelta > 0 && secondsDelta > 0) {
            const rate = completedDelta / secondsDelta;
            const remaining = Math.max(0, safeTotal - safeCompleted);
            if (rate > 0 && remaining > 0) {
                etaSeconds = remaining / rate;
            }
        }
    }

    return {
        elapsedSeconds,
        elapsedText: elapsedSeconds > 0 ? formatDurationCompact(elapsedSeconds) : '',
        etaSeconds,
        etaText: etaSeconds != null ? formatDurationCompact(etaSeconds) : '',
    };
}

function buildProgressText({
    progress = {},
    completed = 0,
    total = 0,
    tracker = null,
    defaultMessage = 'Processing...',
    primaryLabel = '',
}) {
    const meta = updateProgressTracker(tracker, completed, total);
    const parts = [];

    if (primaryLabel) parts.push(primaryLabel);
    if (total > 0) parts.push(`${completed}/${total}`);
    if (meta.etaText) parts.push(`ETA ${meta.etaText}`);
    else if (meta.elapsedText) parts.push(`Elapsed ${meta.elapsedText}`);

    const detail = progress.current_item || progress.message || defaultMessage;
    if (detail) parts.push(detail);

    return parts.join(' · ');
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
        const isActive = btn.dataset.size === nextMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });

    const grid = $('#gallery-grid');
    if (grid) {
        grid.classList.toggle('large', nextMode === 'large');
        grid.classList.toggle('waterfall', nextMode === 'waterfall');
        grid.classList.toggle('selection-mode', !!AppState.selectionMode);
    }

    if (window.Gallery) {
        Gallery.setViewMode(nextMode);
    }

    requestAnimationFrame(() => {
        attachGalleryPaginationListener();
        _onGalleryScroll();
    });
}

const TAGGER_MODEL_ALIASES = {
    'best quality': 'wd-eva02-large-tagger-v3',
    'best-quality': 'wd-eva02-large-tagger-v3',
    'eva02': 'wd-eva02-large-tagger-v3',
    'quality': 'wd-eva02-large-tagger-v3',
    'recommended': 'wd-swinv2-tagger-v3',
    'balanced': 'wd-swinv2-tagger-v3',
    'fast': 'wd-vit-tagger-v3',
    'lightweight': 'wd-vit-tagger-v3',
    'camie': 'camie-tagger-v2',
    'camie v2': 'camie-tagger-v2',
    'pixai': 'pixai-tagger-v0.9',
};

let _taggerModelCatalog = [];
let _taggerModelCatalogMap = new Map();

function normalizeTaggerModelName(value, fallback = 'wd-swinv2-tagger-v3') {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) {
        return fallback;
    }

    return TAGGER_MODEL_ALIASES[rawValue.toLowerCase()] || rawValue;
}

function getTaggerModelMeta(modelName) {
    const normalizedName = normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    return _taggerModelCatalogMap.get(normalizedName) || null;
}

function isToriiGateTaggerModel(modelName, options = {}) {
    const { isCustom = false } = options;
    if (isCustom) return false;
    return normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3') === 'toriigate-0.5';
}

function isGpuLockedTaggerModel(modelName, options = {}) {
    const { isCustom = false } = options;
    if (isCustom) return false;

    const meta = getTaggerModelMeta(modelName);
    return Boolean(meta?.gpu_locked);
}

function isRiskyTaggerGpuSelection(modelName, options = {}) {
    const {
        isCustom = false,
        useGpu = false,
        recommendedGpu = null,
        treatConfirmationRequiredAsRisky = false
    } = options;
    if (!useGpu) return false;
    if (isCustom) return true;
    if (isGpuLockedTaggerModel(modelName, { isCustom })) return false;

    const meta = getTaggerModelMeta(modelName);
    if (treatConfirmationRequiredAsRisky && meta?.gpu_confirmation_required) {
        return true;
    }

    if (typeof recommendedGpu === 'boolean') {
        return useGpu && !recommendedGpu;
    }

    return false;
}

function requiresTaggerGpuLaunchConfirmation(modelName, options = {}) {
    const { isCustom = false, useGpu = false } = options;
    if (!useGpu) return false;
    if (isCustom) return true;
    if (isGpuLockedTaggerModel(modelName, { isCustom })) return false;

    const meta = getTaggerModelMeta(modelName);
    return Boolean(meta?.gpu_confirmation_required);
}

function describeTaggerModel(meta) {
    if (!meta) {
        return tText('tagger.descDefault', 'Balanced default. Good speed, good quality, and solid stability.');
    }

    const summary = meta.description || meta.summary || tText('tagger.defaultSummary', 'WD14 tagger model');
    const bestFor = meta.best_for
        ? tText('tagger.bestForPrefix', ' Best for: {bestFor}.').replace('{bestFor}', meta.best_for)
        : '';
    const quality = Number(meta.quality_score || 0);
    const speed = Number(meta.speed_score || 0);
    const stability = Number(meta.stability_score || 0);
    const runtimeNote = meta.runtime_note ? ` ${meta.runtime_note}` : '';
    return tText('tagger.descSummaryFormat', '{summary} Q{quality}/5 \u2022 S{speed}/5 \u2022 Stable {stability}/5.{bestFor}{runtimeNote}')
        .replace('{summary}', summary)
        .replace('{quality}', quality)
        .replace('{speed}', speed)
        .replace('{stability}', stability)
        .replace('{bestFor}', bestFor)
        .replace('{runtimeNote}', runtimeNote);
}

function describeTaggerRuntime(options = {}) {
    const {
        isCustom = false,
        gpuLocked = false,
        gpuEnabled = false,
        riskyGpu = false,
        meta = null
    } = options;

    if (gpuLocked) {
        return tText('tagger.runtimeAdaptiveMax', 'Adaptive max-throughput mode is active. The app pushes GPU speed first, then falls back only if the run becomes unstable.');
    }

    if (isCustom) {
        if (gpuEnabled) {
            return tText('tagger.runtimeCustomGpu', 'Custom model on GPU. Faster when it works, but less predictable than CPU Safe Mode.');
        }
        return tText('tagger.runtimeCustomCpu', 'Custom model on CPU Safe Mode. Finish one stable run first, then try GPU only if needed.');
    }

    if (riskyGpu) {
        return tText('tagger.runtimeRiskyGpu', 'Risky GPU override is active. This is not the stable default for this model.');
    }

    if (gpuEnabled) {
        const focus = meta?.best_for
            ? tText('tagger.bestForPrefix', ' Best for: {bestFor}.').replace('{bestFor}', meta.best_for)
            : '';
        return `${tText('tagger.runtimeAdaptiveGpu', 'Adaptive GPU mode is active. The app is already using the recommended fast path for this hardware.')}${focus}`;
    }

    return tText('tagger.runtimeCpuSafe', 'CPU Safe Mode is active. Slower, but safer when VRAM is tight or other AI tools are already running.');
}

function getTaggerHardwareRecommendation() {
    return window.__taggerSystemInfo?.recommendation || null;
}

function getRecommendedTaggerChunkSize() {
    const recommendation = getTaggerHardwareRecommendation();
    const size = Number(recommendation?.recommended_batch_size || 4);
    return Number.isFinite(size) && size > 0 ? size : 4;
}

function getTaggerProviderState() {
    const systemInfo = window.__taggerSystemInfo?.system_info || {};
    const providers = Array.isArray(systemInfo.onnx_providers)
        ? systemInfo.onnx_providers.map((provider) => String(provider))
        : [];
    const hasCuda = providers.includes('CUDAExecutionProvider');
    const hasTensorRt = providers.includes('TensorrtExecutionProvider');
    const label = hasCuda
        ? (hasTensorRt ? 'TensorRT + CUDA Ready' : 'CUDA Ready')
        : 'CPU Runtime Only';
    const tone = hasCuda ? 'is-safe' : 'is-warning';

    return {
        providers,
        hasCuda,
        hasTensorRt,
        label,
        tone,
    };
}

function setTaggerStatusChip(element, text, tone = '') {
    if (!element) return;
    element.textContent = text;
    const baseClass = element.classList.contains('system-info-chip') ? 'system-info-chip' : 'tag-runtime-chip';
    const safeTone = VALID_TONES.has(tone) ? tone : '';
    element.className = safeTone ? `${baseClass} ${safeTone}` : baseClass;
    // Ensure ARIA live region so screen readers announce chip changes
    if (!element.getAttribute('aria-live')) {
        element.setAttribute('aria-live', 'polite');
    }
}

const VALID_TONES = new Set(['', 'is-highlight', 'is-warning', 'is-danger', 'is-safe', 'is-info']);

function renderTaggerModelSnapshot(meta, options = {}) {
    const {
        isCustom = false,
        modelDisabled = false,
    } = options;
    const subtitleEl = $('#tag-model-subtitle');
    const badgesEl = $('#tag-model-badges');
    const noteEl = $('#tag-model-note');
    if (!subtitleEl || !badgesEl || !noteEl) return;

    if (isCustom) {
        subtitleEl.textContent = tText('tagger.customSubtitle', 'Custom local ONNX model. The app cannot infer its schema or stability in advance.');
        badgesEl.innerHTML = [
            `<span class="tagger-model-badge is-warning">${escapeHtml(tText('tagger.customBadge', 'Custom'))}</span>`,
            `<span class="tagger-model-badge">${escapeHtml(tText('tagger.onnxOnlyBadge', 'ONNX only'))}</span>`,
            `<span class="tagger-model-badge">${escapeHtml(tText('tagger.schemaUnknownBadge', 'Schema unknown'))}</span>`,
        ].join('');
        noteEl.textContent = tText('tagger.customNote', 'Start from one stable run first. Raise chunk size only after that.');
        return;
    }

    const summary = meta?.description || meta?.summary || tText('tagger.defaultSummary', 'WD14 tagger model');
    subtitleEl.textContent = summary;

    const badges = [];
    if (meta?.recommended) badges.push({ text: 'Recommended', tone: 'is-highlight' });
    if (meta?.speed) badges.push({ text: `Speed ${meta.speed}` });
    if (meta?.memory) badges.push({ text: `Memory ${meta.memory}`, tone: /high/i.test(meta.memory) ? 'is-warning' : '' });
    if (meta?.best_for) badges.push({ text: meta.best_for, tone: 'is-highlight' });
    if (modelDisabled) badges.push({ text: tText('tagger.chipCatalogOnly', 'Catalog Only'), tone: 'is-warning' });

    badgesEl.innerHTML = badges
        .map((badge) => {
            const safeTone = VALID_TONES.has(badge.tone) ? badge.tone : '';
            return `<span class="tagger-model-badge${safeTone ? ` ${safeTone}` : ''}">${escapeHtml(badge.text)}</span>`;
        })
        .join('');

    noteEl.textContent = meta?.disabled_reason || meta?.runtime_note || meta?.safe_mode_note || tText('tagger.defaultNote', 'The selected model decides quality, tag density, and hardware pressure.');
}

function applyTaggerModelThresholdDefaults(meta) {
    const thresholdInput = $('#tag-threshold');
    const thresholdValue = $('#tag-threshold-value');
    const characterThresholdInput = $('#tag-character-threshold');
    const characterThresholdValue = $('#tag-character-threshold-value');
    if (!thresholdInput || !characterThresholdInput) return;

    const generalThreshold = Number(meta?.default_threshold);
    const characterThreshold = Number(meta?.default_character_threshold);

    if (Number.isFinite(generalThreshold) && generalThreshold > 0) {
        thresholdInput.value = String(generalThreshold);
        if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
    }

    if (Number.isFinite(characterThreshold) && characterThreshold > 0) {
        characterThresholdInput.value = String(characterThreshold);
        if (characterThresholdValue) characterThresholdValue.textContent = characterThresholdInput.value;
    }
}

function syncTaggerThresholdUi(options = {}) {
    const { isToriiGate = false } = options;
    const thresholdSection = $('#tag-threshold-section');
    const thresholdNote = $('#tag-threshold-note');
    const thresholdInput = $('#tag-threshold');
    const characterThresholdInput = $('#tag-character-threshold');
    const thresholdValue = $('#tag-threshold-value');
    const characterThresholdValue = $('#tag-character-threshold-value');
    if (!thresholdInput || !characterThresholdInput) return;

    if (thresholdSection) {
        thresholdSection.hidden = isToriiGate;
        thresholdSection.setAttribute('aria-hidden', String(isToriiGate));
    }
    if (thresholdNote) {
        thresholdNote.hidden = !isToriiGate;
    }

    thresholdInput.disabled = isToriiGate;
    characterThresholdInput.disabled = isToriiGate;
    thresholdInput.setAttribute('aria-disabled', String(isToriiGate));
    characterThresholdInput.setAttribute('aria-disabled', String(isToriiGate));
    if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
    if (characterThresholdValue) characterThresholdValue.textContent = characterThresholdInput.value;
}

function syncTaggerRuntimeChunkUi(options = {}) {
    const {
        gpuEnabled = false,
        gpuLocked = false,
        riskyGpu = false,
        isCustom = false,
        isToriiGate = false
    } = options;

    const batchSelect = $('#tagger-batch-size');
    const batchHelp = $('#tag-batch-help');
    const batchRecommendation = $('#tag-batch-recommendation');
    const chunkChip = $('#tag-runtime-chunk-chip');
    if (!batchSelect || !batchHelp) return;

    const recommendedChunk = getRecommendedTaggerChunkSize();
    if (batchSelect.dataset.userChosen !== '1') {
        batchSelect.value = String(recommendedChunk);
    }

    const selectedChunk = parseInt(batchSelect.value, 10) || recommendedChunk;
    const recommendation = getTaggerHardwareRecommendation();
    const riskLevel = String(recommendation?.risk_level || 'medium').toLowerCase();

    if (batchRecommendation) {
        batchRecommendation.textContent = tText('tagger.chunkHelpRecommended', 'Recommended chunk size: {chunk}. Leave this alone unless you are deliberately tuning throughput.').replace('{chunk}', recommendedChunk);
    }

    if (chunkChip) {
        setTaggerStatusChip(
            chunkChip,
            `Chunk ${selectedChunk}`,
            selectedChunk > recommendedChunk ? 'is-warning' : 'is-safe'
        );
    }

    if (gpuLocked) {
        batchHelp.textContent = tText('tagger.chunkHelpAdaptive', 'This model already uses adaptive runtime limits. Only change chunk size if you are stress-testing.');
        return;
    }

    if (isToriiGate) {
        batchHelp.textContent = gpuEnabled
            ? tText('tagger.chunkHelpToriiGateGpu', 'ToriiGate uses the multimodal PyTorch backend. Keep chunk size small, usually 1-2.')
            : tText('tagger.chunkHelpToriiGateCpu', 'ToriiGate on CPU should stay at chunk size 1.');
        return;
    }

    if (selectedChunk > recommendedChunk) {
        batchHelp.textContent = gpuEnabled
            ? tText('tagger.chunkHelpOverGpu', 'You chose {chosen}, above the recommended {recommended}. Expect higher VRAM pressure and more crash risk.').replace('{chosen}', selectedChunk).replace('{recommended}', recommendedChunk)
            : tText('tagger.chunkHelpOverCpu', 'You chose {chosen}, above the recommended {recommended}. This may help throughput, but it raises RAM pressure.').replace('{chosen}', selectedChunk).replace('{recommended}', recommendedChunk);
        return;
    }

    if (riskyGpu) {
        batchHelp.textContent = tText('tagger.chunkHelpRiskyGpu', 'This controls true WD14 batching where supported. Risky GPU mode still needs confirmation.');
        return;
    }

    if (isCustom) {
        batchHelp.textContent = tText('tagger.chunkHelpCustom', 'Custom models may or may not support true batching. Start from the recommended value.');
        return;
    }

    if (riskLevel === 'high') {
        batchHelp.textContent = tText('tagger.chunkHelpHighRisk', 'This machine is marked high-risk for long GPU tagging. Leave the recommended chunk size alone.');
        return;
    }

    batchHelp.textContent = tText('tagger.chunkHelpDefault', 'This controls the true WD14 batch size when the selected model supports dynamic batching.');
}

function syncTaggerModelUi(options = {}) {
    const { applyModelDefaults = false, toastOnAutoSafe = false } = options;
    const modelSelect = $('#tag-model-select');
    const useGpu = $('#tag-use-gpu');
    const modelHelp = $('#tag-model-help');
    const gpuHelp = $('#tag-gpu-help');
    const runtimeSummary = $('#tag-runtime-summary');
    const runtimeDetail = $('#tag-runtime-detail');
    const runtimeModeChip = $('#tag-runtime-mode-chip');
    const runtimeProviderChip = $('#tag-runtime-provider-chip');
    const runtimeAdvanced = $('#tag-runtime-advanced');
    const runtimeAdvancedHint = $('#tag-runtime-advanced-hint');
    const customModelGroup = $('#custom-model-group');
    const customTagsGroup = $('#custom-tags-group');
    const disabledNotice = $('#tagger-disabled-notice');
    const disabledTitle = $('#tagger-disabled-title');
    const disabledBody = $('#tagger-disabled-body');
    if (!modelSelect) return;

    const rawValue = modelSelect.value || '';
    const isCustom = rawValue === 'custom';
    const normalizedModel = normalizeTaggerModelName(rawValue, 'wd-swinv2-tagger-v3');
    const meta = getTaggerModelMeta(normalizedModel);
    const isToriiGate = isToriiGateTaggerModel(normalizedModel, { isCustom });
    const gpuLocked = isGpuLockedTaggerModel(normalizedModel, { isCustom });
    const hardwareRecommendation = getTaggerHardwareRecommendation();
    const providerState = getTaggerProviderState();
    const hardwareRisk = String(hardwareRecommendation?.risk_level || '').toLowerCase();
    const hardwarePrefersGpu = hardwareRecommendation
        ? Boolean(hardwareRecommendation.recommended_use_gpu)
        : true;
    const hardwareHighRisk = hardwareRisk === 'high';
    const taggingIsRunning = $('#btn-start-tag')?.disabled === true;
    const modelDisabled = !isCustom && Boolean(meta?.disabled);
    const modelPrefersGpu = isCustom ? false : Boolean(meta?.gpu_default ?? true);
    const recommendedGpu = gpuLocked
        ? false
        : (modelPrefersGpu && hardwarePrefersGpu);

    if (customModelGroup) customModelGroup.style.display = isCustom ? 'block' : 'none';
    if (customTagsGroup) customTagsGroup.style.display = isCustom ? 'block' : 'none';
    renderTaggerModelSnapshot(meta, { isCustom, modelDisabled });
    syncTaggerThresholdUi({ isToriiGate });

    if (applyModelDefaults && meta && !isCustom) {
        applyTaggerModelThresholdDefaults(meta);
    }

    if (useGpu && (applyModelDefaults || gpuLocked)) {
        const changedToSafeMode = useGpu.checked && !recommendedGpu;
        useGpu.checked = recommendedGpu;
        if (changedToSafeMode && toastOnAutoSafe) {
            showToast(
                gpuLocked
                    ? tText('tagger.toastMaxQualityCpuSafe', 'Max Quality now runs in protected CPU Safe Mode inside the app.')
                    : tText('tagger.toastAutoSafeMode', 'This model was switched to CPU Safe Mode to avoid crashes.'),
                'warning'
            );
        }
    }

    if (runtimeAdvanced && applyModelDefaults && !taggingIsRunning) {
        runtimeAdvanced.open = false;
    }

    if (useGpu) {
        useGpu.disabled = taggingIsRunning ? true : (gpuLocked || modelDisabled);
        useGpu.setAttribute('aria-disabled', String(useGpu.disabled));
    }

    if (modelHelp) {
        if (isCustom) {
            modelHelp.textContent = tText('tagger.customModelHelp', 'Custom ONNX model. Start with CPU Safe Mode first.');
        } else if (modelDisabled) {
            modelHelp.textContent = meta?.disabled_reason || tText('tagger.modelListedFuture', 'This model is listed for future integration but is not runnable in the current build.');
        } else {
            modelHelp.textContent = describeTaggerModel(meta);
        }
    }

    const gpuEnabled = useGpu?.checked ?? false;
    const riskyGpu = modelDisabled ? false : isRiskyTaggerGpuSelection(normalizedModel, {
        isCustom,
        useGpu: gpuEnabled,
        recommendedGpu
    });

    if (runtimeSummary) {
        let summary = modelDisabled
            ? (meta?.disabled_reason || tText('tagger.modelUnavailable', 'This model is currently unavailable in the app runtime.'))
            : describeTaggerRuntime({
            isCustom,
            gpuLocked,
            gpuEnabled,
            riskyGpu,
            meta
        });
        const recommendedChunk = getRecommendedTaggerChunkSize();
        if (hardwareHighRisk && !gpuLocked && !gpuEnabled) {
            summary += tText('tagger.highRiskSuffix', ' This hardware profile is marked high-risk for long GPU runs, so CPU is the safe default.');
        }
        summary += tText('tagger.recommendedChunkSuffix', ' Recommended chunk: {chunk}.').replace('{chunk}', recommendedChunk);
        runtimeSummary.textContent = summary;
    }

    if (runtimeDetail) {
        if (modelDisabled) {
            runtimeDetail.textContent = tText('tagger.catalogOnlyDetail', 'This entry stays in the catalog so the planned integration is visible, but the current tagger runtime cannot execute it.');
        } else if (isToriiGate) {
            runtimeDetail.textContent = gpuEnabled
                ? tText('tagger.toriiGateGpuDetail', 'ToriiGate uses the multimodal PyTorch CUDA path. WD14 thresholds do not apply here.')
                : tText('tagger.toriiGateCpuDetail', 'ToriiGate can run on CPU, but it is much slower than CUDA. WD14 thresholds do not apply here.');
        } else if (isCustom) {
            runtimeDetail.textContent = providerState.hasCuda
                ? tText('tagger.customGpuAvailDetail', 'The final provider is decided when the custom ONNX session is created. GPU is available, but model stability still decides the final path.')
                : tText('tagger.customCpuOnlyDetail', 'CUDAExecutionProvider is not available for the ONNX runtime path right now, so a custom model run will stay on CPU.');
        } else if (providerState.hasCuda) {
            runtimeDetail.textContent = tText('tagger.cudaAvailDetail', 'CUDAExecutionProvider is available on this machine. If the session loads cleanly, the run should stay on GPU.');
        } else {
            runtimeDetail.textContent = tText('tagger.cpuOnlyDetail', 'The current ONNX runtime probe does not expose CUDAExecutionProvider, so this run will stay on CPU.');
        }
    }

    if (runtimeModeChip) {
        setTaggerStatusChip(
            runtimeModeChip,
            modelDisabled ? tText('tagger.chipCatalogOnly', 'Catalog Only') : (gpuEnabled ? tText('tagger.chipGpuTarget', 'GPU Target') : tText('tagger.chipCpuTarget', 'CPU Target')),
            modelDisabled ? 'is-danger' : (gpuEnabled ? 'is-safe' : 'is-warning')
        );
    }

    if (runtimeProviderChip) {
        const providerLabel = modelDisabled
            ? tText('tagger.chipVlmNeeded', 'VLM Backend Needed')
            : (isToriiGate
                ? ((window.__taggerSystemInfo?.system_info?.torch_cuda_available && gpuEnabled) ? tText('tagger.chipPytorchCuda', 'PyTorch CUDA') : tText('tagger.chipPytorchCpu', 'PyTorch CPU'))
                : (providerState.hasCuda ? providerState.label : tText('tagger.chipCpuRuntime', 'CPU Runtime')));
        const providerTone = modelDisabled
            ? 'is-danger'
            : (isToriiGate
                ? (gpuEnabled ? 'is-safe' : 'is-warning')
                : providerState.tone);
        setTaggerStatusChip(runtimeProviderChip, providerLabel, providerTone);
    }

    if (disabledNotice && disabledTitle && disabledBody) {
        if (modelDisabled) {
            disabledNotice.hidden = false;
            disabledTitle.textContent = tText('tagger.disabledNotRunnable', '{model} is not runnable in the current build.').replace('{model}', normalizedModel);
            disabledBody.textContent = meta?.disabled_reason || tText('tagger.disabledFallback', 'Use one of the ONNX taggers above for now.');
        } else {
            disabledNotice.hidden = true;
        }
    }

    if (runtimeAdvancedHint) {
        if (gpuLocked) {
            runtimeAdvancedHint.textContent = tText('tagger.advHintStressTest', 'Optional. Change this only if you are stress-testing.');
        } else if (hardwareHighRisk && !gpuEnabled) {
            runtimeAdvancedHint.textContent = tText('tagger.advHintHighRisk', 'Optional. This machine is marked high-risk for long GPU tagging.');
        } else if (isCustom) {
            runtimeAdvancedHint.textContent = tText('tagger.advHintCustom', 'Optional. Leave this alone until your custom model finishes one stable CPU run.');
        } else if (gpuEnabled && !riskyGpu) {
            runtimeAdvancedHint.textContent = tText('tagger.advHintRecommended', 'Optional. The recommended mode is already active.');
        } else {
            runtimeAdvancedHint.textContent = tText('tagger.advHintDefault', 'Optional. Change this only when troubleshooting or tuning.');
        }
    }

    if (gpuHelp) {
        if (modelDisabled) {
            gpuHelp.textContent = meta?.disabled_reason || tText('tagger.modelNotStartable', 'This model cannot be started in the current build.');
        } else if (isToriiGate) {
            gpuHelp.textContent = gpuEnabled
                ? tText('tagger.gpuHelpToriiGateGpu', 'ToriiGate is using the multimodal PyTorch backend on GPU. Keep chunk size small.')
                : tText('tagger.gpuHelpToriiGateCpu', 'ToriiGate is using the multimodal PyTorch backend on CPU. This is valid but much slower than CUDA.');
        } else if (gpuLocked) {
            gpuHelp.textContent = tText('tagger.gpuHelpAdaptive', 'Adaptive runtime is active for this model. The app prefers GPU throughput and falls back only if the run becomes unstable.');
        } else if (!gpuEnabled) {
            gpuHelp.textContent = isCustom
                ? tText('tagger.gpuHelpCustomCpu', 'CPU Safe Mode is active for the custom model. Keep it here until you have one stable run.')
                : (hardwareHighRisk
                    ? tText('tagger.gpuHelpHighRiskCpu', 'CPU Safe Mode is active because this hardware profile is marked high-risk for long GPU tagging runs.')
                    : tText('tagger.gpuHelpCpuSafe', 'CPU Safe Mode is active. Use this when VRAM is tight or other AI tools are already running.'));
        } else if (riskyGpu) {
            gpuHelp.textContent = tText('tagger.gpuHelpRiskyOverride', 'High-risk GPU override is active. You will be asked to confirm before this run starts.');
        } else if (meta?.gpu_confirmation_required) {
            gpuHelp.textContent = meta?.safe_mode_note
                ? tText('tagger.gpuHelpAdaptiveNote', 'Adaptive runtime is active. {note}').replace('{note}', meta.safe_mode_note)
                : tText('tagger.gpuHelpAdaptive', 'Adaptive runtime is active for this model.');
        } else if (meta?.safe_mode_note) {
            gpuHelp.textContent = tText('tagger.gpuHelpRecommendedNote', 'Recommended GPU mode is active. {note}').replace('{note}', meta.safe_mode_note);
        } else {
            gpuHelp.textContent = tText('tagger.gpuHelpRecommendedDefault', 'Recommended GPU mode is active for this model. Switch to CPU Safe Mode only if you need extra stability.');
        }
    }

    syncTaggerRuntimeChunkUi({
        gpuEnabled,
        gpuLocked,
        riskyGpu,
        isCustom,
        isToriiGate
    });
}

function confirmUnsafeTaggerGpuRun(modelName, meta = null) {
    const displayName = modelName === 'custom'
        ? tText('tagger.confirmCustomModel', 'custom model')
        : normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    const summary = meta?.best_for
        ? tText('tagger.confirmModelFocus', 'Model focus: {bestFor}.').replace('{bestFor}', meta.best_for)
        : tText('tagger.confirmSpeedNotStability', 'This setup is optimized for maximum speed, not maximum stability.');
    const message = [
        tText('tagger.confirmCrashProne', '{model} on GPU is the most crash-prone tagger setup.').replace('{model}', displayName),
        '',
        summary,
        tText('tagger.confirmRecommendCpu', 'Recommended: switch to CPU Safe Mode first.'),
        tText('tagger.confirmContinueRisky', 'Continue with risky GPU mode anyway?')
    ].join('\n');

    return new Promise((resolve) => {
        if (typeof showConfirm === 'function') {
            showConfirm(
                tText('tagger.confirmRiskyTitle', 'Risky GPU Tagger Run'),
                message,
                () => resolve(true),
                () => resolve(false)
            );
            return;
        }

        resolve(window.confirm(message));
    });
}

function syncSelectionModeButton() {
    const toggleBtn = $('#btn-toggle-select');
    if (!toggleBtn) return;

    const iconEl = toggleBtn.querySelector('span:first-child');
    const labelEl = toggleBtn.querySelector('span:last-child');
    const isSelecting = Boolean(AppState.selectionMode);
    const doneLabel = window.I18n?.t?.('selection.doneSelecting') || 'Done Selecting';
    const idleLabel = window.I18n?.t?.('gallery.selectImages') || 'Select Images';

    toggleBtn.classList.toggle('active', isSelecting);
    toggleBtn.classList.toggle('selection-active', isSelecting);
    toggleBtn.setAttribute('aria-pressed', String(isSelecting));
    toggleBtn.setAttribute('data-state', isSelecting ? 'selecting' : 'idle');
    toggleBtn.setAttribute(
        'aria-label',
        isSelecting ? 'Exit image selection mode' : 'Enable image selection mode'
    );

    if (iconEl) {
        iconEl.textContent = isSelecting ? '✦' : '✔';
    }

    if (labelEl) {
        labelEl.textContent = isSelecting ? doneLabel : idleLabel;
    }
}

function emitSelectionStateChanged() {
    window.dispatchEvent(new CustomEvent('selection-state-changed', {
        detail: {
            selectionMode: Boolean(AppState.selectionMode),
            selectedCount: AppState.selectedIds.size,
        }
    }));
}

function ensureSelectionPanelVisible(panel) {
    const sidebar = document.querySelector('.filter-sidebar');
    if (!panel || !sidebar) return;

    const panelRect = panel.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const padding = 10;

    if (panelRect.bottom > sidebarRect.bottom - padding) {
        sidebar.scrollTop += panelRect.bottom - sidebarRect.bottom + padding;
    } else if (panelRect.top < sidebarRect.top + padding) {
        sidebar.scrollTop -= sidebarRect.top + padding - panelRect.top;
    }
}

function setSelectionMode(enabled, options = {}) {
    const { clearSelectionWhenDisabled = true } = options;
    AppState.selectionMode = Boolean(enabled);

    if (!AppState.selectionMode && clearSelectionWhenDisabled) {
        AppState.selectedIds.clear();
    }

    updateSelectionUI();
    emitSelectionStateChanged();

    if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
        Gallery.syncSelectionState();
    }
}

function openGalleryPreview(imageId) {
    switchView('gallery');
    requestAnimationFrame(() => {
        if (window.Gallery && typeof window.Gallery.openPreview === 'function') {
            window.Gallery.openPreview(imageId);
        }
    });
}

function applyPromptFilter(prompt) {
    const value = String(prompt ?? '').trim();
    if (!value) return false;

    AppState.filters.prompts = [value];

    if (typeof renderModalActivePrompts === 'function') {
        renderModalActivePrompts();
    }
    updateFilterSummary();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();
    syncGenTabsWithFilters();
    switchView('gallery');
    loadImages();
    return true;
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
        detachGalleryPaginationListener();
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
        const isActive = tab.dataset.view === viewName;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    // Update mobile nav items
    $$('.mobile-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
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
        setGalleryViewMode(AppState.viewMode);
        // Re-render existing images immediately, only reload from API if needed
        if (AppState.images.length > 0 && window.Gallery) {
            Gallery.setImages(AppState.images);
        } else {
            loadImages();
        }
        requestAnimationFrame(() => {
            attachGalleryPaginationListener();
            _onGalleryScroll();
        });
    } else if (viewName === 'similar') {
        if (typeof window.initSimilar === 'function') window.initSimilar();
    } else if (viewName === 'promptlab') {
        if (typeof window.initPromptLab === 'function') window.initPromptLab();
    } else if (viewName === 'artist') {
        if (window.ArtistIdent && typeof window.ArtistIdent.init === 'function') {
            window.ArtistIdent.init();
        }
    } else if (viewName === 'censor') {
        if (typeof window.initCensorEdit === 'function') window.initCensorEdit();
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
            const modal = backdrop.parentElement;
            // For tag-modal, use cancelTagging logic to minimize to background
            if (modal && modal.id === 'tag-modal') {
                cancelTagging();
                return;
            }
            if (modal) modal.classList.remove('visible');
        });
    });

    // Scan modal
    $('#btn-cancel-scan').addEventListener('click', () => hideModal('scan-modal'));
    $('#btn-start-scan').addEventListener('click', startScan);

    // Tag modal X close button — minimize to background if tagging
    $('#btn-close-tag-modal')?.addEventListener('click', () => cancelTagging());
    // UI-02: Inline validation for scan folder path
    const scanFolderPathInput = $('#scan-folder-path');
    if (scanFolderPathInput) {
        const debouncedValidation = debounce(validateScanFolderPath, 300);
        scanFolderPathInput.addEventListener('input', debouncedValidation);
        scanFolderPathInput.addEventListener('blur', validateScanFolderPath);
    }

    // Tag modal
    $('#btn-cancel-tag').addEventListener('click', cancelTagging);
    $('#btn-start-tag').addEventListener('click', startTagging);
    $('#btn-export-tags-json')?.addEventListener('click', exportTagLibraryJson);

    // Tag threshold sliders
    $('#tag-threshold').addEventListener('input', (e) => {
        $('#tag-threshold-value').textContent = e.target.value;
    });
    $('#tag-character-threshold').addEventListener('input', (e) => {
        $('#tag-character-threshold-value').textContent = e.target.value;
    });

    // Model selection toggle for custom model
    $('#tag-model-select').addEventListener('change', () => {
        syncTaggerModelUi({ applyModelDefaults: true, toastOnAutoSafe: true });
    });
    $('#tag-use-gpu')?.addEventListener('change', () => {
        syncTaggerModelUi({ applyModelDefaults: false });
    });
    $('#tagger-batch-size')?.addEventListener('change', (event) => {
        event.target.dataset.userChosen = '1';
        syncTaggerModelUi({ applyModelDefaults: false });
    });
    syncTaggerModelUi({ applyModelDefaults: true });

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
                    showToast(formatUserError(e, "Failed to clear gallery"), "error");
                }
            }
        );
    });

    // Random button
    $('#btn-random').addEventListener('click', showRandomImage);

    // Multi-select toggle
    $('#btn-toggle-select').addEventListener('click', () => {
        setSelectionMode(!AppState.selectionMode);
    });

    // Export selected
    $('#btn-export-selected').addEventListener('click', showExportModal);

    // Clear selection
    $('#btn-clear-selection').addEventListener('click', () => {
        AppState.selectedIds.clear();
        updateSelectionUI();
        emitSelectionStateChanged();
        if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
            Gallery.syncSelectionState();
        }
    });

    // Select All - select all currently visible/filtered images
    $('#btn-select-all').addEventListener('click', () => {
        AppState.images.forEach(img => AppState.selectedIds.add(img.id));
        updateSelectionUI();
        emitSelectionStateChanged();
        if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
            Gallery.syncSelectionState();
        }
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
    $('#btn-close-export')?.addEventListener('click', () => hideModal('export-modal'));
    $('#btn-copy-export')?.addEventListener('click', () => {
        const text = $('#export-text')?.value || '';
        copyTextToClipboard(text, 'Copied to clipboard!').catch(() => {
            showToast('Failed to copy', 'error');
        });
    });
    // --- Export Tags from FAB ---
    $('#btn-export-tags-selected').addEventListener('click', () => {
        showExportTagsModal();
        const exportAltBtn = $('#btn-export-tags-alt');
        if (exportAltBtn) exportAltBtn.innerHTML = '📤 Export Prompts Instead';
    });

    // --- Alt export button in modal ---
    const exportTagsAlt = $('#btn-export-tags-alt');
    if (exportTagsAlt) {
        exportTagsAlt.addEventListener('click', () => {
            const btn = exportTagsAlt;
            if (btn.textContent.includes('Tags')) {
                showExportTagsModal();
                btn.innerHTML = '📤 Export Prompts Instead';
            } else {
                showExportModal();
                btn.innerHTML = '🏷️ Export Tags Instead';
            }
        });
    }

    // --- Unified Filter Modal ---
    $('#btn-open-filters').addEventListener('click', openFilterModal);
    $('#btn-close-filter-modal').addEventListener('click', () => hideModal('filter-modal'));
    $('#btn-apply-modal-filters').addEventListener('click', applyModalFilters);
    $('#btn-reset-filters').addEventListener('click', resetAllFilters);
    $('#btn-clear-artist')?.addEventListener('click', clearArtistFilter);
    $('#filter-modal')?.addEventListener('change', () => updateFilterModalSummary());
    $('#filter-modal')?.addEventListener('input', () => updateFilterModalSummary());

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
                const newTags = tags.filter(tag => !AppState.filters.tags.includes(tag));
                if (newTags.length > 0) {
                    AppState.filters.tags = [...AppState.filters.tags, ...newTags];
                }
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
                    const newPrompts = prompts.filter(prompt => !AppState.filters.prompts.includes(prompt));
                    if (newPrompts.length > 0) {
                        AppState.filters.prompts = [...AppState.filters.prompts, ...newPrompts];
                    }
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
            showToast(formatUserError(err, "Failed to import tags"), "error");
        }
        e.target.value = ''; // Reset file input
    });

    // --- Censored Edit ---
    $('#btn-send-to-censor')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (AppState.selectedIds.size > 0) {
            addToCensorQueue(Array.from(AppState.selectedIds));
            return;
        }
        switchView('censor');
        if (typeof window.initCensorEdit === 'function') window.initCensorEdit();
    });

    // --- Mobile Navigation ---
    initMobileNavigation();
}

// ============== Mobile Navigation ==============

function initMobileNavigation() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');
    const mobileNavClose = $('#mobile-nav-close');
    const mobileNavItems = $$('.mobile-nav-item');

    // Toggle mobile menu
    mobileMenuToggle?.addEventListener('click', () => {
        toggleMobileMenu();
    });

    // Close mobile menu
    mobileNavClose?.addEventListener('click', () => {
        closeMobileMenu();
    });

    // Close menu when clicking overlay
    mobileNavOverlay?.addEventListener('click', (e) => {
        if (e.target === mobileNavOverlay) {
            closeMobileMenu();
        }
    });

    // Mobile nav item clicks
    mobileNavItems.forEach(item => {
        item.addEventListener('click', () => {
            const viewName = item.dataset.view;
            if (viewName) {
                // Update active state
                mobileNavItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                // Switch view and close menu
                switchView(viewName);
                closeMobileMenu();
            }
        });
    });

    // Mobile action buttons
    $('#mobile-btn-scan')?.addEventListener('click', () => {
        closeMobileMenu();
        showModal('scan-modal');
    });

    $('#mobile-btn-tag')?.addEventListener('click', () => {
        closeMobileMenu();
        showModal('tag-modal');
    });

    $('#mobile-btn-tags-library')?.addEventListener('click', () => {
        closeMobileMenu();
        openTagsLibrary();
    });

    // Mobile filter toggle (fixed button)
    const mobileFilterToggle = $('#mobile-filter-toggle');
    mobileFilterToggle?.addEventListener('click', () => {
        toggleMobileFilterSidebar();
    });

    // Mobile filter header button
    const mobileFilterHeaderBtn = $('#mobile-filter-header-btn');
    mobileFilterHeaderBtn?.addEventListener('click', () => {
        toggleMobileFilterSidebar();
    });

    // Close mobile menu on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (mobileNavOverlay?.classList.contains('visible')) {
                closeMobileMenu();
            }
            // Also close mobile filter sidebar
            const filterSidebar = $('.filter-sidebar');
            if (filterSidebar?.classList.contains('mobile-visible')) {
                filterSidebar.classList.remove('mobile-visible');
            }
        }
    });

    // Handle resize - close mobile menu if window gets larger
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (window.innerWidth > 768) {
                closeMobileMenu();
                const filterSidebar = $('.filter-sidebar');
                if (filterSidebar) {
                    filterSidebar.classList.remove('mobile-visible');
                }
            }
        }, 150);
    });
}

function toggleMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    const isOpen = mobileNavOverlay?.classList.contains('visible');

    if (isOpen) {
        closeMobileMenu();
    } else {
        openMobileMenu();
    }
}

function openMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    mobileMenuToggle?.classList.add('active');
    mobileMenuToggle?.setAttribute('aria-expanded', 'true');
    mobileNavOverlay?.classList.add('visible');

    // Prevent body scroll when menu is open
    document.body.style.overflow = 'hidden';

    // Sync active state with current view
    const currentView = AppState.currentView;
    $$('.mobile-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === currentView);
    });
}

function closeMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    mobileMenuToggle?.classList.remove('active');
    mobileMenuToggle?.setAttribute('aria-expanded', 'false');
    mobileNavOverlay?.classList.remove('visible');

    // Restore body scroll
    document.body.style.overflow = '';
}

function toggleMobileFilterSidebar() {
    const filterSidebar = $('.filter-sidebar');

    if (filterSidebar) {
        filterSidebar.classList.toggle('mobile-visible');

        const mobileFilterToggle = $('#mobile-filter-toggle');
        if (mobileFilterToggle) {
            mobileFilterToggle.setAttribute('aria-expanded', String(filterSidebar.classList.contains('mobile-visible')));
        }

        // If showing, add a close button dynamically
        if (filterSidebar.classList.contains('mobile-visible')) {
            // Add overlay for closing
            if (!$('.filter-sidebar-overlay')) {
                const overlay = document.createElement('div');
                overlay.className = 'filter-sidebar-overlay';
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 999;
                `;
                overlay.addEventListener('click', () => {
                    filterSidebar.classList.remove('mobile-visible');
                    overlay.remove();
                });
                document.body.appendChild(overlay);
            }

            // Prevent body scroll
            document.body.style.overflow = 'hidden';
        } else {
            // Remove overlay if exists
            const overlay = $('.filter-sidebar-overlay');
            if (overlay) overlay.remove();

            // Restore body scroll
            document.body.style.overflow = '';
        }
    }
}

// Function to update mobile filter badge
function updateMobileFilterBadge() {
    const badge = $('#mobile-filter-badge');
    if (!badge) return;

    // Count active filters
    let filterCount = 0;

    // Check generators (if not all selected)
    const allGenerators = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    if (AppState.filters.generators.length !== allGenerators.length) {
        filterCount++;
    }

    // Check ratings (if not all selected)
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];
    if (AppState.filters.ratings.length !== allRatings.length) {
        filterCount++;
    }

    // Tags
    if (AppState.filters.tags && AppState.filters.tags.length > 0) {
        filterCount++;
    }

    // Checkpoints
    if (AppState.filters.checkpoints && AppState.filters.checkpoints.length > 0) {
        filterCount++;
    }

    // Loras
    if (AppState.filters.loras && AppState.filters.loras.length > 0) {
        filterCount++;
    }

    // Prompts
    if (AppState.filters.prompts && AppState.filters.prompts.length > 0) {
        filterCount++;
    }

    // Artist
    if (AppState.filters.artist) {
        filterCount++;
    }

    // Show/hide badge
    if (filterCount > 0) {
        badge.style.display = 'flex';
        badge.textContent = filterCount;
    } else {
        badge.style.display = 'none';
    }
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

// UI-02: Validate scan folder path with inline feedback
function validateScanFolderPath() {
    const input = $('#scan-folder-path');
    const value = input.value.trim();
    const feedbackEl = $('#scan-folder-feedback');

    // Clear previous state
    input.classList.remove('input-valid', 'input-invalid');
    if (feedbackEl) feedbackEl.remove();

    if (!value) {
        return; // Empty is neutral state
    }

    // Create feedback element if needed
    const feedback = document.createElement('small');
    feedback.id = 'scan-folder-feedback';
    feedback.className = 'validation-feedback';
    input.parentNode.appendChild(feedback);

    // Basic path validation — exclude `:` so Windows drive letters (C:\) are allowed
    const invalidChars = /[<>"|?*]/;
    if (invalidChars.test(value)) {
        input.classList.add('input-invalid');
        feedback.className = 'validation-feedback error';
        feedback.textContent = 'Path contains invalid characters';
        return false;
    }

    // Show checking state
    input.classList.add('input-checking');
    feedback.className = 'validation-feedback checking';
    feedback.textContent = 'Checking path...';

    // Use API to validate (server-side)
    API.post('/api/validate-path', { path: value })
        .then(result => {
            input.classList.remove('input-checking');
            if (result.valid) {
                input.classList.add('input-valid');
                feedback.className = 'validation-feedback success';
                feedback.textContent = 'Folder found';
            } else {
                input.classList.add('input-invalid');
                feedback.className = 'validation-feedback error';
                feedback.textContent = result.error || 'Invalid path';
            }
        })
        .catch(() => {
            input.classList.remove('input-checking');
            // If validation endpoint doesn't exist, just clear checking state
            feedback.textContent = '';
        });

    return true;
}

async function startScan() {
    const folderPath = $('#scan-folder-path')?.value?.trim() || '';
    if (!folderPath) {
        showToast('Please enter a folder path', 'error');
        return;
    }

    const recursive = $('#scan-recursive')?.checked ?? true;

    try {
        addRecentFolder(folderPath);
        await API.startScan(folderPath, recursive);

        const progressContainer = $('#scan-progress-container');
        const startBtn = $('#btn-start-scan');
        if (progressContainer) progressContainer.style.display = 'block';
        if (startBtn) startBtn.disabled = true;
        resetProgressTracker(_scanProgressTracker);
        $('#scan-progress-text').textContent = 'Scan · waiting for first update...';

        pollScanProgress();
    } catch (error) {
        // UI-02: Show inline validation feedback on error
        const input = $('#scan-folder-path');
        const feedbackEl = $('#scan-folder-feedback');
        if (input) {
            input.classList.remove('input-valid', 'input-checking');
            input.classList.add('input-invalid');
        }
        if (feedbackEl) {
            feedbackEl.className = 'validation-feedback error';
            feedbackEl.textContent = error.message;
        }
        showToast(formatUserError(error, "Failed to start scan"), "error");
    }
}

async function pollScanProgress(retryCount = 0) {
    try {
        const progress = await API.getScanProgress();

        const processed = Number(progress.processed ?? progress.current ?? 0);
        const total = Number(progress.total || 0);
        const percent = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
        $('#scan-progress-fill').style.width = percent + '%';
        $('#scan-progress-text').textContent = buildProgressText({
            progress,
            completed: processed,
            total,
            tracker: _scanProgressTracker,
            defaultMessage: 'Scanning files...',
            primaryLabel: 'Scan'
        });

        if (progress.status === 'done') {
            const errorCount = Number(progress.errors || progress.result?.errors || 0);
            showToast(progress.message, errorCount > 0 ? 'warning' : 'success');
            hideModal('scan-modal');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            resetProgressTracker(_scanProgressTracker);
            promptsLibraryCache = null; // Invalidate cache after scan
            loadImages();
            loadStats();
            // Auto-tag: if checkbox was on, trigger tagging with current settings
            const autoTagCheckbox = document.getElementById('scan-auto-tag');
            if (autoTagCheckbox && autoTagCheckbox.checked) {
                setTimeout(() => {
                    showModal('tag-modal');
                    // Small delay to let modal render, then trigger start
                    setTimeout(() => {
                        const startBtn = document.getElementById('btn-start-tag');
                        if (startBtn && !startBtn.disabled) {
                            startBtn.click();
                        }
                    }, 300);
                }, 500);
            }
        } else if (progress.status === 'error') {
            showToast(progress.message || 'Scan failed', 'error');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            resetProgressTracker(_scanProgressTracker);
        } else if (progress.status === 'running') {
            setTimeout(() => pollScanProgress(0), 500);
        } else if (progress.status === 'idle' && retryCount < 10) {
            // Allow a brief idle window when attaching to an in-flight background task.
            setTimeout(() => pollScanProgress(0), 500);
        } else if (progress.status === 'idle') {
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            resetProgressTracker(_scanProgressTracker);
        }
    } catch (error) {
        Logger.error('Poll error:', error);
        if (retryCount < 3) {
            setTimeout(() => pollScanProgress(retryCount + 1), 1000);
        } else {
            showToast('Error checking scan progress', 'error');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            resetProgressTracker(_scanProgressTracker);
        }
    }
}

async function resumeScanProgress() {
    try {
        const progress = await API.getScanProgress();
        const hasMeaningfulProgress = Number(progress?.current || 0) > 0 || Number(progress?.total || 0) > 0;
        if (progress?.status !== 'running' && !(progress?.status === 'idle' && hasMeaningfulProgress)) {
            return;
        }

        const progressContainer = $('#scan-progress-container');
        const startBtn = $('#btn-start-scan');
        if (progressContainer) progressContainer.style.display = 'block';
        if (startBtn) startBtn.disabled = true;
        resetProgressTracker(_scanProgressTracker);
        $('#scan-progress-text').textContent = progress.message || 'Resuming scan progress...';
        pollScanProgress();
    } catch (error) {
        Logger.warn('Failed to resume scan progress:', error);
    }
}

// ============== Tagging ==============

let _tagProgressTimer = null;
let _tagPollingActive = false;
let _scanProgressTracker = createProgressTracker();

function clearTagProgressTimer() {
    if (_tagProgressTimer) {
        clearTimeout(_tagProgressTimer);
        _tagProgressTimer = null;
    }
}

function scheduleTagProgressPoll(delay = 500) {
    clearTagProgressTimer();
    _tagProgressTimer = setTimeout(() => pollTagProgress(), delay);
}

function setTaggingUiState(isRunning, options = {}) {
    const startBtn = $('#btn-start-tag');
    const cancelBtn = $('#btn-cancel-tag');
    const modelSelect = $('#tag-model-select');
    const thresholdInput = $('#tag-threshold');
    const characterThresholdInput = $('#tag-character-threshold');
    const retagAll = $('#tag-retag-all');
    const useGpu = $('#tag-use-gpu');
    const modelPath = $('#tag-model-path');
    const tagsPath = $('#tag-tags-path');
    const exportBtn = $('#btn-export-tags-json');
    const importBtn = $('#btn-import-tags');

    if (startBtn) {
        startBtn.disabled = isRunning;
        startBtn.textContent = isRunning ? 'Tagging...' : 'Start Tagging';
    }

    if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = isRunning ? 'Cancel Tagging' : (options.idleLabel || 'Close');
    }

    [modelSelect, thresholdInput, characterThresholdInput, retagAll, useGpu, modelPath, tagsPath, exportBtn, importBtn].forEach((element) => {
        if (element) {
            element.disabled = isRunning;
        }
    });

    if (!isRunning) {
        syncTaggerModelUi({ applyModelDefaults: false });
    }
}

async function loadTaggerModels() {
    const select = $('#tag-model-select');
    if (!select) return;

    try {
        const result = await API.getTaggerModels();
        const models = Array.isArray(result.models) ? result.models : [];
        const defaultModel = normalizeTaggerModelName(result.default, 'wd-swinv2-tagger-v3');
        const currentValue = normalizeTaggerModelName(select.value, defaultModel);
        _taggerModelCatalog = models;
        _taggerModelCatalogMap = new Map(
            models
                .filter((model) => model?.name)
                .map((model) => [normalizeTaggerModelName(model.name, defaultModel), model])
        );

        const options = models.map((model) => {
            const name = model.name || model.path || 'unknown-model';
            const bestFor = model.best_for ? ` - ${model.best_for}` : '';
            const recommended = model.recommended ? ' (Recommended)' : '';
            const disabled = model.disabled ? ' (Unavailable)' : '';
            const disabledAttr = model.disabled ? ' disabled aria-disabled="true"' : '';
            const title = model.disabled && model.disabled_reason
                ? `${name}${bestFor} - ${model.disabled_reason}`
                : `${name}${bestFor}`;
            return `<option value="${escapeHtml(name)}" title="${escapeHtml(title)}"${disabledAttr}>${escapeHtml(name)}${recommended}${disabled}</option>`;
        });
        options.push('<option value="custom">Custom Local Model...</option>');

        select.innerHTML = options.join('');
        select.value = models.some((model) => model.name === currentValue)
            ? currentValue
            : defaultModel;
        select.dispatchEvent(new Event('change'));
    } catch (error) {
        Logger.warn('Failed to load tagger models list:', error);
        syncTaggerModelUi({ applyModelDefaults: false });
    }
}

async function exportTagLibraryJson() {
    try {
        const data = await API.exportAllTags();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `sd-image-sorter-tags-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Tags exported', 'success');
    } catch (error) {
        showToast(formatUserError(error, 'Failed to export tags'), 'error');
    }
}

async function startTagging() {
    const t = (key, fallback) => window.I18n?.t?.(key) || fallback;
    const threshold = parseFloat($('#tag-threshold')?.value) || 0.35;
    const characterThreshold = parseFloat($('#tag-character-threshold')?.value) || 0.85;
    const modelSelectRaw = $('#tag-model-select')?.value || '';
    const modelSelect = normalizeTaggerModelName(
        modelSelectRaw,
        'wd-swinv2-tagger-v3'
    );
    const isCustomModel = modelSelectRaw === 'custom';
    const modelMeta = getTaggerModelMeta(modelSelect);
    if (!isCustomModel && modelMeta?.disabled) {
        showToast(modelMeta.disabled_reason || 'This tagger model is not available in the current build.', 'warning');
        return;
    }
    const useGpuCheckbox = $('#tag-use-gpu');
    const gpuLocked = isGpuLockedTaggerModel(modelSelect, { isCustom: isCustomModel });

    const options = {
        threshold,
        characterThreshold,
        allowUnsafeAcceleration: false
    };

    // Handle custom model
    if (isCustomModel) {
        const modelPath = $('#tag-model-path')?.value?.trim() || '';
        const tagsPath = $('#tag-tags-path')?.value?.trim() || '';

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
    options.useGpu = useGpuCheckbox?.checked ?? true;

    // Advanced runtime chunk size now maps to the backend's true WD14 batch size
    // where the selected model supports dynamic batching.
    const batchSelect = document.getElementById('tagger-batch-size');
    options.batchSize = batchSelect
        ? Math.min(128, parseInt(batchSelect.value, 10) || getRecommendedTaggerChunkSize())
        : Math.min(128, getRecommendedTaggerChunkSize());

    if (gpuLocked) {
        options.useGpu = false;
        options.allowUnsafeAcceleration = false;
        if (useGpuCheckbox) {
            useGpuCheckbox.checked = false;
        }
        syncTaggerModelUi({ applyModelDefaults: false });
    } else if (requiresTaggerGpuLaunchConfirmation(modelSelect, { isCustom: isCustomModel, useGpu: options.useGpu })) {
        const continueWithGpu = await confirmUnsafeTaggerGpuRun(modelSelectRaw || modelSelect, modelMeta);
        if (continueWithGpu) {
            options.allowUnsafeAcceleration = true;
        } else {
            options.useGpu = false;
            if (useGpuCheckbox) {
                useGpuCheckbox.checked = false;
            }
            syncTaggerModelUi({ applyModelDefaults: false });
            showToast('Switched to CPU Safe Mode for a more stable tagging run.', 'warning');
        }
    }

    try {
        await API.startTagging(options);

        // UI-03: Reset timing state when starting new tagging
        _tagStartTime = null;
        _tagProgressHistory = [];
        _tagPollingActive = true;
        clearTagProgressTimer();

        $('#tag-progress-container').style.display = 'block';
        $('#tag-progress-fill').style.width = '0%';
        $('#tag-progress-text').textContent = gpuLocked
            ? t('tag.preparingMaxQuality', 'Preparing Max Quality model in protected CPU Safe Mode...')
            : (options.useGpu
                ? t('tag.preparingGpu', 'Preparing model on GPU...')
                : t('tag.preparingCpu', 'Preparing model on CPU...'));
        setTaggingUiState(true);

        pollTagProgress();
    } catch (error) {
        _tagPollingActive = false;
        clearTagProgressTimer();
        showToast(formatUserError(error, "Failed to start tagging"), "error");
    }
}

async function cancelTagging() {
    // Use local _tagPollingActive flag — no async race with the server
    if (!_tagPollingActive) {
        hideModal('tag-modal');
        _hideBgTagProgress();
        return;
    }

    // Tagging is in progress — minimize to background, not cancel.
    hideModal('tag-modal');

    // Show the bg progress bar immediately, copying text from the modal progress
    const bar = $('#bg-tag-progress');
    if (bar) {
        bar.style.display = 'flex';
        const textEl = $('#bg-tag-progress-text');
        if (textEl) {
            const modalText = $('#tag-progress-text')?.textContent;
            textEl.textContent = modalText || tText('tagger.progressPreparing', 'Preparing tagger...');
        }
    }

    showToast(tText('tagger.minimizedToBackground', 'Tagging continues in the background. Use the progress bar to stop or check details.'), 'info');
}

// UI-03: Track tagging progress timing for ETA estimation
let _tagStartTime = null;
let _tagProgressHistory = [];

async function pollTagProgress() {
    if (!_tagPollingActive) return;

    try {
        const progress = await API.getTagProgress();

        // UI-03: Improved progress display with ETA
        const current = (progress.processed ?? progress.current ?? 0);
        const total = progress.total || 0;
        const percent = total > 0 ? (current / total) * 100 : 0;
        const tagged = Number(progress.tagged || 0);
        const errors = Number(progress.errors || 0);

        $('#tag-progress-fill').style.width = percent + '%';

        // Build progress text with phase awareness and ETA
        const errorSuffix = errors > 0
            ? tText('tagger.progressErrorSuffix', ', {errors} failed').replace('{errors}', errors)
            : '';
        let progressText = progress.message || tText('tagger.progressPreparing', 'Preparing tagger...');

        if (total > 0 && current > 0) {
            // Initialize start time on first progress
            if (!_tagStartTime) {
                _tagStartTime = Date.now();
                _tagProgressHistory = [];
            }

            // Track progress for ETA calculation
            _tagProgressHistory.push({ time: Date.now(), current, total });

            // Keep only last 10 data points for smoother ETA
            if (_tagProgressHistory.length > 10) {
                _tagProgressHistory.shift();
            }

            // Calculate ETA if we have enough data points
            if (_tagProgressHistory.length >= 3) {
                const first = _tagProgressHistory[0];
                const last = _tagProgressHistory[_tagProgressHistory.length - 1];
                const elapsedMs = last.time - first.time;
                const processedInWindow = last.current - first.current;
                const remaining = total - current;

                if (processedInWindow > 0 && elapsedMs > 0) {
                    const rate = processedInWindow / (elapsedMs / 1000); // items per second
                    if (rate > 0) {
                        const etaSeconds = remaining / rate;
                        const etaMinutes = Math.floor(etaSeconds / 60);
                        const etaSecs = Math.floor(etaSeconds % 60);

                        // Format ETA string
                        const etaStr = etaMinutes > 0 ? `${etaMinutes}m ${etaSecs}s` : `${etaSecs}s`;

                        // Update progress text with ETA
                        progressText = tText('tagger.progressTagging', '{current}/{total} ({tagged} tagged{errorSuffix}, ~{eta} remaining)')
                            .replace('{current}', current)
                            .replace('{total}', total)
                            .replace('{tagged}', tagged)
                            .replace('{errorSuffix}', errorSuffix)
                            .replace('{eta}', etaStr);
                    } else {
                        progressText = tText('tagger.progressTaggingNoEta', '{current}/{total} ({tagged} tagged{errorSuffix})')
                            .replace('{current}', current)
                            .replace('{total}', total)
                            .replace('{tagged}', tagged)
                            .replace('{errorSuffix}', errorSuffix);
                    }
                } else {
                    progressText = tText('tagger.progressTaggingNoEta', '{current}/{total} ({tagged} tagged{errorSuffix})')
                        .replace('{current}', current)
                        .replace('{total}', total)
                        .replace('{tagged}', tagged)
                        .replace('{errorSuffix}', errorSuffix);
                }
            } else {
                // Early progress: show message + counts while ETA is being calculated
                progressText = tText('tagger.progressTaggingNoEta', '{current}/{total} ({tagged} tagged{errorSuffix})')
                    .replace('{current}', current)
                    .replace('{total}', total)
                    .replace('{tagged}', tagged)
                    .replace('{errorSuffix}', errorSuffix);
            }
        }
        // When total === 0 or current === 0, we are still in "loading model" phase.
        // The backend sends a message like "Preparing tagger..." during model load.
        // progressText already holds progress.message from above, which is the correct phase text.

        if (progress.status === 'cancelling') {
            progressText = progress.message || tText('tagger.progressCancelling', 'Cancelling... {current}/{total}')
                .replace('{current}', current)
                .replace('{total}', Math.max(total, current));
        }

        $('#tag-progress-text').textContent = progressText;

        // Update background progress bar (always, even if modal is closed)
        _updateBgTagProgress(percent, progressText, progress.status);

        if (progress.status === 'done') {
            _tagPollingActive = false;
            clearTagProgressTimer();
            _hideBgTagProgress();
            _showCompletionFlash();
            showToast(progress.message, errors > 0 ? 'warning' : 'success');
            hideModal('tag-modal');
            $('#tag-progress-container').style.display = 'none';
            setTaggingUiState(false);
            promptsLibraryCache = null; // Invalidate cache after tagging
            // Reset timing state
            _tagStartTime = null;
            _tagProgressHistory = [];
            loadImages();
            loadStats();
        } else if (progress.status === 'cancelled') {
            _tagPollingActive = false;
            clearTagProgressTimer();
            _hideBgTagProgress();
            showToast(progress.message || tText('tagger.progressCancelled', 'Tagging cancelled'), 'info');
            $('#tag-progress-container').style.display = 'none';
            setTaggingUiState(false);
            _tagStartTime = null;
            _tagProgressHistory = [];
        } else if (progress.status === 'running') {
            scheduleTagProgressPoll(500);
        } else if (progress.status === 'cancelling') {
            scheduleTagProgressPoll(300);
        } else if (progress.status === 'error') {
            _tagPollingActive = false;
            clearTagProgressTimer();
            _hideBgTagProgress();
            showToast(progress.message, 'error');
            $('#tag-progress-container').style.display = 'none';
            setTaggingUiState(false);
            // Reset timing state
            _tagStartTime = null;
            _tagProgressHistory = [];
        } else {
            scheduleTagProgressPoll(500);
        }
    } catch (error) {
        _tagPollingActive = false;
        clearTagProgressTimer();
        _hideBgTagProgress();
        showToast(tText('tagger.errorCheckingProgress', 'Error checking tag progress'), 'error');
        $('#tag-progress-container').style.display = 'none';
        setTaggingUiState(false);
        // Reset timing state on error
        _tagStartTime = null;
        _tagProgressHistory = [];
    }
}

// ============== Background Tagging Progress Bar ==============

function _updateBgTagProgress(percent, text, status) {
    const bar = $('#bg-tag-progress');
    if (!bar) return;
    if (!_tagPollingActive || status === 'idle' || status === 'done') {
        bar.style.display = 'none';
        return;
    }
    // Show bg bar only when the tag modal is NOT visible (avoid doubling)
    const tagModal = $('#tag-modal');
    const modalOpen = tagModal && tagModal.classList.contains('visible');
    bar.style.display = modalOpen ? 'none' : 'flex';
    const fill = $('#bg-tag-progress-fill');
    const textEl = $('#bg-tag-progress-text');
    if (fill) fill.style.width = percent + '%';
    if (textEl) textEl.textContent = text;
}

function _hideBgTagProgress() {
    const bar = $('#bg-tag-progress');
    if (bar) bar.style.display = 'none';
}

function _showCompletionFlash() {
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:rgba(34,197,94,0.08);pointer-events:none;z-index:9999;animation:completionFlash 600ms ease-out forwards;';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 700);
}

function _initBgTagProgressButtons() {
    const cancelBtn = $('#bg-tag-cancel');
    const openBtn = $('#bg-tag-open');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            try {
                await API.cancelTagging();
                showToast(tText('tagger.cancellingAfterCurrent', 'Cancelling after current image...'), 'info');
            } catch (err) {
                showToast(formatUserError(err, 'Failed to cancel'), 'error');
            }
        });
    }
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            showModal('tag-modal');
        });
    }
}

async function resumeTaggingProgress() {
    try {
        const progress = await API.getTagProgress();
        if (!['running', 'cancelling'].includes(progress?.status)) {
            _hideBgTagProgress();
            return;
        }

        _tagPollingActive = true;
        clearTagProgressTimer();
        $('#tag-progress-container').style.display = 'block';
        $('#tag-progress-text').textContent = progress.message || tText('tagger.progressResuming', 'Resuming tagging progress...');
        setTaggingUiState(true, { idleLabel: 'Close' });
        // Show background progress bar (tag modal may not be open)
        const current = progress.processed || progress.current || 0;
        const total = progress.total || 0;
        const percent = total > 0 ? (current / total) * 100 : 0;
        _updateBgTagProgress(percent, progress.message || 'Resuming...', progress.status);
        pollTagProgress();
    } catch (error) {
        Logger.warn('Failed to resume tagging progress:', error);
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
        Logger.error('Failed to load stats:', error);
    }
}

// ============== Image Loading ==============

const IMAGE_LOAD_KEY = 'images-load';

// Generate skeleton items for loading state
function generateSkeletonItems(count = 20) {
    const fragment = document.createDocumentFragment();

    // Use SkeletonGallery if available for better integration
    if (window.Skeleton && window.SkeletonGallery) {
        for (let i = 0; i < count; i++) {
            fragment.appendChild(window.Skeleton.galleryItem());
        }
        return fragment;
    }

    // Fallback implementation
    for (let i = 0; i < count; i++) {
        const item = document.createElement('div');
        item.className = 'gallery-item skeleton-item';
        item.innerHTML = `
            <div class="skeleton-image"></div>
            <div class="skeleton-overlay">
                <div class="skeleton-badge skeleton"></div>
            </div>
        `;
        fragment.appendChild(item);
    }
    return fragment;
}

async function loadImages(appendMode = false) {
    // Cancel any pending image load request
    RequestManager.cancel(IMAGE_LOAD_KEY);

    const galleryGrid = $('#gallery-grid');

    if (!appendMode) {
        AppState.pagination.cursor = null;
        AppState.pagination.offset = 0;
        AppState.pagination.hasMore = true;
        AppState.images = [];

        if (galleryGrid) {
            galleryGrid.innerHTML = '';
            galleryGrid.appendChild(generateSkeletonItems(20));
        }
    }

    AppState.isLoading = true;
    const galleryLoading = $('#gallery-loading');
    if (galleryLoading) galleryLoading.style.display = 'flex';
    const imageCount = $('#image-count');
    if (imageCount && !appendMode) imageCount.textContent = 'Loading...';

    try {
        const controller = RequestManager.createAbortController(IMAGE_LOAD_KEY);
        const useCursorPagination = supportsCursorPagination(AppState.filters.sortBy);
        const filters = {
            ...AppState.filters,
            limit: AppState.pagination.pageSize,
            cursor: appendMode && useCursorPagination ? AppState.pagination.cursor : null,
            offset: appendMode && !useCursorPagination ? AppState.pagination.offset : undefined
        };
        const result = await API.getImages(filters, { signal: controller.signal });
        RequestManager.complete(IMAGE_LOAD_KEY);

        if (result === null) return;

        // Update pagination
        AppState.pagination.cursor = result.next_cursor;
        AppState.pagination.hasMore = result.has_more;
        AppState.pagination.total = result.total;

        if (appendMode) {
            AppState.images = [...AppState.images, ...result.images];
        } else {
            AppState.images = result.images;
        }

        AppState.pagination.offset = Number.isFinite(result.next_offset)
            ? result.next_offset
            : AppState.images.length;

        if (imageCount) {
            imageCount.textContent = `${AppState.pagination.total || AppState.images.length} images`;
        }

        // Clean stale selections on fresh load
        if (AppState.selectedIds && AppState.selectedIds.size > 0 && !appendMode) {
            const validIds = new Set(AppState.images.map(img => img.id));
            const staleIds = [...AppState.selectedIds].filter(id => !validIds.has(id));
            if (staleIds.length > 0) {
                staleIds.forEach(id => AppState.selectedIds.delete(id));
                if (typeof updateSelectionUI === 'function') updateSelectionUI();
            }
        }

        if (!appendMode) tagsLibraryCache = null;

        if (window.Gallery) {
            if (appendMode) {
                Gallery.appendImages(result.images);
            } else {
                Gallery.setImages(AppState.images);
            }
        }

        const emptyState = $('#gallery-empty-state');
        if (emptyState) {
            emptyState.style.display = AppState.images.length === 0 ? 'flex' : 'none';
        }
    } catch (error) {
        if (error.name === 'AbortError' || error.cancelled) {
            return;
        }
        showToast(formatUserError(error, "Failed to load images"), "error");
    } finally {
        AppState.isLoading = false;
        $('#gallery-loading').style.display = 'none';

        // Show/hide "Load More" button based on pagination state
        const loadMoreContainer = $('#gallery-load-more');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = AppState.pagination.hasMore ? 'flex' : 'none';
        }

        requestAnimationFrame(() => {
            attachGalleryPaginationListener();
            _onGalleryScroll();
        });
    }
}

// Load next page of images
function loadMoreImages() {
    if (AppState.isLoading || !AppState.pagination.hasMore) return;
    loadImages(true);
}

// Scroll-based infinite scroll — uses gallery grid bottom position for reliable detection
let _scrollLoadTimer = null;
let _galleryScrollContainer = null;
let _galleryScrollTarget = null;

function _isViewportScrollContainer(scrollContainer) {
    return Boolean(
        scrollContainer &&
        (
            scrollContainer === document.documentElement ||
            scrollContainer === document.body ||
            scrollContainer === document.scrollingElement
        )
    );
}

function _getGalleryScrollContainer() {
    if (window.Gallery && typeof window.Gallery._getScrollContainer === 'function') {
        return window.Gallery._getScrollContainer();
    }

    return document.scrollingElement || document.documentElement;
}

function _resolveGalleryScrollTarget(scrollContainer) {
    return _isViewportScrollContainer(scrollContainer) ? window : scrollContainer;
}

function detachGalleryPaginationListener() {
    if (_galleryScrollTarget) {
        _galleryScrollTarget.removeEventListener('scroll', _onGalleryScroll);
    }
    _galleryScrollTarget = null;
    _galleryScrollContainer = null;
}

function attachGalleryPaginationListener() {
    const scrollContainer = _getGalleryScrollContainer();
    if (!scrollContainer) return;

    const scrollTarget = _resolveGalleryScrollTarget(scrollContainer);
    if (_galleryScrollTarget === scrollTarget && _galleryScrollContainer === scrollContainer) {
        return;
    }

    detachGalleryPaginationListener();
    _galleryScrollContainer = scrollContainer;
    _galleryScrollTarget = scrollTarget;
    _galleryScrollTarget.addEventListener('scroll', _onGalleryScroll, { passive: true });
}

function _onGalleryScroll() {
    if (_scrollLoadTimer) return;
    _scrollLoadTimer = requestAnimationFrame(() => {
        _scrollLoadTimer = null;
        if (AppState.currentView !== 'gallery') return;
        if (AppState.isLoading || !AppState.pagination.hasMore) return;

        // Use the gallery grid's actual bottom position for reliable detection
        // getBoundingClientRect is always correct regardless of flex/grid layout
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        const scrollContainer = _galleryScrollContainer || _getGalleryScrollContainer();
        const viewportBottom = _isViewportScrollContainer(scrollContainer)
            ? window.innerHeight
            : scrollContainer.getBoundingClientRect().bottom;
        const gridBottom = grid.getBoundingClientRect().bottom;
        if (gridBottom <= viewportBottom + 800) {
            loadMoreImages();
        }
    });
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
        const safeValue = escapeHtml(value);

        return `
            <div class="model-select-item ${isSelected ? 'selected' : ''}" data-value="${safeValue}">
                <div class="checkbox-custom" style="background: ${isSelected ? 'var(--accent-primary)' : 'transparent'}; border-color: ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}">
                    ${isSelected ? '✓' : ''}
                </div>
                <div class="item-text" title="${safeValue}">${safeValue}</div>
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
    const searchInput = $('#library-search');
    if (searchInput) {
        searchInput.value = '';
    }
    showModal('tags-library-modal');
    loadLibraryContent();
}

function switchLibraryTab(tab) {
    libraryData.currentTab = tab;
    const searchInput = $('#library-search');
    if (searchInput) {
        searchInput.value = '';
    }
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
    const isTagsTab = libraryData.currentTab === 'tags';
    const t = (key, params, fallback) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };
    const loadingLabel = isTagsTab
        ? t('library.loadingTags', null, 'Loading tag library…')
        : t('library.loadingPrompts', null, 'Loading prompt library…');

    content.innerHTML = `
        <div class="library-status">
            <div class="spinner" aria-hidden="true"></div>
            <p>${loadingLabel}</p>
        </div>
    `;
    if (statsText) {
        statsText.textContent = window.I18n?.t?.('library.loading') || loadingLabel;
    }

    try {
        if (isTagsTab) {
            const result = await API.getTagsLibrary(sortBy, 2000);
            libraryData.tags = result.tags;
            renderLibraryTags(result.tags);
            if (statsText) {
                statsText.textContent = t('library.tagsFound', { count: result.total }, `${result.total} unique tags found`);
            }
        } else {
            const result = await API.getPromptsLibrary(10000);
            libraryData.prompts = result.prompts;
            renderLibraryPrompts(result.prompts);
            if (statsText) {
                statsText.textContent = t('library.promptsFound', { count: result.total }, `${result.total} unique prompts found`);
            }
        }
    } catch (error) {
        const fallbackMessage = isTagsTab
            ? t('library.loadTagsFailed', null, 'Failed to load tag library')
            : t('library.loadPromptsFailed', null, 'Failed to load prompt library');
        const message = escapeHtml(formatUserError(error, fallbackMessage));
        content.innerHTML = `
            <div class="library-status library-status-error">
                <strong>${fallbackMessage}</strong>
                <p>${message}</p>
            </div>
        `;
        if (statsText) {
            statsText.textContent = message;
        }
        Logger.error('Library load error:', error);
    }
}

function renderLibraryTags(tags) {
    const content = $('#library-content');
    content.style.flexDirection = 'row';
    if (!tags || tags.length === 0) {
        content.innerHTML = '<p class="empty-state-text" style="width:100%;text-align:center;padding:32px;color:var(--text-muted)">No tags found. Scan a folder and run Tag Images first.</p>';
        return;
    }
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
                AppState.filters.tags = [...AppState.filters.tags, tag];
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
    if (!prompts || prompts.length === 0) {
        content.innerHTML = '<p class="empty-state-text" style="width:100%;text-align:center;padding:32px;color:var(--text-muted)">No prompts found. Scan a folder with images first.</p>';
        return;
    }
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
                AppState.filters.prompts = [...AppState.filters.prompts, prompt];
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
    const panel = $('#selection-actions');
    const countEl = $('#selection-count');
    const grid = $('#gallery-grid');
    const hasSelection = AppState.selectedIds.size > 0;
    const selectionPanelVisible = AppState.selectionMode && AppState.currentView === 'gallery';
    const canRunBatchActions = selectionPanelVisible && hasSelection;
    const buttonIds = [
        'btn-export-selected',
        'btn-export-tags-selected',
        'btn-batch-export-tags',
        'btn-send-to-censor'
    ];

    syncSelectionModeButton();

    if (grid) {
        grid.classList.toggle('selection-mode', !!AppState.selectionMode);
    }

    const selectAllBtn = $('#btn-select-all');
    if (selectAllBtn) {
        selectAllBtn.disabled = !selectionPanelVisible || AppState.images.length === 0;
    }

    const clearSelectionBtn = $('#btn-clear-selection');
    if (clearSelectionBtn) {
        clearSelectionBtn.disabled = !selectionPanelVisible || !hasSelection;
    }

    buttonIds.forEach((id) => {
        const button = document.getElementById(id);
        if (button) {
            button.disabled = !canRunBatchActions;
        }
    });

    if (selectionPanelVisible && panel) {
        panel.style.display = 'grid';
        if (countEl) {
            countEl.textContent = hasSelection
                ? (window.I18n?.t?.('selection.count', { count: AppState.selectedIds.size }) || `${AppState.selectedIds.size} items selected`)
                : (window.I18n?.t?.('selection.emptyHint') || 'Selection mode is on. Pick images or use Select All.');
        }
        requestAnimationFrame(() => ensureSelectionPanelVisible(panel));
    } else if (panel) {
        panel.style.display = 'none';
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
    okBtn.addEventListener('click', () => {
        hideModal('confirm-modal');
        if (onOk) onOk();
    }, { signal });

    // Handle cancel callback if provided
    const cancelBtn = $('#btn-confirm-cancel');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
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
                <div class="analytics-item clickable" data-type="tag" data-value="${escapeHtml(t.tag)}">
                    <span class="item-name">${escapeHtml(t.tag)}</span>
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
        showToast(formatUserError(e, "Failed to load analytics"), "error");
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
            AppState.filters.tags = [...AppState.filters.tags, value];
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
    const exportAltBtn = $('#btn-export-tags-alt');
    if (exportAltBtn) exportAltBtn.innerHTML = '🏷️ Export Tags Instead';
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
    const exportAltBtn = $('#btn-export-tags-alt');
    if (exportAltBtn) exportAltBtn.innerHTML = '📤 Export Prompts Instead';
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
    const outputFolder = $('#batch-export-folder')?.value?.trim() || '';
    if (!outputFolder) {
        showToast('Please enter an output folder', 'error');
        return;
    }

    const prefix = $('#batch-export-prefix')?.value || '';
    const blacklistText = $('#batch-export-blacklist')?.value || '';
    const blacklist = blacklistText ? blacklistText.split(',').map(t => t.trim()).filter(t => t) : [];

    const imageIds = Array.from(AppState.selectedIds);

    // Show progress
    const progressEl = $('#batch-export-progress');
    const progressFill = $('#batch-export-progress-fill');
    const progressText = $('#batch-export-progress-text');
    const startBtn = $('#btn-start-batch-export');
    if (progressEl) progressEl.style.display = 'block';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = 'Exporting...';
    if (startBtn) startBtn.disabled = true;

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
        showToast(formatUserError(e, "Export failed"), "error");
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
        AppState.filters.tags = [...AppState.filters.tags, tag];
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
    // Show skeleton while loading
    if (window.SkeletonFilterModal) {
        window.SkeletonFilterModal.show('filter-modal');
    }

    // Sync modal state with current AppState
    $$('#modal-generator-filters input').forEach(cb => {
        cb.checked = AppState.filters.generators.includes(cb.value);
    });
    $$('#modal-rating-filters input').forEach(cb => {
        cb.checked = AppState.filters.ratings.includes(cb.value);
    });
    const minWidthInput = $('#filter-min-width');
    const maxWidthInput = $('#filter-max-width');
    const minHeightInput = $('#filter-min-height');
    const maxHeightInput = $('#filter-max-height');
    if (minWidthInput) minWidthInput.value = AppState.filters.minWidth ?? '';
    if (maxWidthInput) maxWidthInput.value = AppState.filters.maxWidth ?? '';
    if (minHeightInput) minHeightInput.value = AppState.filters.minHeight ?? '';
    if (maxHeightInput) maxHeightInput.value = AppState.filters.maxHeight ?? '';
    $$('input[name="aspect-ratio"]').forEach(radio => {
        radio.checked = radio.value === (AppState.filters.aspectRatio || '');
    });
    // Don't prefill prompt search bar with AppState.filters.search —
    // the prompt search is for adding prompt filters, not for text search
    $('#modal-prompt-search').value = '';
    const modalTagSearch = $('#modal-tag-search');
    const modalTagSuggestions = $('#modal-tag-suggestions');
    const modalPromptSuggestions = $('#modal-prompt-suggestions');
    if (modalTagSearch) modalTagSearch.value = '';
    if (modalTagSuggestions) {
        modalTagSuggestions.innerHTML = '';
        modalTagSuggestions.classList.remove('visible');
    }
    if (modalPromptSuggestions) {
        modalPromptSuggestions.innerHTML = '';
        modalPromptSuggestions.classList.remove('visible');
    }

    // Show active tags and prompts
    renderModalActiveTags();
    renderModalActivePrompts();

    // Load checkpoints and loras into modal lists
    await loadModalFilterLists();
    updateFilterModalSummary();

    // Hide skeleton after loading
    if (window.SkeletonFilterModal) {
        window.SkeletonFilterModal.hide('filter-modal');
    }

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

    updateFilterModalSummary();
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

    updateFilterModalSummary();
}

async function loadModalFilterLists() {
    const cpList = $('#modal-checkpoint-list');
    const loraList = $('#modal-lora-list');
    const t = (key, params, fallback) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };

    // Show skeleton while loading
    if (window.Skeleton) {
        const skeletonHTML = `
            <div class="skeleton skeleton-filter-option"></div>
            <div class="skeleton skeleton-filter-option"></div>
            <div class="skeleton skeleton-filter-option"></div>
            <div class="skeleton skeleton-filter-option"></div>
            <div class="skeleton skeleton-filter-option"></div>
        `;
        if (cpList) cpList.innerHTML = skeletonHTML;
        if (loraList) loraList.innerHTML = skeletonHTML;
    }

    try {
        // Use cached analytics data if available, otherwise fetch from API
        const data = AppState.analytics || await API.getStats();

        // Render checkpoints
        if (cpList) {
            cpList.innerHTML = (data.checkpoints || []).length > 0 ? (data.checkpoints || []).map(cp => `
                <label class="checkbox-label">
                    <input type="checkbox" value="${escapeHtml(cp.checkpoint)}" ${AppState.filters.checkpoints?.includes(cp.checkpoint) ? 'checked' : ''}>
                    <span class="checkbox-custom"></span>
                    <span class="checkbox-text">${escapeHtml(cp.checkpoint)}</span>
                    <span class="checkbox-count">${cp.count}</span>
                </label>
            `).join('') : `<div class="filter-empty-state">${escapeHtml(t('filter.noCheckpoints', null, 'No checkpoints found yet.'))}</div>`;
        }

        // Render loras
        if (loraList) {
            loraList.innerHTML = (data.loras || []).length > 0 ? (data.loras || []).map(l => `
                <label class="checkbox-label">
                    <input type="checkbox" value="${escapeHtml(l.lora)}" ${AppState.filters.loras?.includes(l.lora) ? 'checked' : ''}>
                    <span class="checkbox-custom"></span>
                    <span class="checkbox-text">${escapeHtml(l.lora)}</span>
                    <span class="checkbox-count">${l.count}</span>
                </label>
            `).join('') : `<div class="filter-empty-state">${escapeHtml(t('filter.noLoras', null, 'No LoRAs found yet.'))}</div>`;
        }

        updateFilterModalSummary();
    } catch (e) {
        Logger.error('Failed to load filter lists:', e);
        // Show error state in lists
        if (cpList) cpList.innerHTML = `<div class="filter-empty-state">${escapeHtml(t('filter.failedLoadCheckpoints', null, 'Failed to load checkpoints.'))}</div>`;
        if (loraList) loraList.innerHTML = `<div class="filter-empty-state">${escapeHtml(t('filter.failedLoadLoras', null, 'Failed to load LoRAs.'))}</div>`;
        updateFilterModalSummary();
    }
}

function updateFilterModalSummary() {
    const selectionSummary = $('#filter-modal-selection-summary');
    const summaryHint = $('#filter-modal-summary-hint');
    const t = (key, params, fallback) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };

    const countChecked = (selector, fallback = 0) => {
        const matches = $$(selector);
        return matches.length > 0 ? matches.length : fallback;
    };
    const setCount = (id, value) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    };

    const generatorTotal = Math.max(1, $$('#modal-generator-filters input').length || 5);
    const ratingTotal = Math.max(1, $$('#modal-rating-filters input').length || 4);
    const generatorCount = countChecked('#modal-generator-filters input:checked', AppState.filters.generators?.length || generatorTotal);
    const ratingCount = countChecked('#modal-rating-filters input:checked', AppState.filters.ratings?.length || ratingTotal);
    const checkpointCount = countChecked('#modal-checkpoint-list input:checked', AppState.filters.checkpoints?.length || 0);
    const loraCount = countChecked('#modal-lora-list input:checked', AppState.filters.loras?.length || 0);
    const tagCount = AppState.filters.tags?.length || 0;
    const promptCount = AppState.filters.prompts?.length || 0;
    const minWidth = parseInt($('#filter-min-width')?.value, 10) || null;
    const maxWidth = parseInt($('#filter-max-width')?.value, 10) || null;
    const minHeight = parseInt($('#filter-min-height')?.value, 10) || null;
    const maxHeight = parseInt($('#filter-max-height')?.value, 10) || null;
    const aspectRatio = $('input[name="aspect-ratio"]:checked')?.value || '';
    const dimensionCount = [minWidth, maxWidth, minHeight, maxHeight].filter(Boolean).length + (aspectRatio ? 1 : 0);

    setCount('filter-modal-count-generators', `${generatorCount}/${generatorTotal}`);
    setCount('filter-modal-count-ratings', `${ratingCount}/${ratingTotal}`);
    setCount('filter-modal-count-tags', String(tagCount));
    setCount('filter-modal-count-prompts', String(promptCount));
    setCount('filter-modal-count-checkpoints', String(checkpointCount));
    setCount('filter-modal-count-loras', String(loraCount));
    setCount('filter-modal-count-dimensions', dimensionCount > 0 ? String(dimensionCount) : t('filter.any', null, 'Any'));

    const activeGroupCount = [
        generatorCount !== generatorTotal,
        ratingCount !== ratingTotal,
        tagCount > 0,
        promptCount > 0,
        checkpointCount > 0,
        loraCount > 0,
        dimensionCount > 0
    ].filter(Boolean).length;

    if (selectionSummary) {
        selectionSummary.textContent = activeGroupCount > 0
            ? t('filter.summaryReady', { count: activeGroupCount }, `${activeGroupCount} filter groups are active.`)
            : t('filter.summaryIdle', null, 'No extra limits selected yet. Apply now to keep the current gallery scope.');
    }

    if (summaryHint) {
        summaryHint.textContent = activeGroupCount > 0
            ? t('filter.summaryHintActive', null, 'Tip: start broad, then add tags or prompts before tightening size, checkpoint, or LoRA filters.')
            : t('filter.summaryHintIdle', null, 'Tip: use tags, prompts, or dimensions when you want a smaller and more targeted result list.');
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
                    AppState.filters.tags = [...AppState.filters.tags, el.dataset.tag];
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
let promptsLibraryCacheTime = 0;
const PROMPTS_CACHE_TTL = 30000; // 30 seconds
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
        // Cache the prompts library for better performance (with TTL)
        const now = Date.now();
        if (!promptsLibraryCache || (now - promptsLibraryCacheTime) > PROMPTS_CACHE_TTL) {
            const result = await API.getPromptsLibrary(5000);
            promptsLibraryCache = result.prompts || [];
            promptsLibraryCacheTime = now;
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
                    AppState.filters.prompts = [...AppState.filters.prompts, prompt];
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
    const promptSearch = $('#modal-prompt-search');
    if (promptSearch) promptSearch.value = '';

    // Get dimension filters
    const minWidth = parseInt($('#filter-min-width')?.value, 10) || null;
    const maxWidth = parseInt($('#filter-max-width')?.value, 10) || null;
    const minHeight = parseInt($('#filter-min-height')?.value, 10) || null;
    const maxHeight = parseInt($('#filter-max-height')?.value, 10) || null;
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
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
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
    const modalPromptSearch = $('#modal-prompt-search');
    if (modalPromptSearch) modalPromptSearch.value = '';
    renderModalActiveTags();
    renderModalActivePrompts();

    // Reset dimension filters
    const filterMinWidth = $('#filter-min-width');
    const filterMaxWidth = $('#filter-max-width');
    const filterMinHeight = $('#filter-min-height');
    const filterMaxHeight = $('#filter-max-height');
    if (filterMinWidth) filterMinWidth.value = '';
    if (filterMaxWidth) filterMaxWidth.value = '';
    if (filterMinHeight) filterMinHeight.value = '';
    if (filterMaxHeight) filterMaxHeight.value = '';
    $$('input[name="aspect-ratio"]').forEach(r => r.checked = r.value === '');
    updateFilterModalSummary();

    // Hide artist filter row
    const artistRow = $('#artist-filter-row');
    if (artistRow) artistRow.style.display = 'none';

    // Update all filter summaries
    updateFilterSummary();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();

    hideModal('filter-modal');
    syncGenTabsWithFilters();
    loadImages();
    showToast('Filters cleared', 'success');
}

// ============== Filter Presets ==============

const FILTER_PRESETS_KEY = 'sd-image-sorter-filter-presets';

function getFilterPresets() {
    try {
        const saved = localStorage.getItem(FILTER_PRESETS_KEY);
        return saved ? JSON.parse(saved) : {};
    } catch (e) {
        return {};
    }
}

function saveFilterPreset(name) {
    if (!name || !name.trim()) {
        showToast('Please enter a preset name', 'error');
        return false;
    }

    const presets = getFilterPresets();
    presets[name.trim()] = {
        generators: AppState.filters.generators,
        ratings: AppState.filters.ratings,
        tags: AppState.filters.tags,
        checkpoints: AppState.filters.checkpoints,
        loras: AppState.filters.loras,
        prompts: AppState.filters.prompts,
        search: AppState.filters.search,
        artist: AppState.filters.artist,
        minWidth: AppState.filters.minWidth,
        maxWidth: AppState.filters.maxWidth,
        minHeight: AppState.filters.minHeight,
        maxHeight: AppState.filters.maxHeight,
        aspectRatio: AppState.filters.aspectRatio
    };

    try {
        localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(presets));
        showToast(`Preset "${name}" saved`, 'success');
        return true;
    } catch (e) {
        showToast('Failed to save preset', 'error');
        return false;
    }
}

function loadFilterPreset(name) {
    const presets = getFilterPresets();
    const preset = presets[name];

    if (!preset) {
        showToast(`Preset "${name}" not found`, 'error');
        return false;
    }

    // Apply preset to filters
    AppState.filters = {
        ...AppState.filters,
        ...preset
    };

    updateFilterSummary();
    syncGenTabsWithFilters();

    // Update modal checkboxes to match
    $$('#modal-generator-filters input').forEach(cb => {
        cb.checked = AppState.filters.generators.includes(cb.value);
    });
    $$('#modal-rating-filters input').forEach(cb => {
        cb.checked = AppState.filters.ratings.includes(cb.value);
    });

    hideModal('filter-modal');
    loadImages();
    showToast(`Preset "${name}" loaded`, 'success');
    return true;
}

function deleteFilterPreset(name) {
    const presets = getFilterPresets();
    if (presets[name]) {
        delete presets[name];
        localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(presets));
        showToast(`Preset "${name}" deleted`, 'success');
        return true;
    }
    return false;
}

function renderFilterPresets() {
    const container = $('#filter-presets-list');
    if (!container) return;

    const presets = getFilterPresets();
    const presetNames = Object.keys(presets);

    if (presetNames.length === 0) {
        container.innerHTML = '<div class="presets-empty">No saved presets</div>';
        return;
    }

    container.innerHTML = presetNames.map(name => {
        const safeName = escapeHtml(name);
        return `
        <div class="preset-item">
            <span class="preset-name">${safeName}</span>
            <div class="preset-actions">
                <button class="btn-small" data-preset-action="load" data-preset-name="${safeName}">Load</button>
                <button class="btn-small btn-danger" data-preset-action="delete" data-preset-name="${safeName}">×</button>
            </div>
        </div>
    `;}).join('');

    container.querySelectorAll('[data-preset-action]').forEach(button => {
        button.addEventListener('click', () => {
            const { presetAction, presetName } = button.dataset;
            if (presetAction === 'load') {
                loadFilterPreset(presetName);
            } else if (presetAction === 'delete' && deleteFilterPreset(presetName)) {
                renderFilterPresets();
            }
        });
    });
}

// Make preset functions globally accessible
window.saveFilterPreset = saveFilterPreset;
window.loadFilterPreset = loadFilterPreset;
window.deleteFilterPreset = deleteFilterPreset;
window.renderFilterPresets = renderFilterPresets;

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

// Save filter state to localStorage
function saveFilterState() {
    try {
        const stateToSave = {
            generators: AppState.filters.generators,
            ratings: AppState.filters.ratings,
            tags: AppState.filters.tags,
            checkpoints: AppState.filters.checkpoints,
            loras: AppState.filters.loras,
            prompts: AppState.filters.prompts,
            search: AppState.filters.search,
            artist: AppState.filters.artist,
            sortBy: AppState.filters.sortBy,
            minWidth: AppState.filters.minWidth,
            maxWidth: AppState.filters.maxWidth,
            minHeight: AppState.filters.minHeight,
            maxHeight: AppState.filters.maxHeight,
            aspectRatio: AppState.filters.aspectRatio
        };
        localStorage.setItem(FILTER_STATE_KEY, JSON.stringify(stateToSave));
    } catch (e) {
        Logger.warn('Failed to save filter state:', e);
    }
}

function updateFilterSummary() {
    // Save filter state whenever summary is updated
    saveFilterState();

    const f = AppState.filters;

    // Use shared filter summary formatter for common fields
    const summary = window.formatFilterSummary(f);

    // Generators
    $('#summary-generators').textContent = summary.generators;

    // Ratings
    $('#summary-ratings').textContent = summary.ratings;

    // Tags
    $('#summary-tags').textContent = summary.tags;

    // Checkpoints
    $('#summary-checkpoints').textContent = summary.checkpoints;

    // Loras
    $('#summary-loras').textContent = summary.loras;

    // Prompt (now uses prompts array)
    const promptSummary = $('#summary-prompt');
    if (promptSummary) {
        promptSummary.textContent = summary.prompts;
    }

    const searchSummary = $('#summary-search');
    if (searchSummary) {
        searchSummary.textContent = summary.search;
    }

    // Artist filter
    const artistRow = $('#artist-filter-row');
    const artistSummary = $('#summary-artist');
    if (artistRow && artistSummary) {
        if (f.artist) {
            artistRow.style.display = 'flex';
            artistSummary.textContent = summary.artist;
        } else {
            artistRow.style.display = 'none';
        }
    }

    // Update mobile filter badge
    if (typeof updateMobileFilterBadge === 'function') {
        updateMobileFilterBadge();
    }
}

// ============== Initialization ==============

// Global keyboard shortcuts for gallery navigation
function initGlobalKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Only handle when not in input/textarea
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        // Only in gallery view
        if (AppState.currentView !== 'gallery') {
            return;
        }

        // G - Toggle grid view
        if (e.key === 'g' || e.key === 'G') {
            e.preventDefault();
            setGalleryViewMode('grid');
            showToast('Grid view', 'info');
        }
        // L - Toggle large view
        else if (e.key === 'l' || e.key === 'L') {
            e.preventDefault();
            setGalleryViewMode('large');
            showToast('Large view', 'info');
        }
        // W - Toggle waterfall view
        else if (e.key === 'w' || e.key === 'W') {
            e.preventDefault();
            setGalleryViewMode('waterfall');
            showToast('Waterfall view', 'info');
        }
        // F - Open filter modal
        else if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            openFilterModal();
        }
        // R - Random image
        else if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            showRandomImage();
        }
        // S - Toggle selection mode
        else if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            setSelectionMode(!AppState.selectionMode);
            showToast(AppState.selectionMode ? 'Selection mode ON' : 'Selection mode OFF', 'info');
        }
        // Escape - Clear selection
        else if (e.key === 'Escape') {
            if (AppState.selectedIds.size > 0) {
                e.preventDefault();
                AppState.selectedIds.clear();
                updateSelectionUI();
                emitSelectionStateChanged();
                if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
                    Gallery.syncSelectionState();
                }
                showToast('Selection cleared', 'info');
            }
        }
        // Delete - Clear gallery (with confirmation)
        else if (e.key === 'Delete') {
            if (AppState.selectedIds.size > 0) {
                e.preventDefault();
                showConfirm(
                    'Clear Selected Images',
                    `Clear ${AppState.selectedIds.size} selected images from gallery?`,
                    () => {
                        AppState.selectedIds.clear();
                        updateSelectionUI();
                        emitSelectionStateChanged();
                        showToast('Selection cleared', 'success');
                    }
                );
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initMissingFilterMarkup();
    initEventListeners();
    initInputModal();
    initGlobalKeyboardShortcuts();
    loadTaggerModels();
    setTaggingUiState(false);
    setGalleryViewMode(AppState.viewMode);
    switchView('gallery');
    loadStats();
    updateFilterSummary();
    updateSelectionUI();
    resumeScanProgress();
    resumeTaggingProgress();
    _initBgTagProgressButtons();

    // Initialize gallery keyboard navigation for accessibility
    if (window.Gallery && typeof window.Gallery.initKeyboardNavigation === 'function') {
        window.Gallery.initKeyboardNavigation();
    }

    // Initialize Censor Edit module so addToCensorQueue is available from Gallery
    // Note: do NOT init here - initCensorEdit is called when user switches to censor view
    // to prevent mousemove/keydown listeners being attached while another view is active

    // Load More button — visible fallback for infinite scroll
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => loadMoreImages());
    }

    // Setup event listeners for buttons that previously had inline onclick
    const returnToGalleryBtn = document.getElementById('return-to-gallery-btn');
    if (returnToGalleryBtn) {
        returnToGalleryBtn.addEventListener('click', () => switchView('gallery'));
    }

    window.addEventListener('resize', _onGalleryScroll, { passive: true });
});

function addToCensorQueue(imageIds = []) {
    const normalizedIds = Array.from(
        new Set(
            (Array.isArray(imageIds) ? imageIds : [imageIds])
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value) && value > 0)
        )
    );

    if (typeof window.initCensorEdit === 'function') {
        window.initCensorEdit();
    }

    const runtimeHandler = window.App?._addToCensorQueue;
    if (typeof runtimeHandler === 'function') {
        return runtimeHandler(normalizedIds);
    }

    switchView('censor');
    return false;
}


function buildAppContext() {
    return {
        API,
        AppState,
        showToast,
        createGuideOverlay,
        copyTextToClipboard,
        showModal,
        hideModal,
        showInputModal,
        showGlobalLoading,
        hideGlobalLoading,
        createProgressTracker,
        resetProgressTracker,
        updateProgressTracker,
        buildProgressText,
        formatDurationCompact,
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
        switchView,
        openGalleryPreview,
        applyPromptFilter,
        addToCensorQueue,
        _addToCensorQueue: null,
        addRecentFolder,
        getRecentFolders,
        $,
        $$
    };
}

// Export for other modules
window.App = buildAppContext();


// ============== Empty State CTA Handlers ==============

// Connect empty state scan button
document.addEventListener('DOMContentLoaded', () => {
    const emptyStateScanBtn = document.getElementById('empty-state-scan-btn');
    if (emptyStateScanBtn) {
        emptyStateScanBtn.addEventListener('click', () => {
            showModal('scan-modal');
        });
    }
});
