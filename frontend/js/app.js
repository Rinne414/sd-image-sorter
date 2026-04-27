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

// i18n helper for app-level dynamic strings.
function appT(key, fallback, params) {
    const val = window.I18n?.t?.(key, params);
    return (val && val !== key) ? val : (fallback || key);
}

function formatGeneratorLabel(generator, fallbackUnknown = 'Unknown') {
    const normalized = String(generator || 'unknown').trim().toLowerCase();
    const keyMap = {
        all: 'generator.all',
        nai: 'generator.nai',
        comfyui: 'generator.comfyui',
        forge: 'generator.forge',
        webui: 'generator.webui',
        unknown: 'generator.unknown'
    };
    const translationKey = keyMap[normalized];
    if (translationKey) {
        return appT(translationKey, normalized === 'unknown' ? fallbackUnknown : normalized);
    }
    return String(generator || appT('generator.unknown', fallbackUnknown));
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
const SCAN_ADVANCED_OPEN_KEY = 'sd-image-sorter-scan-advanced-open';
const TAG_ADVANCED_OPEN_KEY = 'sd-image-sorter-tag-advanced-open';

function readStoredBoolean(storageKey, fallback = false) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (raw == null) return fallback;
        return raw === '1' || raw === 'true';
    } catch (error) {
        return fallback;
    }
}

function writeStoredBoolean(storageKey, value) {
    try {
        localStorage.setItem(storageKey, value ? '1' : '0');
    } catch (error) {
        // Ignore localStorage failures.
    }
}

function getDefaultGalleryPageSize(mode = null) {
    const resolvedMode = mode || localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid';
    const viewportWidth = window.innerWidth || 1600;

    if (resolvedMode === 'large') {
        if (viewportWidth >= 1800) return 220;
        if (viewportWidth >= 1366) return 180;
        return 140;
    }

    if (resolvedMode === 'waterfall') {
        if (viewportWidth >= 1800) return 260;
        if (viewportWidth >= 1366) return 220;
        return 180;
    }

    if (viewportWidth >= 1800) return 420;
    if (viewportWidth >= 1366) return 320;
    return 240;
}

function createDefaultFilterState() {
    return {
        generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
        ratings: ['general', 'sensitive', 'questionable', 'explicit'],
        tags: [],
        checkpoints: [],
        loras: [],
        prompts: [],
        artist: null,
        search: '',
        sortBy: 'newest',
        limit: 0,
        minWidth: null,
        maxWidth: null,
        minHeight: null,
        maxHeight: null,
        aspectRatio: '',
        minAesthetic: null,
        maxAesthetic: null
    };
}

function cloneFilterState(filters) {
    const source = filters || createDefaultFilterState();
    return {
        generators: [...(source.generators || [])],
        ratings: [...(source.ratings || [])],
        tags: [...(source.tags || [])],
        checkpoints: [...(source.checkpoints || [])],
        loras: [...(source.loras || [])],
        prompts: [...(source.prompts || [])],
        artist: source.artist || null,
        search: source.search || '',
        sortBy: source.sortBy || 'newest',
        limit: source.limit || 0,
        minWidth: source.minWidth ?? null,
        maxWidth: source.maxWidth ?? null,
        minHeight: source.minHeight ?? null,
        maxHeight: source.maxHeight ?? null,
        aspectRatio: source.aspectRatio || '',
        minAesthetic: source.minAesthetic ?? null,
        maxAesthetic: source.maxAesthetic ?? null
    };
}

function copyFilterState(target, source) {
    if (!target || !source) return target;
    const next = cloneFilterState(source);
    Object.keys(target).forEach((key) => delete target[key]);
    Object.assign(target, next);
    return target;
}

let FilterModalController = {
    mode: 'gallery',
    workingState: null,
    targetState: null,
    onApply: null,
    onReset: null,
    titleText: null,
    applyButtonText: null,
    resetButtonText: null,
    optionData: null,
};

function getFilterModalState() {
    return FilterModalController.workingState || AppState.filters;
}

function resetFilterModalController() {
    FilterModalController = {
        mode: 'gallery',
        workingState: null,
        targetState: null,
        onApply: null,
        onReset: null,
        titleText: null,
        applyButtonText: null,
        resetButtonText: null,
        optionData: null,
    };
}

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
    filters: savedFilters || createDefaultFilterState(),
    selectedImage: null,
    isLoading: false,
    galleryNeedsRefresh: false,

    // Pagination state
    pagination: {
        cursor: null,
        offset: 0,
        hasMore: true,
        total: 0,
        pageSize: getDefaultGalleryPageSize()
    },

    // Multi-select state
    selectionMode: false,
    selectedIds: new Set(),
    selectionDataCache: {
        key: null,
        data: null
    },

    // Analytics data
    analytics: {
        checkpoints: [],
        loras: [],
        top_tags: []
    },

    update: {
        checking: false,
        status: null,
    },

    // Current modal selection state
    modalSelection: {
        type: null, // 'checkpoint' or 'lora'
        tempSelected: new Set(),
        search: ''
    }
};

// Sort direction pairs: base sort value -> reversed sort value
const SORT_PAIRS = {
    newest: 'oldest',
    name_asc: 'name_desc',
    generator: 'generator_desc',
    prompt_length: 'prompt_length_asc',
    tag_count: 'tag_count_asc',
    rating: 'rating_desc',
    character_count: 'character_count_asc',
    file_size: 'file_size_asc',
    aesthetic: 'aesthetic_asc',
};
// Build full bidirectional reverse map
const SORT_REVERSE_MAP = {};
for (const [a, b] of Object.entries(SORT_PAIRS)) {
    SORT_REVERSE_MAP[a] = b;
    SORT_REVERSE_MAP[b] = a;
}
SORT_REVERSE_MAP.random = 'random';

/** Get the base (non-reversed) sort value for dropdown display */
function getBaseSortValue(sortBy) {
    for (const [base, rev] of Object.entries(SORT_PAIRS)) {
        if (sortBy === rev) return base;
    }
    return sortBy;
}

/** Check if the current sort is in reversed direction */
function isSortReversed(sortBy) {
    return Object.values(SORT_PAIRS).includes(sortBy);
}

/** Sync the sort dropdown and reverse button with current AppState.filters.sortBy */
function updateSortReverseButton() {
    const sortBy = AppState.filters.sortBy;
    const reversed = isSortReversed(sortBy);
    const btn = $('#sort-reverse-btn');
    const dropdown = $('#gallery-sort');
    if (btn) {
        btn.classList.toggle('active', reversed);
        btn.setAttribute('aria-pressed', String(reversed));
    }
    if (dropdown) {
        dropdown.value = getBaseSortValue(sortBy);
    }
}

function syncGallerySortLabels() {
    const dropdown = $('#gallery-sort');
    if (!dropdown) return;

    const mappings = {
        newest: ['sort.newest', 'Newest'],
        name_asc: ['sort.nameAsc', 'Name (A-Z)'],
        generator: ['sort.generator', 'Generator'],
        prompt_length: ['sort.promptLength', 'Prompt Length'],
        tag_count: ['sort.tagCount', 'Most Tags'],
        rating: ['sort.rating', 'Rating (NSFW first)'],
        character_count: ['sort.characterCount', 'Characters'],
        file_size: ['sort.fileSize', 'Largest File'],
        aesthetic: ['sort.aesthetic', 'Aesthetic Score'],
        random: ['sort.random', 'Random'],
    };

    Object.entries(mappings).forEach(([value, [key, fallback]]) => {
        const option = dropdown.querySelector(`option[value="${value}"]`);
        if (option) option.textContent = appT(key, fallback);
    });
}

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
    if (errorData.message) return errorData.message;

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
                const error = new Error(message);
                error.apiStatus = response.status;
                error.apiData = errorData;
                throw error;
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
                const error = new Error(message);
                error.apiStatus = response.status;
                error.apiData = errorData;
                throw error;
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
        if (filters.minAesthetic) params.set('min_aesthetic', filters.minAesthetic);
        if (filters.maxAesthetic) params.set('max_aesthetic', filters.maxAesthetic);

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

    async getSelectionData(imageIds) {
        return this.post('/api/images/export-data', { image_ids: imageIds });
    },

    async getExportSelectionData(imageIds) {
        return this.getSelectionData(imageIds);
    },

    async reparseImage(id) {
        return this.post(`/api/images/${id}/reparse`);
    },

    async openFolder(imageId) {
        return this.post('/api/open-folder', { image_id: imageId });
    },

    async deleteSelectedImages(imageIds) {
        return this.post('/api/images/delete-selected', {
            image_ids: imageIds,
            confirm_delete_files: true
        });
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

    async getTagsLibrary(sortBy = 'frequency', limit = 100000) {
        return this.get(`/api/tags/library?sort_by=${sortBy}&limit=${limit}`);
    },

    async importTags(images, overwrite = false) {
        return this.post('/api/tags/import', { images, overwrite });
    },

    async getPromptsLibrary(limit = 100000) {
        return this.get(`/api/prompts/library?limit=${limit}`);
    },

    async getLorasLibrary(limit = 100000) {
        return this.get(`/api/loras/library?limit=${limit}`);
    },

    async getGenerators() {
        return this.get('/api/generators');
    },

    // Stats
    async getStats() {
        return this.get('/api/stats');
    },

    async getAestheticStatus() {
        return this.get('/api/aesthetic/status');
    },

    async startAestheticScoring(force = false) {
        return this.post(`/api/aesthetic/score-all?force=${force ? 'true' : 'false'}`);
    },

    async getAestheticProgress() {
        return this.get('/api/aesthetic/progress');
    },

    async scoreAestheticForImage(imageId) {
        return this.post(`/api/aesthetic/score/${imageId}`);
    },

    async getModelStatus() {
        return this.get('/api/models/status');
    },

    async prepareModel(modelId, options = {}) {
        return this.post('/api/models/prepare', {
            model_id: modelId,
            source: options.source || null,
            variant: options.variant || null,
        });
    },

    async getUpdateStatus(force = false) {
        return this.get(`/api/updates/status?force=${force ? 'true' : 'false'}`);
    },

    async applyUpdate(options = {}) {
        return this.post('/api/updates/apply', {
            force_check: options.forceCheck ?? true,
            relaunch: options.relaunch ?? true,
        });
    },

    // Scan
    async startScan(folderPath, options = {}) {
        return this.post('/api/scan', {
            folder_path: folderPath,
            recursive: options.recursive ?? true,
            quick_import: options.quickImport ?? true,
            force_reparse: options.forceReparse ?? false,
            cleanup_missing: options.cleanupMissing ?? false,
        });
    },

    async getScanProgress() {
        return this.get('/api/scan/progress');
    },

    async cancelScan() {
        return this.post('/api/scan/cancel');
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
    async moveImages(imageIds, destinationFolder, operation = 'move') {
        return this.post('/api/move', { image_ids: imageIds, destination_folder: destinationFolder, operation });
    },

    async batchMove(generators, tags, ratings, destinationFolder, checkpoints = null, loras = null, prompts = null, dimensions = null, search = null, aesthetic = null, operation = 'move') {
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
            min_aesthetic: aesthetic?.min ?? null,
            max_aesthetic: aesthetic?.max ?? null,
            destination_folder: destinationFolder,
            operation,
        });
    },

    // Manual Sort
    async startSortSession(generators, tags, ratings, folders, checkpoints = null, loras = null, prompts = null, dimensions = null, search = null, aesthetic = null, operationMode = 'move') {
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
        if (aesthetic?.min != null) params.set('min_aesthetic', aesthetic.min);
        if (aesthetic?.max != null) params.set('max_aesthetic', aesthetic.max);
        if (folders) params.set('folders', JSON.stringify(folders));
        if (operationMode) params.set('operation_mode', operationMode);
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
            syncScanAdvancedUi({ resetToPreference: true });
            resetScanFolderValidation();
        }

        // Load system hardware info when tag modal opens
        if (modalId === 'tag-modal') {
            _tagMinimizedToBackground = false;
            _hideBgTagProgress();
            syncTaggerModelUi({ applyModelDefaults: false, resetAdvancedToPreference: true });
            if (typeof loadSystemInfo === 'function') loadSystemInfo();
        }

        // Set up focus trap
        trapFocus(modal);

        // Add escape key handler to close modal
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (modalId === 'tag-modal') {
                    minimizeTaggingToBackground();
                } else if (modalId === 'filter-modal') {
                    closeFilterModal();
                } else {
                    hideModal(modalId);
                }
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

        if (modalId === 'confirm-modal') {
            unlockDynamicI18nText('#confirm-title', 'modal.confirm', 'Are you sure?');
            unlockDynamicI18nText('#confirm-message', 'modal.confirmAction', 'This action cannot be undone.');
        } else if (modalId === 'input-modal') {
            unlockDynamicI18nText('#input-modal-title', 'modal.enterValue', 'Enter Value');
            const messageEl = $('#input-modal-message');
            if (messageEl) messageEl.textContent = '';
        }

        // Release focus trap and restore focus
        releaseFocus();
    }
}

