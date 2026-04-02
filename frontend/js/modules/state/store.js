/**
 * @fileoverview Central state management for application
 * @module state/store
 *
 * NOTE: AppState is defined in app.js which loads first.
 * This module provides utility functions for state management.
 */

/** @constant {string} Local storage key for gallery view mode */
const GALLERY_VIEW_MODE_KEY = 'gallery-view-mode';

/** @constant {string} Local storage key for filter state */
const FILTER_STATE_KEY = 'sd-image-sorter-filter-state';

/**
 * Load saved filter state from localStorage
 * @returns {Object|null} Saved filter state or null
 */
function loadSavedFilterState() {
    try {
        const saved = localStorage.getItem(FILTER_STATE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        if (window.Logger) window.Logger.warn('Failed to load saved filter state:', e);
    }
    return null;
}

// Reference to AppState from app.js (loaded first)
// If not available yet, will be set when app.js initializes
const AppState = window.AppState || {
    currentView: 'gallery',
    viewMode: localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid',
    images: [],
    filters: loadSavedFilterState() || {
        generators: ['comfyui', 'nai', 'webui', 'forge', 'unknown'],
        ratings: ['general', 'sensitive', 'questionable', 'explicit'],
        tags: [],
        checkpoints: [],
        loras: [],
        prompts: [],
        artist: null,
        search: '',
        sortBy: 'newest'
    },
    selectedImage: null,
    isLoading: false,
    pagination: { cursor: null, hasMore: true, total: 0, pageSize: 100 },
    selectionMode: false,
    selectedIds: new Set(),
    analytics: { checkpoints: [], loras: [], top_tags: [], generatorCounts: {}, totalImages: 0 },
    modalSelection: { type: null, tempSelected: new Set(), search: '' }
};

/**
 * Subscribe to state changes (simple pub/sub pattern)
 * @type {Map<string, Set<Function>>}
 */
const subscribers = new Map();

/**
 * Subscribe to state changes
 * @param {string} key - State key to watch
 * @param {Function} callback - Callback function
 * @returns {Function} Unsubscribe function
 */
function subscribe(key, callback) {
    if (!subscribers.has(key)) {
        subscribers.set(key, new Set());
    }
    subscribers.get(key).add(callback);

    // Return unsubscribe function
    return () => {
        const callbacks = subscribers.get(key);
        if (callbacks) {
            callbacks.delete(callback);
        }
    };
}

/**
 * Notify subscribers of state change
 * @param {string} key - State key that changed
 * @param {*} value - New value
 */
function notify(key, value) {
    const callbacks = subscribers.get(key);
    if (callbacks) {
        callbacks.forEach(callback => {
            try {
                callback(value);
            } catch (e) {
                console.error(`Error in subscriber for ${key}:`, e);
            }
        });
    }
}

/**
 * Update state and notify subscribers
 * @param {string} key - State key to update
 * @param {*} value - New value
 */
function setState(key, value) {
    AppState[key] = value;
    notify(key, value);
}

/**
 * Get current state value
 * @param {string} key - State key
 * @returns {*} Current value
 */
function getState(key) {
    return AppState[key];
}

/**
 * Reset filters to default state
 * @returns {void}
 */
function resetFilters() {
    AppState.filters = {
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
        aspectRatio: ''
    };
    notify('filters', AppState.filters);
}

/**
 * Save filter state to localStorage
 */
function saveFilterState() {
    try {
        const stateToSave = {
            generators: AppState.filters.generators,
            ratings: AppState.filters.ratings,
            tags: AppState.filters.tags,
            checkpoints: AppState.filters.checkpoints,
            loras: AppState.filters.loras,
            prompts: AppState.filters.prompts,
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
        if (window.Logger) window.Logger.warn('Failed to save filter state:', e);
    }
}

/**
 * Clear all selections
 */
function clearSelections() {
    AppState.selectedIds.clear();
    AppState.selectionMode = false;
    notify('selectedIds', AppState.selectedIds);
    notify('selectionMode', AppState.selectionMode);
}

/**
 * Toggle image selection
 * @param {number} imageId - Image ID to toggle
 */
function toggleSelection(imageId) {
    if (AppState.selectedIds.has(imageId)) {
        AppState.selectedIds.delete(imageId);
    } else {
        AppState.selectedIds.add(imageId);
    }
    notify('selectedIds', AppState.selectedIds);
}

/**
 * Select all currently loaded images
 */
function selectAllImages() {
    AppState.images.forEach(img => AppState.selectedIds.add(img.id));
    notify('selectedIds', AppState.selectedIds);
}

const store = {
    AppState,
    subscribe,
    setState,
    getState,
    notify,
    resetFilters,
    saveFilterState,
    clearSelections,
    toggleSelection,
    selectAllImages,
    GALLERY_VIEW_MODE_KEY,
    FILTER_STATE_KEY,
    loadSavedFilterState
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.AppState = AppState;
    window.subscribe = subscribe;
    window.setState = setState;
    window.getState = getState;
    window.notify = notify;
    window.resetFilters = resetFilters;
    window.saveFilterState = saveFilterState;
    window.clearSelections = clearSelections;
    window.toggleSelection = toggleSelection;
    window.selectAllImages = selectAllImages;
    window.store = store;
}
