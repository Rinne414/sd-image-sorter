/**
 * @fileoverview Filter state management
 * @module state/filters
 */

// Use global state functions (loaded from store.js)
// Assumes window.AppState, window.notify, window.saveFilterState are available

/** @constant {string} Local storage key for filter presets */
const FILTER_PRESETS_KEY = 'sd-image-sorter-filter-presets';

/**
 * @typedef {Object} FilterPreset
 * @property {string[]} generators
 * @property {string[]} ratings
 * @property {string[]} tags
 * @property {string[]} checkpoints
 * @property {string[]} loras
 * @property {string[]} prompts
 * @property {string|null} artist
 * @property {number|null} minWidth
 * @property {number|null} maxWidth
 * @property {number|null} minHeight
 * @property {number|null} maxHeight
 * @property {string} aspectRatio
 */

/**
 * All valid generator types
 * @constant {string[]}
 */
const ALL_GENERATORS = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];

/**
 * All valid rating types
 * @constant {string[]}
 */
const ALL_RATINGS = ['general', 'sensitive', 'questionable', 'explicit'];

/**
 * Get filter presets from localStorage
 * @returns {Object<string, FilterPreset>} Presets object
 */
function getFilterPresets() {
    try {
        const saved = localStorage.getItem(FILTER_PRESETS_KEY);
        return saved ? JSON.parse(saved) : {};
    } catch (e) {
        return {};
    }
}

/**
 * Save a filter preset
 * @param {string} name - Preset name
 * @returns {boolean} Success status
 */
function saveFilterPreset(name) {
    if (!name || !name.trim()) {
        return false;
    }

    const presets = getFilterPresets();
    presets[name.trim()] = {
        generators: window.AppState.filters.generators,
        ratings: window.AppState.filters.ratings,
        tags: window.AppState.filters.tags,
        checkpoints: window.AppState.filters.checkpoints,
        loras: window.AppState.filters.loras,
        prompts: window.AppState.filters.prompts,
        artist: window.AppState.filters.artist,
        minWidth: window.AppState.filters.minWidth,
        maxWidth: window.AppState.filters.maxWidth,
        minHeight: window.AppState.filters.minHeight,
        maxHeight: window.AppState.filters.maxHeight,
        aspectRatio: window.AppState.filters.aspectRatio
    };

    try {
        localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(presets));
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Load a filter preset
 * @param {string} name - Preset name
 * @returns {boolean} Success status
 */
function loadFilterPreset(name) {
    const presets = getFilterPresets();
    const preset = presets[name];

    if (!preset) {
        return false;
    }

    // Apply preset to filters
    window.AppState.filters = {
        ...window.AppState.filters,
        ...preset
    };

    window.notify('filters', window.AppState.filters);
    return true;
}

/**
 * Delete a filter preset
 * @param {string} name - Preset name
 * @returns {boolean} Success status
 */
function deleteFilterPreset(name) {
    const presets = getFilterPresets();
    if (presets[name]) {
        delete presets[name];
        localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(presets));
        return true;
    }
    return false;
}

/**
 * Update filter with partial changes
 * @param {Object} updates - Partial filter updates
 */