function closeFilterModal() {
    hideModal('filter-modal');
    resetFilterModalController();
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

        lockDynamicI18nText('#input-modal-title', 'modal.enterValue');
        if (titleEl) titleEl.textContent = title || appT('modal.enterValue', 'Enter Value');
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

function getUpdateActionButtons() {
    return ['#btn-app-update', '#mobile-btn-app-update']
        .map((selector) => $(selector))
        .filter(Boolean);
}

function setUpdateButtonState(status = AppState.update.status, checking = false) {
    AppState.update.checking = Boolean(checking);
    AppState.update.status = status || null;

    const buttons = getUpdateActionButtons();
    const currentVersion = status?.current_version || appT('update.versionUnknown', 'current');
    let state = 'idle';
    let label = appT('update.check', 'Check Updates');
    let title = appT('update.checkTitle', 'Check for application updates');

    if (checking) {
        state = 'checking';
        label = appT('update.checking', 'Checking...');
        title = appT('update.checkingTitle', 'Checking the configured update channel for a new version');
    } else if (status?.has_update) {
        state = 'available';
        label = appT('update.availableShort', 'Update {version}', { version: status.latest_version || '' });
        title = appT('update.availableTitle', 'Update from {current} to {latest}', {
            current: currentVersion,
            latest: status.latest_version || '',
        });
    } else if (status?.error || status?.update_unavailable_reason) {
        label = appT('update.retry', 'Retry Update Check');
        title = status?.update_unavailable_reason || status?.error || title;
    } else if (status) {
        label = appT('update.current', 'Latest');
        title = appT('update.currentTitle', 'You are already on version {version}', {
            version: currentVersion,
        });
    }

    buttons.forEach((button) => {
        button.dataset.updateState = state;
        button.disabled = Boolean(checking);
        button.title = title;
        button.setAttribute('aria-label', title);
        const textNode = button.querySelector('span:last-child');
        if (textNode) {
            textNode.textContent = label;
        }
    });
}

async function refreshUpdateStatus({ force = false, silent = false } = {}) {
    if (AppState.update.checking) {
        return AppState.update.status;
    }

    setUpdateButtonState(AppState.update.status, true);
    try {
        const status = await API.getUpdateStatus(force);
        setUpdateButtonState(status, false);

        if (!silent) {
            if (status?.has_update) {
                showToast(
                    appT('update.availableToast', 'New version {version} is ready to install.', {
                        version: status.latest_version || '',
                    }),
                    'info'
                );
            } else if (status?.update_unavailable_reason) {
                showToast(status.update_unavailable_reason, 'warning');
            } else if (status?.error) {
                showToast(status.error, 'error');
            } else {
                showToast(
                    appT('update.none', 'You are already on the latest version.'),
                    'success'
                );
            }
        }

        return status;
    } catch (error) {
        setUpdateButtonState(AppState.update.status, false);
        if (!silent) {
            showToast(
                formatUserError(error, appT('update.checkFailed', 'Failed to check for updates')),
                'error'
            );
        }
        throw error;
    }
}

function buildUpdateConfirmMessage(status) {
    const currentVersion = status?.current_version || appT('update.versionUnknown', 'current version');
    const latestVersion = status?.latest_version || appT('update.versionUnknown', 'latest version');
    return appT('update.confirmMessage', 'Update from {current} to {latest} now? The app will restart when the patch is ready.', {
        current: currentVersion,
        latest: latestVersion,
    });
}

async function applyAppUpdate(status = AppState.update.status) {
    if (!status?.has_update) {
        return null;
    }

    showGlobalLoading(appT('update.downloading', 'Downloading update...'));
    setUpdateButtonState(status, true);
    try {
        const result = await API.applyUpdate({ forceCheck: true, relaunch: true });
        if (result?.status !== 'scheduled') {
            hideGlobalLoading();
            setUpdateButtonState(result, false);
            return result;
        }

        showGlobalLoading(appT('update.applying', 'Applying update and restarting...'));
        showToast(
            appT('update.restartSoon', 'Update downloaded. Restarting the app now...'),
            'info'
        );
        return result;
    } catch (error) {
        hideGlobalLoading();
        setUpdateButtonState(status, false);
        showToast(
            formatUserError(error, appT('update.applyFailed', 'Failed to apply the update')),
            'error'
        );
        throw error;
    }
}

async function handleAppUpdateButtonClick() {
    try {
        let status = AppState.update.status;
        if (!status?.has_update) {
            status = await refreshUpdateStatus({ force: true, silent: false });
        }

        if (status?.has_update) {
            showConfirm(
                appT('update.confirmTitle', 'Install Update'),
                buildUpdateConfirmMessage(status),
                () => {
                    void applyAppUpdate(status);
                }
            );
        }
    } catch (error) {
        // refreshUpdateStatus already surfaced a user-facing toast
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

function buildOperationProgressText({
    completed = 0,
    total = 0,
    tracker = null,
    primaryLabel = '',
    extraParts = [],
    detail = '',
    defaultMessage = 'Processing...',
}) {
    const meta = updateProgressTracker(tracker, completed, total);
    const parts = [];

    if (primaryLabel) parts.push(primaryLabel);
    if (total > 0) parts.push(`${completed}/${total}`);
    extraParts.filter(Boolean).forEach((part) => parts.push(part));
    if (meta.etaText) parts.push(appT('progress.eta', 'ETA {time}').replace('{time}', meta.etaText));
    else if (meta.elapsedText) parts.push(appT('progress.elapsed', 'Elapsed {time}').replace('{time}', meta.elapsedText));

    parts.push(detail || defaultMessage);
    return parts.join(' · ');
}

function lockDynamicI18nText(selector, fallbackKey = '') {
    const el = $(selector);
    if (!el) return;
    if (!el.dataset.i18nOriginal && (el.hasAttribute('data-i18n') || fallbackKey)) {
        el.dataset.i18nOriginal = el.getAttribute('data-i18n') || fallbackKey || '';
    }
    el.removeAttribute('data-i18n');
    el.dataset.i18nLocked = '1';
}

function unlockDynamicI18nText(selector, fallbackKey, fallbackText) {
    const el = $(selector);
    if (!el) return;
    const originalKey = el.dataset.i18nOriginal || fallbackKey || '';
    if (originalKey) {
        el.setAttribute('data-i18n', originalKey);
    }
    delete el.dataset.i18nLocked;
    el.textContent = originalKey ? appT(originalKey, fallbackText || originalKey) : (fallbackText || '');
}

function lockLiveProgressText(selector) {
    lockDynamicI18nText(selector);
}

function unlockLiveProgressText(selector, fallbackKey, fallbackText) {
    unlockDynamicI18nText(selector, fallbackKey, fallbackText);
}

function setScanCancelButtonState(mode = 'idle') {
    const button = $('#btn-cancel-scan');
    if (!button) return;

    if (!button.dataset.i18nOriginal && button.hasAttribute('data-i18n')) {
        button.dataset.i18nOriginal = button.getAttribute('data-i18n') || 'modal.cancel';
    }

    if (mode === 'running') {
        button.removeAttribute('data-i18n');
        button.dataset.liveLabel = '1';
        button.disabled = false;
        button.textContent = appT('scan.stopButton', 'Stop Scan');
        return;
    }

    if (mode === 'cancelling') {
        button.removeAttribute('data-i18n');
        button.dataset.liveLabel = '1';
        button.disabled = true;
        button.textContent = appT('scan.stoppingButton', 'Stopping...');
        return;
    }

    const originalKey = button.dataset.i18nOriginal || 'modal.cancel';
    button.setAttribute('data-i18n', originalKey);
    delete button.dataset.liveLabel;
    button.disabled = false;
    button.textContent = appT(originalKey, 'Cancel');
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
    AppState.pagination.pageSize = getDefaultGalleryPageSize(nextMode);
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

const TAGGER_MODEL_I18N_PREFIXES = {
    'wd-eva02-large-tagger-v3': 'tagger.model.wdEva02',
    'wd-swinv2-tagger-v3': 'tagger.model.wdSwinv2',
    'wd-convnext-tagger-v3': 'tagger.model.wdConvnext',
    'wd-vit-tagger-v3': 'tagger.model.wdVit',
    'wd-vit-large-tagger-v3': 'tagger.model.wdVitLarge',
    'camie-tagger-v2': 'tagger.model.camieV2',
    'pixai-tagger-v0.9': 'tagger.model.pixaiV09',
    'toriigate-0.5': 'tagger.model.toriigate05',
};

function getTaggerLocalizedScale(value) {
    const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return appT(`tagger.scale.${key}`, value);
}

let _taggerModelCatalog = [];
let _taggerModelCatalogMap = new Map();
const TAGGER_CHUNK_OPTIONS = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 24, 32];

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

function getLocalizedTaggerMeta(modelName, meta) {
    if (!meta) return null;

    const prefix = TAGGER_MODEL_I18N_PREFIXES[normalizeTaggerModelName(modelName, '')];
    if (!prefix) return meta;

    const summaryFallback = meta.description || meta.summary || appT('tagger.defaultSummary', 'WD14 tagger model');
    return {
        ...meta,
        summary: appT(`${prefix}.summary`, summaryFallback),
        description: appT(`${prefix}.summary`, summaryFallback),
        best_for: meta.best_for ? appT(`${prefix}.bestFor`, meta.best_for) : meta.best_for,
        runtime_note: meta.runtime_note ? appT(`${prefix}.runtimeNote`, meta.runtime_note) : meta.runtime_note,
        safe_mode_note: meta.safe_mode_note ? appT(`${prefix}.safeModeNote`, meta.safe_mode_note) : meta.safe_mode_note,
    };
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

function describeTaggerModel(meta) {
    if (!meta) {
        return appT('tagger.descDefault', 'Balanced default. Good speed, good quality, and solid stability.');
    }

    const summary = meta.description || meta.summary || appT('tagger.defaultSummary', 'WD14 tagger model');
    const quality = Number(meta.quality_score || 0);
    const speed = Number(meta.speed_score || 0);
    const stability = Number(meta.stability_score || 0);
    return appT('tagger.descSummaryFormat', '{summary} Q{quality}/5 \u2022 S{speed}/5 \u2022 Stable {stability}/5.')
        .replace('{summary}', summary)
        .replace('{quality}', quality)
        .replace('{speed}', speed)
        .replace('{stability}', stability);
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
        return appT('tagger.runtimeAdaptiveMax', 'Adaptive max-throughput mode is active. The app pushes GPU speed first, then falls back only if the run becomes unstable.');
    }

    if (isCustom) {
        if (gpuEnabled) {
            return appT('tagger.runtimeCustomGpu', 'Custom model on GPU. Faster when it works, but less predictable than CPU Safe Mode.');
        }
        return appT('tagger.runtimeCustomCpu', 'Custom model on CPU Safe Mode. Finish one stable run first, then try GPU only if needed.');
    }

    if (riskyGpu) {
        return appT('tagger.runtimeRiskyGpu', 'GPU override is active. Automatic hardware limits still apply, but this path is less conservative than CPU Safe Mode.');
    }

    if (gpuEnabled) {
        const focus = meta?.best_for
            ? appT('tagger.bestForPrefix', ' Best for: {bestFor}.').replace('{bestFor}', meta.best_for)
            : '';
        return `${appT('tagger.runtimeAdaptiveGpu', 'Adaptive GPU mode is active. The app is already using the recommended fast path for this hardware.')}${focus}`;
    }

    return appT('tagger.runtimeCpuSafe', 'CPU Safe Mode is active. Slower, but safer when VRAM is tight or other AI tools are already running.');
}

function getTaggerHardwareRecommendation(modelName = null, options = {}) {
    const { isCustom = false, useGpu = true } = options;
    const info = window.__taggerSystemInfo || {};
    const recommendationsByModel = info.recommendations_by_model || {};
    const normalizedModel = isCustom
        ? 'custom'
        : normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    const modeKey = useGpu ? 'gpu' : 'cpu';

    if (recommendationsByModel[normalizedModel]?.[modeKey]) {
        return recommendationsByModel[normalizedModel][modeKey];
    }

    return info.recommendation || null;
}

function getRecommendedTaggerChunkSize(modelName = null, options = {}) {
    const recommendation = getTaggerHardwareRecommendation(modelName, options);
    const size = Number(recommendation?.recommended_batch_size || 8);
    return Number.isFinite(size) && size > 0 ? size : 8;
}

function clampTaggerChunkToAvailableOption(value) {
    const safeValue = Math.max(1, Number(value) || 1);
    const descending = [...TAGGER_CHUNK_OPTIONS].sort((a, b) => b - a);
    const match = descending.find((option) => option <= safeValue);
    return String(match || TAGGER_CHUNK_OPTIONS[0]);
}

function applyTaggerChunkOptions(batchSelect, maxChunk) {
    if (!batchSelect) return;
    const safeMax = Math.max(1, Number(maxChunk) || 1);
    Array.from(batchSelect.options).forEach((option) => {
        const optionValue = Number(option.value || 0);
        const enabled = optionValue > 0 && optionValue <= safeMax;
        option.disabled = !enabled;
        option.hidden = !enabled;
    });
}

function hasLoadedTaggerSystemInfo() {
    return Boolean(window.__taggerSystemInfo && (window.__taggerSystemInfo.system_info || window.__taggerSystemInfo.recommendation));
}

function getTaggerProviderState() {
    const probeLoaded = hasLoadedTaggerSystemInfo();
    if (!probeLoaded) {
        return {
            providers: [],
            hasCuda: false,
            hasDml: false,
            hasTensorRt: false,
            hasTorchCuda: false,
            label: appT('tag.providerUnknown', 'Provider unknown'),
            tone: 'is-info',
            probeLoaded: false,
        };
    }

    const systemInfo = window.__taggerSystemInfo?.system_info || {};
    const providers = Array.isArray(systemInfo.onnx_providers)
        ? systemInfo.onnx_providers.map((provider) => String(provider))
        : [];
    const hasCuda = providers.includes('CUDAExecutionProvider');
    const hasDml = providers.includes('DmlExecutionProvider');
    const hasTensorRt = providers.includes('TensorrtExecutionProvider');
    const hasTorchCuda = Boolean(systemInfo.torch_cuda_available);
    const label = hasTensorRt
        ? appT('tagger.tensorrtReady', 'TensorRT + CUDA ready')
        : hasCuda
            ? appT('tagger.cudaReady', 'CUDA ready')
            : hasDml
                ? appT('tagger.directmlReady', 'DirectML ready')
                : hasTorchCuda
                    ? appT('tagger.pytorchCudaOnly', 'PyTorch CUDA only')
                    : appT('tagger.cpuRuntime', 'CPU runtime');
    const tone = (hasCuda || hasTensorRt) ? 'is-safe' : 'is-warning';

    return {
        providers,
        hasCuda,
        hasDml,
        hasTensorRt,
        hasTorchCuda,
        label,
        tone,
        probeLoaded: true,
    };
}

function setTaggerStatusChip(element, text, tone = '') {
    if (!element) return;
    element.removeAttribute('data-i18n');
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

function getTaggerSafetyTierLabel(meta) {
    const tier = String(meta?.runtime_safety_tier || '').toLowerCase();
    if (tier === 'light') return appT('tagger.tierLight', 'Light');
    if (tier === 'heavy') return appT('tagger.tierHeavy', 'Heavy');
    if (tier === 'vlm') return appT('tagger.tierVlm', 'VLM');
    return appT('tagger.tierBalanced', 'Balanced');
}

function getTaggerMinimumHardwareText(meta) {
    if (!meta) return '';

    const gpuRam = Number(meta.minimum_total_ram_gb || 0);
    const gpuFreeRam = Number(meta.minimum_available_ram_gb || 0);
    const gpuVramMb = Number(meta.minimum_gpu_vram_mb || 0);
    const gpuFreeVramMb = Number(meta.minimum_gpu_available_vram_mb || 0);
    const cpuRam = Number(meta.minimum_cpu_total_ram_gb || 0);
    const cpuFreeRam = Number(meta.minimum_cpu_available_ram_gb || 0);

    if (gpuRam || gpuVramMb || cpuRam) {
        const gpuParts = [];
        if (gpuRam) gpuParts.push(`${gpuRam} GB RAM`);
        if (gpuFreeRam) gpuParts.push(`${gpuFreeRam} GB free RAM`);
        if (gpuVramMb) gpuParts.push(`${Math.round(gpuVramMb / 1024)} GB VRAM`);
        if (gpuFreeVramMb) gpuParts.push(`${Math.round(gpuFreeVramMb / 1024)} GB free VRAM`);

        const cpuParts = [];
        if (cpuRam) cpuParts.push(`${cpuRam} GB RAM`);
        if (cpuFreeRam) cpuParts.push(`${cpuFreeRam} GB free RAM`);

        const segments = [];
        if (gpuParts.length) {
            segments.push(
                appT('tagger.minimumGpuPrefix', 'GPU minimum: {requirements}.').replace('{requirements}', gpuParts.join(' + '))
            );
        }
        if (cpuParts.length) {
            segments.push(
                appT('tagger.minimumCpuPrefix', 'CPU minimum: {requirements}.').replace('{requirements}', cpuParts.join(' + '))
            );
        }
        return segments.join(' ');
    }

    return appT(
        'tagger.minimumAdaptive',
        'No hard minimum. The runtime still clamps chunk size against current free VRAM/RAM for this model.'
    );
}

function renderTaggerModelSnapshot(meta, options = {}) {
    const {
        isCustom = false,
        modelDisabled = false,
        rawMeta = null,
    } = options;
    const subtitleEl = $('#tag-model-subtitle');
    const badgesEl = $('#tag-model-badges');
    const noteEl = $('#tag-model-note');
    if (!subtitleEl || !badgesEl || !noteEl) return;

    if (isCustom) {
        subtitleEl.textContent = appT('tagger.customSubtitle', 'Custom local ONNX model. The app cannot infer its schema or stability in advance.');
        badgesEl.innerHTML = [
            `<span class="tagger-model-badge is-warning">${escapeHtml(appT('tagger.customBadge', 'Custom'))}</span>`,
            `<span class="tagger-model-badge">${escapeHtml(appT('tagger.onnxOnlyBadge', 'ONNX only'))}</span>`,
            `<span class="tagger-model-badge">${escapeHtml(appT('tagger.schemaUnknownBadge', 'Schema unknown'))}</span>`,
        ].join('');
        noteEl.textContent = appT('tagger.customNote', 'Start from one stable run first. Raise chunk size only after that.');
        return;
    }

    const summary = meta?.description || meta?.summary || appT('tagger.defaultSummary', 'WD14 tagger model');
    subtitleEl.textContent = summary;

    const badges = [];
    if (meta?.recommended) badges.push({ text: appT('tagger.badgeRecommended', 'Recommended'), tone: 'is-highlight' });
    if (meta?.speed) {
        badges.push({
            text: appT('tagger.badgeSpeed', 'Speed {value}').replace('{value}', getTaggerLocalizedScale(meta.speed)),
        });
    }
    if (meta?.memory) {
        const memorySource = String(rawMeta?.memory || meta.memory || '');
        badges.push({
            text: appT('tagger.badgeMemory', 'Memory {value}').replace('{value}', getTaggerLocalizedScale(meta.memory)),
            tone: /high/i.test(memorySource) ? 'is-warning' : '',
        });
    }
    if (meta?.runtime_safety_tier) badges.push({ text: getTaggerSafetyTierLabel(meta) });
    if (meta?.best_for) badges.push({ text: meta.best_for, tone: 'is-highlight' });
    if (modelDisabled) badges.push({ text: appT('tagger.chipCatalogOnly', 'Catalog Only'), tone: 'is-warning' });

    badgesEl.innerHTML = badges
        .map((badge) => {
            const safeTone = VALID_TONES.has(badge.tone) ? badge.tone : '';
            return `<span class="tagger-model-badge${safeTone ? ` ${safeTone}` : ''}">${escapeHtml(badge.text)}</span>`;
        })
        .join('');

    const minimumHardwareText = getTaggerMinimumHardwareText(meta);
    noteEl.textContent = meta?.disabled_reason
        || meta?.safe_mode_note
        || meta?.runtime_note
        || minimumHardwareText
        || appT('tagger.defaultNote', 'The selected model changes speed, quality, and load.');
}

function applyTaggerModelThresholdDefaults(meta) {
    const thresholdInput = $('#tag-threshold');
    const thresholdValue = $('#tag-threshold-value');
    const characterThresholdInput = $('#tag-character-threshold');
    const characterThresholdValue = $('#tag-character-threshold-value');
    if (!thresholdInput || !characterThresholdInput) return;

    delete thresholdInput.dataset.userChosen;
    delete characterThresholdInput.dataset.userChosen;

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

function hasActiveScanAdvancedOptions() {
    return Boolean(
        $('#scan-force-reparse')?.checked ||
        $('#scan-cleanup-missing')?.checked ||
        $('#scan-auto-tag')?.checked
    );
}

function syncScanAdvancedUi(options = {}) {
    const { resetToPreference = false } = options;
    const advancedDetails = $('#scan-advanced-options');
    if (!advancedDetails) return;

    if (resetToPreference) {
        advancedDetails.open = hasActiveScanAdvancedOptions() || readStoredBoolean(SCAN_ADVANCED_OPEN_KEY, false);
        return;
    }

    if (hasActiveScanAdvancedOptions()) {
        advancedDetails.open = true;
    }
}

function hasActiveTagAdvancedOptions() {
    return Boolean(
        ($('#tag-model-select')?.value || '') === 'custom' ||
        $('#tag-retag-all')?.checked ||
        $('#tag-use-gpu')?.dataset.userChosen === '1' ||
        $('#tagger-batch-size')?.dataset.userChosen === '1' ||
        $('#tag-threshold')?.dataset.userChosen === '1' ||
        $('#tag-character-threshold')?.dataset.userChosen === '1'
    );
}

function syncTagAdvancedUi(options = {}) {
    const { resetToPreference = false } = options;
    const advancedDetails = $('#tag-advanced-options');
    const advancedHint = $('#tag-advanced-options-hint');
    const isCustom = ($('#tag-model-select')?.value || '') === 'custom';
    const hasActiveAdvanced = hasActiveTagAdvancedOptions();
    if (!advancedDetails) return;

    if (advancedHint) {
        advancedHint.textContent = isCustom
            ? appT('tagger.advancedHintCustomPanel', 'Custom local model selected. Fill in these fields before starting.')
            : (hasActiveAdvanced
                ? appT('tagger.advancedHintActivePanel', 'Advanced settings are active for this run.')
                : appT('tagger.advancedHintPanel', 'Optional. Open this only if you want more control.'));
    }

    if (resetToPreference) {
        advancedDetails.open = isCustom || hasActiveAdvanced || readStoredBoolean(TAG_ADVANCED_OPEN_KEY, false);
        return;
    }

    if (isCustom || hasActiveAdvanced) {
        advancedDetails.open = true;
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
        modelName = 'wd-swinv2-tagger-v3',
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

    if (isToriiGate) {
        batchSelect.value = '1';
        batchSelect.disabled = true;
        batchSelect.setAttribute('aria-disabled', 'true');
        delete batchSelect.dataset.userChosen;

        if (batchRecommendation) {
            batchRecommendation.textContent = appT('tagger.chunkHelpToriiGateFixed', 'ToriiGate uses a fixed safe chunk size of 1.');
        }
        if (chunkChip) {
            setTaggerStatusChip(chunkChip, 'Chunk 1', 'is-safe');
        }
        batchHelp.textContent = gpuEnabled
            ? appT('tagger.chunkHelpToriiGateGpu', 'ToriiGate uses the multimodal PyTorch backend. Chunk size is fixed to 1 in Safe Mode to avoid VRAM spikes.')
            : appT('tagger.chunkHelpToriiGateCpu', 'ToriiGate on CPU uses fixed chunk size 1.');
        return;
    }

    batchSelect.disabled = false;
    batchSelect.setAttribute('aria-disabled', 'false');
    const recommendation = getTaggerHardwareRecommendation(modelName, { isCustom, useGpu: gpuEnabled }) || getTaggerHardwareRecommendation(modelName, { isCustom, useGpu: true });
    const recommendedChunk = getRecommendedTaggerChunkSize(modelName, { isCustom, useGpu: gpuEnabled });
    applyTaggerChunkOptions(batchSelect, recommendedChunk);
    if (batchSelect.dataset.userChosen !== '1') {
        batchSelect.value = clampTaggerChunkToAvailableOption(recommendedChunk);
    }

    if (Number(batchSelect.value || 0) > recommendedChunk) {
        batchSelect.value = clampTaggerChunkToAvailableOption(recommendedChunk);
    }

    const selectedChunk = parseInt(batchSelect.value, 10) || recommendedChunk;
    const riskLevel = String(recommendation?.risk_level || 'medium').toLowerCase();

    if (batchRecommendation) {
        batchRecommendation.textContent = (isCustom
            ? (gpuEnabled
                ? appT('tagger.chunkHelpRecommendedCustomGpu', 'Recommended starting chunk size: {chunk}. Keep custom GPU runs conservative until the model proves stable.')
                : appT('tagger.chunkHelpRecommendedCustomCpu', 'Recommended starting chunk size: {chunk}. Finish one stable CPU run before you raise it.'))
            : appT('tagger.chunkHelpRecommended', 'Recommended chunk size: {chunk}. Leave this alone unless you are deliberately tuning throughput.'))
            .replace('{chunk}', recommendedChunk);
    }

    if (chunkChip) {
        setTaggerStatusChip(
            chunkChip,
            `Chunk ${selectedChunk}`,
            selectedChunk > recommendedChunk ? 'is-warning' : 'is-safe'
        );
    }

    if (gpuLocked) {
        batchHelp.textContent = appT('tagger.chunkHelpAdaptive', 'This model already uses adaptive runtime limits. Only change chunk size if you are stress-testing.');
        return;
    }

    if (selectedChunk > recommendedChunk) {
        batchHelp.textContent = gpuEnabled
            ? appT('tagger.chunkHelpOverGpu', 'You chose {chosen}, above the recommended {recommended}. Expect higher VRAM pressure and more crash risk.').replace('{chosen}', selectedChunk).replace('{recommended}', recommendedChunk)
            : appT('tagger.chunkHelpOverCpu', 'You chose {chosen}, above the recommended {recommended}. This may help throughput, but it raises RAM pressure.').replace('{chosen}', selectedChunk).replace('{recommended}', recommendedChunk);
        return;
    }

    if (riskyGpu) {
        batchHelp.textContent = appT('tagger.chunkHelpRiskyGpu', 'This controls true WD14 batching where supported. Risky GPU mode now starts directly, so use it only when you intentionally want more throughput.');
        return;
    }

    if (isCustom) {
        batchHelp.textContent = appT('tagger.chunkHelpCustom', 'Custom models may or may not support true batching. Start from the recommended value.');
        return;
    }

    if (riskLevel === 'high') {
        batchHelp.textContent = appT('tagger.chunkHelpHighRisk', 'This machine is marked high-risk for long GPU tagging. Leave the recommended chunk size alone.');
        return;
    }

    batchHelp.textContent = appT('tagger.chunkHelpDefault', 'This controls the true WD14 batch size when the selected model supports dynamic batching.');
}

function syncTaggerModelUi(options = {}) {
    const { applyModelDefaults = false, toastOnAutoSafe = false, resetAdvancedToPreference = false } = options;
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
    const rawMeta = getTaggerModelMeta(normalizedModel);
    const meta = getLocalizedTaggerMeta(normalizedModel, rawMeta);
    const isToriiGate = isToriiGateTaggerModel(normalizedModel, { isCustom });
    const gpuLocked = isGpuLockedTaggerModel(normalizedModel, { isCustom });
    const gpuUserChosen = useGpu?.dataset.userChosen === '1';
    const currentGpuSelection = useGpu?.checked ?? true;
    const activeHardwareRecommendation = getTaggerHardwareRecommendation(normalizedModel, { isCustom, useGpu: currentGpuSelection });
    const gpuHardwareRecommendation = getTaggerHardwareRecommendation(normalizedModel, { isCustom, useGpu: true });
    const hardwareRecommendation = activeHardwareRecommendation || gpuHardwareRecommendation;
    const providerState = getTaggerProviderState();
    const hardwareProbeLoaded = providerState.probeLoaded;
    const onnxGpuAvailable = providerState.hasCuda || providerState.hasDml;
    const torchGpuAvailable = providerState.hasTorchCuda || providerState.hasCuda || providerState.hasTensorRt;
    const hardwareRisk = String(hardwareRecommendation?.risk_level || '').toLowerCase();
    const hardwarePrefersGpu = isToriiGate
        ? (hardwareProbeLoaded ? torchGpuAvailable : currentGpuSelection)
        : (isCustom
            ? (hardwareProbeLoaded ? onnxGpuAvailable : currentGpuSelection)
            : (gpuHardwareRecommendation
                ? Boolean(gpuHardwareRecommendation.recommended_use_gpu)
                : currentGpuSelection));
    const hardwareHighRisk = hardwareRisk === 'high';
    const taggingIsRunning = $('#btn-start-tag')?.disabled === true;
    const modelDisabled = !isCustom && Boolean(meta?.disabled);
    const modelPrefersGpu = isCustom ? onnxGpuAvailable : Boolean(meta?.gpu_default ?? true);
    const recommendedGpu = gpuLocked
        ? false
        : (hardwareProbeLoaded ? (modelPrefersGpu && hardwarePrefersGpu) : currentGpuSelection);

    if (customModelGroup) customModelGroup.style.display = isCustom ? 'block' : 'none';
    if (customTagsGroup) customTagsGroup.style.display = isCustom ? 'block' : 'none';
    renderTaggerModelSnapshot(meta, { isCustom, modelDisabled, rawMeta });
    syncTaggerThresholdUi({ isToriiGate });

    if (applyModelDefaults && meta && !isCustom) {
        applyTaggerModelThresholdDefaults(meta);
    }

    if (useGpu && (gpuLocked || (applyModelDefaults && !gpuUserChosen)) && (gpuLocked || hardwareProbeLoaded)) {
        const changedToSafeMode = useGpu.checked && !recommendedGpu;
        useGpu.checked = recommendedGpu;
        if (changedToSafeMode && toastOnAutoSafe) {
            showToast(
                gpuLocked
                    ? appT('tagger.toastMaxQualityCpuSafe', 'Max Quality now runs in protected CPU Safe Mode inside the app.')
                    : appT('tagger.toastAutoSafeMode', 'This model was switched to CPU Safe Mode to avoid crashes.'),
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
            modelHelp.textContent = (useGpu?.checked ?? false)
                ? appT('tagger.customModelHelpGpuPreferred', 'Custom ONNX model. GPU mode is on for this run. CPU Safe Mode is still safer if stability is unknown.')
                : appT('tagger.customModelHelp', 'Custom ONNX model. Start with CPU Safe Mode first.');
        } else if (modelDisabled) {
            modelHelp.textContent = meta?.disabled_reason || appT('tagger.modelListedFuture', 'This model is listed for future integration but is not runnable in the current build.');
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
    const liveRuntime = taggingIsRunning ? (window.__liveTagProgress || null) : null;
    const liveTargetBackend = String(liveRuntime?.runtime_backend_target || (gpuEnabled ? 'gpu' : 'cpu')).toLowerCase();
    const liveActualBackend = String(liveRuntime?.runtime_backend_actual || '').toLowerCase();
    const liveRuntimeReason = String(liveRuntime?.runtime_backend_reason || '').trim();
    const liveMemoryPressure = String(liveRuntime?.memory_pressure_warning || '').trim();
    const hasLiveRuntime = Boolean(liveActualBackend) && !modelDisabled;

    if (runtimeSummary) {
        let summary = modelDisabled
            ? (meta?.disabled_reason || appT('tagger.modelUnavailable', 'This model is currently unavailable in the app runtime.'))
            : describeTaggerRuntime({
            isCustom,
            gpuLocked,
            gpuEnabled,
            riskyGpu,
            meta
        });
        const recommendedChunk = getRecommendedTaggerChunkSize(normalizedModel, { isCustom, useGpu: gpuEnabled });
        if (hasLiveRuntime) {
            summary = `Requested ${liveTargetBackend.toUpperCase()}, actual ${liveActualBackend.toUpperCase()}.`;
            if (liveRuntimeReason) {
                summary += ` ${liveRuntimeReason}`;
            }
            if (liveMemoryPressure) {
                summary += ` ${liveMemoryPressure}`;
            }
        }
        runtimeSummary.textContent = summary;
    }

    if (runtimeDetail) {
        if (modelDisabled) {
            runtimeDetail.textContent = appT('tagger.catalogOnlyDetail', 'This entry stays in the catalog so the planned integration is visible, but the current tagger runtime cannot execute it.');
        } else if (hasLiveRuntime) {
            let detail = `Actual backend: ${liveActualBackend.toUpperCase()}.`;
            if (liveTargetBackend && liveTargetBackend !== liveActualBackend) {
                detail += ` Target requested ${liveTargetBackend.toUpperCase()}.`;
            }
            if (liveRuntimeReason) {
                detail += ` ${liveRuntimeReason}`;
            }
            if (liveMemoryPressure) {
                detail += ` ${liveMemoryPressure}`;
            }
            runtimeDetail.textContent = detail;
        } else if (meta) {
            runtimeDetail.textContent = getTaggerMinimumHardwareText(meta);
        } else if (isToriiGate) {
            runtimeDetail.textContent = gpuEnabled
                ? appT('tagger.toriiGateGpuDetail', 'ToriiGate uses the multimodal PyTorch CUDA path. WD14 thresholds do not apply here.')
                : appT('tagger.toriiGateCpuDetail', 'ToriiGate can run on CPU, but it is much slower than CUDA. WD14 thresholds do not apply here.');
        } else if (isCustom) {
            runtimeDetail.textContent = onnxGpuAvailable
                ? appT('tagger.customGpuAvailDetail', 'The final runtime path is decided when the custom ONNX session is created. GPU is available, but model stability still decides the final path.')
                : appT('tagger.customCpuOnlyDetail', 'CUDAExecutionProvider is not available for the ONNX runtime path right now, so a custom model run will stay on CPU.');
        } else if (!hardwareProbeLoaded) {
            runtimeDetail.textContent = appT('tagger.hardwarePendingDetail', 'Hardware probe is still loading. GPU stays enabled by default until the runtime check finishes.');
        } else if (providerState.hasCuda || providerState.hasDml) {
            runtimeDetail.textContent = appT('tagger.cudaAvailDetail', 'CUDAExecutionProvider is available on this machine. If the session loads cleanly, the run should stay on GPU.');
        } else if (providerState.hasTorchCuda) {
            runtimeDetail.textContent = appT('tagger.pytorchCudaOnlyDetail', 'PyTorch CUDA is available, but the ONNX runtime path is still CPU-only on this machine.');
        } else {
            runtimeDetail.textContent = appT('tagger.cpuOnlyDetail', 'The current ONNX runtime probe does not expose CUDAExecutionProvider, so this run will stay on CPU.');
        }
    }

    if (runtimeModeChip) {
        setTaggerStatusChip(
            runtimeModeChip,
            modelDisabled
                ? appT('tagger.chipCatalogOnly', 'Catalog Only')
                : (hasLiveRuntime
                ? `${liveTargetBackend.toUpperCase()} target -> ${liveActualBackend.toUpperCase()} actual`
                    : (gpuEnabled ? appT('tagger.chipGpuTarget', 'GPU Target') : appT('tagger.chipCpuTarget', 'CPU Target'))),
            modelDisabled ? 'is-danger' : (!hardwareProbeLoaded && !hasLiveRuntime ? 'is-info' : ((hasLiveRuntime ? liveActualBackend === 'gpu' : gpuEnabled) ? 'is-safe' : 'is-warning'))
        );
    }

    if (runtimeProviderChip) {
        const providerLabel = modelDisabled
            ? appT('tagger.chipVlmNeeded', 'VLM Backend Needed')
            : (hasLiveRuntime
                ? `Actual ${liveActualBackend.toUpperCase()}`
                : (!hardwareProbeLoaded
                    ? appT('tag.providerUnknown', 'Provider unknown')
                : (isToriiGate
                    ? ((window.__taggerSystemInfo?.system_info?.torch_cuda_available && gpuEnabled) ? appT('tagger.chipPytorchCuda', 'PyTorch CUDA') : appT('tagger.chipPytorchCpu', 'PyTorch CPU'))
                    : ((providerState.hasCuda || providerState.hasDml || providerState.hasTorchCuda) ? providerState.label : appT('tagger.chipCpuRuntime', 'CPU Runtime')))));
        const providerTone = modelDisabled
            ? 'is-danger'
            : (hasLiveRuntime
                ? (liveActualBackend === 'gpu' ? 'is-safe' : 'is-warning')
                : (!hardwareProbeLoaded
                    ? 'is-info'
                : (isToriiGate
                ? (gpuEnabled ? 'is-safe' : 'is-warning')
                : providerState.tone)));
        setTaggerStatusChip(runtimeProviderChip, providerLabel, providerTone);
    }

    if (disabledNotice && disabledTitle && disabledBody) {
        if (modelDisabled) {
            disabledNotice.hidden = false;
            disabledTitle.textContent = appT('tagger.disabledNotRunnable', '{model} is not runnable in the current build.').replace('{model}', normalizedModel);
            disabledBody.textContent = meta?.disabled_reason || appT('tagger.disabledFallback', 'Use one of the ONNX taggers above for now.');
        } else {
            disabledNotice.hidden = true;
        }
    }

    if (runtimeAdvancedHint) {
        if (gpuLocked) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintStressTest', 'Optional. Change this only if you are stress-testing.');
        } else if (hardwareHighRisk && !gpuEnabled) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintHighRisk', 'Optional. This machine is marked high-risk for long GPU tagging.');
        } else if (isCustom) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintCustom', 'Optional. Leave this alone until your custom model finishes one stable CPU run.');
        } else if (gpuEnabled && !riskyGpu) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintRecommended', 'Optional. The recommended mode is already active.');
        } else {
            runtimeAdvancedHint.textContent = appT('tagger.advHintDefault', 'Optional. Change this only when troubleshooting or tuning.');
        }
    }

    if (gpuHelp) {
        if (modelDisabled) {
            gpuHelp.textContent = meta?.disabled_reason || appT('tagger.modelNotStartable', 'This model cannot be started in the current build.');
        } else if (hasLiveRuntime) {
            let helpText = `Actual backend: ${liveActualBackend.toUpperCase()}.`;
            if (liveRuntimeReason) {
                helpText += ` ${liveRuntimeReason}`;
            }
            if (liveMemoryPressure) {
                helpText += ` ${liveMemoryPressure}`;
            }
            gpuHelp.textContent = helpText;
        } else if (isToriiGate) {
            gpuHelp.textContent = gpuEnabled
                ? appT('tagger.gpuHelpToriiGateGpu', 'ToriiGate is using the multimodal PyTorch backend on GPU. Keep chunk size small.')
                : appT('tagger.gpuHelpToriiGateCpu', 'ToriiGate is using the multimodal PyTorch backend on CPU. This is valid but much slower than CUDA.');
        } else if (!hardwareProbeLoaded) {
            gpuHelp.textContent = appT('tagger.gpuHelpPendingProbe', 'Hardware probe is still loading. GPU remains enabled by default unless the runtime check later proves it unsafe or unavailable.');
        } else if (gpuLocked) {
            gpuHelp.textContent = appT('tagger.gpuHelpAdaptive', 'Adaptive runtime is active for this model. The app prefers GPU throughput and falls back only if the run becomes unstable.');
        } else if (!gpuEnabled) {
            gpuHelp.textContent = isCustom
                ? appT('tagger.gpuHelpCustomCpu', 'CPU Safe Mode is active for the custom model. Switch back to GPU Preferred if you need more speed and the model stays stable.')
                : (hardwareHighRisk
                    ? appT('tagger.gpuHelpHighRiskCpu', 'CPU Safe Mode is active because this hardware profile is marked high-risk for long GPU tagging runs.')
                    : appT('tagger.gpuHelpCpuSafe', 'CPU Safe Mode is active. Use this when VRAM is tight or other AI tools are already running.'));
        } else if (riskyGpu) {
            gpuHelp.textContent = appT('tagger.gpuHelpRiskyOverride', 'GPU override is active. Automatic hardware limits still apply, but this path will lean harder on the runtime than CPU Safe Mode.');
        } else if (meta?.safe_mode_note) {
            gpuHelp.textContent = appT('tagger.gpuHelpRecommendedNote', 'Recommended GPU mode is active. {note}').replace('{note}', meta.safe_mode_note);
        } else {
            gpuHelp.textContent = appT('tagger.gpuHelpRecommendedDefault', 'Recommended GPU mode is active for this model. Switch to CPU Safe Mode only if you need extra stability.');
        }
    }

    syncTaggerRuntimeChunkUi({
        modelName: normalizedModel,
        gpuEnabled,
        gpuLocked,
        riskyGpu,
        isCustom,
        isToriiGate
    });

    syncTagAdvancedUi({ resetToPreference: resetAdvancedToPreference || applyModelDefaults });
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
    const detail = {
        selectionMode: Boolean(AppState.selectionMode),
        selectedCount: AppState.selectedIds.size,
    };
    window.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
    document.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
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
        if (window.Gallery) {
            window.Gallery.lastSelectedIndex = null;
        }
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
        if (AppState.galleryNeedsRefresh) {
            loadImages({
                silent: AppState.images.length > 0,
                preserveExisting: AppState.images.length > 0,
                coalesce: true,
            });
            AppState.galleryNeedsRefresh = false;
        } else if (AppState.images.length > 0 && window.Gallery) {
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
    } else if (viewName === 'sorting') {
        const activeSortingSub = document.querySelector('.sorting-sub-tab.active')?.getAttribute('data-sorting-sub') || 'autosep';
        if (typeof window._switchSortingSub === 'function') {
            window._switchSortingSub(activeSortingSub);
        }
    }
}

function getSelectedGalleryExamples(ids, limit = 5) {
    return ids
        .slice(0, limit)
        .map((id) => AppState.images.find((image) => image.id === id)?.filename || `Image ${id}`)
        .join(', ');
}

function deleteSelectedGalleryImages() {
    const ids = Array.from(AppState.selectedIds)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id));

    if (ids.length === 0) {
        showToast(appT('selection.emptyHint', 'Selection mode is on. Pick images or use Select Visible.'), 'info');
        return;
    }

    const examples = getSelectedGalleryExamples(ids);
    const title = appT('selection.deleteConfirmTitle', 'Delete selected image files?');
    const message = appT(
        'selection.deleteConfirmBody',
        'This will permanently delete {count} files from disk. Examples: {examples}'
    )
        .replace('{count}', ids.length)
        .replace('{examples}', examples || ids.slice(0, 5).join(', '));

    showConfirm(title, message, async () => {
        try {
            const result = await API.deleteSelectedImages(ids);
            const failed = Array.isArray(result.failed) ? result.failed : [];
            const failedIds = new Set(failed.map((item) => Number(item.image_id)));

            ids
                .filter((id) => !failedIds.has(id))
                .forEach((id) => AppState.selectedIds.delete(id));

            updateSelectionUI();
            emitSelectionStateChanged();
            if (window.Gallery && typeof window.Gallery.syncSelectionState === 'function') {
                window.Gallery.syncSelectionState();
            }

            await loadImages();
            loadStats();

            if (failed.length > 0) {
                showToast(
                    appT('selection.deletePartial', 'Deleted {deleted} file(s). {failed} failed.')
                        .replace('{deleted}', result.deleted || 0)
                        .replace('{failed}', failed.length),
                    'warning'
                );
                return;
            }

            showToast(
                appT('selection.deleteSuccess', 'Deleted {count} image file(s).')
                    .replace('{count}', result.deleted || 0),
                'success'
            );
        } catch (error) {
            showToast(
                formatUserError(error, appT('selection.deleteFailed', 'Failed to delete selected image files')),
                'error'
            );
        }
    });
}

function updateNavigationOverflowState() {
    const navBar = $('.nav-bar');
    const navTabs = $('.nav-tabs');
    if (!navBar || !navTabs) return window.innerWidth <= 768;

    const forceMobileLayout = window.innerWidth <= 768;
    navBar.classList.remove('nav-tabs-overflow', 'nav-actions-compact');
    if (forceMobileLayout) {
        navBar.classList.add('nav-tabs-overflow');
        return true;
    }

    const navActions = $('.nav-actions');
    const navBrand = $('.nav-brand');
    const needsOverflow = () => {
        const availableWidth = Math.max(
            0,
            navBar.clientWidth - (navBrand?.offsetWidth || 0) - (navActions?.offsetWidth || 0) - 72
        );
        return availableWidth > 0 && navTabs.scrollWidth > availableWidth + 24;
    };

    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    // Compact the utility buttons first. Only collapse the primary tabs when
    // the compact desktop header still cannot fit the navigation.
    navBar.classList.add('nav-actions-compact');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.remove('nav-actions-compact');
    navBar.classList.add('nav-tabs-overflow');
    return true;
}

// ============== Event Listeners ==============

function initEventListeners() {
    // Nav tabs
    $$('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Scan button
    $('#btn-scan').addEventListener('click', () => showModal('scan-modal'));
    $('#btn-browse-folder')?.addEventListener('click', () => {
        const input = $('#scan-folder-path');
        if (input && typeof window.showFolderBrowser === 'function') {
            window.showFolderBrowser(input);
        }
    });

    // Tag button
    $('#btn-tag').addEventListener('click', () => showModal('tag-modal'));
    $('#btn-score-aesthetic')?.addEventListener('click', async () => {
        await refreshAestheticStatus();
        await startAestheticScoring(false);
    });
    $('#btn-app-update')?.addEventListener('click', () => {
        void handleAppUpdateButtonClick();
    });
    $('#mobile-btn-app-update')?.addEventListener('click', () => {
        closeMobileMenu();
        void handleAppUpdateButtonClick();
    });

    // Modal backdrops
    $$('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            const modal = backdrop.parentElement;
            // For tag-modal, use cancelTagging logic to minimize to background
            if (modal && modal.id === 'tag-modal') {
                minimizeTaggingToBackground();
                return;
            }
            if (modal && modal.id === 'filter-modal') {
                closeFilterModal();
                return;
            }
            if (modal && modal.id === 'tags-library-modal') {
                finishTagsLibraryInteraction();
                return;
            }
            if (modal) hideModal(modal.id);
        });
    });

    // Scan modal
    $('#btn-cancel-scan').addEventListener('click', requestStopScan);
    $('#btn-start-scan').addEventListener('click', startScan);

    // Tag modal X close button — minimize to background if tagging
    $('#btn-close-tag-modal')?.addEventListener('click', () => minimizeTaggingToBackground());
    // UI-02: Inline validation for scan folder path
    const scanFolderPathInput = $('#scan-folder-path');
    if (scanFolderPathInput) {
        const debouncedValidation = debounce(validateScanFolderPath, 300);
        scanFolderPathInput.addEventListener('input', debouncedValidation);
        scanFolderPathInput.addEventListener('blur', validateScanFolderPath);
    }

    // Tag modal
    $('#btn-cancel-tag').addEventListener('click', minimizeTaggingToBackground);
    $('#btn-start-tag').addEventListener('click', startTagging);
    $('#btn-export-tags-json')?.addEventListener('click', exportTagLibraryJson);

    // Tag threshold sliders
    $('#tag-threshold').addEventListener('input', (e) => {
        e.target.dataset.userChosen = '1';
        $('#tag-threshold-value').textContent = e.target.value;
        syncTagAdvancedUi();
    });
    $('#tag-character-threshold').addEventListener('input', (e) => {
        e.target.dataset.userChosen = '1';
        $('#tag-character-threshold-value').textContent = e.target.value;
        syncTagAdvancedUi();
    });
    $('#tag-retag-all')?.addEventListener('change', () => syncTagAdvancedUi());

    // Model selection toggle for custom model
    $('#tag-model-select').addEventListener('change', () => {
        delete $('#tag-use-gpu')?.dataset.userChosen;
        syncTaggerModelUi({ applyModelDefaults: true, toastOnAutoSafe: true });
    });
    $('#tag-use-gpu')?.addEventListener('change', () => {
        $('#tag-use-gpu').dataset.userChosen = '1';
        syncTaggerModelUi({ applyModelDefaults: false });
    });
    $('#tagger-batch-size')?.addEventListener('change', (event) => {
        event.target.dataset.userChosen = '1';
        syncTaggerModelUi({ applyModelDefaults: false });
    });
    $('#scan-advanced-options')?.addEventListener('toggle', (event) => {
        writeStoredBoolean(SCAN_ADVANCED_OPEN_KEY, Boolean(event.currentTarget?.open));
    });
    $('#tag-advanced-options')?.addEventListener('toggle', (event) => {
        writeStoredBoolean(TAG_ADVANCED_OPEN_KEY, Boolean(event.currentTarget?.open));
    });
    ['scan-force-reparse', 'scan-cleanup-missing', 'scan-auto-tag'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => syncScanAdvancedUi());
    });
    syncScanAdvancedUi({ resetToPreference: true });
    syncTaggerModelUi({ applyModelDefaults: true });

    // Image modal
    $('#modal-close').addEventListener('click', () => hideModal('image-modal'));

    // Clear all filters button (sidebar)
    $('#btn-clear-filters').addEventListener('click', () => {
        resetAllFilters();
        hideModal('filter-modal');  // In case it's open
    });

    // View mode buttons
    $$('.view-btn[data-size]').forEach(btn => {
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
        if (AppState.filters.sortBy === 'aesthetic') {
            if (!_aestheticStatus.available) {
                showToast(_aestheticStatus.message || appT('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable — required dependencies not installed'), 'warning');
                e.target.value = 'newest';
                AppState.filters.sortBy = 'newest';
            } else if (_aestheticStatus.scored_count === 0) {
                showToast(appT('gallery.aestheticNeedScoring', 'No images have been scored yet. Click the ⭐ button in the toolbar to score your images first.'), 'info');
            }
        }
        updateSortReverseButton();
        loadImages();
    });

    $('#btn-open-model-manager')?.addEventListener('click', openModelManager);
    $('#model-manager-close')?.addEventListener('click', () => hideModal('model-manager-modal'));

    // Sort reverse button
    $('#sort-reverse-btn').addEventListener('click', () => {
        const current = AppState.filters.sortBy;
        const reversed = SORT_REVERSE_MAP[current];
        if (reversed && reversed !== current) {
            AppState.filters.sortBy = reversed;
            updateSortReverseButton();
            loadImages();
        }
    });




    // Clear DB button
    $('#btn-clear-db').addEventListener('click', () => {
        showConfirm(
            appT('gallery.clearTitle', 'Clear Gallery'),
            appT('gallery.clearMessage', 'Are you sure you want to clear all images from the database? This will NOT delete your physical files.'),
            async () => {
                try {
                    await API.clearGallery();
                    showToast(appT('gallery.clearSuccess', 'Gallery cleared successfully'));
                    loadImages();
                    loadStats();
                } catch (e) {
                    showToast(formatUserError(e, appT('gallery.clearFailed', 'Failed to clear gallery')), "error");
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
    $('#btn-export-selected').addEventListener('click', () => {
        resetSelectionDataCache();
        showExportModal();
    });

    // Clear selection
    $('#btn-clear-selection').addEventListener('click', () => {
        if (window.Gallery && typeof Gallery.clearSelection === 'function') {
            Gallery.clearSelection();
        } else {
            AppState.selectedIds.clear();
            updateSelectionUI();
            emitSelectionStateChanged();
        }
    });

    // Select visible gallery items
    $('#btn-select-all').addEventListener('click', () => {
        if (window.Gallery && typeof Gallery.selectAllVisible === 'function') {
            Gallery.selectAllVisible();
        }
    });

    $('#btn-invert-selection-visible')?.addEventListener('click', () => {
        if (window.Gallery && typeof Gallery.invertVisibleSelection === 'function') {
            Gallery.invertVisibleSelection();
        }
    });

    $('#btn-delete-selected-files')?.addEventListener('click', deleteSelectedGalleryImages);


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
        copyTextToClipboard(text, appT('export.copied', 'Copied to clipboard!')).catch(() => {
            showToast(appT('export.copyFailed', 'Failed to copy'), 'error');
        });
    });
    // --- Export Tags from FAB ---
    $('#btn-export-tags-selected').addEventListener('click', () => {
        resetSelectionDataCache();
        showExportTagsModal();
    });

    // --- Alt export button in modal ---
    const exportTagsAlt = $('#btn-export-tags-alt');
    if (exportTagsAlt) {
        exportTagsAlt.addEventListener('click', () => {
            if (exportTagsAlt.dataset.exportView === 'prompts') {
                showExportTagsModal();
            } else {
                showExportModal();
            }
        });
    }

    // --- Unified Filter Modal ---
    $('#btn-open-filters').addEventListener('click', openFilterModal);

    // --- UI Desktop Sidebar Toggle ---
    const btnCollapseDesktop = $('#btn-collapse-desktop-sidebar');
    const btnRestoreDesktop = $('#btn-restore-desktop-sidebar');
    const sidebarDesktop = $('.filter-sidebar');
    const galleryDesktop = $('.gallery-container');

    const toggleDesktopSidebar = (collapse) => {
        if(collapse) {
            sidebarDesktop?.classList.add('desktop-collapsed');
            galleryDesktop?.classList.add('desktop-collapsed');
            if(btnRestoreDesktop) btnRestoreDesktop.style.display = 'block';
            localStorage.setItem('desktop-sidebar-collapsed', 'true');
        } else {
            sidebarDesktop?.classList.remove('desktop-collapsed');
            galleryDesktop?.classList.remove('desktop-collapsed');
            if(btnRestoreDesktop) btnRestoreDesktop.style.display = 'none';
            localStorage.setItem('desktop-sidebar-collapsed', 'false');
        }
    };

    if (localStorage.getItem('desktop-sidebar-collapsed') === 'true') {
        toggleDesktopSidebar(true);
    }

    btnCollapseDesktop?.addEventListener('click', () => toggleDesktopSidebar(true));
    btnRestoreDesktop?.addEventListener('click', () => toggleDesktopSidebar(false));
    $('#btn-close-filter-modal').addEventListener('click', closeFilterModal);
    $('#btn-apply-modal-filters').addEventListener('click', applyModalFilters);
    $('#btn-reset-filters').addEventListener('click', resetAllFilters);
    $('#btn-clear-artist')?.addEventListener('click', clearArtistFilter);
    $('#filter-modal')?.addEventListener('change', () => updateFilterModalSummary());
    $('#filter-modal')?.addEventListener('input', () => updateFilterModalSummary());

    // Aesthetic quick filter buttons
    $$('.aesthetic-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const minInput = $('#filter-aesthetic-min');
            const maxInput = $('#filter-aesthetic-max');
            if (minInput) minInput.value = btn.dataset.min || '';
            if (maxInput) maxInput.value = btn.dataset.max || '';
            updateFilterModalSummary();
        });
    });

    // Modal tag search (debounced)
    const debouncedTagSearch = debounce((value) => searchModalTags(value), 300);
    $('#modal-tag-search')?.addEventListener('input', (e) => debouncedTagSearch(e.target.value));

    // Tag input Enter key - add comma-separated tags
    $('#modal-tag-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const input = e.target.value.trim();
            if (input) {
                const filterState = getFilterModalState();
                const tags = input.split(',').map(t => t.trim()).filter(t => t.length > 0);
                const newTags = tags.filter(tag => !filterState.tags.includes(tag));
                if (newTags.length > 0) {
                    filterState.tags = [...filterState.tags, ...newTags];
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
                    const filterState = getFilterModalState();
                    // Normalize: lowercase + underscore→space, then dedup against existing
                    const normalize = s => s.toLowerCase().replace(/_/g, ' ').trim();
                    const prompts = input.split(',').map(p => normalize(p)).filter(p => p.length > 0);
                    const existingNormalized = filterState.prompts.map(normalize);
                    const newPrompts = prompts.filter(prompt => !existingNormalized.includes(prompt));
                    if (newPrompts.length > 0) {
                        filterState.prompts = [...filterState.prompts, ...newPrompts];
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
        const returnFilterOptions = {
            mode: FilterModalController.mode || 'gallery',
            titleText: FilterModalController.titleText || null,
            filterState: getFilterModalState(),
            onApply: FilterModalController.onApply,
            onReset: FilterModalController.onReset,
            applyButtonText: FilterModalController.applyButtonText,
            resetButtonText: FilterModalController.resetButtonText,
            optionData: FilterModalController.optionData,
        };
        hideModal('filter-modal');
        openTagsLibrary({
            filterState: getFilterModalState(),
            returnFilterOptions,
            optionData: FilterModalController.optionData,
        });
    });
    $('#btn-close-tags-library')?.addEventListener('click', finishTagsLibraryInteraction);
    $('#btn-close-tags-library-2')?.addEventListener('click', finishTagsLibraryInteraction);
    $('#library-search')?.addEventListener('input', filterLibraryContent);
    $('#library-sort')?.addEventListener('change', loadLibraryContent);
    // Library tab switching
    $('#library-tab-tags')?.addEventListener('click', () => switchLibraryTab('tags'));
    $('#library-tab-prompts')?.addEventListener('click', () => switchLibraryTab('prompts'));
    $('#library-tab-loras')?.addEventListener('click', () => switchLibraryTab('loras'));

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
                appT('tag.importTitle', 'Import Tags'),
                appT(
                    'tag.importMessage',
                    'Found {count} images in the file.\n\nOverwrite existing tags?\nOK = overwrite existing tags\nCancel = keep existing tags',
                    { count: data.images.length }
                ),
                async () => {
                    // Overwrite = true
                    const result = await API.importTags(data.images, true);
                    showToast(appT('tag.importSuccess', 'Imported tags for {imported} images ({skipped} skipped)', {
                        imported: result.imported,
                        skipped: result.skipped,
                    }), 'success');
                    loadImages();
                },
                async () => {
                    // Overwrite = false (skip already-tagged)
                    const result = await API.importTags(data.images, false);
                    showToast(appT('tag.importSuccess', 'Imported tags for {imported} images ({skipped} skipped)', {
                        imported: result.imported,
                        skipped: result.skipped,
                    }), 'success');
                    loadImages();
                }
            );
        } catch (err) {
            showToast(formatUserError(err, appT('tag.importFailed', 'Failed to import tags')), 'error');
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

    // Handle resize - keep nav usable when tabs overflow on desktop
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const collapsed = updateNavigationOverflowState();
            if (!collapsed) {
                const filterSidebar = $('.filter-sidebar');
                if (filterSidebar) {
                    filterSidebar.classList.remove('mobile-visible');
                }
            }
        }, 150);
    });

    updateNavigationOverflowState();
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

function resetScanFolderValidation() {
    const input = $('#scan-folder-path');
    const feedback = $('#scan-folder-feedback');
    if (input) {
        input.classList.remove('input-valid', 'input-invalid', 'input-checking');
    }
    if (feedback) {
        feedback.className = 'validation-feedback';
        feedback.textContent = '';
    }
}

function setScanFolderValidation(state, message = '') {
    const input = $('#scan-folder-path');
    const feedback = $('#scan-folder-feedback');
    if (!input || !feedback) return;

    input.classList.remove('input-valid', 'input-invalid', 'input-checking');
    feedback.className = 'validation-feedback';

    if (state === 'success') {
        input.classList.add('input-valid');
        feedback.classList.add('success');
    } else if (state === 'error') {
        input.classList.add('input-invalid');
        feedback.classList.add('error');
    } else if (state === 'checking') {
        input.classList.add('input-checking');
        feedback.classList.add('checking');
    }

    feedback.textContent = message;
}

function mapScanPathError(error) {
    const rawMessage = (error instanceof Error ? error.message : String(error || '')).trim();
    const message = rawMessage.toLowerCase();

    if (!rawMessage) {
        return appT('scan.invalidPath', 'Path format is invalid');
    }
    if (message.includes('invalid filename characters')) {
        return appT('scan.invalidFolderName', 'Folder name contains unsupported characters');
    }
    if (message.includes('invalid or suspicious characters')) {
        return appT('scan.invalidPathChars', 'Path contains invalid characters');
    }
    if (message.includes('does not exist') || message.includes('not exist') || message.includes('not found')) {
        return appT('scan.folderNotFound', 'Folder not found');
    }
    if (message.includes('not a directory')) {
        return appT('scan.pathNotFolder', 'This path is not a folder');
    }
    if (message.includes('maximum length')) {
        return appT('scan.pathTooLong', 'Path is too long');
    }
    if (message.includes('cannot resolve path') || message.includes('invalid path format')) {
        return appT('scan.invalidPath', 'Path format is invalid');
    }

    return rawMessage;
}