function updateFilters(updates) {
    window.AppState.filters = {
        ...window.AppState.filters,
        ...updates
    };
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Add tag to filter
 * @param {string} tag - Tag to add
 */
function addTagFilter(tag) {
    if (!window.AppState.filters.tags.includes(tag)) {
        window.AppState.filters.tags = [...window.AppState.filters.tags, tag];
        window.saveFilterState();
        window.notify('filters', window.AppState.filters);
    }
}

/**
 * Remove tag from filter
 * @param {string} tag - Tag to remove
 */
function removeTagFilter(tag) {
    window.AppState.filters.tags = window.AppState.filters.tags.filter(t => t !== tag);
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Add prompt to filter
 * @param {string} prompt - Prompt to add
 */
function addPromptFilter(prompt) {
    if (!window.AppState.filters.prompts.includes(prompt)) {
        window.AppState.filters.prompts = [...window.AppState.filters.prompts, prompt];
        window.saveFilterState();
        window.notify('filters', window.AppState.filters);
    }
}

/**
 * Remove prompt from filter
 * @param {string} prompt - Prompt to remove
 */
function removePromptFilter(prompt) {
    window.AppState.filters.prompts = window.AppState.filters.prompts.filter(p => p !== prompt);
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Set generator filter
 * @param {string[]} generators - Generators to filter
 */
function setGeneratorFilter(generators) {
    window.AppState.filters.generators = generators;
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Set rating filter
 * @param {string[]} ratings - Ratings to filter
 */
function setRatingFilter(ratings) {
    window.AppState.filters.ratings = ratings;
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Set checkpoint filter
 * @param {string[]} checkpoints - Checkpoints to filter
 */
function setCheckpointFilter(checkpoints) {
    window.AppState.filters.checkpoints = checkpoints;
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Set LoRA filter
 * @param {string[]} loras - LoRAs to filter
 */
function setLoraFilter(loras) {
    window.AppState.filters.loras = loras;
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Set artist filter
 * @param {string|null} artist - Artist to filter
 */
function setArtistFilter(artist) {
    window.AppState.filters.artist = artist;
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Clear artist filter
 */
function clearArtistFilter() {
    window.AppState.filters.artist = null;
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Set dimension filters
 * @param {Object} dimensions - Dimension filter object
 * @param {number|null} dimensions.minWidth
 * @param {number|null} dimensions.maxWidth
 * @param {number|null} dimensions.minHeight
 * @param {number|null} dimensions.maxHeight
 * @param {string} dimensions.aspectRatio
 */
function setDimensionFilters(dimensions) {
    window.AppState.filters.minWidth = dimensions.minWidth || null;
    window.AppState.filters.maxWidth = dimensions.maxWidth || null;
    window.AppState.filters.minHeight = dimensions.minHeight || null;
    window.AppState.filters.maxHeight = dimensions.maxHeight || null;
    window.AppState.filters.aspectRatio = dimensions.aspectRatio || '';
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Reset all filters to default
 */
function resetAllFilters() {
    window.AppState.filters = {
        generators: [...ALL_GENERATORS],
        ratings: [...ALL_RATINGS],
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
    window.saveFilterState();
    window.notify('filters', window.AppState.filters);
}

/**
 * Get filter summary text
 * @returns {Object} Summary texts for each filter category
 */
function getFilterSummary() {
    const f = window.AppState.filters;

    return {
        generators: f.generators.length === ALL_GENERATORS.length ? 'All' :
            f.generators.length === 0 ? 'None' :
                f.generators.length > 2 ? `${f.generators.length} selected` : f.generators.join(', '),
        ratings: f.ratings.length === ALL_RATINGS.length ? 'All' :
            f.ratings.length === 0 ? 'None' :
                f.ratings.length > 2 ? `${f.ratings.length} selected` : f.ratings.join(', '),
        tags: f.tags.length === 0 ? 'None' :
            f.tags.length > 2 ? `${f.tags.length} tags` : f.tags.join(', '),
        checkpoints: (!f.checkpoints || f.checkpoints.length === 0) ? 'None' :
            `${f.checkpoints.length} selected`,
        loras: (!f.loras || f.loras.length === 0) ? 'None' :
            `${f.loras.length} selected`,
        prompts: (!f.prompts || f.prompts.length === 0) ? 'None' :
            f.prompts.length > 2 ? `${f.prompts.length} prompts` : f.prompts.join(', '),
        artist: f.artist ? f.artist.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null
    };
}

const filtersState = {
    ALL_GENERATORS,
    ALL_RATINGS,
    FILTER_PRESETS_KEY,
    getFilterPresets,
    saveFilterPreset,
    loadFilterPreset,
    deleteFilterPreset,
    updateFilters,
    addTagFilter,
    removeTagFilter,
    addPromptFilter,
    removePromptFilter,
    setGeneratorFilter,
    setRatingFilter,
    setCheckpointFilter,
    setLoraFilter,
    setArtistFilter,
    clearArtistFilter,
    setDimensionFilters,
    resetAllFilters,
    getFilterSummary
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.ALL_GENERATORS = ALL_GENERATORS;
    window.ALL_RATINGS = ALL_RATINGS;
    window.getFilterPresets = getFilterPresets;
    window.saveFilterPreset = saveFilterPreset;
    window.loadFilterPreset = loadFilterPreset;
    window.deleteFilterPreset = deleteFilterPreset;
    window.updateFilters = updateFilters;
    window.addTagFilter = addTagFilter;
    window.removeTagFilter = removeTagFilter;
    window.addPromptFilter = addPromptFilter;
    window.removePromptFilter = removePromptFilter;
    window.setGeneratorFilter = setGeneratorFilter;
    window.setRatingFilter = setRatingFilter;
    window.setCheckpointFilter = setCheckpointFilter;
    window.setLoraFilter = setLoraFilter;
    window.setArtistFilter = setArtistFilter;
    window.clearArtistFilter = clearArtistFilter;
    window.setDimensionFilters = setDimensionFilters;
    window.resetAllFilters = resetAllFilters;
    window.getFilterSummary = getFilterSummary;
    window.filtersState = filtersState;
}