function isScanPathError(error) {
    const rawMessage = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
    return rawMessage.includes('path')
        || rawMessage.includes('directory')
        || rawMessage.includes('folder')
        || rawMessage.includes('filename');
}

// UI-02: Validate scan folder path with inline feedback
function validateScanFolderPath() {
    const input = $('#scan-folder-path');
    if (!input) return true;
    const value = input.value.trim();

    resetScanFolderValidation();

    if (!value) {
        return; // Empty is neutral state
    }

    // Basic path validation — exclude `:` so Windows drive letters (C:\) are allowed
    const invalidChars = /[<>"|?*]/;
    if (invalidChars.test(value)) {
        setScanFolderValidation('error', appT('scan.invalidPathChars', 'Path contains invalid characters'));
        return false;
    }

    // Show checking state
    setScanFolderValidation('checking', appT('scan.pathChecking', 'Checking path...'));
    const requestValue = value;

    // Use API to validate (server-side)
    API.post('/api/validate-path', { path: value })
        .then(result => {
            if (input.value.trim() !== requestValue) return;
            if (result.valid) {
                setScanFolderValidation('success', appT('scan.folderFound', 'Folder found'));
            } else {
                setScanFolderValidation('error', mapScanPathError(result.error || appT('scan.invalidPath', 'Path format is invalid')));
            }
        })
        .catch((error) => {
            if (input.value.trim() !== requestValue) return;
            // If validation endpoint doesn't exist, just clear checking state
            setScanFolderValidation('', isScanPathError(error) ? mapScanPathError(error) : '');
        });

    return true;
}

async function startScan() {
    const folderPath = $('#scan-folder-path')?.value?.trim() || '';
    if (!folderPath) {
        showToast(appT('scan.enterFolder', 'Please choose a folder first'), 'error');
        return;
    }

    const recursive = $('#scan-recursive')?.checked ?? true;
    const quickImport = $('#scan-quick-import')?.checked ?? true;
    const forceReparse = $('#scan-force-reparse')?.checked ?? false;
    const cleanupMissing = $('#scan-cleanup-missing')?.checked ?? false;

    try {
        addRecentFolder(folderPath);
        await API.startScan(folderPath, {
            recursive,
            quickImport,
            forceReparse,
            cleanupMissing,
        });

        const progressContainer = $('#scan-progress-container');
        const startBtn = $('#btn-start-scan');
        if (progressContainer) progressContainer.style.display = 'block';
        if (startBtn) startBtn.disabled = true;
        setScanCancelButtonState('running');
        lockLiveProgressText('#scan-progress-text');
        resetProgressTracker(_scanProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        $('#scan-progress-text').textContent = appT('scan.waitingForUpdate', 'Import · waiting for first update...');
        showToast(
            appT('scan.startedToast', 'Import started. The first images will appear soon, and the rest of the details will keep filling in.'),
            'info'
        );

        pollScanProgress();
    } catch (error) {
        const userMessage = mapScanPathError(error);
        if (isScanPathError(error)) {
            setScanFolderValidation('error', userMessage);
        }
        const rawMessage = error instanceof Error ? error.message : String(error || '');
        const toastMessage = userMessage !== rawMessage
            ? userMessage
            : formatUserError(error, appT('scan.failedStart', 'Failed to start import'));
        showToast(toastMessage, "error");
    }
}

async function requestStopScan() {
    const progress = await API.getScanProgress().catch(() => null);
    if (!progress || !['running', 'cancelling'].includes(progress.status)) {
        hideModal('scan-modal');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        return;
    }

    try {
        const result = await API.cancelScan();
        const processed = Number(progress.processed ?? progress.current ?? 0);
        const total = Number(progress.total || 0);
        const totalFinal = progress?.total_final !== false;
        setScanCancelButtonState(result?.status === 'cancelled' ? 'idle' : 'cancelling');
        $('#scan-progress-text').textContent = (result?.status === 'cancelled')
            ? appT('scan.cancelled', 'Scan cancelled')
            : totalFinal
                ? appT('scan.cancelling', 'Cancelling scan... {current}/{total}')
                    .replace('{current}', String(processed))
                    .replace('{total}', String(total || '?'))
                : appT('scan.backgroundCancelling', 'Stopping scan...');
        showToast(
            result?.status === 'cancelled'
                ? appT('scan.cancelled', 'Scan cancelled')
                : appT('scan.cancellingAfterCurrent', 'Stopping scan after the current file...'),
            'info'
        );
        if (result?.status === 'cancelled') {
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _hideBgScanProgress();
        }
    } catch (error) {
        showToast(formatUserError(error, appT('scan.failedCancel', 'Failed to stop import')), 'error');
    }
}

function _refreshScanDrivenViews(force = false, options = {}) {
    const {
        refreshGallery = true,
    } = options;
    const now = Date.now();
    if (!force && now - _scanLastAutoRefreshAt < 2500) {
        return;
    }
    _scanLastAutoRefreshAt = now;
    promptsLibraryCache = null;
    if (refreshGallery) {
        if (AppState.currentView === 'gallery') {
            loadImages({
                silent: true,
                preserveExisting: true,
                coalesce: true,
            });
            AppState.galleryNeedsRefresh = false;
        } else {
            AppState.galleryNeedsRefresh = true;
        }
    }
    loadStats();
}

function _updateBgScanProgress(progress) {
    const bar = $('#bg-scan-progress');
    if (!bar) return;

    if (!['running', 'cancelling'].includes(progress?.status)) {
        bar.style.display = 'none';
        return;
    }

    const scanModal = $('#scan-modal');
    const modalOpen = scanModal && scanModal.classList.contains('visible');
    bar.style.display = modalOpen ? 'none' : 'flex';

    const processed = Number(progress?.processed ?? progress?.current ?? 0);
    const total = Number(progress?.total || 0);
    const totalFinal = progress?.total_final !== false;
    const metadataProcessed = Number(progress?.metadata_processed || 0);
    const metadataTotal = Number(progress?.metadata_total || 0);
    const percentBase = progress?.step === 'metadata' && metadataTotal > 0
        ? (metadataProcessed / metadataTotal) * 100
        : (totalFinal && total > 0 ? (processed / total) * 100 : 0);

    const fill = $('#bg-scan-progress-fill');
    const textEl = $('#bg-scan-progress-text');
    const isIndeterminate = ['running', 'cancelling'].includes(progress?.status) && (
        progress?.step === 'metadata'
            ? (!percentBase || percentBase === 0)
            : (!totalFinal || !percentBase || percentBase === 0)
    );
    if (fill) {
        fill.classList.toggle('is-indeterminate', isIndeterminate);
        fill.style.width = isIndeterminate ? '' : (Math.min(100, percentBase) + '%');
    }

    if (textEl) {
        if (progress?.status === 'cancelling') {
            textEl.textContent = appT('scan.backgroundCancelling', 'Stopping scan...');
        } else if (progress?.step === 'metadata') {
            textEl.textContent = `${appT('scan.backgroundMetadata', 'Filling in image details...')} ${metadataProcessed}/${metadataTotal || '?'}`;
        } else if (!totalFinal) {
            textEl.textContent = appT('scan.backgroundDiscovering', '{count} scanned. Discovering more images...')
                .replace('{count}', String(processed));
        } else {
            textEl.textContent = progress?.message || appT('scan.backgroundImporting', 'Bringing images into your library...');
        }
    }
}

function _hideBgScanProgress() {
    const bar = $('#bg-scan-progress');
    if (bar) bar.style.display = 'none';
}

function _initBgScanProgressButtons() {
    const cancelBtn = $('#bg-scan-cancel');
    const openBtn = $('#bg-scan-open');

    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            await requestStopScan();
        });
    }

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            showModal('scan-modal');
        });
    }
}

async function pollScanProgress(retryCount = 0) {
    try {
        const progress = await API.getScanProgress();

        const processed = Number(progress.processed ?? progress.current ?? 0);
        const total = Number(progress.total || 0);
        const totalFinal = progress.total_final !== false;
        const metadataProcessed = Number(progress.metadata_processed || 0);
        const metadataTotal = Number(progress.metadata_total || 0);
        const effectiveTotal = totalFinal ? total : 0;
        const percent = effectiveTotal > 0 ? Math.min(100, (processed / effectiveTotal) * 100) : 0;
        const scanFillEl = $('#scan-progress-fill');
        const scanIndeterminate = progress.status === 'running' && (!totalFinal || effectiveTotal === 0);
        if (scanFillEl) {
            scanFillEl.classList.toggle('is-indeterminate', scanIndeterminate);
            scanFillEl.style.width = scanIndeterminate ? '' : (percent + '%');
        }

        const errorCount = Number(progress.errors || 0);
        const newCount = Number(progress.new || 0);
        const updatedCount = Number(progress.updated || 0);
        const removedCount = Number(progress.removed || 0);
        const remaining = totalFinal && total > 0 ? Math.max(0, total - processed) : 0;
        const extraParts = [];
        if (totalFinal && total > 0) {
            extraParts.push(appT('progress.left', '{count} left').replace('{count}', remaining));
        } else if (processed > 0) {
            extraParts.push(appT('progress.discoveredCount', '{count} scanned').replace('{count}', processed));
        }
        if (progress.step === 'metadata' && metadataTotal > 0) {
            extraParts.push(
                appT('progress.metadataCount', '{current}/{total} metadata')
                    .replace('{current}', metadataProcessed)
                    .replace('{total}', metadataTotal)
            );
        }
        if (newCount > 0) extraParts.push(appT('progress.newCount', '{count} new').replace('{count}', newCount));
        if (updatedCount > 0) extraParts.push(appT('progress.updatedCount', '{count} updated').replace('{count}', updatedCount));
        if (removedCount > 0) extraParts.push(appT('progress.removedCount', '{count} removed').replace('{count}', removedCount));
        if (errorCount > 0) extraParts.push(appT('progress.failedCount', '{count} failed').replace('{count}', errorCount));

        let scanDetail = progress.current_item || progress.message || 'Importing images...';
        if (progress.step === 'importing' && !totalFinal) {
            scanDetail = appT('progress.discoveringMore', '{count} scanned. Discovering more images...')
                .replace('{count}', processed);
        }

        $('#scan-progress-text').textContent = buildOperationProgressText({
            completed: processed,
            total: effectiveTotal,
            tracker: _scanProgressTracker,
            primaryLabel: appT('scan.progressLabel', 'Import'),
            extraParts,
            detail: scanDetail,
            defaultMessage: 'Importing images...',
        });

        _updateBgScanProgress(progress);

        if (progress.library_ready && !_scanLibraryReadyHandled && progress.status === 'running') {
            _scanLibraryReadyHandled = true;
            hideModal('scan-modal');
            _refreshScanDrivenViews(true, { refreshGallery: true });
            showToast(
                appT('scan.libraryReadyToast', 'Library is ready. Metadata is still loading in the background.'),
                'info'
            );
        }

        if (progress.status === 'running' && progress.library_ready) {
            // Keep the gallery stable while import continues in the background.
            // Re-rendering the grid every few seconds made large scans feel like
            // the gallery was stuck loading again.
            if (AppState.currentView !== 'gallery') {
                AppState.galleryNeedsRefresh = true;
            }
        }

        if (progress.status === 'done') {
            const errorCount = Number(progress.errors || progress.result?.errors || 0);
            const completionMessage = _scanLibraryReadyHandled
                ? appT('scan.completedBackgroundToast', 'The remaining image details are ready now.')
                : (progress.message || appT('scan.completedToast', 'Import complete. Everything is ready now.'));
            showToast(completionMessage, errorCount > 0 ? 'warning' : 'success');
            hideModal('scan-modal');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _scanLibraryReadyHandled = false;
            _scanLastAutoRefreshAt = 0;
            _hideBgScanProgress();
            _refreshScanDrivenViews(true, { refreshGallery: true });
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
        } else if (progress.status === 'cancelled') {
            showToast(progress.message || appT('scan.cancelled', 'Scan cancelled'), 'info');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _scanLibraryReadyHandled = false;
            _scanLastAutoRefreshAt = 0;
            _hideBgScanProgress();
        } else if (progress.status === 'error') {
            showToast(progress.message || appT('scan.failedStatus', 'Import failed'), 'error');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _scanLibraryReadyHandled = false;
            _scanLastAutoRefreshAt = 0;
            _hideBgScanProgress();
        } else if (progress.status === 'running') {
            setScanCancelButtonState('running');
            setTimeout(() => pollScanProgress(0), 500);
        } else if (progress.status === 'cancelling') {
            setScanCancelButtonState('cancelling');
            setTimeout(() => pollScanProgress(0), 250);
        } else if (progress.status === 'idle' && retryCount < 10) {
            // Allow a brief idle window when attaching to an in-flight background task.
            setTimeout(() => pollScanProgress(0), 500);
        } else if (progress.status === 'idle') {
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _scanLibraryReadyHandled = false;
            _scanLastAutoRefreshAt = 0;
            _hideBgScanProgress();
        }
    } catch (error) {
        Logger.error('Poll error:', error);
        if (retryCount < 3) {
            setTimeout(() => pollScanProgress(retryCount + 1), 1000);
        } else {
            showToast(appT('scan.failedProgress', 'Could not update import progress'), 'error');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _scanLibraryReadyHandled = false;
            _scanLastAutoRefreshAt = 0;
            _hideBgScanProgress();
        }
    }
}

async function resumeScanProgress() {
    try {
        const progress = await API.getScanProgress();
        const hasMeaningfulProgress = Number(progress?.current || 0) > 0 || Number(progress?.total || 0) > 0;
        if (progress?.status !== 'running' && !(progress?.status === 'idle' && hasMeaningfulProgress)) {
            _hideBgScanProgress();
            return;
        }

        if (progress?.library_ready && progress?.status === 'running') {
            _scanLibraryReadyHandled = true;
            _updateBgScanProgress(progress);
            pollScanProgress();
            return;
        }

        const progressContainer = $('#scan-progress-container');
        const startBtn = $('#btn-start-scan');
        if (progressContainer) progressContainer.style.display = 'block';
        if (startBtn) startBtn.disabled = true;
        setScanCancelButtonState(progress?.status === 'cancelling' ? 'cancelling' : 'running');
        lockLiveProgressText('#scan-progress-text');
        resetProgressTracker(_scanProgressTracker);
        $('#scan-progress-text').textContent = progress.message || 'Resuming scan progress...';
        _updateBgScanProgress(progress);
        pollScanProgress();
    } catch (error) {
        Logger.warn('Failed to resume scan progress:', error);
    }
}

// ============== Tagging ==============

let _tagProgressTimer = null;
let _tagPollingActive = false;
let _tagMinimizedToBackground = false;
let _tagLastProgressPercent = 0;
let _tagLastProgressText = '';
let _tagLastCurrent = 0;
let _tagLastTotal = 0;
let _scanProgressTracker = createProgressTracker();
let _scanLibraryReadyHandled = false;
let _scanLastAutoRefreshAt = 0;
let _tagProgressTracker = createProgressTracker();

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

function resetTagUiProgressState() {
    _tagMinimizedToBackground = false;
    _tagLastProgressPercent = 0;
    _tagLastProgressText = '';
    _tagLastCurrent = 0;
    _tagLastTotal = 0;
    resetProgressTracker(_tagProgressTracker);
}

function minimizeTaggingToBackground() {
    if (!_tagPollingActive) {
        hideModal('tag-modal');
        _hideBgTagProgress();
        return;
    }

    _tagMinimizedToBackground = true;
    hideModal('tag-modal');
    _updateBgTagProgress(
        _tagLastProgressPercent,
        _tagLastProgressText || appT('tagger.progressPreparing', 'Preparing tagger...'),
        'running'
    );
    showToast(appT('tagger.minimizedToBackground', 'Tagging continues in the background. Use the progress bar to stop or check details.'), 'info');
}

async function requestStopTagging() {
    if (!_tagPollingActive) {
        hideModal('tag-modal');
        _hideBgTagProgress();
        return;
    }

    try {
        await API.cancelTagging();
        _tagMinimizedToBackground = true;
        _updateBgTagProgress(
            _tagLastProgressPercent,
            appT('tagger.progressCancelling', 'Cancelling... {current}/{total}')
                .replace('{current}', String(_tagLastCurrent))
                .replace('{total}', String(_tagLastTotal)),
            'cancelling'
        );
        showToast(appT('tagger.cancellingAfterCurrent', 'Cancelling after current image...'), 'info');
    } catch (err) {
        showToast(formatUserError(err, 'Failed to cancel'), 'error');
    }
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
        startBtn.textContent = isRunning
            ? appT('tag.running', 'Tagging...')
            : appT('tag.startTagging', 'Start Tagging');
    }

    if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = isRunning
            ? appT('tagger.runInBackground', 'Run in Background')
            : (options.idleLabel || appT('common.close', 'Close'));
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
        showToast(appT('tag.tagsExported', 'Tags exported'), 'success');
    } catch (error) {
        showToast(formatUserError(error, appT('tag.exportFailed', 'Failed to export tags')), 'error');
    }
}

async function startTagging() {
    const t = (key, fallback) => window.I18n?.t?.(key) || fallback;
    if (!hasLoadedTaggerSystemInfo() && typeof loadSystemInfo === 'function') {
        await loadSystemInfo();
    }
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
        showToast(modelMeta.disabled_reason || appT('tag.modelUnavailable', 'This tagger model is not available in the current build.'), 'warning');
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
            showToast(appT('tag.modelPathRequired', 'Please enter a model path'), 'error');
            return;
        }

        if (!tagsPath) {
            showToast(appT('tag.tagsCsvRequired', 'Please enter a Tags CSV path'), 'error');
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
    options.batchSize = isToriiGateTaggerModel(modelSelect, { isCustom: isCustomModel })
        ? 1
        : (batchSelect
            ? Math.min(128, parseInt(batchSelect.value, 10) || getRecommendedTaggerChunkSize(modelSelect, { isCustom: isCustomModel, useGpu: options.useGpu }))
            : Math.min(128, getRecommendedTaggerChunkSize(modelSelect, { isCustom: isCustomModel, useGpu: options.useGpu })));

    if (gpuLocked) {
        options.useGpu = false;
        options.allowUnsafeAcceleration = false;
        if (useGpuCheckbox) {
            useGpuCheckbox.checked = false;
        }
        syncTaggerModelUi({ applyModelDefaults: false });
    }

    try {
        await API.startTagging(options);

        _tagPollingActive = true;
        resetTagUiProgressState();
        clearTagProgressTimer();

        $('#tag-progress-container').style.display = 'block';
        lockLiveProgressText('#tag-progress-text');
        $('#tag-progress-fill').style.width = '0%';
        _tagLastProgressPercent = 0;
        _tagLastProgressText = gpuLocked
            ? t('tag.preparingMaxQuality', 'Preparing Max Quality model in protected CPU Safe Mode...')
            : (options.useGpu
                ? t('tag.preparingGpu', 'Preparing model on GPU...')
                : t('tag.preparingCpu', 'Preparing model on CPU...'));
        $('#tag-progress-text').textContent = _tagLastProgressText;
        setTaggingUiState(true);

        pollTagProgress();
    } catch (error) {
        _tagPollingActive = false;
        clearTagProgressTimer();
        showToast(formatUserError(error, appT('tag.startFailed', 'Failed to start tagging')), 'error');
    }
}

async function pollTagProgress() {
    if (!_tagPollingActive) return;

    try {
        const progress = await API.getTagProgress();
        window.__liveTagProgress = progress;
        syncTaggerModelUi();

        // UI-03: Improved progress display with ETA
        const current = (progress.processed ?? progress.current ?? 0);
        const total = progress.total || 0;
        const percent = total > 0 ? (current / total) * 100 : 0;
        _tagLastCurrent = current;
        _tagLastTotal = total;
        const tagged = Number(progress.tagged || 0);
        const errors = Number(progress.errors || 0);

        const fillEl = $('#tag-progress-fill');
        // No real percent yet means we are still importing modules / downloading the
        // VLM / loading the ONNX session. Switch the bar to an indeterminate "still
        // working" animation so users can see activity instead of a stuck 0%.
        const isIndeterminate = progress.status === 'running' && (total === 0 || current === 0);
        if (fillEl) {
            fillEl.classList.toggle('is-indeterminate', isIndeterminate);
            fillEl.style.width = isIndeterminate ? '' : (percent + '%');
        }

        const remaining = total > 0 ? Math.max(0, total - current) : 0;
        const extraParts = [];
        if (total > 0) extraParts.push(appT('progress.left', '{count} left').replace('{count}', remaining));
        if (tagged > 0) extraParts.push(appT('progress.taggedCount', '{count} tagged').replace('{count}', tagged));
        if (errors > 0) extraParts.push(appT('progress.failedCount', '{count} failed').replace('{count}', errors));

        let progressText = buildOperationProgressText({
            completed: current,
            total,
            tracker: _tagProgressTracker,
            primaryLabel: appT('tagger.progressLabel', 'Tagging'),
            extraParts,
            detail: progress.current_item || progress.message || appT('tagger.progressPreparing', 'Preparing tagger...'),
            defaultMessage: appT('tagger.progressPreparing', 'Preparing tagger...'),
        });

        if (progress.status === 'cancelling') {
            progressText = progress.message || appT('tagger.progressCancelling', 'Cancelling... {current}/{total}')
                .replace('{current}', current)
                .replace('{total}', Math.max(total, current));
        }

        $('#tag-progress-text').textContent = progressText;
        _tagLastProgressPercent = percent;
        _tagLastProgressText = progressText;

        // Update background progress bar (always, even if modal is closed)
        _updateBgTagProgress(percent, progressText, progress.status);

        if (progress.status === 'done') {
            window.__liveTagProgress = null;
            _tagPollingActive = false;
            clearTagProgressTimer();
            _hideBgTagProgress();
            _showCompletionFlash();
            showToast(progress.message, errors > 0 ? 'warning' : 'success');
            hideModal('tag-modal');
            $('#tag-progress-container').style.display = 'none';
            unlockLiveProgressText('#tag-progress-text', 'modal.tagLoadingModel', 'Loading model...');
            setTaggingUiState(false);
            resetTagUiProgressState();
            syncTaggerModelUi();
            promptsLibraryCache = null; // Invalidate cache after tagging
            loadImages();
            loadStats();
        } else if (progress.status === 'cancelled') {
            window.__liveTagProgress = null;
            _tagPollingActive = false;
            clearTagProgressTimer();
            _hideBgTagProgress();
            showToast(progress.message || appT('tagger.progressCancelled', 'Tagging cancelled'), 'info');
            $('#tag-progress-container').style.display = 'none';
            unlockLiveProgressText('#tag-progress-text', 'modal.tagLoadingModel', 'Loading model...');
            setTaggingUiState(false);
            resetTagUiProgressState();
            syncTaggerModelUi();
        } else if (progress.status === 'running') {
            scheduleTagProgressPoll(500);
        } else if (progress.status === 'cancelling') {
            scheduleTagProgressPoll(300);
        } else if (progress.status === 'error') {
            window.__liveTagProgress = null;
            _tagPollingActive = false;
            clearTagProgressTimer();
            _hideBgTagProgress();
            showToast(progress.message, 'error');
            $('#tag-progress-container').style.display = 'none';
            unlockLiveProgressText('#tag-progress-text', 'modal.tagLoadingModel', 'Loading model...');
            setTaggingUiState(false);
            resetTagUiProgressState();
            syncTaggerModelUi();
        } else {
            scheduleTagProgressPoll(500);
        }
    } catch (error) {
        window.__liveTagProgress = null;
        _tagPollingActive = false;
        clearTagProgressTimer();
        _hideBgTagProgress();
        showToast(appT('tagger.errorCheckingProgress', 'Error checking tag progress'), 'error');
        $('#tag-progress-container').style.display = 'none';
        unlockLiveProgressText('#tag-progress-text', 'modal.tagLoadingModel', 'Loading model...');
        setTaggingUiState(false);
        resetTagUiProgressState();
        syncTaggerModelUi();
    }
}

// ============== Background Tagging Progress Bar ==============

function _updateBgTagProgress(percent, text, status) {
    const bar = $('#bg-tag-progress');
    if (!bar) return;
    if (!_tagPollingActive || ['idle', 'done', 'cancelled', 'error'].includes(status)) {
        bar.style.display = 'none';
        return;
    }
    const tagModal = $('#tag-modal');
    const modalOpen = tagModal && tagModal.classList.contains('visible');
    const shouldShow = _tagMinimizedToBackground || !modalOpen;
    bar.style.display = shouldShow ? 'flex' : 'none';
    const fill = $('#bg-tag-progress-fill');
    const textEl = $('#bg-tag-progress-text');
    const isIndeterminate = ['running', 'cancelling'].includes(status) && (!percent || percent === 0);
    if (fill) {
        fill.classList.toggle('is-indeterminate', isIndeterminate);
        fill.style.width = isIndeterminate ? '' : (percent + '%');
    }
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
            await requestStopTagging();
        });
    }
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            _tagMinimizedToBackground = false;
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
        _tagMinimizedToBackground = !($('#tag-modal')?.classList.contains('visible'));
        clearTagProgressTimer();
        $('#tag-progress-container').style.display = 'block';
        lockLiveProgressText('#tag-progress-text');
        _tagLastProgressPercent = 0;
        _tagLastProgressText = progress.message || appT('tagger.progressResuming', 'Resuming tagging progress...');
        $('#tag-progress-text').textContent = _tagLastProgressText;
        setTaggingUiState(true, { idleLabel: appT('common.close', 'Close') });
        // Show background progress bar (tag modal may not be open)
        const current = progress.processed || progress.current || 0;
        const total = progress.total || 0;
        const percent = total > 0 ? (current / total) * 100 : 0;
        _tagLastProgressPercent = percent;
        _updateBgTagProgress(percent, _tagLastProgressText, progress.status);
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

let _aestheticStatus = { available: false, message: '' };
let _aestheticProgressTimer = null;

function clearAestheticProgressTimer() {
    if (_aestheticProgressTimer) {
        clearTimeout(_aestheticProgressTimer);
        _aestheticProgressTimer = null;
    }
}

function updateAestheticUi({ running = false, completed = 0, total = 0 } = {}) {
    const button = $('#btn-score-aesthetic');
    const chip = $('#aesthetic-status-chip');
    if (!button || !chip) return;

    const t = (key, fallback, params) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };

    if (!_aestheticStatus.available) {
        button.disabled = true;
        button.title = _aestheticStatus.message || t('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable');
        chip.style.display = 'inline-flex';
        chip.className = 'header-status-chip is-warning';
        chip.textContent = t('gallery.aestheticUnavailableShort', 'Aesthetic unavailable');
        return;
    }

    button.disabled = running;
    button.title = running
        ? t('gallery.aestheticRunning', 'Scoring aesthetics...')
        : t('gallery.scoreAesthetic', 'Score Aesthetic');

    if (running) {
        chip.style.display = 'inline-flex';
        chip.className = 'header-status-chip is-info';
        chip.textContent = t('gallery.aestheticProgress', '{completed}/{total} scored', {
            completed,
            total: Math.max(total, completed),
        });
    } else {
        // Idle state — hide chip to reduce visual noise
        chip.style.display = 'none';
    }
}

async function refreshAestheticStatus() {
    try {
        const status = await API.getAestheticStatus();
        _aestheticStatus = {
            available: Boolean(status?.available),
            message: status?.message || '',
            scored_count: Number(status?.scored_count || 0),
        };
    } catch (error) {
        _aestheticStatus = {
            available: false,
            message: formatUserError(error, appT('gallery.aestheticStatusFailed', 'Could not check aesthetic scoring status')),
            scored_count: 0,
        };
    }

    updateAestheticUi();

    // Update sort dropdown option availability
    const sortDropdown = $('#gallery-sort');
    if (sortDropdown) {
        const aestheticOption = sortDropdown.querySelector('option[value="aesthetic"]');
        if (aestheticOption) {
            if (!_aestheticStatus.available && _aestheticStatus.scored_count === 0) {
                aestheticOption.disabled = true;
                aestheticOption.textContent = appT('sort.aestheticDisabled', 'Aesthetic Score (unavailable)');
            } else if (_aestheticStatus.scored_count === 0) {
                aestheticOption.disabled = false;
                aestheticOption.textContent = appT('sort.aestheticNoScores', 'Aesthetic Score (no scores yet - click ⭐ to score)');
            } else {
                aestheticOption.disabled = false;
                aestheticOption.textContent = appT('sort.aesthetic', 'Aesthetic Score') +
                    ` (${_aestheticStatus.scored_count} scored)`;
            }
        }
    }
}

async function pollAestheticProgress() {
    clearAestheticProgressTimer();
    try {
        const progress = await API.getAestheticProgress();
        const running = Boolean(progress?.running);
        const completed = Number(progress?.completed || 0);
        const total = Number(progress?.total || 0);

        updateAestheticUi({ running, completed, total });

        if (running) {
            _aestheticProgressTimer = setTimeout(pollAestheticProgress, 1200);
            return;
        }

        if (total > 0) {
            const errors = Number(progress?.errors || 0);
            showToast(
                errors > 0
                    ? appT('gallery.aestheticCompletedWarn', 'Aesthetic scoring finished with {errors} errors.').replace('{errors}', errors)
                    : appT('gallery.aestheticCompleted', 'Aesthetic scoring completed.'),
                errors > 0 ? 'warning' : 'success'
            );
            await loadImages();
            await loadStats();
        }
    } catch (error) {
        updateAestheticUi({ running: false });
        showToast(formatUserError(error, appT('gallery.aestheticProgressFailed', 'Failed to read aesthetic progress')), 'error');
    }
}

async function startAestheticScoring(force = false) {
    if (!_aestheticStatus.available) {
        showToast(_aestheticStatus.message || appT('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable'), 'warning');
        return;
    }

    try {
        const result = await API.startAestheticScoring(force);
        const status = String(result?.status || 'started');
        const total = Number(result?.total || 0);
        if (status === 'started' && total === 0) {
            updateAestheticUi({ running: false, completed: 0, total: 0 });
            showToast(appT('gallery.aestheticNothingToScore', 'All current images already have aesthetic scores.'), 'info');
            return;
        }
        if (status === 'started' || status === 'already_running') {
            updateAestheticUi({ running: true, completed: 0, total });
            if (status === 'started') {
                showToast(appT('gallery.aestheticStarted', 'Aesthetic scoring started in the background.'), 'info');
            }
            await pollAestheticProgress();
        }
    } catch (error) {
        showToast(formatUserError(error, appT('gallery.aestheticStartFailed', 'Failed to start aesthetic scoring')), 'error');
    }
}

// ============== Image Loading ==============

const IMAGE_LOAD_KEY = 'images-load';
let _pendingImageReload = null;

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

async function loadImages(appendMode = false, options = {}) {
    if (typeof appendMode === 'object') {
        options = appendMode;
        appendMode = false;
    }

    const {
        silent = false,
        preserveExisting = false,
        coalesce = false,
    } = options;

    if (AppState.isLoading && coalesce) {
        _pendingImageReload = { appendMode, options: { ...options } };
        return;
    }

    // Cancel any pending user-facing image load request
    if (!coalesce) {
        RequestManager.cancel(IMAGE_LOAD_KEY);
    }

    const galleryGrid = $('#gallery-grid');

    if (!appendMode && !preserveExisting) {
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
    if (galleryLoading && !silent) galleryLoading.style.display = 'flex';
    const imageCount = $('#image-count');
    if (imageCount && !appendMode && !silent) imageCount.textContent = appT('gallery.loading', 'Loading images...');

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
        resetSelectionDataCache();

        AppState.pagination.offset = Number.isFinite(result.next_offset)
            ? result.next_offset
            : AppState.images.length;

        if (imageCount) {
            imageCount.textContent = appT('gallery.imageCount', '{count} images')
                .replace('{count}', String(AppState.pagination.total || AppState.images.length));
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
        showToast(formatUserError(error, appT('gallery.loadImagesFailed', 'Failed to load images')), 'error');
    } finally {
        AppState.isLoading = false;
        if (galleryLoading && !silent) {
            galleryLoading.style.display = 'none';
        }

        // Show/hide "Load More" button based on pagination state
        const loadMoreContainer = $('#gallery-load-more');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = AppState.pagination.hasMore ? 'flex' : 'none';
        }

        requestAnimationFrame(() => {
            attachGalleryPaginationListener();
            _onGalleryScroll();
        });

        const pendingReload = _pendingImageReload;
        _pendingImageReload = null;
        if (pendingReload) {
            queueMicrotask(() => {
                loadImages(pendingReload.appendMode, pendingReload.options);
            });
        }
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

    $('#model-select-title').textContent = type === 'checkpoint'
        ? appT('modelSelect.checkpointsTitle', 'Select Models')
        : appT('modelSelect.lorasTitle', 'Select LoRAs');
    $('#model-select-search').value = '';

    renderModelSelectList();
    showModal('model-select-modal');
}

function renderModelSelectList() {
    const { type, tempSelected, search } = AppState.modalSelection;
    const items = type === 'checkpoint' ? AppState.analytics.checkpoints : AppState.analytics.loras;
    const list = $('#model-select-list');

    if (!items || items.length === 0) {
        list.innerHTML = `<div class="filter-empty" style="text-align: center; padding: 20px; color: var(--text-muted);">${escapeHtml(appT('modelSelect.empty', 'No models found'))}</div>`;
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
    prompts: [],
    loras: [],
    filterState: null,
    returnFilterOptions: null,
    optionData: null,
};

function openTagsLibrary(options = {}) {
    libraryData.filterState = options.filterState || null;
    libraryData.returnFilterOptions = options.returnFilterOptions || null;
    libraryData.optionData = options.optionData || null;
    const searchInput = $('#library-search');
    if (searchInput) {
        searchInput.value = '';
    }
    showModal('tags-library-modal');
    loadLibraryContent();
}

function finishTagsLibraryInteraction() {
    const returnFilterOptions = libraryData.returnFilterOptions;
    hideModal('tags-library-modal');
    libraryData.filterState = null;
    libraryData.returnFilterOptions = null;
    libraryData.optionData = null;

    if (returnFilterOptions) {
        openFilterModal(returnFilterOptions);
    }
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
    const lorasTab = $('#library-tab-loras');
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
    if (lorasTab) {
        lorasTab.classList.toggle('active', tab === 'loras');
        lorasTab.classList.toggle('btn-secondary', tab === 'loras');
        lorasTab.classList.toggle('btn-ghost', tab !== 'loras');
    }
    loadLibraryContent();
}

async function loadLibraryContent() {
    const content = $('#library-content');
    const statsText = $('#library-stats-text');
    const sortBy = $('#library-sort')?.value || 'frequency';
    const currentTab = libraryData.currentTab;
    const t = (key, params, fallback) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };
    const loadingLabels = {
        tags: t('library.loadingTags', null, 'Loading tag library…'),
        prompts: t('library.loadingPrompts', null, 'Loading prompt library…'),
        loras: t('library.loadingLoras', null, 'Loading LoRA library…')
    };
    const loadingLabel = loadingLabels[currentTab] || loadingLabels.tags;

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
        if (libraryData.optionData) {
            if (currentTab === 'tags') {
                const tags = libraryData.optionData.tags || [];
                if (tags.length > 0) {
                    libraryData.tags = tags;
                    renderLibraryTags(tags);
                    if (statsText) {
                        statsText.textContent = t('library.tagsFound', { count: tags.length }, `${tags.length} unique tags found`);
                    }
                    return;
                }
            } else if (currentTab === 'loras') {
                const loras = libraryData.optionData.loras || [];
                if (loras.length > 0) {
                    libraryData.loras = loras;
                    renderLibraryLoras(loras);
                    if (statsText) {
                        statsText.textContent = t('library.lorasFound', { count: loras.length }, `${loras.length} unique LoRAs found`);
                    }
                    return;
                }
            } else {
                const prompts = libraryData.optionData.prompts || [];
                if (prompts.length > 0) {
                    libraryData.prompts = prompts;
                    renderLibraryPrompts(prompts);
                    if (statsText) {
                        statsText.textContent = t('library.promptsFound', { count: prompts.length }, `${prompts.length} unique prompts found`);
                    }
                    return;
                }
            }
        }

        if (currentTab === 'tags') {
            const result = await API.getTagsLibrary(sortBy);
            libraryData.tags = result.tags;
            renderLibraryTags(result.tags);
            if (statsText) {
                statsText.textContent = t('library.tagsFound', { count: result.total }, `${result.total} unique tags found`);
            }
        } else if (currentTab === 'loras') {
            const result = await API.getLorasLibrary();
            libraryData.loras = result.loras;
            renderLibraryLoras(result.loras);
            if (statsText) {
                statsText.textContent = t('library.lorasFound', { count: result.total }, `${result.total} unique LoRAs found`);
            }
        } else {
            const result = await API.getPromptsLibrary();
            libraryData.prompts = result.prompts;
            renderLibraryPrompts(result.prompts);
            if (statsText) {
                statsText.textContent = t('library.promptsFound', { count: result.total }, `${result.total} unique prompts found`);
            }
        }
    } catch (error) {
        const fallbackMessages = {
            tags: t('library.loadTagsFailed', null, 'Failed to load tag library'),
            prompts: t('library.loadPromptsFailed', null, 'Failed to load prompt library'),
            loras: t('library.loadLorasFailed', null, 'Failed to load LoRA library')
        };
        const fallbackMessage = fallbackMessages[currentTab] || fallbackMessages.tags;
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
        content.innerHTML = '<p class="empty-state-text" style="width:100%;text-align:center;padding:32px;color:var(--text-muted)">' + escapeHtml(appT('library.tagsEmpty', 'No tags found. Scan a folder and run Tag Images first.')) + '</p>';
        return;
    }
    const addHint = escapeHtml(appT('library.clickToAddFilter', 'Click to add as filter'));
    content.innerHTML = tags.map(t => `
        <div class="library-tag" data-tag="${escapeHtml(t.tag)}" title="${addHint}">
            <span class="tag-name">${escapeHtml(t.tag)}</span>
            <span class="tag-count">${t.count}</span>
        </div>
    `).join('');

    content.querySelectorAll('.library-tag').forEach(el => {
        el.addEventListener('click', () => {
            const tag = el.dataset.tag;
            const filterState = libraryData.filterState || AppState.filters;
            if (!filterState.tags.includes(tag)) {
                filterState.tags = [...filterState.tags, tag];
                if (!libraryData.returnFilterOptions) {
                    updateFilterSummary();
                    loadImages();
                }
                finishTagsLibraryInteraction();
                showToast(appT('library.addedFilter', 'Added "{value}" to filters').replace('{value}', tag), 'success');
            }
        });
    });
}

function renderLibraryPrompts(prompts) {
    const content = $('#library-content');
    content.style.flexDirection = 'row';
    if (!prompts || prompts.length === 0) {
        content.innerHTML = '<p class="empty-state-text" style="width:100%;text-align:center;padding:32px;color:var(--text-muted)">' + escapeHtml(appT('library.promptsEmpty', 'No prompts yet. Import images with prompt info first.')) + '</p>';
        return;
    }
    const addHint = escapeHtml(appT('library.clickToAddFilter', 'Click to add as filter'));
    content.innerHTML = prompts.map(p => `
        <div class="library-tag" data-prompt="${escapeHtml(p.prompt)}" title="${addHint}">
            <span class="tag-name">${escapeHtml(p.prompt)}</span>
            <span class="tag-count">${p.count}</span>
        </div>
    `).join('');

    content.querySelectorAll('.library-tag').forEach(el => {
        el.addEventListener('click', () => {
            const prompt = el.dataset.prompt;
            const filterState = libraryData.filterState || AppState.filters;
            if (!filterState.prompts.includes(prompt)) {
                filterState.prompts = [...filterState.prompts, prompt];
                if (!libraryData.returnFilterOptions) {
                    updateFilterSummary();
                    loadImages();
                }
                finishTagsLibraryInteraction();
                showToast(appT('library.addedFilter', 'Added "{value}" to filters').replace('{value}', prompt), 'success');
            }
        });
    });
}

function renderLibraryLoras(loras) {
    const content = $('#library-content');
    content.style.flexDirection = 'row';
    if (!loras || loras.length === 0) {
        content.innerHTML = '<p class="empty-state-text" style="width:100%;text-align:center;padding:32px;color:var(--text-muted)">' + escapeHtml(appT('library.lorasEmpty', 'No LoRA info yet. Import images with LoRA info first.')) + '</p>';
        return;
    }
    const addHint = escapeHtml(appT('library.clickToAddFilter', 'Click to add as filter'));
    content.innerHTML = loras.map(l => `
        <div class="library-tag" data-lora="${escapeHtml(l.lora)}" title="${addHint}">
            <span class="tag-name">${escapeHtml(l.lora)}</span>
            <span class="tag-count">${l.count}</span>
        </div>
    `).join('');

    content.querySelectorAll('.library-tag').forEach(el => {
        el.addEventListener('click', () => {
            const lora = el.dataset.lora;
            const filterState = libraryData.filterState || AppState.filters;
            const currentLoras = filterState.loras || [];
            if (!currentLoras.includes(lora)) {
                filterState.loras = [...currentLoras, lora];
                if (!libraryData.returnFilterOptions) {
                    updateFilterSummary();
                    loadImages();
                }
                finishTagsLibraryInteraction();
                showToast(appT('library.addedFilter', 'Added "{value}" to filters').replace('{value}', lora), 'success');
            }
        });
    });
}

function filterLibraryContent() {
    const query = $('#library-search')?.value.toLowerCase() || '';

    if (libraryData.currentTab === 'tags') {
        const filtered = libraryData.tags.filter(t => t.tag.toLowerCase().includes(query));
        renderLibraryTags(filtered);
    } else if (libraryData.currentTab === 'loras') {
        const filtered = (libraryData.loras || []).filter(l => l.lora.toLowerCase().includes(query));
        renderLibraryLoras(filtered);
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
        'btn-send-to-censor',
        'btn-delete-selected-files'
    ];

    syncSelectionModeButton();

    if (grid) {
        grid.classList.toggle('selection-mode', !!AppState.selectionMode);
    }

    const selectAllBtn = $('#btn-select-all');
    if (selectAllBtn) {
        selectAllBtn.disabled = !selectionPanelVisible || AppState.images.length === 0;
    }

    const invertVisibleBtn = $('#btn-invert-selection-visible');
    if (invertVisibleBtn) {
        invertVisibleBtn.disabled = !selectionPanelVisible || AppState.images.length === 0;
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
    lockDynamicI18nText('#confirm-title', 'modal.confirm');
    lockDynamicI18nText('#confirm-message', 'modal.confirmAction');
    $('#confirm-title').textContent = title || appT('modal.confirm', 'Are you sure?');
    $('#confirm-message').textContent = message || appT('modal.confirmAction', 'This action cannot be undone.');

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
        showToast(appT('gallery.noImagesAvailable', 'No images available'), 'info');
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
            `).join('') : `<p>${escapeHtml(appT('analytics.noCheckpoints', 'No checkpoints found'))}</p>`;

        $('#analytics-loras').innerHTML = data.loras.length ?
            data.loras.map(l => `
                <div class="analytics-item clickable" data-type="lora" data-value="${escapeHtml(l.lora)}">
                    <span class="item-name">${escapeHtml(l.lora)}</span>
                    <span class="item-count">${l.count}</span>
                </div>
            `).join('') : `<p>${escapeHtml(appT('analytics.noLoras', 'No LoRAs found'))}</p>`;

        $('#analytics-tags').innerHTML = data.top_tags.length ?
            data.top_tags.map(t => `
                <div class="analytics-item clickable" data-type="tag" data-value="${escapeHtml(t.tag)}">
                    <span class="item-name">${escapeHtml(t.tag)}</span>
                    <span class="item-count">${t.count}</span>
                </div>
            `).join('') : `<p>${escapeHtml(appT('analytics.noTags', 'No tags found'))}</p>`;

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
        showToast(formatUserError(e, appT('analytics.loadFailed', 'Failed to load analytics')), 'error');
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
    showToast(appT('filter.appliedValue', 'Filter applied: {value}', { value }), 'success');
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

    $('#export-title').textContent = `📤 ${appT('export.promptsTitle', 'Export Prompts')}`;
    $('#export-count').textContent = appT('export.imagesSelected', '{count} images selected', {
        count: AppState.selectedIds.size,
    });
    setExportModalMode('prompts');
    const textArea = $('#export-text');
    textArea.value = appT('export.loadingPrompts', 'Loading prompts...');

    showModal('export-modal');

    try {
        const ids = Array.from(AppState.selectedIds);
        const exportData = await loadSelectionData(ids);
        const prompts = exportData.images
            .map((image) => image.prompt?.trim())
            .filter(Boolean);

        textArea.value = prompts.join('\n\n');
    } catch (e) {
        textArea.value = appT('export.errorLoadingPrompts', 'Error loading prompts: {message}', {
            message: e.message,
        });
    }
}

async function showExportTagsModal() {
    if (AppState.selectedIds.size === 0) return;

    $('#export-title').textContent = `🏷️ ${appT('export.tagsTitle', 'Export Tags')}`;
    $('#export-count').textContent = appT('export.imagesSelected', '{count} images selected', {
        count: AppState.selectedIds.size,
    });
    setExportModalMode('tags');
    const textArea = $('#export-text');
    textArea.value = appT('export.loadingTags', 'Loading tags...');

    showModal('export-modal');
    try {
        const ids = Array.from(AppState.selectedIds);
        const exportData = await loadSelectionData(ids);
        const allTags = new Set();

        exportData.images.forEach((image) => {
            (image.tags || []).forEach((tag) => {
                allTags.add(tag);
            });
        });

        // Sort alphabetically and join
        const sortedTags = Array.from(allTags).sort();
        textArea.value = sortedTags.join(', ');
    } catch (e) {
        textArea.value = appT('export.errorLoadingTags', 'Error loading tags: {message}', {
            message: e.message,
        });
    }
}

function showBatchExportModal() {
    if (AppState.selectedIds.size === 0) {
        showToast(appT('export.selectImagesFirst', 'Please select images first'), 'error');
        return;
    }

    $('#batch-export-count').textContent = appT('export.imagesSelected', '{count} images selected', {
        count: AppState.selectedIds.size,
    });
    $('#batch-export-progress').style.display = 'none';
    $('#btn-start-batch-export').disabled = false;
    showModal('batch-export-modal');
}

function getExportDataCacheKey(imageIds) {
    return imageIds.map((id) => String(id)).join(',');
}

function resetSelectionDataCache() {
    AppState.selectionDataCache = {
        key: null,
        data: null
    };
}

function buildSelectionDataPayload(imageIds, data) {
    const normalizedIds = imageIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
    const requestedIdSet = new Set(normalizedIds);
    const cachedImages = new Map(
        (AppState.images || [])
            .filter((image) => requestedIdSet.has(Number(image?.id)))
            .map((image) => [Number(image.id), image])
    );
    const fetchedImages = new Map(
        (Array.isArray(data?.images) ? data.images : [])
            .map((image) => [Number(image.id), image])
    );
    const images = [];
    const resolvedIds = new Set();

    normalizedIds.forEach((id) => {
        const cached = cachedImages.get(id) || null;
        const fetched = fetchedImages.get(id) || null;
        if (!cached && !fetched) {
            return;
        }

        images.push({
            ...(cached || {}),
            ...(fetched || {}),
            id,
            prompt: fetched?.prompt ?? cached?.prompt ?? '',
            tags: Array.isArray(fetched?.tags)
                ? fetched.tags
                : (Array.isArray(cached?.tags) ? cached.tags : []),
        });
        resolvedIds.add(id);
    });

    const missingFromApi = Array.isArray(data?.missing_ids)
        ? data.missing_ids
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0)
        : [];
    const missingIds = Array.from(new Set([
        ...missingFromApi,
        ...normalizedIds.filter((id) => !resolvedIds.has(id)),
    ]));

    return { images, missing_ids: missingIds };
}

async function loadSelectionData(imageIds) {
    const cacheKey = getExportDataCacheKey(imageIds);
    if (AppState.selectionDataCache.key === cacheKey && AppState.selectionDataCache.data) {
        return AppState.selectionDataCache.data;
    }

    const data = buildSelectionDataPayload(imageIds, await API.getSelectionData(imageIds));
    AppState.selectionDataCache = {
        key: cacheKey,
        data
    };
    return data;
}

function setExportModalMode(mode) {
    const exportAltBtn = $('#btn-export-tags-alt');
    if (!exportAltBtn) return;

    exportAltBtn.dataset.exportView = mode;
    exportAltBtn.innerHTML = mode === 'prompts'
        ? `🏷️ ${appT('export.tagsInstead', 'Export Tags Instead')}`
        : `📤 ${appT('export.promptsInstead', 'Export Prompts Instead')}`;
}

async function executeBatchExport() {
    const outputFolder = $('#batch-export-folder')?.value?.trim() || '';
    if (!outputFolder) {
        showToast(appT('export.outputFolderRequired', 'Please enter an output folder'), 'error');
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
    if (progressText) progressText.textContent = appT('export.inProgress', 'Exporting...');
    if (startBtn) startBtn.disabled = true;

    try {
        const result = await API.exportTagsBatch(imageIds, outputFolder, blacklist, prefix);

        $('#batch-export-progress-fill').style.width = '100%';

        if (result.status === 'ok') {
            showToast(appT('export.success', 'Exported {count} tag files successfully.', {
                count: result.exported,
            }), 'success');
            hideModal('batch-export-modal');
        } else {
            showToast(appT('export.failedReason', 'Export failed: {reason}', {
                reason: result.errors?.join(', ') || appT('common.unknownError', 'Unknown error'),
            }), 'error');
        }
    } catch (e) {
        showToast(formatUserError(e, appT('export.failed', 'Export failed')), "error");
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
    const freeTextSearch = $('#modal-free-text-search');
    if (freeTextSearch) freeTextSearch.value = '';
    const activeTags = $('#active-tags');
    if (activeTags) activeTags.innerHTML = '';
    loadImages();
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

async function openFilterModal(options = {}) {
    const targetState = options.filterState || AppState.filters;
    FilterModalController.mode = options.mode || 'gallery';
    FilterModalController.targetState = targetState;
    FilterModalController.workingState = cloneFilterState(targetState);
    FilterModalController.onApply = typeof options.onApply === 'function' ? options.onApply : null;
    FilterModalController.onReset = typeof options.onReset === 'function' ? options.onReset : null;
    FilterModalController.titleText = options.titleText || null;
    FilterModalController.applyButtonText = options.applyButtonText || null;
    FilterModalController.resetButtonText = options.resetButtonText || null;
    FilterModalController.optionData = options.optionData || null;

    // Show skeleton while loading
    if (window.SkeletonFilterModal) {
        window.SkeletonFilterModal.show('filter-modal');
    }

    // Sync modal state with current AppState
    const filterState = getFilterModalState();
    const titleEl = $('#filter-modal-title');
    if (titleEl && FilterModalController.titleText) {
        titleEl.textContent = FilterModalController.titleText;
    } else if (titleEl) {
        titleEl.textContent = appT('filter.filterImages', 'Filter Images');
    }
    const applyButton = $('#btn-apply-modal-filters');
    const resetButton = $('#btn-reset-filters');
    if (applyButton) {
        applyButton.textContent = FilterModalController.applyButtonText || appT('filter.apply', 'Apply Filters');
    }
    if (resetButton) {
        resetButton.textContent = FilterModalController.resetButtonText || appT('filter.reset', 'Reset All');
    }
    $$('#modal-generator-filters input').forEach(cb => {
        cb.checked = filterState.generators.includes(cb.value);
    });
    $$('#modal-rating-filters input').forEach(cb => {
        cb.checked = filterState.ratings.includes(cb.value);
    });
    const minWidthInput = $('#filter-min-width');
    const maxWidthInput = $('#filter-max-width');
    const minHeightInput = $('#filter-min-height');
    const maxHeightInput = $('#filter-max-height');
    if (minWidthInput) minWidthInput.value = filterState.minWidth ?? '';
    if (maxWidthInput) maxWidthInput.value = filterState.maxWidth ?? '';
    if (minHeightInput) minHeightInput.value = filterState.minHeight ?? '';
    if (maxHeightInput) maxHeightInput.value = filterState.maxHeight ?? '';
    $$('input[name="aspect-ratio"]').forEach(radio => {
        radio.checked = radio.value === (filterState.aspectRatio || '');
    });
    // Aesthetic score filter
    const minAestheticInput = $('#filter-aesthetic-min');
    const maxAestheticInput = $('#filter-aesthetic-max');
    if (minAestheticInput) minAestheticInput.value = filterState.minAesthetic ?? '';
    if (maxAestheticInput) maxAestheticInput.value = filterState.maxAesthetic ?? '';
    // Don't prefill prompt search bar with AppState.filters.search —
    // the prompt search is for adding prompt filters, not for text search
    $('#modal-prompt-search').value = '';
    const freeTextSearch = $('#modal-free-text-search');
    if (freeTextSearch) freeTextSearch.value = filterState.search || '';
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

    const filterState = getFilterModalState();
    filterState.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'active-tag';
        tagEl.appendChild(document.createTextNode(`${tag} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-modal-tag';
        removeEl.dataset.tag = tag;
        removeEl.textContent = '×';
        removeEl.addEventListener('click', () => {
            filterState.tags = filterState.tags.filter(t => t !== tag);
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
    const filterState = getFilterModalState();
    filterState.prompts.forEach(prompt => {
        const promptEl = document.createElement('span');
        promptEl.className = 'active-tag';
        promptEl.appendChild(document.createTextNode(`${prompt} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-modal-prompt';
        removeEl.dataset.prompt = prompt;
        removeEl.textContent = '×';
        removeEl.addEventListener('click', () => {
            filterState.prompts = filterState.prompts.filter(p => p !== prompt);
            renderModalActivePrompts();
        });

        promptEl.appendChild(removeEl);
        container.appendChild(promptEl);
    });

    updateFilterModalSummary();
}

// ============== Model Manager ==============

async function openModelManager() {
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (summaryEl) {
        summaryEl.innerHTML = `<div class="model-manager-stat"><strong>${escapeHtml(appT('models.loadingTitle', 'Checking'))}</strong><span>${escapeHtml(appT('models.loadingBody', 'Checking what is ready on this computer...'))}</span></div>`;
    }
    if (gridEl) gridEl.innerHTML = '';
    showModal('model-manager-modal');

    try {
        const result = await API.getModelStatus();
        renderModelManager(result.models || []);
    } catch (error) {
        if (summaryEl) {
            summaryEl.innerHTML = `<div class="model-manager-stat"><strong>${escapeHtml(appT('models.failedTitle', 'Load failed'))}</strong><span>${escapeHtml(error.message || appT('models.failedBody', 'Could not read local feature status right now.'))}</span></div>`;
        }
    }
}

function renderModelManager(models = []) {
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (!summaryEl || !gridEl) return;

    const readyCount = models.filter(model => model.status === 'ready').length;
    const downloadedCount = models.filter(model => model.status === 'downloaded').length;
    const missingCount = models.filter(model => model.status === 'missing').length;

    summaryEl.innerHTML = `
        <div class="model-manager-stat">
            <strong>${readyCount}</strong>
            <span>${escapeHtml(appT('models.ready', 'Ready now'))}</span>
        </div>
        <div class="model-manager-stat">
            <strong>${downloadedCount}</strong>
            <span>${escapeHtml(appT('models.downloaded', 'Downloaded only'))}</span>
        </div>
        <div class="model-manager-stat">
            <strong>${missingCount}</strong>
            <span>${escapeHtml(appT('models.missing', 'Need attention'))}</span>
        </div>
        <div class="model-manager-stat">
            <strong>${models.length}</strong>
            <span>${escapeHtml(appT('models.total', 'Tracked runtimes'))}</span>
        </div>
    `;

    gridEl.innerHTML = models.map((model) => {
        const safeId = escapeHtml(model.id);
        const status = model.status || (model.available ? 'ready' : 'missing');
        const statusClass = status === 'ready' ? 'is-ready' : (status === 'downloaded' ? 'is-downloaded' : 'is-missing');
        const statusLabel = status === 'ready'
            ? appT('models.readyBadge', 'Ready')
            : (status === 'downloaded' ? appT('models.downloadedBadge', 'Downloaded') : appT('models.missingBadge', 'Missing'));
        const sourceOptions = Array.isArray(model.sources) ? model.sources.map((source) => `
            <option value="${escapeHtml(source)}">${escapeHtml(source)}</option>
        `).join('') : '';
        const variantOptions = Array.isArray(model.variants) ? model.variants.map((variant) => `
            <option value="${escapeHtml(variant)}">${escapeHtml(variant)}</option>
        `).join('') : '';
        const installedVariants = Array.isArray(model.installed_variants) && model.installed_variants.length
            ? `<div class="model-card-hint">${escapeHtml(appT('models.installedVariants', 'Installed variants'))}: ${escapeHtml(model.installed_variants.join(', '))}</div>`
            : '';
        const externalLinks = Array.isArray(model.external_links) ? model.external_links.map((link) => `
            <a class="btn btn-ghost btn-small" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label || appT('models.openSource', 'Open source'))}</a>
        `).join('') : '';

        return `
            <article class="model-card ${statusClass}" data-model-id="${safeId}">
                <div class="model-card-header">
                    <div>
                        <div class="model-card-group">${escapeHtml(model.group || appT('models.groupFallback', 'Feature'))}</div>
                        <div class="model-card-title">${escapeHtml(model.name || model.id)}</div>
                    </div>
                    <span class="model-card-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                </div>
                <div class="model-card-message">${escapeHtml(model.message || '')}</div>
                ${model.path ? `<div class="model-card-path">${escapeHtml(appT('models.path', 'Current path'))}:<code>${escapeHtml(model.path)}</code></div>` : ''}
                ${model.runtime_path ? `<div class="model-card-path">${escapeHtml(appT('models.runtimePath', 'Runtime files'))}:<code>${escapeHtml(model.runtime_path)}</code></div>` : ''}
                ${installedVariants}
                ${sourceOptions ? `
                    <label class="model-card-hint">
                        ${escapeHtml(appT('models.source', 'Source'))}
                        <select class="input-field model-source-select" data-model-id="${safeId}">${sourceOptions}</select>
                    </label>
                ` : ''}
                ${variantOptions ? `
                    <label class="model-card-hint">
                        ${escapeHtml(appT('models.variant', 'Variant'))}
                        <select class="input-field model-variant-select" data-model-id="${safeId}">${variantOptions}</select>
                    </label>
                ` : ''}
                <div class="model-card-actions">
                    ${model.download_supported ? `<button class="btn btn-primary btn-small btn-prepare-model" data-model-id="${safeId}">${escapeHtml(status === 'ready' ? appT('models.repair', 'Recheck / Repair') : appT('models.prepare', 'Prepare / Download'))}</button>` : ''}
                    ${externalLinks}
                </div>
            </article>
        `;
    }).join('');

    gridEl.querySelectorAll('.btn-prepare-model').forEach((button) => {
        button.addEventListener('click', async () => {
            const modelId = button.dataset.modelId;
            const source = gridEl.querySelector(`.model-source-select[data-model-id="${CSS.escape(modelId)}"]`)?.value || null;
            const variant = gridEl.querySelector(`.model-variant-select[data-model-id="${CSS.escape(modelId)}"]`)?.value || null;
            const originalLabel = button.textContent;
            button.disabled = true;
            button.textContent = appT('models.working', 'Working...');
            try {
                const result = await API.prepareModel(modelId, { source, variant });
                showToast(result.message || appT('models.readyToast', '{model} is ready.', { model: modelId }), 'success');
                const refreshed = await API.getModelStatus();
                renderModelManager(refreshed.models || []);
                // Notify other tabs (e.g. Similar Images) that a model changed
                document.dispatchEvent(new CustomEvent('model-status-changed', { detail: { modelId } }));
            } catch (error) {
                const apiData = error?.apiData || {};
                const userMessage = apiData.message || formatUserError(error, appT('models.prepareFailed', 'Model setup failed'));
                const manualSteps = Array.isArray(apiData.manual_steps) ? apiData.manual_steps : [];
                if (apiData.type === 'CivitaiLoginRequired' && manualSteps.length > 0) {
                    const card = button.closest('.model-card');
                    if (card) {
                        const messageEl = card.querySelector('.model-card-message');
                        if (messageEl) {
                            messageEl.textContent = userMessage;
                        }
                        let stepsEl = card.querySelector('.model-card-manual-steps');
                        if (!stepsEl) {
                            stepsEl = document.createElement('div');
                            stepsEl.className = 'model-card-hint model-card-manual-steps';
                            const actionsEl = card.querySelector('.model-card-actions');
                            card.insertBefore(stepsEl, actionsEl || null);
                        }
                        stepsEl.innerHTML = manualSteps
                            .map((step, index) => `<div>${index + 1}. ${escapeHtml(step)}</div>`)
                            .join('');
                    }
                }
                showToast(userMessage, error?.apiStatus === 409 ? 'warning' : 'error');
                button.disabled = false;
                button.textContent = originalLabel;
            }
        });
    });
}

async function loadModalFilterLists() {
    const cpList = $('#modal-checkpoint-list');
    const loraList = $('#modal-lora-list');
    const filterState = getFilterModalState();
    const optionData = FilterModalController.optionData;
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
        const data = optionData || AppState.analytics || await API.getStats();

        // Render checkpoints
        if (cpList) {
            cpList.innerHTML = (data.checkpoints || []).length > 0 ? (data.checkpoints || []).map(cp => `
                <label class="checkbox-label">
                    <input type="checkbox" value="${escapeHtml(cp.checkpoint)}" ${filterState.checkpoints?.includes(cp.checkpoint) ? 'checked' : ''}>
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
                    <input type="checkbox" value="${escapeHtml(l.lora)}" ${filterState.loras?.includes(l.lora) ? 'checked' : ''}>
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
    const filterState = getFilterModalState();
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
    const generatorCount = countChecked('#modal-generator-filters input:checked', filterState.generators?.length || generatorTotal);
    const ratingCount = countChecked('#modal-rating-filters input:checked', filterState.ratings?.length || ratingTotal);
    const checkpointCount = countChecked('#modal-checkpoint-list input:checked', filterState.checkpoints?.length || 0);
    const loraCount = countChecked('#modal-lora-list input:checked', filterState.loras?.length || 0);
    const tagCount = filterState.tags?.length || 0;
    const promptCount = filterState.prompts?.length || 0;
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

    // Aesthetic stat
    const aestheticMin = filterState.minAesthetic;
    const aestheticMax = filterState.maxAesthetic;
    const aestheticLabel = (aestheticMin || aestheticMax)
        ? `${aestheticMin ?? '0'} - ${aestheticMax ?? '10'}`
        : t('filter.any', null, 'Any');
    setCount('filter-modal-count-aesthetic', aestheticLabel);

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
        const normalizedQuery = query.toLowerCase().replace(/_/g, ' ');
        if (FilterModalController.optionData?.tags) {
            const filtered = FilterModalController.optionData.tags
                .filter(t => t.tag.toLowerCase().replace(/_/g, ' ').includes(normalizedQuery))
                .slice(0, 24);

            if (filtered.length > 0) {
                suggestionsEl.innerHTML = filtered.map(t => `
                    <div class="tag-suggestion" data-tag="${escapeHtml(t.tag)}">
                        ${escapeHtml(t.tag)} <span style="color: var(--text-muted)">(${t.count})</span>
                    </div>
                `).join('');

                suggestionsEl.classList.add('visible');
                suggestionsEl.querySelectorAll('.tag-suggestion').forEach(el => {
                    el.addEventListener('click', () => {
                        const filterState = getFilterModalState();
                        if (!filterState.tags.includes(el.dataset.tag)) {
                            filterState.tags = [...filterState.tags, el.dataset.tag];
                            renderModalActiveTags();
                        }
                        $('#modal-tag-search').value = '';
                        suggestionsEl.innerHTML = '';
                        suggestionsEl.classList.remove('visible');
                    });
                });
                return;
            }
        }

        // Use cached tags to avoid repeated API calls on every keystroke
        const now = Date.now();
        if (!tagsLibraryCache || (now - tagsLibraryCacheTime) > TAGS_CACHE_TTL) {
            tagsLibraryCache = await API.getTags();
            tagsLibraryCacheTime = now;
        }
        const result = tagsLibraryCache;
        const filtered = result.tags
            .filter(t => t.tag.toLowerCase().replace(/_/g, ' ').includes(normalizedQuery))
            .slice(0, 24);

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
                const filterState = getFilterModalState();
                if (!filterState.tags.includes(el.dataset.tag)) {
                    filterState.tags = [...filterState.tags, el.dataset.tag];
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
        if (FilterModalController.optionData?.prompts) {
            const filtered = FilterModalController.optionData.prompts
                .filter(p => p.prompt.toLowerCase().includes(query.toLowerCase().replace(/_/g, ' ')))
                .slice(0, 24);

            if (filtered.length > 0) {
                suggestionsEl.innerHTML = filtered.map(p => `
                    <div class="tag-suggestion" data-prompt="${escapeHtml(p.prompt)}">
                        ${escapeHtml(p.prompt)} <span style="color: var(--text-muted)">(${p.count})</span>
                    </div>
                `).join('');

                suggestionsEl.classList.add('visible');
                suggestionsEl.querySelectorAll('.tag-suggestion').forEach(el => {
                    el.addEventListener('click', () => {
                        const prompt = el.dataset.prompt;
                        const filterState = getFilterModalState();
                        if (!filterState.prompts.includes(prompt)) {
                            filterState.prompts = [...filterState.prompts, prompt];
                            renderModalActivePrompts();
                        }
                        $('#modal-prompt-search').value = '';
                        suggestionsEl.innerHTML = '';
                        suggestionsEl.classList.remove('visible');
                    });
                });
                return;
            }
        }

        // Cache the prompts library for better performance (with TTL)
        const now = Date.now();
        if (!promptsLibraryCache || (now - promptsLibraryCacheTime) > PROMPTS_CACHE_TTL) {
            const result = await API.getPromptsLibrary();
            promptsLibraryCache = result.prompts || [];
            promptsLibraryCacheTime = now;
        }

        const filtered = promptsLibraryCache
            .filter(p => p.prompt.toLowerCase().includes(query.toLowerCase().replace(/_/g, ' ')))
            .slice(0, 24);

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
                const filterState = getFilterModalState();
                if (!filterState.prompts.includes(prompt)) {
                    filterState.prompts = [...filterState.prompts, prompt];
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
    const filterState = getFilterModalState();
    // Get generators
    const generators = [];
    $$('#modal-generator-filters input:checked').forEach(cb => generators.push(cb.value));
    filterState.generators = generators;

    // Get ratings
    const ratings = [];
    $$('#modal-rating-filters input:checked').forEach(cb => ratings.push(cb.value));
    filterState.ratings = ratings;

    // Get checkpoints
    const checkpoints = [];
    $$('#modal-checkpoint-list input:checked').forEach(cb => checkpoints.push(cb.value));
    filterState.checkpoints = checkpoints;

    // Get loras
    const loras = [];
    $$('#modal-lora-list input:checked').forEach(cb => loras.push(cb.value));
    filterState.loras = loras;

    // Prompts: don't use prompt search bar as text search — prompts array is built via Enter key
    // But read the free-text search field for filename/prompt text search
    const freeTextSearch = $('#modal-free-text-search');
    filterState.search = freeTextSearch ? freeTextSearch.value.trim() : '';
    const promptSearch = $('#modal-prompt-search');
    if (promptSearch) promptSearch.value = '';

    // Get dimension filters
    const minWidth = parseInt($('#filter-min-width')?.value, 10) || null;
    const maxWidth = parseInt($('#filter-max-width')?.value, 10) || null;
    const minHeight = parseInt($('#filter-min-height')?.value, 10) || null;
    const maxHeight = parseInt($('#filter-max-height')?.value, 10) || null;
    filterState.minWidth = minWidth;
    filterState.maxWidth = maxWidth;
    filterState.minHeight = minHeight;
    filterState.maxHeight = maxHeight;

    // Get aspect ratio
    const aspectRadio = $('input[name="aspect-ratio"]:checked');
    filterState.aspectRatio = aspectRadio ? aspectRadio.value : '';

    // Get aesthetic score range
    const minAesthetic = parseFloat($('#filter-aesthetic-min')?.value) || null;
    const maxAesthetic = parseFloat($('#filter-aesthetic-max')?.value) || null;
    filterState.minAesthetic = minAesthetic;
    filterState.maxAesthetic = maxAesthetic;

    if (FilterModalController.targetState) {
        copyFilterState(FilterModalController.targetState, filterState);
    }

    hideModal('filter-modal');

    if (FilterModalController.onApply) {
        FilterModalController.onApply(cloneFilterState(FilterModalController.targetState || filterState));
        showToast(appT('filter.appliedToast', 'Filters applied'), 'success');
        resetFilterModalController();
        return;
    }

    // Update all filter summaries (gallery sidebar + view-specific)
    updateFilterSummary();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();

    syncGenTabsWithFilters();
    loadImages();
    showToast(appT('filter.appliedToast', 'Filters applied'), 'success');
    resetFilterModalController();
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
    const filterState = getFilterModalState();
    copyFilterState(filterState, createDefaultFilterState());

    // Reset modal checkboxes
    $$('#modal-generator-filters input').forEach(cb => cb.checked = true);
    $$('#modal-rating-filters input').forEach(cb => cb.checked = true);
    $$('#modal-checkpoint-list input').forEach(cb => cb.checked = false);
    $$('#modal-lora-list input').forEach(cb => cb.checked = false);
    const modalPromptSearch = $('#modal-prompt-search');
    if (modalPromptSearch) modalPromptSearch.value = '';
    const freeTextSearch = $('#modal-free-text-search');
    if (freeTextSearch) freeTextSearch.value = '';
    // Reset aesthetic inputs
    const minAeInput = $('#filter-aesthetic-min');
    const maxAeInput = $('#filter-aesthetic-max');
    if (minAeInput) minAeInput.value = '';
    if (maxAeInput) maxAeInput.value = '';
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
    updateSortReverseButton();
    updateFilterModalSummary();

    // Hide artist filter row
    const artistRow = $('#artist-filter-row');
    if (artistRow) artistRow.style.display = 'none';

    // Update all filter summaries
    updateFilterSummary();
    hideModal('filter-modal');

    if (FilterModalController.targetState) {
        copyFilterState(FilterModalController.targetState, filterState);
    }

    if (FilterModalController.onReset) {
        FilterModalController.onReset(cloneFilterState(FilterModalController.targetState || filterState));
        showToast(appT('filter.clearedToast', 'Filters cleared'), 'success');
        resetFilterModalController();
        return;
    }

    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();

    syncGenTabsWithFilters();
    loadImages();
    showToast(appT('filter.clearedToast', 'Filters cleared'), 'success');
    resetFilterModalController();
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
        showToast(appT('filter.presetNameRequired', 'Please enter a preset name'), 'error');
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
        showToast(appT('filter.presetSaved', 'Preset "{name}" saved', { name }), 'success');
        return true;
    } catch (e) {
        showToast(appT('filter.presetSaveFailed', 'Failed to save preset'), 'error');
        return false;
    }
}

function loadFilterPreset(name) {
    const presets = getFilterPresets();
    const preset = presets[name];

    if (!preset) {
        showToast(appT('filter.presetMissing', 'Preset "{name}" not found', { name }), 'error');
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

    closeFilterModal();
    loadImages();
    showToast(appT('filter.presetLoaded', 'Preset "{name}" loaded', { name }), 'success');
    return true;
}

function deleteFilterPreset(name) {
    const presets = getFilterPresets();
    if (presets[name]) {
        delete presets[name];
        localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(presets));
        showToast(appT('filter.presetDeleted', 'Preset "{name}" deleted', { name }), 'success');
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
        container.innerHTML = `<div class="presets-empty">${escapeHtml(appT('filter.presetsEmpty', 'No saved presets'))}</div>`;
        return;
    }

    container.innerHTML = presetNames.map(name => {
        const safeName = escapeHtml(name);
        return `
        <div class="preset-item">
            <span class="preset-name">${safeName}</span>
            <div class="preset-actions">
                <button class="btn-small" data-preset-action="load" data-preset-name="${safeName}">${escapeHtml(appT('filter.loadPreset', 'Load'))}</button>
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
    showToast(appT('filter.artistCleared', 'Artist filter cleared'), 'info');
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
            aspectRatio: AppState.filters.aspectRatio,
            minAesthetic: AppState.filters.minAesthetic,
            maxAesthetic: AppState.filters.maxAesthetic,
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

    const detail = { filters: cloneFilterState(AppState.filters) };
    window.dispatchEvent(new CustomEvent('gallery-filters-changed', { detail }));
    document.dispatchEvent(new CustomEvent('gallery-filters-changed', { detail }));
}

function refreshLocalizedImageCount() {
    const imageCount = $('#image-count');
    if (!imageCount) return;

    if (AppState.isLoading) {
        imageCount.textContent = appT('gallery.loading', 'Loading images...');
        return;
    }

    const total = AppState.pagination.total || AppState.images.length || 0;
    imageCount.textContent = appT('gallery.imageCount', '{count} images')
        .replace('{count}', String(total));
}

function refreshLocalizedDynamicUi() {
    refreshLocalizedImageCount();
    updateFilterSummary();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();
    if (AppState.modalSelection.type) {
        const titleEl = $('#model-select-title');
        if (titleEl) {
            titleEl.textContent = AppState.modalSelection.type === 'checkpoint'
                ? appT('modelSelect.checkpointsTitle', 'Select Models')
                : appT('modelSelect.lorasTitle', 'Select LoRAs');
        }
        renderModelSelectList();
    }
    updateAestheticUi();
    window.Gallery?.refreshLocalizedContent?.();
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
            showToast(appT('gallery.viewGrid', 'Grid view'), 'info');
        }
        // L - Toggle large view
        else if (e.key === 'l' || e.key === 'L') {
            e.preventDefault();
            setGalleryViewMode('large');
            showToast(appT('gallery.viewLarge', 'Large view'), 'info');
        }
        // W - Toggle waterfall view
        else if (e.key === 'w' || e.key === 'W') {
            e.preventDefault();
            setGalleryViewMode('waterfall');
            showToast(appT('gallery.viewWaterfall', 'Waterfall view'), 'info');
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
            showToast(
                AppState.selectionMode
                    ? appT('gallery.selectionModeOn', 'Selection mode ON')
                    : appT('gallery.selectionModeOff', 'Selection mode OFF'),
                'info'
            );
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
                showToast(appT('gallery.selectionCleared', 'Selection cleared'), 'info');
            }
        }
        // Delete - Clear gallery (with confirmation)
        else if (e.key === 'Delete') {
            if (AppState.selectedIds.size > 0) {
                e.preventDefault();
                deleteSelectedGalleryImages();
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
    updateSortReverseButton();
    syncGallerySortLabels();
    switchView('gallery');
    loadStats();
    refreshAestheticStatus();
    updateFilterSummary();
    updateSelectionUI();
    resumeScanProgress();
    resumeTaggingProgress();
    _initBgTagProgressButtons();
    _initBgScanProgressButtons();
    document.addEventListener('languageChanged', refreshLocalizedDynamicUi);
    document.addEventListener('languageChanged', () => setUpdateButtonState(AppState.update.status, AppState.update.checking));
    setUpdateButtonState();

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
    document.addEventListener('languageChanged', updateNavigationOverflowState);
    updateNavigationOverflowState();
    window.addEventListener('load', updateNavigationOverflowState, { once: true });
    document.fonts?.ready?.then?.(() => updateNavigationOverflowState()).catch?.(() => {});
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

function openPromptBuildFromImage(imageId) {
    const normalizedId = Number(imageId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return false;
    }

    switchView('promptlab');
    if (typeof window.initPromptLab === 'function') {
        window.initPromptLab();
    }

    const buildTab = document.querySelector('.promptlab-tab[data-mode="build"]');
    buildTab?.click();
    const buildSource = document.getElementById('pl-build-source');
    if (buildSource) {
        buildSource.value = String(normalizedId);
        buildSource.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    return false;
}

async function openReaderFromImage(imageId, filename = '') {
    const normalizedId = Number(imageId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return false;
    }

    switchView('reader');
    if (window.ImageReader?.openLibraryImage) {
        return window.ImageReader.openLibraryImage(normalizedId, filename);
    }
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
        syncGenTabsWithFilters,
        createDefaultFilterState,
        cloneFilterState,
        copyFilterState,
        updateSortReverseButton,
        syncGallerySortLabels,
        formatGeneratorLabel,
        loadSelectionData,
        resetSelectionDataCache,
        openTagsLibrary,
        switchLibraryTab,
        filterLibraryContent,
        switchView,
        openGalleryPreview,
        applyPromptFilter,
        addToCensorQueue,
        sendToCensor: addToCensorQueue,
        _addToCensorQueue: null,
        openPromptBuildFromImage,
        openReaderFromImage,
        addRecentFolder,
        getRecentFolders,
        clampTaggerChunkToAvailableOption,
        $,
        $$
    };
}

// Export for other modules
window.App = buildAppContext();
window.clampTaggerChunkToAvailableOption = clampTaggerChunkToAvailableOption;


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

