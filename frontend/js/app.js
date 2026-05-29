/**
 * SD Image Sorter - Main Application
 * Core app logic and API communication
 */

const API_BASE = '';  // Same origin
const SCAN_PREVIEW_PAGE_SIZE = 80;
const VALID_ASPECT_RATIO_FILTERS = new Set(['square', 'landscape', 'portrait']);
const VALID_PROMPT_MATCH_MODES = new Set(['exact', 'contains']);

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
    let text = (val && val !== key) ? val : (fallback || key);
    if (params && typeof params === 'object') {
        for (const [paramKey, paramValue] of Object.entries(params)) {
            text = String(text).split(`{${paramKey}}`).join(String(paramValue));
        }
    }
    return text;
}

function normalizeAspectRatioFilter(value) {
    const text = String(value || '').trim();
    return VALID_ASPECT_RATIO_FILTERS.has(text) ? text : '';
}

function normalizePromptMatchMode(value) {
    const text = String(value || '').trim().toLowerCase();
    return VALID_PROMPT_MATCH_MODES.has(text) ? text : 'exact';
}

// Generators that show as their own top-level tab in the gallery header.
// Keep this small and intentional — the goal is to spend the limited
// horizontal space only on the generators most users actually have in bulk.
const PRIMARY_GENERATORS = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];

// Generators that are bundled under the "Others" top-level tab. Each
// is still filterable individually via the Filter Criteria modal — this
// list only controls what `data-gen="others"` resolves to. Stay in sync
// with backend/metadata_parser.py::MetadataParser.OTHERS_BUNDLE.
const OTHERS_GENERATOR_BUNDLE = [
    'others',
    'fooocus',
    'reforge',
    'easy-diffusion',
    'invokeai',
    'swarmui',
    'drawthings',
    'gemini',
    'gpt-image'
];

const ALL_GENERATORS = [...PRIMARY_GENERATORS, ...OTHERS_GENERATOR_BUNDLE];

function formatGeneratorLabel(generator, fallbackUnknown = 'Unknown') {
    const normalized = String(generator || 'unknown').trim().toLowerCase();
    const keyMap = {
        all: 'generator.all',
        nai: 'generator.nai',
        comfyui: 'generator.comfyui',
        forge: 'generator.forge',
        webui: 'generator.webui',
        reforge: 'generator.reforge',
        fooocus: 'generator.fooocus',
        'easy-diffusion': 'generator.easyDiffusion',
        invokeai: 'generator.invokeai',
        swarmui: 'generator.swarmui',
        drawthings: 'generator.drawthings',
        gemini: 'generator.gemini',
        'gpt-image': 'generator.gptImage',
        others: 'generator.others',
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

    complete(key, controller = null) {
        if (!controller || this.pendingRequests.get(key) === controller) {
            this.pendingRequests.delete(key);
        }
    },

    isAbortedError(error) {
        return error.name === 'AbortError';
    }
};

const GALLERY_VIEW_MODE_KEY = 'gallery-view-mode';
const FILTER_STATE_KEY = 'sd-image-sorter-filter-state';
const SCAN_ADVANCED_OPEN_KEY = 'sd-image-sorter-scan-advanced-open';
const TAG_ADVANCED_OPEN_KEY = 'sd-image-sorter-tag-advanced-open';
const FILTERED_SELECTION_CONFIRM_THRESHOLD = 10000;
const FILTERED_SELECTION_CHUNK_SIZE = 2000;
const EXPORT_PREVIEW_MAX_IMAGES = 2000;
const EXPORT_PREVIEW_MAX_CHARS = 200000;
const FACET_SUGGESTION_LIMIT = 24;
const FACET_FILTER_SEARCH_LIMIT = 200;

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
    if (window.FilterStore?.createDefaultFilterState) {
        return window.FilterStore.createDefaultFilterState();
    }
    return {
        generators: [...ALL_GENERATORS],
        ratings: ['general', 'sensitive', 'questionable', 'explicit'],
        tags: [],
        tagMode: 'and',
        checkpoints: [],
        loras: [],
        prompts: [],
        promptMatchMode: 'exact',
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
        maxAesthetic: null,
        brightnessMin: null,
        brightnessMax: null,
        colorTemperature: '',
        brightnessDistribution: '',
        excludeTags: [],
        excludeGenerators: [],
        excludeRatings: [],
        excludeCheckpoints: [],
        excludeLoras: [],
    };
}

function cloneFilterState(filters) {
    if (window.FilterStore?.cloneState) {
        return window.FilterStore.cloneState(filters);
    }
    const source = filters || createDefaultFilterState();
    return {
        generators: [...(source.generators || [])],
        ratings: [...(source.ratings || [])],
        tags: [...(source.tags || [])],
        tagMode: source.tagMode || 'and',
        checkpoints: [...(source.checkpoints || [])],
        loras: [...(source.loras || [])],
        prompts: [...(source.prompts || [])],
        promptMatchMode: normalizePromptMatchMode(source.promptMatchMode || source.prompt_match_mode),
        artist: source.artist || null,
        search: source.search || '',
        sortBy: source.sortBy || 'newest',
        limit: source.limit || 0,
        minWidth: source.minWidth ?? null,
        maxWidth: source.maxWidth ?? null,
        minHeight: source.minHeight ?? null,
        maxHeight: source.maxHeight ?? null,
        aspectRatio: normalizeAspectRatioFilter(source.aspectRatio),
        minAesthetic: source.minAesthetic ?? null,
        maxAesthetic: source.maxAesthetic ?? null,
        brightnessMin: source.brightnessMin ?? null,
        brightnessMax: source.brightnessMax ?? null,
        colorTemperature: ['warm', 'neutral', 'cool'].includes(String(source.colorTemperature || '').trim())
            ? String(source.colorTemperature || '').trim()
            : '',
        brightnessDistribution: ['left_heavy', 'right_heavy', 'middle_heavy', 'edge_heavy', 'balanced'].includes(String(source.brightnessDistribution || '').trim())
            ? String(source.brightnessDistribution || '').trim()
            : '',
        excludeTags: [...(source.excludeTags || [])],
        excludeGenerators: [...(source.excludeGenerators || [])],
        excludeRatings: [...(source.excludeRatings || [])],
        excludeCheckpoints: [...(source.excludeCheckpoints || [])],
        excludeLoras: [...(source.excludeLoras || [])],
    };
}

function createDefaultSelectionState() {
    if (window.SelectionStore?.createDefaultState) {
        return window.SelectionStore.createDefaultState();
    }
    return {
        selectionMode: false,
        selectedIds: new Set(),
        scope: 'visible',
        filterKey: null,
        selectionToken: null,
        selectionTotal: 0,
    };
}

function cloneSelectionState(selectionState) {
    if (window.SelectionStore?.cloneState) {
        return window.SelectionStore.cloneState(selectionState);
    }
    const source = selectionState || createDefaultSelectionState();
    const scope = source.scope === 'filtered' || source.scope === 'loaded' ? source.scope : 'visible';
    const filterKey = scope === 'filtered' && typeof source.filterKey === 'string' && source.filterKey
        ? source.filterKey
        : null;
    const selectionToken = scope === 'filtered' && typeof source.selectionToken === 'string' && source.selectionToken
        ? source.selectionToken
        : null;
    const selectionTotal = scope === 'filtered'
        ? Math.max(0, Number(source.selectionTotal || 0) || 0)
        : 0;
    return {
        selectionMode: Boolean(source.selectionMode),
        selectedIds: new Set(Array.from(source.selectedIds || [])),
        scope,
        filterKey,
        selectionToken,
        selectionTotal,
    };
}

function buildSelectionFilterRequest(filters = AppState?.filters || createDefaultFilterState()) {
    const source = cloneFilterState(filters);
    return {
        generators: [...(source.generators || [])],
        ratings: [...(source.ratings || [])],
        tags: [...(source.tags || [])],
        tagMode: source.tagMode || 'and',
        checkpoints: [...(source.checkpoints || [])]
            .map(normalizeCheckpointFilterValue)
            .filter(Boolean),
        loras: [...(source.loras || [])],
        prompts: [...(source.prompts || [])],
        promptMatchMode: normalizePromptMatchMode(source.promptMatchMode),
        artist: source.artist ? String(source.artist).trim() : null,
        search: source.search || '',
        sortBy: source.sortBy || 'newest',
        minWidth: source.minWidth ?? null,
        maxWidth: source.maxWidth ?? null,
        minHeight: source.minHeight ?? null,
        maxHeight: source.maxHeight ?? null,
        aspectRatio: normalizeAspectRatioFilter(source.aspectRatio) || null,
        minAesthetic: source.minAesthetic ?? null,
        maxAesthetic: source.maxAesthetic ?? null,
        brightnessMin: source.brightnessMin ?? null,
        brightnessMax: source.brightnessMax ?? null,
        colorTemperature: source.colorTemperature || null,
        brightnessDistribution: source.brightnessDistribution || null,
        // v3.2.2 per-item exclude filters
        excludeTags: [...(source.excludeTags || [])],
        excludeGenerators: [...(source.excludeGenerators || [])],
        excludeRatings: [...(source.excludeRatings || [])],
        excludeCheckpoints: [...(source.excludeCheckpoints || [])],
        excludeLoras: [...(source.excludeLoras || [])],
    };
}

function getSelectionFilterCacheKey(filters = AppState?.filters || createDefaultFilterState()) {
    return JSON.stringify(buildSelectionFilterRequest(filters));
}

function buildAdvancedFilterContract(filters = AppState?.filters || createDefaultFilterState()) {
    const request = buildSelectionFilterRequest(filters);
    return {
        generators: request.generators,
        ratings: request.ratings,
        tags: request.tags,
        tagMode: request.tagMode,
        checkpoints: request.checkpoints,
        loras: request.loras,
        prompts: request.prompts,
        promptMatchMode: request.promptMatchMode,
        artist: request.artist,
        search: request.search || '',
        minWidth: request.minWidth ?? null,
        maxWidth: request.maxWidth ?? null,
        minHeight: request.minHeight ?? null,
        maxHeight: request.maxHeight ?? null,
        aspectRatio: request.aspectRatio || '',
        minAesthetic: request.minAesthetic ?? null,
        maxAesthetic: request.maxAesthetic ?? null,
        brightnessMin: request.brightnessMin ?? null,
        brightnessMax: request.brightnessMax ?? null,
        colorTemperature: request.colorTemperature || '',
        brightnessDistribution: request.brightnessDistribution || '',
        excludeTags: request.excludeTags,
        excludeGenerators: request.excludeGenerators,
        excludeRatings: request.excludeRatings,
        excludeCheckpoints: request.excludeCheckpoints,
        excludeLoras: request.excludeLoras,
    };
}

function getAdvancedFilterContractSignature(filters = AppState?.filters || createDefaultFilterState()) {
    return JSON.stringify(buildAdvancedFilterContract(filters));
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

const savedFilters = cloneFilterState(loadSavedFilterState());
const AppFilterStore = window.FilterStore?.create(savedFilters || createDefaultFilterState()) || null;
const AppSelectionStore = window.SelectionStore?.create(createDefaultSelectionState()) || null;

// Expose store handles + a small read-only accessor for features (Mass Tag
// Editor, color backfill, etc.) that need to read current selection / filter
// state without coupling to internal IIFE variables. Keep the accessor shape
// narrow so future refactors only need to remap these few methods.
window.AppFilterStore = AppFilterStore;
window.AppSelectionStore = AppSelectionStore;
window.AppFilterAccess = {
    getSelectionState() {
        const state = AppSelectionStore?.getState?.();
        if (!state) return null;
        return {
            selectedIds: state.selectedIds,
            scope: state.scope,
            filterKey: state.filterKey || null,
            selectionToken: state.selectionToken || null,
            selectionTotal: state.selectionTotal || 0,
        };
    },
    getActiveSelectionToken() {
        const state = AppSelectionStore?.getState?.();
        if (!state || state.scope !== 'filtered' || !state.selectionToken) return null;
        const isActive = typeof window.App?.isFilteredSelectionActiveForCurrentFilters === 'function'
            ? window.App.isFilteredSelectionActiveForCurrentFilters()
            : (typeof isFilteredSelectionActiveForCurrentFilters === 'function'
                ? isFilteredSelectionActiveForCurrentFilters()
                : true);
        if (isActive) {
            return state.selectionToken;
        }
        return null;
    },
    getSelectionTotal() {
        const state = AppSelectionStore?.getState?.();
        return Number(state?.selectionTotal || 0);
    },
    /** Returns only explicitly selected IDs already held by the UI. */
    getSelectedImageIds() {
        const state = AppSelectionStore?.getState?.();
        if (!state) return [];
        if (state.selectedIds instanceof Set) return Array.from(state.selectedIds);
        if (Array.isArray(state.selectedIds)) return [...state.selectedIds];
        return [];
    },
    async resolveSelectedImageIds(limit = 5000) {
        const token = this.getActiveSelectionToken();
        const normalizedLimit = Math.max(1, Math.min(Number(limit) || 5000, 10000));
        if (token && window.App?.API?.getSelectionChunk) {
            const ids = [];
            let offset = 0;
            let hasMore = true;
            while (hasMore && ids.length < normalizedLimit) {
                const chunk = await window.App.API.getSelectionChunk(token, {
                    offset,
                    limit: Math.min(5000, normalizedLimit - ids.length),
                });
                const chunkIds = Array.isArray(chunk?.image_ids) ? chunk.image_ids : [];
                ids.push(...chunkIds.map(Number).filter((id) => Number.isFinite(id) && id > 0));
                hasMore = Boolean(chunk?.has_more);
                offset = Number(chunk?.next_offset || 0);
                if (!offset && hasMore) break;
            }
            return ids;
        }
        return this.getSelectedImageIds()
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .slice(0, normalizedLimit);
    },
    /**
     * Returns a URLSearchParams instance for the current gallery filter,
     * suitable for `fetch('/api/images?' + p)`. Mirrors the mapping used by
     * the gallery's own load path (Api.getImages in app.js) so a filter-scope
     * bulk operation sees the same images the user sees.
     */
    getFilterQueryParams() {
        const filters = AppFilterStore?.getState?.() || createDefaultFilterState();
        const params = new URLSearchParams();
        if (filters.generators?.length) params.set('generators', filters.generators.join(','));
        if (filters.ratings?.length) params.set('ratings', filters.ratings.join(','));
        if (filters.tags?.length) params.set('tags', filters.tags.join(','));
        if (filters.tagMode && filters.tagMode !== 'and') params.set('tag_mode', filters.tagMode);
        if (filters.checkpoints?.length) params.set('checkpoints', filters.checkpoints.join(','));
        if (filters.loras?.length) params.set('loras', filters.loras.join(','));
        if (filters.prompts?.length) params.set('prompts', filters.prompts.join(','));
        const promptMatchMode = typeof normalizePromptMatchMode === 'function'
            ? normalizePromptMatchMode(filters.promptMatchMode)
            : (filters.promptMatchMode === 'contains' ? 'contains' : 'exact');
        if (promptMatchMode !== 'exact') params.set('prompt_match_mode', promptMatchMode);
        if (filters.artist) params.set('artist', filters.artist);
        if (filters.search) params.set('search', filters.search);
        if (filters.minWidth) params.set('min_width', filters.minWidth);
        if (filters.maxWidth) params.set('max_width', filters.maxWidth);
        if (filters.minHeight) params.set('min_height', filters.minHeight);
        if (filters.maxHeight) params.set('max_height', filters.maxHeight);
        if (filters.aspectRatio) params.set('aspect_ratio', filters.aspectRatio);
        if (filters.minAesthetic) params.set('min_aesthetic', filters.minAesthetic);
        if (filters.maxAesthetic) params.set('max_aesthetic', filters.maxAesthetic);
        if (filters.brightnessMin) params.set('brightness_min', filters.brightnessMin);
        if (filters.brightnessMax) params.set('brightness_max', filters.brightnessMax);
        if (filters.colorTemperature) params.set('color_temperature', filters.colorTemperature);
        if (filters.brightnessDistribution) params.set('brightness_distribution', filters.brightnessDistribution);
        // v3.2.2 per-item exclude filters
        if (filters.excludeTags?.length) params.set('exclude_tags', filters.excludeTags.join(','));
        if (filters.excludeGenerators?.length) params.set('exclude_generators', filters.excludeGenerators.join(','));
        if (filters.excludeRatings?.length) params.set('exclude_ratings', filters.excludeRatings.join(','));
        if (filters.excludeCheckpoints?.length) params.set('exclude_checkpoints', filters.excludeCheckpoints.join(','));
        if (filters.excludeLoras?.length) params.set('exclude_loras', filters.excludeLoras.join(','));
        return params;
    },
};

// App State
const AppState = {
    currentView: 'gallery',
    viewMode: localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid',
    images: [],
    filters: AppFilterStore ? AppFilterStore.getState() : (savedFilters || createDefaultFilterState()),
    selectedImage: null,
    isLoading: false,
    galleryNeedsRefresh: false,
    gallerySuppressNextAutoLoadMore: false,

    // Pagination state
    pagination: {
        cursor: null,
        offset: 0,
        hasMore: true,
        total: 0,
        pageSize: getDefaultGalleryPageSize()
    },

    // Multi-select state
    selectionMode: AppSelectionStore ? AppSelectionStore.getState().selectionMode : false,
    selectedIds: AppSelectionStore ? AppSelectionStore.getState().selectedIds : new Set(),
    selectionScope: AppSelectionStore ? AppSelectionStore.getState().scope : 'visible',
    selectionFilterKey: AppSelectionStore ? AppSelectionStore.getState().filterKey : null,
    selectionToken: AppSelectionStore ? AppSelectionStore.getState().selectionToken : null,
    selectionTotal: AppSelectionStore ? AppSelectionStore.getState().selectionTotal : 0,
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

if (AppFilterStore) {
    AppFilterStore.subscribe((nextState) => {
        AppState.filters = nextState;
        clearFilteredSelectionIfFilterChanged(nextState);
    });
}

if (AppSelectionStore) {
    AppSelectionStore.subscribe((nextState) => {
        AppState.selectionMode = nextState.selectionMode;
        AppState.selectedIds = nextState.selectedIds;
        AppState.selectionScope = nextState.scope;
        AppState.selectionFilterKey = nextState.filterKey || null;
        AppState.selectionToken = nextState.selectionToken || null;
        AppState.selectionTotal = nextState.selectionTotal || 0;
    });
}

function setAppFilters(nextFilters) {
    if (AppFilterStore) {
        return AppFilterStore.setState(nextFilters);
    }
    AppState.filters = cloneFilterState(nextFilters);
    clearFilteredSelectionIfFilterChanged(AppState.filters);
    return AppState.filters;
}

function updateAppFilters(updater) {
    if (AppFilterStore) {
        return AppFilterStore.update(updater);
    }
    const draft = cloneFilterState(AppState.filters);
    const nextState = typeof updater === 'function'
        ? (updater(draft) ?? draft)
        : updater;
    return setAppFilters(nextState);
}

function setSelectionState(nextSelection) {
    if (AppSelectionStore) {
        return AppSelectionStore.setState(nextSelection);
    }
    const nextState = cloneSelectionState(nextSelection);
    AppState.selectionMode = nextState.selectionMode;
    AppState.selectedIds = nextState.selectedIds;
    AppState.selectionScope = nextState.scope;
    AppState.selectionFilterKey = nextState.filterKey || null;
    AppState.selectionToken = nextState.selectionToken || null;
    AppState.selectionTotal = nextState.selectionTotal || 0;
    return nextState;
}

function updateSelectionState(updater) {
    if (AppSelectionStore) {
        return AppSelectionStore.update(updater);
    }
    const draft = cloneSelectionState({
        selectionMode: AppState.selectionMode,
        selectedIds: AppState.selectedIds,
        scope: AppState.selectionScope,
        filterKey: AppState.selectionFilterKey,
        selectionToken: AppState.selectionToken,
        selectionTotal: AppState.selectionTotal,
    });
    const nextState = typeof updater === 'function'
        ? (updater(draft) ?? draft)
        : updater;
    return setSelectionState(nextState);
}

function mutateSelectedIds(mutator, { scope = null } = {}) {
    return updateSelectionState((selection) => {
        const nextIds = new Set(selection.selectedIds);
        const result = typeof mutator === 'function' ? mutator(nextIds) : mutator;
        selection.selectedIds = result instanceof Set ? result : nextIds;
        if (scope) {
            selection.scope = scope;
            if (scope !== 'filtered') {
                selection.filterKey = null;
                selection.selectionToken = null;
                selection.selectionTotal = 0;
            }
        }
    });
}

function clearSelectedIds(options = {}) {
    return mutateSelectedIds((selectedIds) => {
        selectedIds.clear();
    }, options);
}

// v3.2.2: detect whether the user has applied any non-default filter so
// the empty-state can show a contextual message ("no matches, try clearing
// your filter") instead of the onboarding card ("no images yet, import a
// folder") which is misleading when the user has a populated library.
function _galleryHasActiveFilter() {
    const f = AppState.filters || {};
    if (f.tags && f.tags.length > 0) return true;
    if (f.checkpoints && f.checkpoints.length > 0) return true;
    if (f.loras && f.loras.length > 0) return true;
    if (f.prompts && f.prompts.length > 0) return true;
    if (f.search && String(f.search).trim().length > 0) return true;
    if (f.artist) return true;
    if (f.minWidth != null || f.maxWidth != null) return true;
    if (f.minHeight != null || f.maxHeight != null) return true;
    if (f.aspectRatio) return true;
    if (f.minAesthetic != null || f.maxAesthetic != null) return true;
    if (f.brightnessMin != null || f.brightnessMax != null) return true;
    if (f.colorTemperature) return true;
    if (f.brightnessDistribution) return true;
    // generators/ratings start as "all selected" - flag only when a strict
    // subset is selected
    if (Array.isArray(f.generators) && Array.isArray(ALL_GENERATORS) &&
        f.generators.length > 0 && f.generators.length < ALL_GENERATORS.length) return true;
    if (Array.isArray(f.ratings) && f.ratings.length > 0 && f.ratings.length < 4) return true;
    return false;
}

function _applyGalleryEmptyStateVariant(emptyState) {
    if (!emptyState) return;
    const filterActive = _galleryHasActiveFilter();
    emptyState.classList.toggle('empty-state-no-matches', filterActive);
    emptyState.classList.toggle('empty-state-no-library', !filterActive);

    // Look up the title/hint strings; fall back to English if i18n
    // hasn't loaded yet.
    const t = (key, fallback) => (typeof appT === 'function' ? appT(key, fallback) : fallback);

    const titleEl = emptyState.querySelector('h3');
    const hintEl = emptyState.querySelector('p');
    const importBtn = emptyState.querySelector('#empty-state-scan-btn');
    const onboardingSteps = emptyState.querySelector('.onboarding-steps');
    const clearFiltersBtn = emptyState.querySelector('#empty-state-clear-filters-btn');

    if (filterActive) {
        if (titleEl) {
            titleEl.setAttribute('data-i18n', 'gallery.noMatchesTitle');
            titleEl.textContent = t('gallery.noMatchesTitle', 'No images match your filters');
        }
        if (hintEl) {
            hintEl.setAttribute('data-i18n', 'gallery.noMatchesHint');
            hintEl.textContent = t('gallery.noMatchesHint',
                'Try removing some filter criteria, clearing your search, or adjusting the prompt/tag conditions.');
        }
        if (importBtn) importBtn.style.display = 'none';
        if (onboardingSteps) onboardingSteps.style.display = 'none';
        // Inject a "Clear filters" CTA if not already present
        let cta = clearFiltersBtn;
        if (!cta) {
            const actions = emptyState.querySelector('.empty-actions');
            if (actions) {
                cta = document.createElement('button');
                cta.id = 'empty-state-clear-filters-btn';
                cta.className = 'btn btn-primary';
                const labelSpan = document.createElement('span');
                labelSpan.setAttribute('data-i18n', 'gallery.clearFilters');
                labelSpan.textContent = t('gallery.clearFilters', 'Clear all filters');
                cta.append(document.createTextNode('🧹 '));
                cta.appendChild(labelSpan);
                cta.addEventListener('click', () => {
                    if (typeof window.resetFilters === 'function') {
                        window.resetFilters();
                    } else if (window.FilterStore?.resetFilters) {
                        window.FilterStore.resetFilters();
                    } else {
                        // Last-ditch fallback: full reload
                        location.reload();
                    }
                });
                actions.appendChild(cta);
            }
        } else {
            cta.style.display = '';
        }
    } else {
        if (titleEl) {
            titleEl.setAttribute('data-i18n', 'gallery.noImages');
            titleEl.textContent = t('gallery.noImages', 'No images yet');
        }
        if (hintEl) {
            hintEl.setAttribute('data-i18n', 'gallery.scanPrompt');
            hintEl.textContent = t('gallery.scanPrompt',
                'Import an image folder to start browsing, filtering, and organizing your images');
        }
        if (importBtn) importBtn.style.display = '';
        if (onboardingSteps) onboardingSteps.style.display = '';
        if (clearFiltersBtn) clearFiltersBtn.style.display = 'none';
    }
    // v3.2.2: re-apply i18n to the empty state subtree so the new
    // data-i18n attributes resolve correctly even if applyToDOM has
    // already cached their previous value.
    if (window.I18n && typeof window.I18n.applyToDOM === 'function') {
        try { window.I18n.applyToDOM(emptyState); } catch (_e) {}
    }
}

function clearFilteredSelectionIfFilterChanged(filters = AppState.filters) {
    if (AppState.selectionScope !== 'filtered') return false;
    if (!AppState.selectionToken && (!AppState?.selectedIds || AppState.selectedIds.size === 0)) return false;

    const currentFilterKey = getSelectionFilterCacheKey(filters);
    if (!AppState.selectionFilterKey || AppState.selectionFilterKey === currentFilterKey) {
        return false;
    }

    updateSelectionState((selection) => {
        selection.selectedIds = new Set();
        selection.scope = 'visible';
        selection.filterKey = null;
        selection.selectionToken = null;
        selection.selectionTotal = 0;
    });
    resetSelectionDataCache();

    if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
        Gallery.syncSelectionState();
    }
    if (typeof updateSelectionUI === 'function') updateSelectionUI();
    emitSelectionStateChanged();
    return true;
}

function markGalleryNeedsRefresh({ resetSelectionCache = true } = {}) {
    AppState.galleryNeedsRefresh = true;
    if (resetSelectionCache) {
        resetSelectionDataCache();
    }
}

function commitFilterModalState(filterState) {
    const nextFilters = cloneFilterState(filterState);
    const hasExternalHandler = Boolean(FilterModalController.onApply || FilterModalController.onReset);

    if (!hasExternalHandler) {
        setAppFilters(nextFilters);
        return cloneFilterState(AppState.filters);
    }

    if (FilterModalController.targetState) {
        copyFilterState(FilterModalController.targetState, nextFilters);
        return cloneFilterState(FilterModalController.targetState);
    }

    return nextFilters;
}

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
    brightness: 'brightness_asc',
    saturation: 'saturation_asc',
    brightness_skew: 'brightness_skew_asc',
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
        brightness: ['sort.brightness', 'Brightest'],
        saturation: ['sort.saturation', 'Most Saturated'],
        brightness_skew: ['sort.brightnessSkew', 'Brightness Spread'],
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
        if (filters.tagMode && filters.tagMode !== 'and') params.set('tag_mode', filters.tagMode);
        if (filters.checkpoints?.length) params.set('checkpoints', filters.checkpoints.join(','));
        if (filters.loras?.length) params.set('loras', filters.loras.join(','));
        if (filters.prompts?.length) params.set('prompts', filters.prompts.join(','));
        const promptMatchMode = normalizePromptMatchMode(filters.promptMatchMode);
        if (promptMatchMode !== 'exact') params.set('prompt_match_mode', promptMatchMode);
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
        const aspectRatio = normalizeAspectRatioFilter(filters.aspectRatio);
        if (aspectRatio) params.set('aspect_ratio', aspectRatio);
        if (filters.minAesthetic) params.set('min_aesthetic', filters.minAesthetic);
        if (filters.maxAesthetic) params.set('max_aesthetic', filters.maxAesthetic);
        if (filters.brightnessMin) params.set('brightness_min', filters.brightnessMin);
        if (filters.brightnessMax) params.set('brightness_max', filters.brightnessMax);
        if (filters.colorTemperature) params.set('color_temperature', filters.colorTemperature);
        if (filters.brightnessDistribution) params.set('brightness_distribution', filters.brightnessDistribution);

        // v3.2.2 per-item exclude filters
        if (filters.excludeTags?.length) params.set('exclude_tags', filters.excludeTags.join(','));
        if (filters.excludeGenerators?.length) params.set('exclude_generators', filters.excludeGenerators.join(','));
        if (filters.excludeRatings?.length) params.set('exclude_ratings', filters.excludeRatings.join(','));
        if (filters.excludeCheckpoints?.length) params.set('exclude_checkpoints', filters.excludeCheckpoints.join(','));
        if (filters.excludeLoras?.length) params.set('exclude_loras', filters.excludeLoras.join(','));

        return this.get(`/api/images?${params}`, options);
    },

    async clearGallery() {
        return this.delete('/api/clear-gallery');
    },

    async getImage(id) {
        return this.get(`/api/images/${id}`);
    },

    async getSelectionIds(filters = {}) {
        return this.post('/api/images/selection-ids', buildSelectionFilterRequest(filters));
    },

    async createSelectionToken(filters = {}, chunkSize = FILTERED_SELECTION_CHUNK_SIZE, options = {}) {
        const payload = {
            ...buildSelectionFilterRequest(filters),
            chunkSize,
        };
        if (Array.isArray(options.excludedImageIds) && options.excludedImageIds.length > 0) {
            payload.excludedImageIds = options.excludedImageIds;
        }
        return this.post('/api/images/selection-token', payload);
    },

    async getSelectionChunk(selectionToken, { offset = 0, limit = FILTERED_SELECTION_CHUNK_SIZE } = {}) {
        const params = new URLSearchParams();
        params.set('selection_token', selectionToken);
        params.set('offset', String(offset));
        params.set('limit', String(limit));
        return this.get(`/api/images/selection-chunk?${params.toString()}`);
    },

    async getSelectionData(imageIds) {
        return this.post('/api/images/export-data', { image_ids: imageIds });
    },

    async getSelectionDataByToken(selectionToken, { offset = 0, limit = EXPORT_PREVIEW_MAX_IMAGES } = {}) {
        return this.post('/api/images/export-data', {
            selection_token: selectionToken,
            offset,
            limit,
        });
    },

    async reparseImage(id) {
        return this.post(`/api/images/${id}/reparse`);
    },

    async openFolder(imageId) {
        return this.post('/api/open-folder', { image_id: imageId });
    },

    async deleteSelectedImages(imageIds, options = {}) {
        const payload = { confirm_delete_files: true };
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/delete-selected', payload);
    },

    async removeSelectedImages(imageIds, options = {}) {
        const payload = {};
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/remove-selected', payload);
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

    async getTagsLibrary(sortBy = 'frequency', options = {}) {
        const requestOptions = typeof options === 'number' ? { limit: options } : (options || {});
        const params = new URLSearchParams();
        params.set('sort_by', sortBy);
        if (requestOptions.limit != null) params.set('limit', String(requestOptions.limit));
        if (requestOptions.query) params.set('q', requestOptions.query);
        return this.get(`/api/tags/library?${params.toString()}`);
    },

    async importTags(images, overwrite = false) {
        return this.post('/api/tags/import', { images, overwrite });
    },

    async getPromptsLibrary(options = {}) {
        const requestOptions = typeof options === 'number' ? { limit: options } : (options || {});
        const params = new URLSearchParams();
        if (requestOptions.limit != null) params.set('limit', String(requestOptions.limit));
        if (requestOptions.query) params.set('q', requestOptions.query);
        const queryString = params.toString();
        return this.get(`/api/prompts/library${queryString ? `?${queryString}` : ''}`);
    },

    async getLorasLibrary(options = {}) {
        const requestOptions = typeof options === 'number' ? { limit: options } : (options || {});
        const params = new URLSearchParams();
        if (requestOptions.limit != null) params.set('limit', String(requestOptions.limit));
        if (requestOptions.query) params.set('q', requestOptions.query);
        const queryString = params.toString();
        return this.get(`/api/loras/library${queryString ? `?${queryString}` : ''}`);
    },

    async getGenerators() {
        return this.get('/api/generators');
    },

    // Stats
    async getStats() {
        return this.get('/api/stats');
    },

    async getAnalyticsFacet(facet, options = {}) {
        const params = new URLSearchParams();
        if (facet) params.set('facet', facet);
        if (options.query) params.set('q', options.query);
        if (options.limit != null) params.set('limit', String(options.limit));
        const queryString = params.toString();
        return this.get(`/api/analytics${queryString ? `?${queryString}` : ''}`);
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

    async cancelAesthetic() {
        return this.post('/api/aesthetic/cancel');
    },

    async cancelSimilarityEmbed() {
        return this.post('/api/similarity/cancel');
    },

    async cancelArtistBatch() {
        return this.post('/api/artists/batch-cancel');
    },

    async getModelStatus() {
        return this.get('/api/models/status');
    },

    async getCacheStatus() {
        return this.get('/api/disk/cache-status');
    },

    async cleanCaches(keys) {
        return this.post('/api/disk/cleanup', { keys });
    },

    async setDiskSettings(settings) {
        return this.post('/api/disk/settings', settings);
    },

    async rebuildCoreRuntime() {
        return this.post('/api/disk/runtime/rebuild-core', {});
    },

    async getMirror() {
        return this.get('/api/models/mirror');
    },

    async setMirror(mirror) {
        return this.post('/api/models/mirror', { mirror });
    },

    async prepareModel(modelId, options = {}) {
        return this.post('/api/models/prepare', {
            model_id: modelId,
            source: options.source || null,
            variant: options.variant || null,
        });
    },

    async getModelBulkBundle() {
        return this.get('/api/models/bulk-bundle');
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

    // Drop resolution
    async resolveDrop(folderName, droppedFiles) {
        return this.post('/api/resolve-drop', { folder_name: folderName, files: droppedFiles });
    },

    async importFiles(fileList) {
        const form = new FormData();
        for (let i = 0; i < fileList.length; i++) {
            form.append('files', fileList[i]);
        }
        const response = await fetch(`${API_BASE}/api/import-files`, {
            method: 'POST',
            body: form,
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Import failed');
        }
        return response.json();
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

    async getSupportDiagnostics(lines = 200) {
        return this.get(`/api/support/diagnostics?lines=${encodeURIComponent(lines)}`);
    },

    async openSupportLog() {
        return this.post('/api/support/open-log', {});
    },

    async cancelScan() {
        return this.post('/api/scan/cancel');
    },

    async startReconnectMissing(folderPath, options = {}) {
        return this.post('/api/images/reconnect-missing/start', {
            search_folder: folderPath,
            recursive: options.recursive ?? true,
            verify_uncertain: options.verifyUncertain ?? true,
        });
    },

    async getReconnectProgress() {
        return this.get('/api/images/reconnect-missing/progress');
    },

    async cancelReconnectMissing() {
        return this.post('/api/images/reconnect-missing/cancel');
    },

    // Tagging - with all new options
    async startTagging(options = {}) {
        return this.post('/api/tag/start', { // Unified with backend endpoint
            threshold: options.threshold || 0.35,
            character_threshold: options.characterThreshold || 0.85,
            model_name: options.modelName || null,
            model_path: options.modelPath || null,
            tags_path: options.tagsPath || null,
            custom_profile: options.customProfile || null,
            image_ids: options.imageIds || null,
            retag_all: options.retagAll || false,
            use_gpu: options.useGpu ?? true,
            allow_unsafe_acceleration: options.allowUnsafeAcceleration ?? false,
            batch_size: options.batchSize || null,
            // v3.2.2 T-power-PR1: pre-tag filters applied inside the worker.
            pre_tag_blacklist: Array.isArray(options.preTagBlacklist) ? options.preTagBlacklist : [],
            max_tags_per_image: Number.isFinite(options.maxTagsPerImage) ? Math.max(0, options.maxTagsPerImage) : 0,
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
    async moveImages(imageIds, destinationFolder, operation = 'move', options = {}) {
        const payload = { destination_folder: destinationFolder, operation };
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/move', payload);
    },

    async batchMove(generators, tags, ratings, destinationFolder, checkpoints = null, loras = null, prompts = null, dimensions = null, search = null, aesthetic = null, operation = 'move', artist = null, promptMatchMode = 'exact', tagMode = 'and', excludeFilters = null) {
        return this.post('/api/batch-move', {
            generators,
            tags,
            tag_mode: tagMode === 'or' ? 'or' : 'and',
            ratings,
            checkpoints,
            loras,
            prompts,
            prompt_match_mode: normalizePromptMatchMode(promptMatchMode),
            artist: artist ? String(artist).trim() : null,
            search,
            min_width: dimensions?.minWidth || null,
            max_width: dimensions?.maxWidth || null,
            min_height: dimensions?.minHeight || null,
            max_height: dimensions?.maxHeight || null,
            aspect_ratio: normalizeAspectRatioFilter(dimensions?.aspectRatio) || null,
            min_aesthetic: aesthetic?.min ?? null,
            max_aesthetic: aesthetic?.max ?? null,
            exclude_tags: excludeFilters?.tags || null,
            exclude_generators: excludeFilters?.generators || null,
            exclude_ratings: excludeFilters?.ratings || null,
            exclude_checkpoints: excludeFilters?.checkpoints || null,
            exclude_loras: excludeFilters?.loras || null,
            destination_folder: destinationFolder,
            operation,
        });
    },

    // Manual Sort
    async startSortSession(generators, tags, ratings, folders, checkpoints = null, loras = null, prompts = null, dimensions = null, search = null, aesthetic = null, operationMode = 'copy', artist = null, replaceExisting = false, promptMatchMode = 'exact', tagMode = 'and', excludeFilters = null) {
        return this.post('/api/sort/start', {
            generators,
            tags,
            tag_mode: tagMode === 'or' ? 'or' : 'and',
            ratings,
            checkpoints,
            loras,
            prompts,
            prompt_match_mode: normalizePromptMatchMode(promptMatchMode),
            artist: artist ? String(artist).trim() : null,
            search,
            min_width: dimensions?.minWidth || null,
            max_width: dimensions?.maxWidth || null,
            min_height: dimensions?.minHeight || null,
            max_height: dimensions?.maxHeight || null,
            aspect_ratio: normalizeAspectRatioFilter(dimensions?.aspectRatio) || null,
            min_aesthetic: aesthetic?.min ?? null,
            max_aesthetic: aesthetic?.max ?? null,
            folders,
            // Default to copy (non-destructive) when no explicit mode is
            // passed. Locked by Principle #11 in docs/AI_PRINCIPLES.md.
            operation_mode: operationMode || 'copy',
            replace_existing: Boolean(replaceExisting),
            exclude_tags: excludeFilters?.tags || null,
            exclude_generators: excludeFilters?.generators || null,
            exclude_ratings: excludeFilters?.ratings || null,
            exclude_checkpoints: excludeFilters?.checkpoints || null,
            exclude_loras: excludeFilters?.loras || null,
        });
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

    // Batch Sidecar Export
    async exportTagsBatch(imageIds, outputFolder, blacklist = [], prefix = '', contentMode = 'tags', overwritePolicy = 'unique', options = {}) {
        const payload = {
            output_folder: outputFolder,
            output_mode: options.outputMode || 'folder',
            blacklist: blacklist,
            prefix: prefix,
            content_mode: contentMode,
            overwrite_policy: overwritePolicy
        };
        if (options.templateOptions) {
            payload.template_options = options.templateOptions;
        }
        if (options.imageOverrides && typeof options.imageOverrides === 'object') {
            payload.image_overrides = options.imageOverrides;
        }
        if (options.captionTransforms && typeof options.captionTransforms === 'object') {
            payload.caption_transforms = options.captionTransforms;
        }
        if (typeof options.normalizeTagUnderscores === 'boolean') {
            payload.normalize_tag_underscores = options.normalizeTagUnderscores;
        }
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/tags/export-batch', payload);
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
        if (modalId === 'image-modal') {
            window.Gallery?._cleanupZoomHandlers?.();
        }

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
        if (!button.classList.contains('btn-icon-only')) {
            const textNode = button.querySelector('span:last-child');
            if (textNode) {
                textNode.textContent = label;
            }
        }
    });

    window.requestAnimationFrame?.(() => updateNavigationOverflowState());
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
    const btn = document.getElementById('btn-app-update');
    if (!btn) return;
    const existing = document.getElementById('update-popup');
    if (existing?.classList.contains('visible')) {
        _hideUpdatePopup();
        return;
    }
    _showUpdatePopup(btn);
}

let _updatePopupEl = null;

function _createUpdatePopup() {
    if (_updatePopupEl) return _updatePopupEl;
    const el = document.createElement('div');
    el.id = 'update-popup';
    el.className = 'update-popup';
    document.body.appendChild(el);
    _updatePopupEl = el;

    document.addEventListener('click', (e) => {
        if (_updatePopupEl?.classList.contains('visible') && !_updatePopupEl.contains(e.target)) {
            const btn = document.getElementById('btn-app-update');
            if (btn && !btn.contains(e.target)) _hideUpdatePopup();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _updatePopupEl?.classList.contains('visible')) _hideUpdatePopup();
    });

    return el;
}

async function _showUpdatePopup(anchorBtn) {
    const popup = _createUpdatePopup();
    const currentVersion = AppState.appVersion || appT('update.versionUnknown', '?');
    const githubUrl = AppState.githubUrl || '';
    const status = AppState.update.status;
    const hasUpdate = status?.has_update;
    const latestVersion = status?.latest_version || currentVersion;
    const releaseUrl = status?.release_url || (githubUrl ? githubUrl + '/releases/latest' : '');
    const releaseNotes = status?.release_notes || '';

    let notesHtml = '';
    if (releaseNotes) {
        const truncated = releaseNotes.length > 200 ? releaseNotes.slice(0, 200) + '...' : releaseNotes;
        notesHtml = `<div class="update-popup-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <span class="update-popup-label">${escapeHtml(appT('update.releaseNotes', 'Release Notes'))}</span>
            <span style="font-size:12px;color:var(--text-secondary);line-height:1.5;white-space:pre-wrap;">${escapeHtml(truncated)}</span>
        </div>`;
    }

    let actionsHtml = '';
    if (hasUpdate) {
        actionsHtml = `<div class="update-popup-actions">
            <button class="btn btn-primary" data-update-action="install">${escapeHtml(appT('update.installNow', 'Install Update'))}</button>
        </div>`;
    } else {
        actionsHtml = `<div class="update-popup-actions">
            <button class="btn btn-secondary" data-update-action="check">${escapeHtml(appT('update.checkNow', 'Check for Updates'))}</button>
        </div>`;
    }

    popup.innerHTML = `<div class="update-popup-card">
        <div class="update-popup-header">
            <span class="update-popup-title">${escapeHtml(appT('update.popupTitle', 'Version Info'))}</span>
            <button class="update-popup-close" data-update-action="close" aria-label="Close">&times;</button>
        </div>
        <div class="update-popup-row">
            <span class="update-popup-label">${escapeHtml(appT('update.currentLabel', 'Current Version'))}</span>
            <span class="update-popup-value">v${escapeHtml(currentVersion)}</span>
        </div>
        <div class="update-popup-row">
            <span class="update-popup-label">${escapeHtml(appT('update.latestLabel', 'Latest Version'))}</span>
            <span class="update-popup-value${hasUpdate ? ' has-update' : ''}">v${escapeHtml(latestVersion)}${hasUpdate ? ' ✦' : ''}</span>
        </div>
        ${releaseUrl ? `<div class="update-popup-row">
            <span class="update-popup-label">${escapeHtml(appT('update.releasePageLabel', 'Release Page'))}</span>
            <a href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener" class="update-popup-link">GitHub ↗</a>
        </div>` : ''}
        ${notesHtml ? '<div class="update-popup-divider"></div>' + notesHtml : ''}
        <div class="update-popup-divider"></div>
        ${actionsHtml}
    </div>`;

    const rect = anchorBtn.getBoundingClientRect();
    popup.style.top = (rect.bottom + 8) + 'px';
    popup.style.right = (window.innerWidth - rect.right) + 'px';
    popup.classList.add('visible');
    // Single delegated handler — re-renders no longer accumulate listeners on
    // detached DOM nodes. We replace popup.onclick wholesale on each show so
    // closures captured by the previous render are eligible for GC.
    popup.onclick = async (event) => {
        const target = event.target.closest('[data-update-action]');
        if (!target) return;
        const action = target.dataset.updateAction;
        if (action === 'close') {
            _hideUpdatePopup();
        } else if (action === 'install') {
            _hideUpdatePopup();
            showConfirm(
                appT('update.confirmTitle', 'Install Update'),
                buildUpdateConfirmMessage(AppState.update.status),
                () => { void applyAppUpdate(AppState.update.status); }
            );
        } else if (action === 'check') {
            target.disabled = true;
            target.textContent = appT('update.checking', 'Checking...');
            try {
                await refreshUpdateStatus({ force: true, silent: false });
                _hideUpdatePopup();
                const btn2 = document.getElementById('btn-app-update');
                if (btn2 && AppState.update.status) _showUpdatePopup(btn2);
            } catch (err) {
                _hideUpdatePopup();
            }
        }
    };
}

function _hideUpdatePopup() {
    if (!_updatePopupEl) return;
    _updatePopupEl.classList.remove('visible');
    // Drop child DOM + delegated handler so closures from the previous render
    // can be garbage-collected. The two document-level listeners installed
    // by _createUpdatePopup remain (idempotent setup).
    _updatePopupEl.onclick = null;
    _updatePopupEl.innerHTML = '';
}

function createProgressTracker(maxSamples = 12) {
    return {
        maxSamples,
        scopeKey: '',
        startedAt: null,
        samples: [],
        lastEtaSeconds: null,
    };
}

function resetProgressTracker(tracker) {
    if (!tracker) return;
    tracker.scopeKey = '';
    tracker.startedAt = null;
    tracker.samples = [];
    tracker.lastEtaSeconds = null;
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

function updateProgressTracker(tracker, completed, total, options = {}) {
    if (!tracker) return { elapsedText: '', etaText: '' };

    const safeCompleted = Math.max(0, Number(completed) || 0);
    const safeTotal = Math.max(0, Number(total) || 0);
    const scopeKey = String(options.scopeKey || '');
    const now = Date.now();

    if (tracker.scopeKey !== scopeKey) {
        tracker.scopeKey = scopeKey;
        tracker.startedAt = null;
        tracker.samples = [];
        tracker.lastEtaSeconds = null;
    }

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
    if (options.showEta !== false && safeTotal > 0 && tracker.samples.length >= 3) {
        const first = tracker.samples[0];
        const last = tracker.samples[tracker.samples.length - 1];
        const completedDelta = last.completed - first.completed;
        const secondsDelta = (last.time - first.time) / 1000;
        if (completedDelta > 0 && secondsDelta > 0) {
            const rate = completedDelta / secondsDelta;
            const remaining = Math.max(0, safeTotal - safeCompleted);
            if (rate > 0 && remaining > 0) {
                etaSeconds = remaining / rate;
                if (tracker.lastEtaSeconds != null && Number.isFinite(tracker.lastEtaSeconds)) {
                    etaSeconds = (tracker.lastEtaSeconds * 0.65) + (etaSeconds * 0.35);
                }
                tracker.lastEtaSeconds = etaSeconds;
            }
        }
    }
    if (etaSeconds == null && safeTotal > 0 && safeCompleted >= safeTotal) {
        tracker.lastEtaSeconds = null;
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
    if (meta.etaText) parts.push(appT('progress.eta', 'ETA {time}').replace('{time}', meta.etaText));
    else if (meta.elapsedText) parts.push(appT('progress.elapsed', 'Elapsed {time}').replace('{time}', meta.elapsedText));

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
    showEta = true,
    progressKey = '',
}) {
    const meta = updateProgressTracker(tracker, completed, total, { showEta, scopeKey: progressKey });
    const parts = [];

    if (primaryLabel) parts.push(primaryLabel);
    if (total > 0) parts.push(`${completed}/${total}`);
    extraParts.filter(Boolean).forEach((part) => parts.push(part));
    if (showEta && meta.etaText) parts.push(appT('progress.eta', 'ETA {time}').replace('{time}', meta.etaText));
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
const TAGGER_CHUNK_OPTIONS = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 24, 32, 48, 64];

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

function getCustomTaggerProfile() {
    return normalizeTaggerModelName($('#tag-custom-profile-select')?.value || 'wd14', 'wd14');
}

function getEffectiveTaggerModelForUi(modelName, options = {}) {
    const { isCustom = false } = options;
    if (!isCustom) return normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    const customProfile = getCustomTaggerProfile();
    if (customProfile === 'camie-tagger-v2' || customProfile === 'pixai-tagger-v0.9') {
        return customProfile;
    }
    return 'custom';
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
        return appT('tagger.runtimeAdaptiveMax', 'Adaptive max-throughput mode is active. The app uses GPU first, then falls back only if the GPU provider fails.');
    }

    if (isCustom) {
        if (gpuEnabled) {
            return appT('tagger.runtimeCustomGpu', 'Custom model on GPU.');
        }
        return appT('tagger.runtimeCustomCpu', 'Custom model is set to CPU only.');
    }

    if (riskyGpu) {
        return appT('tagger.runtimeRiskyGpu', 'GPU mode is enabled. Automatic hardware limits still apply.');
    }

    if (gpuEnabled) {
        const focus = meta?.best_for
            ? appT('tagger.bestForPrefix', ' Best for: {bestFor}.').replace('{bestFor}', meta.best_for)
            : '';
        return `${appT('tagger.runtimeAdaptiveGpu', 'Adaptive GPU mode is active. The app is already using the recommended fast path for this hardware.')}${focus}`;
    }

    return appT('tagger.runtimeCpuSafe', 'CPU mode is active. GPU acceleration is off for this run.');
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
        const profileName = getCustomTaggerProfile();
        const profileMeta = profileName && profileName !== 'wd14' ? getLocalizedTaggerMeta(profileName, getTaggerModelMeta(profileName)) : null;
        if (profileMeta?.description) {
            subtitleEl.textContent = appT('tagger.customProfileSubtitle', 'Custom local model using {profile} profile.').replace('{profile}', profileName);
            badgesEl.innerHTML = [
                `<span class="tagger-model-badge is-warning">${escapeHtml(appT('tagger.customBadge', 'Custom'))}</span>`,
                `<span class="tagger-model-badge">${escapeHtml(profileName)}</span>`,
                `<span class="tagger-model-badge">${escapeHtml(appT('tagger.profileAwareBadge', 'Profile aware'))}</span>`,
            ].join('');
            noteEl.textContent = appT('tagger.customProfileNote', "The app will use this profile's preprocessing, metadata parser, confidence normalization, and rating behavior.");
            return;
        }
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
            batchRecommendation.textContent = appT('tagger.chunkHelpToriiGateFixed', 'ToriiGate uses a fixed chunk size of 1.');
        }
        if (chunkChip) {
            setTaggerStatusChip(chunkChip, 'Chunk 1', 'is-safe');
        }
        batchHelp.textContent = gpuEnabled
            ? appT('tagger.chunkHelpToriiGateGpu', 'ToriiGate uses the multimodal PyTorch backend. Chunk size is fixed to 1 for this backend.')
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
                : appT('tagger.chunkHelpRecommendedCustomCpu', 'Recommended starting chunk size: {chunk}. Increase only when tuning throughput.'))
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
    const customProfileGroup = $('#custom-profile-group');
    const customProfileSelect = $('#tag-custom-profile-select');
    const customModelGroup = $('#custom-model-group');
    const customTagsGroup = $('#custom-tags-group');
    const disabledNotice = $('#tagger-disabled-notice');
    const disabledTitle = $('#tagger-disabled-title');
    const disabledBody = $('#tagger-disabled-body');
    if (!modelSelect) return;

    const rawValue = modelSelect.value || '';
    const isCustom = rawValue === 'custom';
    const normalizedModel = normalizeTaggerModelName(rawValue, 'wd-swinv2-tagger-v3');
    const effectiveModelForUi = getEffectiveTaggerModelForUi(normalizedModel, { isCustom });
    const rawMeta = getTaggerModelMeta(effectiveModelForUi === 'custom' ? normalizedModel : effectiveModelForUi);
    const meta = getLocalizedTaggerMeta(effectiveModelForUi === 'custom' ? normalizedModel : effectiveModelForUi, rawMeta);
    const isToriiGate = isToriiGateTaggerModel(effectiveModelForUi, { isCustom: false });
    const gpuLocked = isGpuLockedTaggerModel(effectiveModelForUi, { isCustom });
    const gpuUserChosen = useGpu?.dataset.userChosen === '1';
    const currentGpuSelection = useGpu?.checked ?? true;
    const activeHardwareRecommendation = getTaggerHardwareRecommendation(effectiveModelForUi, { isCustom: effectiveModelForUi === 'custom', useGpu: currentGpuSelection });
    const gpuHardwareRecommendation = getTaggerHardwareRecommendation(effectiveModelForUi, { isCustom: effectiveModelForUi === 'custom', useGpu: true });
    const hardwareRecommendation = activeHardwareRecommendation || gpuHardwareRecommendation;
    const providerState = getTaggerProviderState();
    const hardwareProbeLoaded = providerState.probeLoaded;
    const onnxGpuAvailable = providerState.hasCuda || providerState.hasDml;
    const torchGpuAvailable = providerState.hasTorchCuda || providerState.hasCuda || providerState.hasTensorRt;
    const hardwareRisk = String(hardwareRecommendation?.risk_level || '').toLowerCase();
    const hardwarePrefersGpu = true;
    const hardwareHighRisk = hardwareRisk === 'high';
    const taggingIsRunning = $('#btn-start-tag')?.disabled === true;
    const modelDisabled = !isCustom && Boolean(meta?.disabled);
    const modelPrefersGpu = Boolean(meta?.gpu_default ?? true);
    const recommendedGpu = gpuLocked ? false : (modelPrefersGpu && hardwarePrefersGpu);

    if (customProfileGroup) customProfileGroup.style.display = isCustom ? 'block' : 'none';
    if (customProfileSelect) customProfileSelect.disabled = taggingIsRunning;
    if (customModelGroup) customModelGroup.style.display = isCustom ? 'block' : 'none';
    if (customTagsGroup) customTagsGroup.style.display = isCustom ? 'block' : 'none';
    renderTaggerModelSnapshot(meta, { isCustom, modelDisabled, rawMeta });
    syncTaggerThresholdUi({ isToriiGate });

    if (applyModelDefaults && meta && (!isCustom || effectiveModelForUi !== 'custom')) {
        applyTaggerModelThresholdDefaults(meta);
    }

    if (useGpu && gpuLocked) {
        useGpu.checked = false;
    } else if (useGpu && applyModelDefaults && !gpuUserChosen) {
        useGpu.checked = recommendedGpu;
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
            const customProfile = getCustomTaggerProfile();
            if (customProfile === 'camie-tagger-v2') {
                modelHelp.textContent = appT('tagger.customCamieHelp', 'Custom Camie ONNX: use the Camie metadata JSON. Logits are sigmoid-normalized before thresholds.');
            } else if (customProfile === 'pixai-tagger-v0.9') {
                modelHelp.textContent = appT('tagger.customPixaiHelp', 'Custom PixAI ONNX: use selected_tags.csv. PixAI preprocessing and rating fallback are enabled.');
            } else {
                modelHelp.textContent = (useGpu?.checked ?? false)
                    ? appT('tagger.customModelHelpGpuPreferred', 'Custom ONNX model. GPU mode is on for this run.')
                    : appT('tagger.customModelHelp', 'Custom ONNX model. CPU mode is selected for this run.');
            }
        } else if (modelDisabled) {
            modelHelp.textContent = meta?.disabled_reason || appT('tagger.modelListedFuture', 'This model is listed for future integration but is not runnable in the current build.');
        } else {
            modelHelp.textContent = describeTaggerModel(meta);
        }
    }

    const gpuEnabled = useGpu?.checked ?? false;
    const riskyGpu = modelDisabled ? false : isRiskyTaggerGpuSelection(effectiveModelForUi, {
        isCustom: isCustom && effectiveModelForUi === 'custom',
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
            runtimeAdvancedHint.textContent = appT('tagger.advHintCustom', 'Optional. Change this only when troubleshooting a custom model.');
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
            gpuHelp.textContent = appT('tagger.gpuHelpPendingProbe', 'Hardware probe is still loading. GPU remains enabled by default while the runtime check finishes.');
        } else if (gpuLocked) {
            gpuHelp.textContent = appT('tagger.gpuHelpAdaptive', 'Adaptive runtime is active for this model. The app prefers GPU throughput.');
        } else if (!gpuEnabled) {
            gpuHelp.textContent = isCustom
                ? appT('tagger.gpuHelpCustomCpu', 'CPU mode is active for the custom model. Switch GPU back on if you want acceleration.')
                : (hardwareHighRisk
                    ? appT('tagger.gpuHelpHighRiskCpu', 'CPU mode is active. GPU acceleration is disabled for this run.')
                    : appT('tagger.gpuHelpCpuSafe', 'CPU mode is active. GPU acceleration is disabled for this run.'));
        } else if (riskyGpu) {
            gpuHelp.textContent = appT('tagger.gpuHelpRiskyOverride', 'GPU mode is active. Automatic hardware limits still apply.');
        } else if (meta?.safe_mode_note) {
            gpuHelp.textContent = appT('tagger.gpuHelpRecommendedNote', 'Recommended GPU mode is active. {note}').replace('{note}', meta.safe_mode_note);
        } else {
            gpuHelp.textContent = appT('tagger.gpuHelpRecommendedDefault', 'GPU mode is active for this model.');
        }
    }

    syncTaggerRuntimeChunkUi({
        modelName: effectiveModelForUi,
        gpuEnabled,
        gpuLocked,
        riskyGpu,
        isCustom: isCustom && effectiveModelForUi === 'custom',
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
    const _d = window.I18n?.t?.('selection.doneSelecting');
    const doneLabel = (_d && _d !== 'selection.doneSelecting') ? _d : 'Done Selecting';
    const _s = window.I18n?.t?.('gallery.selectImages');
    const idleLabel = (_s && _s !== 'gallery.selectImages') ? _s : 'Select Images';

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
    const selectedCount = getSelectedGalleryCount();
    const detail = {
        selectionMode: Boolean(AppState.selectionMode),
        selectedCount,
        selectionScope: AppState.selectionScope || 'visible',
    };
    window.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
    document.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
}

function getSelectionScopeSummaryText(scope = AppState.selectionScope || 'visible') {
    if (scope === 'loaded') {
        return appT('selection.scopeLoaded', 'Selected from loaded gallery items');
    }
    if (scope === 'filtered') {
        return AppState.selectionToken
            ? appT('selection.scopeFiltered', 'Selected all current filter matches')
            : appT('selection.scopeFilteredExplicit', 'Selected current filter matches');
    }
    return appT('selection.scopeVisible', 'Selected manually from Gallery');
}

function collapseSelectionMoreActions() {
    // Selection actions are now always visible in sections; kept as a no-op for older callers.
}

function normalizeSelectionImageIds(rawIds) {
    return Array.isArray(rawIds)
        ? rawIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
        : [];
}

function confirmLargeFilteredSelection(total) {
    const normalizedTotal = Number(total || 0);
    if (normalizedTotal <= FILTERED_SELECTION_CONFIRM_THRESHOLD) {
        return true;
    }

    const confirmMessage = appT(
        'selection.largeFilteredConfirm',
        'This will select {count} filtered images using a compact selection token. Continue?',
        { count: normalizedTotal }
    );
    return window.confirm(confirmMessage);
}

function shouldFallbackToSelectionIds(error) {
    return [404, 405, 501].includes(Number(error?.apiStatus));
}

async function resolveFilteredSelectionIdsViaChunks(filterPayload, options = {}) {
    const tokenPayload = await API.createSelectionToken(filterPayload, FILTERED_SELECTION_CHUNK_SIZE, options);
    const selectionToken = tokenPayload?.selection_token;
    if (!selectionToken) {
        throw new Error('Selection token response was missing a token');
    }

    const totalEstimate = Number(tokenPayload?.total_estimate || 0);
    if (!confirmLargeFilteredSelection(totalEstimate)) {
        return { cancelled: true, imageIds: [] };
    }

    return {
        cancelled: false,
        imageIds: [],
        selectionToken,
        total: totalEstimate,
        exactTotal: tokenPayload?.exact_total !== false,
    };
}

async function resolveFilteredSelectionIdsViaLegacyEndpoint(filterPayload) {
    const result = await API.getSelectionIds(filterPayload);
    const imageIds = normalizeSelectionImageIds(result?.image_ids);
    const total = Number(result?.total || imageIds.length || 0);
    if (!confirmLargeFilteredSelection(total)) {
        return { cancelled: true, imageIds: [] };
    }
    return { cancelled: false, imageIds, selectionToken: null, total };
}

async function resolveFilteredSelectionIds(filterPayload, options = {}) {
    try {
        return await resolveFilteredSelectionIdsViaChunks(filterPayload, options);
    } catch (error) {
        if (!shouldFallbackToSelectionIds(error)) {
            throw error;
        }
        return resolveFilteredSelectionIdsViaLegacyEndpoint(filterPayload);
    }
}

async function selectAllFilteredResults() {
    const selectFilteredBtn = $('#btn-select-all');
    if (selectFilteredBtn) {
        selectFilteredBtn.disabled = true;
    }

    try {
        const filterPayload = buildSelectionFilterRequest();
        const filterKey = JSON.stringify(filterPayload);
        const result = await resolveFilteredSelectionIds(filterPayload);
        if (result.cancelled) {
            updateSelectionUI();
            return;
        }

        if (getSelectionFilterCacheKey(AppState.filters) !== filterKey) {
            updateSelectionUI();
            return;
        }

        updateSelectionState((selection) => {
            selection.selectedIds = result.selectionToken ? new Set() : new Set(result.imageIds);
            selection.scope = 'filtered';
            selection.filterKey = filterKey;
            selection.selectionToken = result.selectionToken || null;
            selection.selectionTotal = Number(result.total || result.imageIds?.length || 0);
        });

        if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
            Gallery.syncSelectionState();
        }
        updateSelectionUI();
        emitSelectionStateChanged();
    } catch (error) {
        showToast(
            formatUserError(error, appT('selection.selectFilteredFailed', 'Failed to select all current filter matches')),
            'error'
        );
        updateSelectionUI();
    }
}

async function invertAllFilteredResults() {
    const invertFilteredBtn = $('#btn-invert-selection-filtered');
    if (invertFilteredBtn) {
        invertFilteredBtn.disabled = true;
    }

    try {
        const filterPayload = buildSelectionFilterRequest();
        const filterKey = JSON.stringify(filterPayload);
        const excludedImageIds = getSelectedGalleryIds();
        const result = await resolveFilteredSelectionIds(filterPayload, { excludedImageIds });
        if (result.cancelled) {
            updateSelectionUI();
            return;
        }

        if (getSelectionFilterCacheKey(AppState.filters) !== filterKey) {
            updateSelectionUI();
            return;
        }

        const currentSelected = new Set(AppState.selectedIds || []);
        const activeSelectionToken = getActiveSelectionTokenForActions();

        updateSelectionState((selection) => {
            if (activeSelectionToken) {
                if (currentSelected.size === 0) {
                    selection.selectedIds = new Set();
                    selection.scope = 'visible';
                    selection.filterKey = null;
                    selection.selectionToken = null;
                    selection.selectionTotal = 0;
                    return;
                }

                selection.selectedIds = new Set(currentSelected);
                selection.scope = 'filtered';
                selection.filterKey = filterKey;
                selection.selectionToken = null;
                selection.selectionTotal = currentSelected.size;
                return;
            }

            if (result.selectionToken) {
                selection.selectedIds = currentSelected;
                selection.scope = 'filtered';
                selection.filterKey = filterKey;
                selection.selectionToken = result.selectionToken;
                selection.selectionTotal = Number(result.total || 0);
                return;
            }

            const nextSelected = new Set(
                result.imageIds.filter((imageId) => !currentSelected.has(imageId))
            );
            selection.selectedIds = nextSelected;
            selection.scope = 'filtered';
            selection.filterKey = filterKey;
            selection.selectionToken = null;
            selection.selectionTotal = nextSelected.size;
        });

        if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
            Gallery.syncSelectionState();
        }
        resetSelectionDataCache();
        updateSelectionUI();
        emitSelectionStateChanged();
    } catch (error) {
        showToast(
            formatUserError(error, appT('selection.invertFilteredFailed', 'Failed to invert current filter matches')),
            'error'
        );
        updateSelectionUI();
    }
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
    const nextMode = Boolean(enabled);
    updateSelectionState((selection) => {
        selection.selectionMode = nextMode;
        if (!nextMode && clearSelectionWhenDisabled) {
            selection.selectedIds = new Set();
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        }
    });

    if (!nextMode) {
        collapseSelectionMoreActions();
    }

    if (!nextMode && clearSelectionWhenDisabled && window.Gallery) {
        window.Gallery.lastSelectedIndex = null;
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

    updateAppFilters((filters) => {
        filters.prompts = [value];
    });

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
        cancelGalleryImageLoad();
        // Stop hidden-gallery thumbnail downloads from occupying the browser's
        // per-host connection pool. This keeps Dataset Maker's folder browser
        // responsive even when the gallery was still loading many thumbnails.
        // The cached ``AppState.images`` array survives, so when the user
        // returns to the gallery the ``Gallery.setImages`` path on line ~3729
        // re-renders the DOM (and re-attaches img.src) from cache without a
        // network refetch. Setting ``galleryNeedsRefresh = true`` here would
        // force a full reload on every nav-out and break callers that
        // explicitly DO NOT want a refresh after their action (e.g. Reader
        // save-as-new to a path outside the indexed library).
        const galleryGrid = $('#gallery-grid');
        if (galleryGrid) {
            galleryGrid.querySelectorAll('img').forEach((img) => {
                img.removeAttribute('srcset');
                img.removeAttribute('src');
            });
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
        collapseSelectionMoreActions();
    } else if (AppState.selectionMode && getSelectedGalleryCount() > 0) {
        // Show FAB if we have selections and are returning to gallery
        const selActions = $('#selection-actions');
        if (selActions) selActions.style.display = 'grid';
    }

    // View-specific initialization
    if (viewName === 'gallery') {
        let suppressInitialGalleryAutoLoadMore = false;
        setGalleryViewMode(AppState.viewMode);
        // Re-render existing images immediately, only reload from API if needed
        if (AppState.galleryNeedsRefresh) {
            suppressInitialGalleryAutoLoadMore = AppState.gallerySuppressNextAutoLoadMore;
            loadImages(false, {
                silent: AppState.images.length > 0,
                preserveExisting: AppState.images.length > 0,
                coalesce: true,
                suppressAutoLoadMore: suppressInitialGalleryAutoLoadMore,
            });
            AppState.galleryNeedsRefresh = false;
            AppState.gallerySuppressNextAutoLoadMore = false;
        } else if (AppState.images.length > 0 && window.Gallery) {
            Gallery.setImages(AppState.images);
        } else {
            loadImages();
        }
        requestAnimationFrame(() => {
            attachGalleryPaginationListener();
            if (!suppressInitialGalleryAutoLoadMore) {
                _onGalleryScroll();
            }
        });
        // Re-check whether unreadable rows exist when returning to gallery.
        // Cached for 60s inside UnreadableBanner so this is cheap.
        window.UnreadableBanner?.refresh?.(false);
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

    updateSelectionUI();
}

function getSelectedGalleryExamples(ids, limit = 5) {
    const imageById = new Map((AppState.images || []).map((image) => [Number(image.id), image]));
    return ids
        .slice(0, limit)
        .map((id) => imageById.get(Number(id))?.filename || `Image ${id}`)
        .join(', ');
}

function getSelectedGalleryCount() {
    if (AppState.selectionScope === 'filtered' && AppState.selectionToken) {
        return Math.max(0, Number(AppState.selectionTotal || AppState.selectedIds?.size || 0) || 0);
    }
    return AppState.selectedIds?.size || 0;
}

function getActiveSelectionTokenForActions() {
    if (AppState.selectionScope !== 'filtered' || !AppState.selectionToken) {
        return null;
    }
    if (AppState.selectionFilterKey !== getSelectionFilterCacheKey(AppState.filters)) {
        return null;
    }
    return AppState.selectionToken;
}

function isFilteredSelectionActiveForCurrentFilters() {
    return Boolean(getActiveSelectionTokenForActions());
}

function clearGallerySelectionAfterBulkAction() {
    updateSelectionState((selection) => {
        selection.selectedIds = new Set();
        selection.scope = 'visible';
        selection.filterKey = null;
        selection.selectionToken = null;
        selection.selectionTotal = 0;
    });
    resetSelectionDataCache();
}

function getSelectedGalleryIds() {
    return Array.from(AppState.selectedIds)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
}

async function deleteGalleryImagesByIds(imageIds) {
    const selectionToken = getActiveSelectionTokenForActions();
    const ids = normalizeSelectionImageIds(imageIds);
    const count = selectionToken ? getSelectedGalleryCount() : ids.length;

    if (count === 0) {
        showToast(appT('selection.emptyHint', 'Select images, or choose all current filter matches.'), 'info');
        return;
    }

    const examples = selectionToken ? '' : getSelectedGalleryExamples(ids);
    const title = appT('selection.deleteConfirmTitle', 'Move selected image files to Trash?');
    const message = appT(
        'selection.deleteConfirmBody',
        'This moves {count} original file(s) to the operating system Trash / Recycle Bin and removes them from this gallery. Use Remove from Gallery if you only want to clean the index. Examples: {examples}'
    )
        .replace('{count}', count)
        .replace('{examples}', examples || (selectionToken
            ? appT('selection.filteredExamples', 'current filtered selection')
            : ids.slice(0, 5).join(', ')));

    showConfirm(title, message, async () => {
        try {
            const result = await API.deleteSelectedImages(ids, { selectionToken });
            const failed = Array.isArray(result.failed) ? result.failed : [];
            const failedIds = new Set(failed.map((item) => Number(item.image_id)));

            if (selectionToken) {
                clearGallerySelectionAfterBulkAction();
            } else {
                const deletedIds = ids.filter((id) => !failedIds.has(id));
                mutateSelectedIds((selectedIds) => {
                    deletedIds.forEach((id) => selectedIds.delete(id));
                });
            }

            updateSelectionUI();
            emitSelectionStateChanged();
            if (window.Gallery && typeof window.Gallery.syncSelectionState === 'function') {
                window.Gallery.syncSelectionState();
            }

            await loadImages();
            loadStats();

            if (failed.length > 0) {
                showToast(
                    appT('selection.deletePartial', 'Moved {deleted} file(s) to Trash. {failed} failed.')
                        .replace('{deleted}', result.deleted || 0)
                        .replace('{failed}', failed.length),
                    'warning'
                );
                return;
            }

            showToast(
                appT('selection.deleteSuccess', 'Moved {count} image file(s) to Trash.')
                    .replace('{count}', result.deleted || 0),
                'success'
            );
        } catch (error) {
            showToast(
                formatUserError(error, appT('selection.deleteFailed', 'Failed to move selected image files to Trash')),
                'error'
            );
        }
    });
}

function deleteSelectedGalleryImages() {
    return deleteGalleryImagesByIds(getSelectedGalleryIds());
}

async function removeGalleryImagesByIds(imageIds) {
    const selectionToken = getActiveSelectionTokenForActions();
    const ids = normalizeSelectionImageIds(imageIds);
    const count = selectionToken ? getSelectedGalleryCount() : ids.length;

    if (count === 0) {
        showToast(appT('selection.emptyHint', 'Select images, or choose all current filter matches.'), 'info');
        return;
    }

    const examples = selectionToken ? '' : getSelectedGalleryExamples(ids);
    const title = appT('selection.removeConfirmTitle', 'Remove selected images from gallery?');
    const message = appT(
        'selection.removeConfirmBody',
        'This removes {count} image record(s) from this gallery only. Files stay on disk and can be re-imported by scanning again. Examples: {examples}'
    )
        .replace('{count}', count)
        .replace('{examples}', examples || (selectionToken
            ? appT('selection.filteredExamples', 'current filtered selection')
            : ids.slice(0, 5).join(', ')));

    showConfirm(title, message, async () => {
        try {
            const result = await API.removeSelectedImages(ids, { selectionToken });
            if (selectionToken) {
                clearGallerySelectionAfterBulkAction();
            } else {
                mutateSelectedIds((selectedIds) => {
                    ids.forEach((id) => selectedIds.delete(id));
                });
                resetSelectionDataCache();
            }
            updateSelectionUI();
            emitSelectionStateChanged();
            if (window.Gallery && typeof window.Gallery.syncSelectionState === 'function') {
                window.Gallery.syncSelectionState();
            }

            await loadImages();
            await loadStats();

            const missingCount = Array.isArray(result?.missing_ids) ? result.missing_ids.length : 0;
            if (missingCount > 0) {
                showToast(
                    appT('selection.removePartial', 'Removed {removed} image record(s). {missing} were already missing from the gallery.')
                        .replace('{removed}', result?.removed || 0)
                        .replace('{missing}', missingCount),
                    'warning'
                );
                return;
            }

            showToast(
                appT('selection.removeSuccess', 'Removed {count} image record(s) from the gallery. Files were not deleted.')
                    .replace('{count}', result?.removed || 0),
                'success'
            );
        } catch (error) {
            showToast(
                formatUserError(error, appT('selection.removeFailed', 'Failed to remove selected images from gallery')),
                'error'
            );
        }
    });
}

function removeSelectedGalleryImages() {
    return removeGalleryImagesByIds(getSelectedGalleryIds());
}

async function moveOrCopyGalleryImages(imageIds, operation = 'move', options = {}) {
    const normalizedOperation = operation === 'copy' ? 'copy' : 'move';
    // v3.2.1 task #34: when the user is in "Select All Filtered" scope, the
    // selection is represented by a token (not by populating
    // AppState.selectedIds). The previous implementation relied solely on the
    // ID list and showed a misleading "select images" toast even when a
    // filtered selection was active. Mirror the delete/remove logic instead.
    const selectionToken = options.source === 'selection'
        ? getActiveSelectionTokenForActions()
        : null;
    const ids = normalizeSelectionImageIds(imageIds);
    const isSingleContext = options.source === 'context' && ids.length === 1;
    const totalCount = selectionToken ? getSelectedGalleryCount() : ids.length;

    if (totalCount === 0) {
        showToast(appT('selection.emptyHint', 'Select images, or choose all current filter matches.'), 'info');
        return;
    }

    const operationLabel = normalizedOperation === 'copy'
        ? appT('selection.copyVerb', 'Copy')
        : appT('selection.moveVerb', 'Move');
    const destination = await showInputModal(
        isSingleContext
            ? (normalizedOperation === 'copy'
                ? appT('gallery.contextCopyPromptTitle', 'Copy image')
                : appT('gallery.contextMovePromptTitle', 'Move image'))
            : appT('selection.destinationPromptTitle', '{operation} selected images')
                .replace('{operation}', operationLabel),
        appT('selection.destinationPromptBody', 'Enter the destination folder path for {count} selected image(s).')
            .replace('{count}', totalCount),
        getRecentFolders()[0] || ''
    );
    if (!destination || !destination.trim()) return;

    const trimmedDestination = destination.trim();
    const confirmTitle = isSingleContext
        ? (normalizedOperation === 'copy'
            ? appT('gallery.contextCopyConfirmTitle', 'Copy this image file?')
            : appT('gallery.contextMoveConfirmTitle', 'Move this image file?'))
        : (normalizedOperation === 'copy'
            ? appT('selection.copyConfirmTitle', 'Copy selected image files?')
            : appT('selection.moveConfirmTitle', 'Move selected image files?'));
    const confirmBody = (isSingleContext
        ? (normalizedOperation === 'copy'
            ? appT('gallery.contextCopyConfirmBody', 'This copies the file to: {destination}. Original stays in place.')
            : appT('gallery.contextMoveConfirmBody', 'This moves the original file to: {destination}'))
        : (normalizedOperation === 'copy'
            ? appT('selection.copyConfirmBody', 'This copies {count} file(s) to: {destination}. Originals stay in place.')
            : appT('selection.moveConfirmBody', 'This moves {count} original file(s) to: {destination}')))
        .replace('{count}', totalCount)
        .replace('{destination}', trimmedDestination);

    showConfirm(confirmTitle, confirmBody, async () => {
        try {
            const result = await API.moveImages(ids, trimmedDestination, normalizedOperation, { selectionToken });
            const results = Array.isArray(result?.results) ? result.results : [];
            const successes = results.filter((item) => item?.success);
            // For filtered selection mode the API expanded the token server-side,
            // so the per-id failure mapping uses results[].id rather than the
            // empty client-side `ids` list.
            const failed = results.length > 0
                ? results.filter((item) => !item?.success)
                : (ids.length > 0 ? ids.map((id) => ({ id, error: 'No result returned' })) : []);

            if (successes.length > 0 && normalizedOperation === 'move') {
                if (selectionToken) {
                    clearGallerySelectionAfterBulkAction();
                } else {
                    const movedIds = new Set(successes.map((item) => Number(item.id)).filter((id) => Number.isFinite(id)));
                    mutateSelectedIds((selectedIds) => {
                        movedIds.forEach((id) => selectedIds.delete(id));
                    });
                }
            }

            addRecentFolder(trimmedDestination);
            resetSelectionDataCache();
            updateSelectionUI();
            emitSelectionStateChanged();
            if (window.Gallery && typeof window.Gallery.syncSelectionState === 'function') {
                window.Gallery.syncSelectionState();
            }

            await loadImages();
            await loadStats();

            if (failed.length > 0) {
                showToast(
                    appT('selection.moveCopyPartial', '{operation} completed for {success} image(s). {failed} failed.')
                        .replace('{operation}', operationLabel)
                        .replace('{success}', successes.length)
                        .replace('{failed}', failed.length),
                    successes.length > 0 ? 'warning' : 'error'
                );
                return;
            }

            showToast(
                appT('selection.moveCopySuccess', '{operation} completed for {count} image(s).')
                    .replace('{operation}', operationLabel)
                    .replace('{count}', successes.length),
                'success'
            );
        } catch (error) {
            showToast(
                formatUserError(error, appT('selection.moveCopyFailed', 'Failed to {operation} selected images')
                    .replace('{operation}', operationLabel.toLowerCase())),
                'error'
            );
        }
    });
}

async function moveOrCopySelectedGalleryImages(operation = 'move') {
    return moveOrCopyGalleryImages(getSelectedGalleryIds(), operation, { source: 'selection' });
}

// v3.2.2 task #4: push the gallery selection into the Dataset Maker
// queue and switch the user to that view.
async function sendSelectionToDatasetMaker() {
    const ids = getSelectedGalleryIds();
    const hasFilteredToken = Boolean(getActiveSelectionTokenForActions());
    if ((!ids || ids.length === 0) && !hasFilteredToken) {
        showToast(
            appT('selection.emptyHint',
                 'Select images, or choose all current filter matches.'),
            'info'
        );
        return;
    }
    if (!window.DatasetMaker || typeof window.DatasetMaker.addImageIds !== 'function') {
        showToast(
            appT('selection.sendToDatasetMakerUnavailable',
                 'Dataset Maker module not loaded yet — try again in a moment.'),
            'error'
        );
        return;
    }
    try {
        // Route through DatasetMaker so filtered-selection tokens resolve
        // into real image IDs and the user lands on Dataset tab 1.
        const resolvedIds = typeof window.DatasetMaker._resolveGallerySelectionIds === 'function'
            ? await window.DatasetMaker._resolveGallerySelectionIds()
            : ids;
        await window.DatasetMaker.addImageIds(resolvedIds, { switchView: true, showToast: true });
    } catch (exc) {
        showToast(
            appT('selection.sendToDatasetMakerFailed',
                 'Failed to send selection to Dataset Maker: {error}',
                 { error: exc?.message || String(exc) }),
            'error'
        );
    }
}

function updateNavigationOverflowState() {
    const navBar = $('.nav-bar');
    const navTabs = $('.nav-tabs');
    if (!navBar || !navTabs) return window.innerWidth <= 768;

    const forceMobileLayout = window.innerWidth <= 768;
    navBar.classList.remove('nav-tabs-overflow', 'nav-actions-compact', 'nav-tabs-icon-only');
    if (forceMobileLayout) {
        navBar.classList.add('nav-tabs-overflow');
        return true;
    }

    const needsOverflow = () => {
        // v3.2.2: simplest possible overflow detection — does the
        // ``navTabs`` flex container's scrollWidth (its natural,
        // un-clipped width) exceed its clientWidth (what the layout
        // gave it)? If yes, content is being clipped, regardless of
        // what nav-actions-compact / brand width / etc. compute to.
        // The previous formula tried to predict the available width
        // from sibling sizes; on 1440 px laptops it under-counted the
        // gap and let the last tab silently clip.
        return navTabs.scrollWidth > navTabs.clientWidth + 1;
    };

    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    // v3.2.2: with the new 📦 Dataset tab the count of primary tabs went
    // from 7 to 8, which pushes 1366-1440 px laptops past the cliff.
    // Try a 3-step graceful degradation before falling back to the
    // hamburger overlay:
    //   1. Compact the nav-actions buttons (smaller padding)
    //   2. Hide the text labels on the nav tabs (icon-only) - tabs
    //      keep their aria-label so screen readers and tooltips still
    //      announce the destination
    //   3. Full mobile-menu fallback
    navBar.classList.add('nav-actions-compact');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.add('nav-tabs-icon-only');
    if (!needsOverflow()) {
        closeMobileMenu();
        return false;
    }

    navBar.classList.remove('nav-actions-compact', 'nav-tabs-icon-only');
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

    $('#btn-reconnect-missing')?.addEventListener('click', () => showModal('reconnect-modal'));
    $('#btn-browse-reconnect-folder')?.addEventListener('click', () => {
        const input = $('#reconnect-folder-path');
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
    $('#btn-cancel-aesthetic')?.addEventListener('click', async () => {
        try {
            await API.cancelAesthetic();
            // Don't wait ~1.2s for the next poll tick to clear local state.
            // Without this, the busy guard on #btn-clear-db (and related
            // "is something running" checks elsewhere) will keep blocking
            // user input for the full polling interval after cancel returns.
            clearAestheticProgressTimer();
            updateAestheticUi({ running: false, completed: 0, total: 0 });
            showToast(appT('gallery.aestheticCancelled', 'Aesthetic scoring is being stopped...'), 'info');
        } catch (error) {
            showToast(formatUserError(error, 'Failed to cancel'), 'error');
        }
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
    $('#btn-copy-scan-diagnostics')?.addEventListener('click', copyScanDiagnostics);
    $('#btn-open-scan-log')?.addEventListener('click', openScanLogFile);
    $('#btn-copy-scan-log-path')?.addEventListener('click', copyScanLogPath);
    $('#btn-stop-scan-from-diagnostics')?.addEventListener('click', requestStopScan);
    $('#btn-cancel-reconnect')?.addEventListener('click', requestStopReconnectMissing);
    $('#btn-start-reconnect')?.addEventListener('click', startReconnectMissing);

    // Tag modal X close button — minimize to background if tagging
    $('#btn-close-tag-modal')?.addEventListener('click', () => minimizeTaggingToBackground());
    // UI-02: Inline validation for scan folder path
    const scanFolderPathInput = $('#scan-folder-path');
    if (scanFolderPathInput) {
        const debouncedValidation = debounce(validateScanFolderPath, 300);
        scanFolderPathInput.addEventListener('input', debouncedValidation);
        scanFolderPathInput.addEventListener('blur', validateScanFolderPath);
    }
    const reconnectFolderPathInput = $('#reconnect-folder-path');
    if (reconnectFolderPathInput) {
        const debouncedReconnectValidation = debounce(validateReconnectFolderPath, 300);
        reconnectFolderPathInput.addEventListener('input', debouncedReconnectValidation);
        reconnectFolderPathInput.addEventListener('blur', validateReconnectFolderPath);
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
    $('#tag-custom-profile-select')?.addEventListener('change', () => {
        delete $('#tag-use-gpu')?.dataset.userChosen;
        syncTaggerModelUi({ applyModelDefaults: true, toastOnAutoSafe: true });
        syncTagAdvancedUi();
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
                updateAppFilters((filters) => {
                    filters.generators = [...ALL_GENERATORS];
                });
            } else if (gen === 'others') {
                // Bundle of less common generators — Fooocus, reForge,
                // Gemini, gpt-image, etc. Each is still individually
                // filterable via the Filter Criteria modal.
                updateAppFilters((filters) => {
                    filters.generators = [...OTHERS_GENERATOR_BUNDLE];
                });
            } else {
                // Filter by single generator
                updateAppFilters((filters) => {
                    filters.generators = [gen];
                });
            }

            // Update filter modal checkboxes to stay in sync
            $$('#modal-generator-filters input').forEach(cb => {
                if (gen === 'all') {
                    cb.checked = true;
                } else if (gen === 'others') {
                    cb.checked = OTHERS_GENERATOR_BUNDLE.includes(cb.value);
                } else {
                    cb.checked = cb.value === gen;
                }
            });

            updateFilterSummary();
            loadImages();
        });
    });

    // Gallery sort dropdown
    $('#gallery-sort').addEventListener('change', (e) => {
        updateAppFilters((filters) => {
            filters.sortBy = e.target.value;
        });
        if (AppState.filters.sortBy === 'aesthetic') {
            const hasExistingScores = Number(_aestheticStatus.scored_count || 0) > 0;
            if (!_aestheticStatus.available && !hasExistingScores) {
                // Predictor missing AND no scores in DB — there is literally
                // nothing to sort by, so push the user back to newest and
                // explain why.
                showToast(_aestheticStatus.message || appT('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable — required dependencies not installed'), 'warning');
                e.target.value = 'newest';
                updateAppFilters((filters) => {
                    filters.sortBy = 'newest';
                });
            } else if (!_aestheticStatus.available && hasExistingScores) {
                // Predictor missing but scores exist from a previous run —
                // sorting still works, just no NEW scoring. Inform the user
                // so they don't think the data is gone.
                showToast(appT('gallery.aestheticViewExistingOnly', 'Showing your {count} existing aesthetic scores. New scoring is unavailable until the predictor is reinstalled.', { count: _aestheticStatus.scored_count }), 'info');
            } else if (_aestheticStatus.scored_count === 0) {
                showToast(appT('gallery.aestheticNeedScoring', 'No images have been scored yet. Open AI Tag Images and run Score Aesthetic first.'), 'info');
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
            updateAppFilters((filters) => {
                filters.sortBy = reversed;
            });
            updateSortReverseButton();
            loadImages();
        }
    });




    // Clear DB button
    $('#btn-clear-db').addEventListener('click', async () => {
        // Belt-and-braces: check local poll-state first, then verify
        // against ALL THREE backend progress endpoints. Local state can
        // lag (e.g. if a poll callback never runs after cancel), so the
        // server is the source of truth.
        //
        // Note: scan polling does NOT use a stored timer handle — it uses
        // a `_scanProgressTracker` object plus bare `setTimeout` calls.
        // Earlier revisions of this guard referenced a `_scanProgressTimer`
        // that was never declared, so any path through this branch threw
        // `ReferenceError: _scanProgressTimer is not defined` and broke
        // the Clear DB button entirely. The local check now uses the
        // tracker's `startedAt` instead.
        const BUSY_STATUSES = new Set(['running', 'cancelling', 'starting']);
        const isProgressBusy = (value) => {
            if (!value) return false;
            if (BUSY_STATUSES.has(value.status)) return true;
            if (value.running) return true;
            return false;
        };
        let busy = Boolean(_aestheticProgressTimer || _tagProgressTimer || _scanProgressTracker?.startedAt);
        if (!busy) {
            const [scanResult, tagResult, aestheticResult] = await Promise.allSettled([
                API.getScanProgress(),
                API.getTagProgress(),
                API.getAestheticProgress(),
            ]);
            const probes = [
                ['scan', scanResult],
                ['tag', tagResult],
                ['aesthetic', aestheticResult],
            ];
            for (const [label, result] of probes) {
                if (result.status === 'fulfilled') {
                    if (isProgressBusy(result.value)) {
                        busy = true;
                    }
                } else {
                    Logger.warn(`Clear gallery: ${label} progress probe failed, assuming idle:`, result.reason);
                }
            }
        }
        if (busy) {
            Logger.warn('Clear gallery blocked: a background job is still active', {
                aestheticTimer: !!_aestheticProgressTimer,
                scanTracker: Boolean(_scanProgressTracker?.startedAt),
                tagTimer: !!_tagProgressTimer,
            });
            showToast(appT('gallery.clearBlocked', 'Cannot clear gallery while scanning, tagging, or scoring is running. Stop the operation first.'), 'warning');
            return;
        }
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
            clearSelectedIds({ scope: 'visible' });
            updateSelectionUI();
            emitSelectionStateChanged();
        }
    });

    // Selection scope actions
    $('#btn-select-all')?.addEventListener('click', () => {
        selectAllFilteredResults();
    });

    $('#btn-invert-selection-filtered')?.addEventListener('click', () => {
        invertAllFilteredResults();
    });

    $('#btn-move-selected')?.addEventListener('click', () => moveOrCopySelectedGalleryImages('move'));
    $('#btn-copy-selected')?.addEventListener('click', () => moveOrCopySelectedGalleryImages('copy'));
    // v3.2.2 task #4: gallery selection now offers "send to Dataset Maker"
    // (the training-set workspace) instead of standalone color analysis.
    // Color analysis is still available via the Tag Images modal's Color
    // tab, where most users actually trigger it.
    $('#btn-send-selection-to-dataset-maker')?.addEventListener('click', sendSelectionToDatasetMaker);
    $('#btn-remove-selected-gallery')?.addEventListener('click', removeSelectedGalleryImages);
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
    $('#export-format')?.addEventListener('change', (event) => {
        renderExportModalText(event.target.value);
    });
    $('#btn-download-export')?.addEventListener('click', downloadCurrentExportText);
    // --- Export Tags from legacy direct button, if present ---
    $('#btn-export-tags-selected')?.addEventListener('click', () => {
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

    // Checkpoint search in filter modal - query backend facets, not just loaded rows
    const debouncedCheckpointSearch = debounce((value) => searchModalFilterFacet('checkpoints', value), 200);
    $('#modal-checkpoint-search')?.addEventListener('input', (e) => {
        debouncedCheckpointSearch(e.target.value);
    });

    // LoRA search in filter modal - query backend facets, not just loaded rows
    const debouncedLoraSearch = debounce((value) => searchModalFilterFacet('loras', value), 200);
    $('#modal-lora-search')?.addEventListener('input', (e) => {
        debouncedLoraSearch(e.target.value);
    });

    // --- Batch Tag Export Modal ---
    $('#btn-batch-export-tags')?.addEventListener('click', showBatchExportModal);
    $('#btn-close-batch-export')?.addEventListener('click', () => hideModal('batch-export-modal'));
    $('#btn-cancel-batch-export')?.addEventListener('click', () => hideModal('batch-export-modal'));
    $('#btn-start-batch-export')?.addEventListener('click', executeBatchExport);
    $('#batch-export-content-mode')?.addEventListener('change', (event) => {
        updateBatchExportContentDescription(event.target.value);
    });
    document.querySelectorAll('input[name="batch-export-output-mode"]').forEach((input) => {
        input.addEventListener('change', syncBatchExportOutputModeUi);
    });

    // --- Import Tags (from Tag Modal) ---
    $('#btn-import-tags')?.addEventListener('click', () => {
        $('#import-tags-file').click();
    });
    $('#import-tags-file')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();

            // Parse and shape-validate as separate steps so the user gets a
            // precise reason: a syntactically broken file is reported as
            // invalid JSON, while a well-formed file with the wrong layout
            // is reported as a structure mismatch.
            let data;
            try {
                data = JSON.parse(text);
            } catch (_parseErr) {
                showToast(appT('tag.importNotJson', 'File is not valid JSON.'), 'error');
                e.target.value = '';
                return;
            }

            // Validate the data structure
            if (!data || typeof data !== 'object' || !Array.isArray(data.images)) {
                showToast(appT('tag.importBadShape', 'Wrong structure: expected { images: [...] }.'), 'error');
                e.target.value = '';
                return;
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
    $('#btn-send-to-censor')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (getSelectedGalleryCount() > 0) {
            const token = getActiveSelectionTokenForActions();
            if (token) {
                addToCensorQueue({
                    selectionToken: token,
                    total: getSelectedGalleryCount(),
                    filterKey: AppState.selectionFilterKey || null,
                    visibleImageIds: normalizeSelectionImageIds((AppState.images || []).map((image) => image?.id)),
                });
                return;
            }
            addToCensorQueue(getSelectedGalleryIds());
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

    $('#mobile-btn-model-manager')?.addEventListener('click', () => {
        closeMobileMenu();
        openModelManager();
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
            closeMobileFilterSidebar();
        }
    });

    // Handle resize - keep nav usable when tabs overflow on desktop
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const collapsed = updateNavigationOverflowState();
            if (!collapsed) {
                closeMobileMenu();
                closeMobileFilterSidebar();
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

function syncBodyScrollLocks() {
    const mobileNavOverlay = $('#mobile-nav-overlay');
    const filterSidebar = $('.filter-sidebar');
    const shouldLock = mobileNavOverlay?.classList.contains('visible')
        || filterSidebar?.classList.contains('mobile-visible');
    document.body.style.overflow = shouldLock ? 'hidden' : '';
}

function setMobileFilterSidebarExpanded(expanded) {
    ['#mobile-filter-toggle', '#mobile-filter-header-btn'].forEach((selector) => {
        const button = $(selector);
        if (button) {
            button.setAttribute('aria-expanded', String(expanded));
        }
    });
}

function closeMobileFilterSidebar() {
    const filterSidebar = $('.filter-sidebar');
    if (filterSidebar) {
        filterSidebar.classList.remove('mobile-visible');
    }

    const overlay = $('.filter-sidebar-overlay');
    if (overlay) {
        overlay.remove();
    }

    setMobileFilterSidebarExpanded(false);
    syncBodyScrollLocks();
}

function openMobileMenu() {
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const mobileNavOverlay = $('#mobile-nav-overlay');

    mobileMenuToggle?.classList.add('active');
    mobileMenuToggle?.setAttribute('aria-expanded', 'true');
    mobileNavOverlay?.classList.add('visible');

    syncBodyScrollLocks();

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

    syncBodyScrollLocks();
}

function toggleMobileFilterSidebar() {
    const filterSidebar = $('.filter-sidebar');

    if (filterSidebar) {
        const willOpen = !filterSidebar.classList.contains('mobile-visible');
        if (!willOpen) {
            closeMobileFilterSidebar();
            return;
        }

        filterSidebar.classList.add('mobile-visible');
        setMobileFilterSidebarExpanded(true);

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
                overlay.addEventListener('click', () => closeMobileFilterSidebar());
                document.body.appendChild(overlay);
            }

            syncBodyScrollLocks();
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
    const allGenerators = [...ALL_GENERATORS];
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

async function searchModalFilterFacet(facet, query) {
    const normalizedQuery = String(query || '').trim();
    const targetListId = facet === 'checkpoints' ? 'modal-checkpoint-list' : 'modal-lora-list';
    const list = document.getElementById(targetListId);
    if (!list) return;

    try {
        if (!normalizedQuery) {
            const data = FilterModalController.optionData || AppState.analytics || await API.getStats();
            if (facet === 'checkpoints') {
                renderCheckpointFilterList(data.checkpoints || []);
            } else {
                renderLoraFilterList(data.loras || []);
            }
            updateFilterModalSummary();
            return;
        }

        const result = await API.getAnalyticsFacet(facet, {
            query: normalizedQuery,
            limit: FACET_FILTER_SEARCH_LIMIT,
        });
        if (facet === 'checkpoints') {
            renderCheckpointFilterList(result.checkpoints || []);
        } else {
            renderLoraFilterList(result.loras || []);
        }
        updateFilterModalSummary();
    } catch (error) {
        Logger.error('Filter facet search failed:', error);
        filterModalList(targetListId, normalizedQuery);
    }
}


// ============== Missing File Reconnect ==============

function resetReconnectFolderValidation() {
    const input = $('#reconnect-folder-path');
    const feedback = $('#reconnect-folder-feedback');
    if (input) {
        input.classList.remove('input-valid', 'input-invalid', 'input-checking');
    }
    if (feedback) {
        feedback.className = 'validation-feedback';
        feedback.textContent = '';
    }
}

function setReconnectFolderValidation(state, message = '') {
    const input = $('#reconnect-folder-path');
    const feedback = $('#reconnect-folder-feedback');
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

function validateReconnectFolderPath() {
    const input = $('#reconnect-folder-path');
    if (!input) return true;
    const value = input.value.trim();
    resetReconnectFolderValidation();
    if (!value) return true;

    const invalidChars = /[<>"|?*]/;
    if (invalidChars.test(value)) {
        setReconnectFolderValidation('error', appT('scan.invalidPathChars', 'Path contains invalid characters'));
        return false;
    }

    setReconnectFolderValidation('checking', appT('scan.pathChecking', 'Checking path...'));
    const requestValue = value;
    API.post('/api/validate-path', { path: value })
        .then(result => {
            if (input.value.trim() !== requestValue) return;
            if (result.valid) {
                setReconnectFolderValidation('success', appT('scan.folderFound', 'Folder found'));
            } else {
                setReconnectFolderValidation('error', mapScanPathError(result.error || appT('scan.invalidPath', 'Path format is invalid')));
            }
        })
        .catch((error) => {
            if (input.value.trim() !== requestValue) return;
            setReconnectFolderValidation('', isScanPathError(error) ? mapScanPathError(error) : '');
        });
    return true;
}

function _setReconnectRunningUi(isRunning) {
    const startBtn = $('#btn-start-reconnect');
    const cancelBtn = $('#btn-cancel-reconnect');
    if (startBtn) startBtn.disabled = Boolean(isRunning);
    if (cancelBtn) {
        if (isRunning) {
            cancelBtn.removeAttribute('data-i18n');
            cancelBtn.textContent = appT('reconnect.stopButton', 'Stop Search');
        } else {
            cancelBtn.setAttribute('data-i18n', 'modal.cancel');
            cancelBtn.textContent = appT('modal.cancel', 'Cancel');
        }
    }
}

function _formatReconnectStatus(progress) {
    const checked = Number(progress?.checked_files ?? progress?.processed ?? progress?.current ?? 0);
    const matched = Number(progress?.matched || 0);
    const missingTotal = Number(progress?.missing_total || 0);
    const ambiguous = Number(progress?.ambiguous || 0);
    const conflicts = Number(progress?.conflicts || 0);
    const errors = Number(progress?.errors || 0);
    const base = missingTotal > 0
        ? appT('reconnect.progressText', 'Checked {checked} files · found {matched}/{missing} missing')
            .replace('{checked}', String(checked))
            .replace('{matched}', String(matched))
            .replace('{missing}', String(missingTotal))
        : appT('reconnect.progressNoMissing', 'Checking files... {checked} checked')
            .replace('{checked}', String(checked));
    const extras = [];
    if (ambiguous) {
        extras.push(appT('reconnect.ambiguousShort', '{count} need review').replace('{count}', String(ambiguous)));
    }
    if (conflicts) {
        extras.push(appT('reconnect.conflictsShort', '{count} already in gallery').replace('{count}', String(conflicts)));
    }
    if (errors) {
        extras.push(appT('reconnect.errorsShort', '{count} errors').replace('{count}', String(errors)));
    }
    return extras.length ? `${base} · ${extras.join(' · ')}` : base;
}

function _renderReconnectResultPanel(progress) {
    const panel = $('#reconnect-result-panel');
    if (!panel) return;

    if (progress?.status !== 'done' || !progress?.result) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    const result = progress.result || {};
    const updated = Array.isArray(result.updated) ? result.updated : [];
    const needsReview = Array.isArray(result.needs_review) ? result.needs_review : [];
    const conflicts = Array.isArray(result.conflict_samples) ? result.conflict_samples : [];
    const stillMissing = Array.isArray(result.still_missing_samples) ? result.still_missing_samples : [];
    const errors = Array.isArray(result.recent_errors) ? result.recent_errors : [];
    const matched = Number(result.matched || progress.matched || 0);
    const missingTotal = Number(result.missing_total || progress.missing_total || 0);
    const libraryMissingTotal = Number(result.library_missing_total || progress.library_missing_total || 0);
    const missing = Number(result.still_missing || 0);
    const resultSummaryKey = missingTotal === 0 && libraryMissingTotal > 0
        ? 'reconnect.resultNoMatches'
        : 'reconnect.resultSummary';

    const pathLine = (label, value) => value
        ? `<div class="reconnect-result-path"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`
        : '';
    const emptyText = appT('reconnect.resultEmpty', 'Nothing to show here.');
    const renderItems = (items, renderItem) => items.length
        ? items.slice(0, 5).map(renderItem).join('')
        : `<div class="reconnect-result-empty">${escapeHtml(emptyText)}</div>`;

    panel.innerHTML = `
        <div class="reconnect-result-summary">
            <strong>${escapeHtml(appT('reconnect.resultTitle', 'Search result'))}</strong>
            <span>${escapeHtml(appT(resultSummaryKey, '{matched} reconnected · {missing} still missing')
                .replace('{matched}', String(matched))
                .replace('{missing}', String(missing))
                .replace('{libraryMissing}', String(libraryMissingTotal)))}</span>
        </div>
        <details class="reconnect-result-group" open>
            <summary>${escapeHtml(appT('reconnect.resultUpdated', 'Reconnected'))} <span>${updated.length}</span></summary>
            ${renderItems(updated, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || `#${item.image_id}`)}</strong>
                    ${pathLine(appT('reconnect.oldPathLabel', 'Old'), item.old_path)}
                    ${pathLine(appT('reconnect.newPathLabel', 'New'), item.new_path)}
                </div>
            `)}
        </details>
        <details class="reconnect-result-group" ${needsReview.length ? 'open' : ''}>
            <summary>${escapeHtml(appT('reconnect.resultNeedsReview', 'Need your choice'))} <span>${needsReview.length}</span></summary>
            ${renderItems(needsReview, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || '')}</strong>
                    <p>${escapeHtml(appT('reconnect.needsReviewHelp', 'Several old records could match this file. Choose a smaller folder and run Find Moved Images again, or review the paths manually.'))}</p>
                    ${pathLine(appT('reconnect.foundPathLabel', 'Found'), item.found_path)}
                    ${(Array.isArray(item.old_paths) ? item.old_paths : []).map((path) => pathLine(appT('reconnect.possibleOldPathLabel', 'Possible old'), path)).join('')}
                </div>
            `)}
        </details>
        <details class="reconnect-result-group" ${conflicts.length ? 'open' : ''}>
            <summary>${escapeHtml(appT('reconnect.resultConflicts', 'Already in gallery'))} <span>${conflicts.length}</span></summary>
            ${renderItems(conflicts, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || '')}</strong>
                    <p>${escapeHtml(appT('reconnect.conflictHelp', 'The new file path is already another gallery item. If the old missing record is only a duplicate, remove the old record from the gallery.'))}</p>
                    ${pathLine(appT('reconnect.oldPathLabel', 'Old'), item.old_path)}
                    ${pathLine(appT('reconnect.existingPathLabel', 'Already indexed'), item.existing_path)}
                    ${item.old_image_id ? `<button type="button" class="btn btn-ghost btn-small reconnect-remove-old" data-reconnect-remove-id="${escapeHtml(item.old_image_id)}">${escapeHtml(appT('reconnect.removeOldRecord', 'Remove old gallery record'))}</button>` : ''}
                </div>
            `)}
        </details>
        <details class="reconnect-result-group" ${stillMissing.length ? '' : ''}>
            <summary>${escapeHtml(appT('reconnect.resultStillMissing', 'Still missing'))} <span>${stillMissing.length}</span></summary>
            ${renderItems(stillMissing, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || `#${item.image_id}`)}</strong>
                    <p>${escapeHtml(appT('reconnect.stillMissingHelp', 'The file was not found in the folder you chose. Try a wider folder or reconnect the drive.'))}</p>
                    ${pathLine(appT('reconnect.oldPathLabel', 'Old'), item.old_path)}
                </div>
            `)}
        </details>
        ${errors.length ? `<details class="reconnect-result-group" open>
            <summary>${escapeHtml(appT('reconnect.resultErrors', 'Errors'))} <span>${errors.length}</span></summary>
            ${renderItems(errors, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || '')}</strong>
                    <p>${escapeHtml(item.error || '')}</p>
                </div>
            `)}
        </details>` : ''}
    `;

    panel.querySelectorAll('[data-reconnect-remove-id]').forEach((button) => {
        button.addEventListener('click', () => {
            const imageId = Number(button.getAttribute('data-reconnect-remove-id'));
            if (Number.isFinite(imageId) && imageId > 0) {
                removeGalleryImagesByIds([imageId]);
            }
        });
    });
    panel.style.display = 'grid';
}

function _updateReconnectProgressUi(progress) {
    const container = $('#reconnect-progress-container');
    const fill = $('#reconnect-progress-fill');
    const textEl = $('#reconnect-progress-text');
    const running = ['running', 'cancelling'].includes(progress?.status);
    if (container) container.style.display = running || ['done', 'error', 'cancelled'].includes(progress?.status) ? 'block' : 'none';
    if (fill) {
        fill.classList.toggle('is-indeterminate', running);
        fill.style.width = running ? '' : (progress?.status === 'done' ? '100%' : '0%');
    }
    if (textEl) {
        if (progress?.status === 'cancelling') {
            textEl.textContent = appT('reconnect.cancelling', 'Stopping search...');
        } else if (progress?.status === 'done') {
            textEl.textContent = progress.message || appT('reconnect.done', 'Search complete.');
        } else if (progress?.status === 'error') {
            textEl.textContent = progress.message || appT('reconnect.failedStatus', 'Search failed');
        } else if (progress?.status === 'cancelled') {
            textEl.textContent = progress.message || appT('reconnect.cancelled', 'Search stopped');
        } else {
            textEl.textContent = _formatReconnectStatus(progress);
        }
    }
    _setReconnectRunningUi(running);
    _renderReconnectResultPanel(progress);
}

function _updateBgReconnectProgress(progress) {
    const bar = $('#bg-reconnect-progress');
    if (!bar) return;
    if (!['running', 'cancelling'].includes(progress?.status)) {
        bar.style.display = 'none';
        return;
    }
    const modal = $('#reconnect-modal');
    const modalOpen = modal && modal.classList.contains('visible');
    bar.style.display = modalOpen ? 'none' : 'flex';
    const fill = $('#bg-reconnect-progress-fill');
    if (fill) {
        fill.classList.add('is-indeterminate');
        fill.style.width = '';
    }
    const textEl = $('#bg-reconnect-progress-text');
    if (textEl) {
        textEl.textContent = progress?.status === 'cancelling'
            ? appT('reconnect.cancelling', 'Stopping search...')
            : _formatReconnectStatus(progress);
    }
}

function _hideBgReconnectProgress() {
    const bar = $('#bg-reconnect-progress');
    if (bar) bar.style.display = 'none';
}

function _clearReconnectPollTimer() {
    if (_reconnectPollTimer) {
        clearTimeout(_reconnectPollTimer);
        _reconnectPollTimer = null;
    }
}

function _initBgReconnectProgressButtons() {
    $('#bg-reconnect-cancel')?.addEventListener('click', async () => {
        await requestStopReconnectMissing();
    });
    $('#bg-reconnect-open')?.addEventListener('click', () => {
        showModal('reconnect-modal');
    });
}

async function startReconnectMissing() {
    const folderPath = $('#reconnect-folder-path')?.value?.trim() || '';
    if (!folderPath) {
        showToast(appT('reconnect.enterFolder', 'Choose where the moved images may be now.'), 'error');
        return;
    }
    const recursive = $('#reconnect-recursive')?.checked ?? true;
    const verifyUncertain = $('#reconnect-verify-uncertain')?.checked ?? true;

    try {
        await API.startReconnectMissing(folderPath, { recursive, verifyUncertain });
        const initialProgress = {
            status: 'running',
            checked_files: 0,
            matched: 0,
            missing_total: 0,
            ambiguous: 0,
            errors: 0,
        };
        _updateReconnectProgressUi(initialProgress);
        hideModal('reconnect-modal');
        _updateBgReconnectProgress(initialProgress);
        showToast(appT('reconnect.startedToast', 'Search started in the background. You can keep using the gallery.'), 'info');
        pollReconnectProgress();
    } catch (error) {
        const userMessage = mapScanPathError(error);
        if (isScanPathError(error)) {
            setReconnectFolderValidation('error', userMessage);
        }
        showToast(formatUserError(error, appT('reconnect.failedStart', 'Failed to start finding moved files')), 'error');
    }
}

async function requestStopReconnectMissing() {
    const progress = await API.getReconnectProgress().catch(() => null);
    if (!progress || !['running', 'cancelling'].includes(progress.status)) {
        hideModal('reconnect-modal');
        _setReconnectRunningUi(false);
        return;
    }
    try {
        const result = await API.cancelReconnectMissing();
        _updateReconnectProgressUi(result);
        _updateBgReconnectProgress(result);
        showToast(appT('reconnect.cancelling', 'Stopping search...'), 'info');
        pollReconnectProgress();
    } catch (error) {
        showToast(formatUserError(error, appT('reconnect.failedCancel', 'Failed to stop finding moved files')), 'error');
    }
}

async function pollReconnectProgress(retryCount = 0) {
    _clearReconnectPollTimer();
    try {
        const progress = await API.getReconnectProgress();
        _updateReconnectProgressUi(progress);
        _updateBgReconnectProgress(progress);

        if (progress.status === 'running' || progress.status === 'cancelling') {
            _reconnectPollTimer = setTimeout(() => pollReconnectProgress(0), progress.status === 'cancelling' ? 250 : 700);
            return;
        }

        if (progress.status === 'done') {
            const result = progress.result || {};
            const matched = Number(progress.matched || result.matched || 0);
            const stillMissing = Number(result.still_missing || 0);
            const missingTotal = Number(progress.missing_total || result.missing_total || 0);
            const libraryMissingTotal = Number(progress.library_missing_total || result.library_missing_total || 0);
            const ambiguous = Number(progress.ambiguous || result.ambiguous || 0);
            const conflicts = Number(progress.conflicts || result.conflicts || 0);
            const doneKey = missingTotal === 0 && libraryMissingTotal > 0
                ? 'reconnect.doneNoMatchesToast'
                : 'reconnect.doneToast';
            showToast(
                appT(doneKey, 'Found {matched} moved images. {missing} still missing. {ambiguous} need review. {conflicts} already in gallery.')
                    .replace('{matched}', String(matched))
                    .replace('{missing}', String(stillMissing))
                    .replace('{libraryMissing}', String(libraryMissingTotal))
                    .replace('{ambiguous}', String(ambiguous))
                    .replace('{conflicts}', String(conflicts)),
                ambiguous > 0 || stillMissing > 0 || conflicts > 0 || (missingTotal === 0 && libraryMissingTotal > 0) ? 'warning' : 'success'
            );
            _hideBgReconnectProgress();
            _setReconnectRunningUi(false);
            _refreshScanDrivenViews(true, { refreshGallery: true });
            window.UnreadableBanner?.refresh(true);
            return;
        }

        if (progress.status === 'cancelled') {
            showToast(progress.message || appT('reconnect.cancelled', 'Search stopped'), 'info');
            _hideBgReconnectProgress();
            _setReconnectRunningUi(false);
            window.UnreadableBanner?.refresh(true);
            return;
        }

        if (progress.status === 'error') {
            showToast(progress.message || appT('reconnect.failedStatus', 'Search failed'), 'error');
            _hideBgReconnectProgress();
            _setReconnectRunningUi(false);
        }
    } catch (error) {
        if (retryCount < 3) {
            _reconnectPollTimer = setTimeout(() => pollReconnectProgress(retryCount + 1), 1000);
            return;
        }
        showToast(formatUserError(error, appT('reconnect.failedProgress', 'Could not update moved-file search progress')), 'error');
        _hideBgReconnectProgress();
        _setReconnectRunningUi(false);
    }
}

async function resumeReconnectProgress() {
    try {
        const progress = await API.getReconnectProgress();
        if (!['running', 'cancelling'].includes(progress?.status)) {
            _hideBgReconnectProgress();
            return;
        }
        _updateReconnectProgressUi(progress);
        _updateBgReconnectProgress(progress);
        pollReconnectProgress();
    } catch (error) {
        Logger.warn('Failed to resume moved-file search progress:', error);
    }
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
        resetProgressTracker(_scanBackgroundProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        $('#scan-progress-text').textContent = appT('progress.countingImages', 'Counting images... {count} found').replace('{count}', '0');
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
        const totalFinal = progress?.total_final === true;
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
            updateScanDiagnosticsCard(null);
        }
    } catch (error) {
        showToast(formatUserError(error, appT('scan.failedCancel', 'Failed to stop import')), 'error');
    }
}

function _refreshScanDrivenViews(force = false, options = {}) {
    const {
        refreshGallery = true,
        pageSizeOverride = null,
    } = options;
    const now = Date.now();
    if (!force && now - _scanLastAutoRefreshAt < 2500) {
        return;
    }
    _scanLastAutoRefreshAt = now;
    if (refreshGallery) {
        if (AppState.currentView === 'gallery') {
            const loadOptions = {
                silent: true,
                preserveExisting: true,
                coalesce: true,
                suppressAutoLoadMore: true,
            };
            if (Number.isFinite(pageSizeOverride) && pageSizeOverride > 0) {
                loadOptions.pageSizeOverride = pageSizeOverride;
            }
            loadImages(false, loadOptions);
            AppState.galleryNeedsRefresh = false;
        } else {
            AppState.galleryNeedsRefresh = true;
            AppState.gallerySuppressNextAutoLoadMore = true;
        }
    }
    loadStats();
    // Library state changed (scan / reconnect / clear). Drop any cached
    // unreadable count so the banner reflects the new reality next time
    // gallery is the active view.
    window.UnreadableBanner?.invalidate?.();
    if (AppState.currentView === 'gallery') {
        window.UnreadableBanner?.refresh?.(true);
    }
}

function getScanProgressMetrics(progress) {
    const processed = Number(progress?.processed ?? progress?.current ?? 0);
    const total = Number(progress?.total || 0);
    const totalFinal = progress?.total_final === true;
    const counted = Number(progress?.counted || total || 0);
    const metadataProcessed = Number(progress?.metadata_processed || 0);
    const metadataTotal = Number(progress?.metadata_total || 0);
    const importComplete = progress?.import_complete === true || (totalFinal && total > 0 && processed >= total);
    const metadataTotalFinal = progress?.metadata_total_final === true;
    const isCounting = progress?.step === 'counting' || !totalFinal;
    const showingMetadata = progress?.step === 'metadata' && importComplete;
    const completed = showingMetadata ? metadataProcessed : processed;
    const stableTotal = showingMetadata
        ? (metadataTotalFinal ? metadataTotal : 0)
        : (totalFinal ? total : 0);
    const showEta = showingMetadata
        ? (metadataTotalFinal && metadataTotal > 0 && metadataProcessed > 0)
        : (totalFinal && total > 0 && processed > 0 && !isCounting);
    const percent = showingMetadata
        ? (metadataTotal > 0 ? Math.min(100, (metadataProcessed / metadataTotal) * 100) : 0)
        : (totalFinal && total > 0 ? Math.min(100, (processed / total) * 100) : 0);
    const progressKey = showingMetadata
        ? `scan-metadata:${metadataTotalFinal ? metadataTotal : 'growing'}`
        : `scan-import:${totalFinal ? total : 'counting'}`;

    return {
        processed,
        total,
        totalFinal,
        counted,
        metadataProcessed,
        metadataTotal,
        metadataTotalFinal,
        importComplete,
        isCounting,
        showingMetadata,
        completed,
        stableTotal,
        showEta,
        percent,
        progressKey,
    };
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

    const metrics = getScanProgressMetrics(progress);
    const fill = $('#bg-scan-progress-fill');
    const textEl = $('#bg-scan-progress-text');
    const isIndeterminate = ['running', 'cancelling'].includes(progress?.status) && (
        metrics.isCounting || !metrics.percent || metrics.percent <= 0
    );
    if (fill) {
        fill.classList.toggle('is-indeterminate', isIndeterminate);
        fill.style.width = isIndeterminate ? '' : (Math.min(100, metrics.percent) + '%');
    }

    if (!textEl) return;

    if (progress?.status === 'cancelling') {
        textEl.textContent = appT('scan.backgroundCancelling', 'Stopping scan...');
        return;
    }

    if (progress?.attention_required) {
        textEl.textContent = buildScanAttentionMessage(progress, { compact: true });
        return;
    }

    if (metrics.isCounting) {
        textEl.textContent = appT('progress.countingImages', 'Counting images... {count} found')
            .replace('{count}', String(metrics.counted || metrics.processed || 0));
        return;
    }

    const extraParts = [];
    if (metrics.showingMetadata && metrics.metadataTotal > 0) {
        extraParts.push(
            appT('progress.metadataCount', '{current}/{total} details')
                .replace('{current}', String(metrics.metadataProcessed))
                .replace('{total}', String(metrics.metadataTotal))
        );
        if (!metrics.metadataTotalFinal) {
            extraParts.push(appT('progress.detailsStillCounting', 'details total still being checked'));
        }
    } else if (metrics.totalFinal && metrics.total > 0) {
        extraParts.push(
            appT('progress.left', '{count} left')
                .replace('{count}', String(Math.max(0, metrics.total - metrics.processed)))
        );
    }

    textEl.textContent = buildOperationProgressText({
        completed: metrics.completed,
        total: metrics.stableTotal,
        tracker: _scanBackgroundProgressTracker,
        primaryLabel: appT('scan.progressLabel', 'Import'),
        extraParts,
        detail: progress?.message || (metrics.showingMetadata
            ? appT('scan.backgroundMetadata', 'Filling in image details...')
            : appT('scan.backgroundImporting', 'Bringing images into your library...')),
        defaultMessage: appT('scan.backgroundImporting', 'Bringing images into your library...'),
        showEta: metrics.showEta,
        progressKey: metrics.progressKey,
    });
}

function _hideBgScanProgress() {
    const bar = $('#bg-scan-progress');
    if (bar) bar.style.display = 'none';
    resetProgressTracker(_scanBackgroundProgressTracker);
}

function buildScanAttentionMessage(progress, options = {}) {
    const compact = Boolean(options.compact);
    const stalledSeconds = Number(progress?.stalled_seconds || 0);
    const pending = Number(progress?.metadata_pending || 0);
    const currentItem = progress?.current_item || appT('scan.diagnosticsCurrentUnknown', 'current file');
    const secondsText = stalledSeconds > 0 ? `${Math.round(stalledSeconds)}s` : appT('scan.diagnosticsSomeTime', 'some time');
    const key = compact ? 'scan.backgroundStalledDetailed' : 'scan.diagnosticsDefaultDetailed';
    const fallback = compact
        ? 'Scan needs attention: no visible progress for {seconds}. Open details to copy diagnostics.'
        : 'No visible progress for {seconds}. The app may be waiting on a slow, broken, or network-drive image. If this does not recover in 1-2 minutes, copy diagnostics for support.';
    return appT(key, fallback, {
        seconds: secondsText,
        pending: String(pending),
        current: currentItem,
        step: progress?.step || progress?.status || '-',
    });
}

function rememberScanDiagnosticsInteraction() {
    _scanDiagnosticsHoldUntil = Date.now() + SCAN_DIAGNOSTICS_HOLD_MS;
}

function rememberScanLogPath(rawPath = '', redactedPath = '') {
    _scanLastLogPath = rawPath || '';
    _scanLastLogPathRedacted = redactedPath || (rawPath ? '<PATH>' : '');
}

function _formatScanDiagnosticsPayload(payload) {
    const parts = [
        'SD Image Sorter scan diagnostics',
        `App version: ${payload?.app_version || 'unknown'}`,
        `Log file: ${payload?.log_file_path_redacted || (payload?.log_file_path ? '<PATH>' : 'unavailable')}`,
        `Log exists: ${payload?.log_file_exists ? 'yes' : 'no'}`,
        `Access log: ${payload?.access_log_enabled ? 'on' : 'off'}`,
        `Log level: ${payload?.log_level || 'unknown'}`,
        '',
        'Recent backend log:',
        payload?.recent_log_text || '(no log lines available)',
    ];
    return parts.join('\n');
}

async function copyScanDiagnostics() {
    try {
        rememberScanDiagnosticsInteraction();
        const payload = await API.getSupportDiagnostics(200);
        const copied = await copyTextToClipboard(
            _formatScanDiagnosticsPayload(payload),
            appT('scan.diagnosticsCopied', 'Diagnostics copied')
        );
        if (!copied) {
            showToast(appT('scan.diagnosticsCopyFailed', 'Could not copy diagnostics automatically'), 'warning');
        }
    } catch (error) {
        Logger.error('Failed to copy scan diagnostics:', error);
        showToast(appT('scan.diagnosticsFetchFailed', 'Could not load diagnostics'), 'error');
    }
}

async function copyScanLogPath() {
    try {
        rememberScanDiagnosticsInteraction();
        let pathToCopy = _scanLastLogPath;
        if (!pathToCopy) {
            const payload = await API.getSupportDiagnostics(1);
            rememberScanLogPath(payload?.log_file_path || '', payload?.log_file_path_redacted || '');
            const pathEl = $('#scan-diagnostics-path');
            if (pathEl && _scanLastLogPathRedacted) {
                pathEl.textContent = _scanLastLogPathRedacted;
                pathEl.title = _scanLastLogPathRedacted;
            }
            pathToCopy = _scanLastLogPath;
        }
        if (!pathToCopy) {
            showToast(appT('scan.copyLogPathUnavailable', 'Log path is not available'), 'warning');
            return;
        }
        const copied = await copyTextToClipboard(pathToCopy, appT('scan.logPathCopied', 'Log path copied'));
        if (!copied) {
            showToast(appT('scan.logPathCopyFailed', 'Could not copy log path automatically'), 'warning');
        }
    } catch (error) {
        Logger.error('Failed to copy scan log path:', error);
        showToast(appT('scan.logPathCopyFailed', 'Could not copy log path automatically'), 'error');
    }
}

async function openScanLogFile() {
    try {
        const result = await API.openSupportLog();
        const pathEl = $('#scan-diagnostics-path');
        rememberScanDiagnosticsInteraction();
        rememberScanLogPath(result?.path || '', result?.path_redacted || '');
        if (pathEl && result?.path) {
            pathEl.textContent = result.path_redacted || '<PATH>';
            pathEl.title = result.path_redacted || '<PATH>';
        }
        if (result?.opened === false) {
            showToast(appT('scan.openLogUnavailable', 'Could not open automatically; the log path is shown. Copy that path if you need to send the log file to support.'), 'warning');
            return;
        }
        showToast(appT('scan.logOpened', 'Opened support log location'), 'success');
    } catch (error) {
        Logger.error('Failed to open scan log file:', error);
        showToast(formatUserError(error, appT('scan.openLogFailed', 'Could not open support log')), 'error');
    }
}

function updateScanDiagnosticsCard(progress) {
    _scanLastProgress = progress || null;
    const card = $('#scan-diagnostics-card');
    if (!card) return;

    const activeStatus = ['running', 'cancelling'].includes(progress?.status);
    const holdActive = activeStatus && Date.now() < _scanDiagnosticsHoldUntil;
    const shouldShow = Boolean(progress?.attention_required || holdActive);
    card.style.display = shouldShow ? 'flex' : 'none';
    card.classList.toggle('is-visible', shouldShow);
    if (!shouldShow) return;

    const messageEl = $('#scan-diagnostics-message');
    const pathEl = $('#scan-diagnostics-path');
    const stopButton = $('#btn-stop-scan-from-diagnostics');
    const stepEl = $('#scan-diagnostics-step');
    const currentEl = $('#scan-diagnostics-current');
    const pendingEl = $('#scan-diagnostics-pending');
    const completedEl = $('#scan-diagnostics-completed');
    if (messageEl) {
        messageEl.removeAttribute('data-i18n');
        messageEl.textContent = progress?.attention_required
            ? buildScanAttentionMessage(progress)
            : appT('scan.diagnosticsRecentlyActive', 'Progress resumed. Keeping diagnostics visible briefly in case you still need them.');
    }
    if (stepEl) {
        stepEl.removeAttribute('data-i18n');
        stepEl.textContent = progress.step || progress.status || '-';
    }
    if (currentEl) {
        currentEl.removeAttribute('data-i18n');
        currentEl.textContent = progress.current_item || progress.message || '-';
    }
    if (pendingEl) {
        pendingEl.removeAttribute('data-i18n');
        pendingEl.textContent = String(progress.metadata_pending ?? 0);
    }
    if (completedEl) {
        completedEl.removeAttribute('data-i18n');
        const completed = progress.metadata_total
            ? `${progress.metadata_processed || 0}/${progress.metadata_total}`
            : `${progress.processed || progress.current || 0}/${progress.total || '?'}`;
        completedEl.textContent = completed;
    }
    if (pathEl) {
        pathEl.textContent = _scanLastLogPathRedacted || (progress.diagnostics_available
            ? appT('scan.diagnosticsLogReady', 'Support log is ready to copy or open.')
            : '');
        pathEl.title = _scanLastLogPathRedacted || '';
    }
    if (stopButton) {
        stopButton.disabled = progress.status === 'cancelling';
        stopButton.textContent = progress.status === 'cancelling'
            ? appT('scan.stoppingButton', 'Stopping...')
            : appT('scan.stopButton', 'Stop Import');
    }
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

        const metrics = getScanProgressMetrics(progress);
        const scanFillEl = $('#scan-progress-fill');
        const scanIndeterminate = progress.status === 'running' && (
            metrics.isCounting || !metrics.percent || metrics.percent <= 0
        );
        if (scanFillEl) {
            scanFillEl.classList.toggle('is-indeterminate', scanIndeterminate);
            scanFillEl.style.width = scanIndeterminate ? '' : (metrics.percent + '%');
        }

        const errorCount = Number(progress.errors || 0);
        const newCount = Number(progress.new || 0);
        const updatedCount = Number(progress.updated || 0);
        const removedCount = Number(progress.removed || 0);
        const extraParts = [];
        if (metrics.isCounting) {
            extraParts.push(
                appT('progress.discoveredCount', '{count} found')
                    .replace('{count}', String(metrics.counted || metrics.processed || 0))
            );
        } else if (metrics.totalFinal && metrics.total > 0 && !metrics.showingMetadata) {
            extraParts.push(
                appT('progress.left', '{count} left')
                    .replace('{count}', String(Math.max(0, metrics.total - metrics.processed)))
            );
        }
        if (metrics.metadataTotal > 0) {
            extraParts.push(
                appT('progress.metadataCount', '{current}/{total} metadata')
                    .replace('{current}', String(metrics.metadataProcessed))
                    .replace('{total}', String(metrics.metadataTotal))
            );
            if (!metrics.metadataTotalFinal && metrics.importComplete) {
                extraParts.push(appT('progress.detailsStillCounting', 'details total still being checked'));
            }
        }
        if (newCount > 0) extraParts.push(appT('progress.newCount', '{count} new').replace('{count}', newCount));
        if (updatedCount > 0) extraParts.push(appT('progress.updatedCount', '{count} updated').replace('{count}', updatedCount));
        if (removedCount > 0) extraParts.push(appT('progress.removedCount', '{count} removed').replace('{count}', removedCount));
        if (errorCount > 0) extraParts.push(appT('progress.failedCount', '{count} failed').replace('{count}', errorCount));

        let scanDetail = progress.current_item || progress.message || 'Importing images...';
        if (metrics.isCounting) {
            scanDetail = appT('progress.countingImages', 'Counting images... {count} found')
                .replace('{count}', String(metrics.counted || metrics.processed || 0));
        } else if (metrics.totalFinal && metrics.processed === 0 && metrics.total > 0) {
            scanDetail = appT('progress.foundStarting', 'Found {total} images. Starting scan...')
                .replace('{total}', String(metrics.total));
        } else if (metrics.showingMetadata && !metrics.metadataTotalFinal) {
            scanDetail = appT('progress.detailsStillCounting', 'details total still being checked');
        }

        $('#scan-progress-text').textContent = buildOperationProgressText({
            completed: metrics.completed,
            total: metrics.stableTotal,
            tracker: _scanProgressTracker,
            primaryLabel: appT('scan.progressLabel', 'Import'),
            extraParts,
            detail: scanDetail,
            defaultMessage: 'Importing images...',
            showEta: metrics.showEta,
            progressKey: metrics.progressKey,
        });

        _updateBgScanProgress(progress);
        updateScanDiagnosticsCard(progress);

        if (progress.library_ready && !_scanLibraryReadyHandled && progress.status === 'running') {
            _scanLibraryReadyHandled = true;
            hideModal('scan-modal');
            _refreshScanDrivenViews(true, {
                refreshGallery: true,
                pageSizeOverride: SCAN_PREVIEW_PAGE_SIZE,
            });
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
                AppState.gallerySuppressNextAutoLoadMore = true;
            }
        }

        if (progress.status === 'done') {
            const libraryReadyWasHandled = _scanLibraryReadyHandled;
            const errorCount = Number(progress.errors || progress.result?.errors || 0);
            const completionMessage = libraryReadyWasHandled
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
            updateScanDiagnosticsCard(null);
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
            const cancelCount = Number(progress.processed ?? progress.current ?? 0);
            const cancelMsg = cancelCount > 0
                ? appT('scan.cancelledAfterCount', 'Import cancelled after {count} scanned.').replace('{count}', String(cancelCount))
                : appT('scan.cancelled', 'Import cancelled');
            showToast(cancelMsg, 'info');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _scanLibraryReadyHandled = false;
            _scanLastAutoRefreshAt = 0;
            _hideBgScanProgress();
            updateScanDiagnosticsCard(null);
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
            updateScanDiagnosticsCard(null);
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
            updateScanDiagnosticsCard(null);
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
            updateScanDiagnosticsCard(null);
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
        resetProgressTracker(_scanBackgroundProgressTracker);
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
// Guards the window between a startTagging() click and the backend ack.
// _tagPollingActive only flips true AFTER the await, so without this a
// double-click would fire two concurrent start requests.
let _tagStartInFlight = false;
let _tagMinimizedToBackground = false;
let _tagLastProgressPercent = 0;
let _tagLastProgressText = '';
let _tagLastCurrent = 0;
let _tagLastTotal = 0;
let _scanProgressTracker = createProgressTracker();
let _scanBackgroundProgressTracker = createProgressTracker();
let _scanLastProgress = null;
let _scanLastLogPath = '';
let _scanLastLogPathRedacted = '';
const SCAN_DIAGNOSTICS_HOLD_MS = 10000;
let _scanDiagnosticsHoldUntil = 0;
let _scanLibraryReadyHandled = false;
let _scanLastAutoRefreshAt = 0;
let _reconnectPollTimer = null;
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
    const customProfile = $('#tag-custom-profile-select');
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

    [modelSelect, thresholdInput, characterThresholdInput, retagAll, useGpu, customProfile, modelPath, tagsPath, exportBtn, importBtn].forEach((element) => {
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
        // v3.2.1: add VLM (Natural Language) backend as a primary tagger choice
        const _vg = window.I18n?.t?.('modal.tagGroupVlm');
        const vlmGroupLabel = (_vg && _vg !== 'modal.tagGroupVlm') ? _vg : 'VLM Captioning (Natural Language)';
        const _vm = window.I18n?.t?.('modal.tagModelVlm');
        const vlmOptionLabel = (_vm && _vm !== 'modal.tagModelVlm') ? _vm : '🧠 VLM (Cloud API or Local Ollama)';
        options.push(
            `<optgroup label="${escapeHtml(vlmGroupLabel)}">` +
            `<option value="vlm">${escapeHtml(vlmOptionLabel)}</option>` +
            '</optgroup>'
        );

        select.innerHTML = options.join('');
        select.value = currentValue === 'custom' || models.some((model) => model.name === currentValue)
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
    const t = (key, fallback) => { const v = window.I18n?.t?.(key); return (v && v !== key) ? v : fallback; };
    // In-flight guard: block a second start request while the first is still
    // awaiting the backend ack (before _tagPollingActive flips true).
    if (_tagStartInFlight || _tagPollingActive) {
        return;
    }
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
        const customProfile = getCustomTaggerProfile();

        if (!modelPath) {
            showToast(appT('tag.modelPathRequired', 'Please enter a model path'), 'error');
            return;
        }

        options.modelPath = modelPath;
        if (tagsPath) {
            options.tagsPath = tagsPath;
        }
        options.customProfile = customProfile;
        options.modelName = customProfile;
    } else {
        options.modelName = modelSelect;
    }

    options.retagAll = $('#tag-retag-all').checked;
    options.useGpu = useGpuCheckbox?.checked ?? true;

    // v3.2.2 T-power-PR1: pre-tag filters from the optional <details>.
    // Blacklist is split on commas + newlines, trimmed, deduped.
    const blacklistRaw = (document.getElementById('tag-pre-blacklist')?.value || '').trim();
    if (blacklistRaw) {
        const seen = new Set();
        const blacklist = [];
        for (const token of blacklistRaw.split(/[,\n]+/)) {
            const t = token.trim();
            if (!t) continue;
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            blacklist.push(t);
        }
        if (blacklist.length) options.preTagBlacklist = blacklist;
    }
    const maxTagsRaw = (document.getElementById('tag-max-tags-per-image')?.value || '').trim();
    if (maxTagsRaw) {
        const n = parseInt(maxTagsRaw, 10);
        if (Number.isFinite(n) && n > 0) options.maxTagsPerImage = n;
    }

    // Advanced runtime chunk size now maps to the backend's true WD14 batch size
    // where the selected model supports dynamic batching.
    const batchSelect = document.getElementById('tagger-batch-size');
    const effectiveModelForBatch = getEffectiveTaggerModelForUi(modelSelect, { isCustom: isCustomModel });
    if (isToriiGateTaggerModel(effectiveModelForBatch, { isCustom: false })) {
        options.batchSize = 1;
    } else if (batchSelect?.dataset.userChosen === '1') {
        const recommendedBatchSize = getRecommendedTaggerChunkSize(effectiveModelForBatch, {
            isCustom: isCustomModel && effectiveModelForBatch === 'custom',
            useGpu: options.useGpu,
        });
        options.batchSize = Math.min(128, parseInt(batchSelect.value, 10) || recommendedBatchSize);
    }

    if (gpuLocked) {
        options.useGpu = false;
        options.allowUnsafeAcceleration = false;
        if (useGpuCheckbox) {
            useGpuCheckbox.checked = false;
        }
        syncTaggerModelUi({ applyModelDefaults: false });
    }

    try {
        _tagStartInFlight = true;
        await API.startTagging(options);

        _tagPollingActive = true;
        _tagStartInFlight = false;
        resetTagUiProgressState();
        clearTagProgressTimer();

        $('#tag-progress-container').style.display = 'block';
        lockLiveProgressText('#tag-progress-text');
        $('#tag-progress-fill').style.width = '0%';
        _tagLastProgressPercent = 0;
        _tagLastProgressText = gpuLocked
            ? t('tag.preparingMaxQuality', 'Preparing Max Quality model on CPU...')
            : (options.useGpu
                ? t('tag.preparingGpu', 'Preparing model on GPU...')
                : t('tag.preparingCpu', 'Preparing model on CPU...'));
        $('#tag-progress-text').textContent = _tagLastProgressText;
        setTaggingUiState(true);

        pollTagProgress();
    } catch (error) {
        _tagPollingActive = false;
        _tagStartInFlight = false;
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
            loadImages();
            loadStats();
            // v3.2.2 T-power-PR2 (H): pop the post-tag stats modal once
            // when the worker emits last_run_stats on the terminal send.
            if (progress.last_run_stats && typeof window.TagStatsModal === 'object'
                && typeof window.TagStatsModal.show === 'function') {
                try { window.TagStatsModal.show(progress.last_run_stats); } catch (_e) { /* */ }
            }
            // v3.2.2 T-power-PR3 (G): two-layer completion notification
            // (favicon+title blink always; Notification API if user opted in).
            if (typeof window.TagCompleteNotify === 'object'
                && typeof window.TagCompleteNotify.fireOnDone === 'function') {
                try {
                    window.TagCompleteNotify.fireOnDone(
                        progress.message || 'Tagging complete',
                        errors > 0 ? 'warning' : 'success',
                    );
                } catch (_e) { /* */ }
            }
            // v3.2.1: dispatch a hookable event so other modules (gallery
            // sub-views, prompt-lab, etc.) can react to fresh tags without
            // needing to know about the polling internals here.
            try {
                document.dispatchEvent(new CustomEvent('taggingCompleted', {
                    detail: {
                        completed: progress?.completed || 0,
                        errors: errors || 0,
                        message: progress?.message || '',
                    },
                }));
            } catch (_e) {
                /* event dispatch is best-effort */
            }
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
        // Use onclick (single handler) instead of addEventListener: this
        // initializer can run more than once, and stacking listeners would
        // fire multiple stop-tagging requests on a single click.
        cancelBtn.onclick = async () => {
            await requestStopTagging();
        };
    }
    if (openBtn) {
        openBtn.onclick = () => {
            _tagMinimizedToBackground = false;
            showModal('tag-modal');
        };
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

        const metadataPending = Number(stats.metadata_pending || stats.metadata_status?.pending || stats.metadata_status_counts?.pending || 0);
        const scanStatus = String(stats.scan_status || '').toLowerCase();
        const scanRunning = scanStatus === 'running' || scanStatus === 'cancelling';
        const scanLibraryReady = stats.scan_library_ready === true;
        const countsResolving = metadataPending > 0 || (scanRunning && !scanLibraryReady);
        const reportedTotal = Number.isFinite(Number(stats.total_images))
            ? Number(stats.total_images)
            : totalCount;

        // Update generator tab counts
        const countAll = $('#count-all');
        if (countAll) countAll.textContent = reportedTotal;

        ['nai', 'comfyui', 'forge', 'webui', 'unknown'].forEach(gen => {
            const countEl = $(`#count-${gen}`);
            if (countEl) {
                const count = genCounts[gen] || 0;
                countEl.textContent = countsResolving && count === 0 ? '…' : String(count);
                countEl.title = countsResolving
                    ? appT('gallery.metadataResolvingTitle', 'Generator counts are still resolving while metadata is being read or scan import is still running.')
                    : '';
            }
        });

        // The "Others" tab bundles every uncommon generator (Fooocus,
        // reForge, Gemini, gpt-image, ...) — its count must reflect the
        // sum so the badge matches the gallery once the user clicks it.
        const othersCount = OTHERS_GENERATOR_BUNDLE.reduce(
            (sum, gen) => sum + (genCounts[gen] || 0),
            0
        );
        const countOthersEl = $('#count-others');
        if (countOthersEl) {
            countOthersEl.textContent = countsResolving && othersCount === 0 ? '…' : String(othersCount);
            countOthersEl.title = countsResolving
                ? appT('gallery.metadataResolvingTitle', 'Generator counts are still resolving while metadata is being read or scan import is still running.')
                : '';
        }

        const metadataChip = $('#metadata-status-chip');
        if (metadataChip) {
            if (countsResolving) {
                metadataChip.textContent = metadataPending > 0
                    ? appT('gallery.metadataResolving', 'Reading image info: {count} pending')
                        .replace('{count}', String(metadataPending))
                    : appT('gallery.scanResolving', 'Scanning library: generator counts are not final yet');
                metadataChip.title = appT('gallery.metadataResolvingTitle', 'Generator counts are still resolving while metadata is being read or scan import is still running.');
                metadataChip.style.display = 'inline-flex';
            } else {
                metadataChip.textContent = '';
                metadataChip.title = '';
                metadataChip.style.display = 'none';
            }
        }

        // Populate version badge
        if (stats.app_version) {
            const vBadge = document.getElementById('brand-version');
            if (vBadge) vBadge.textContent = 'v' + stats.app_version;
            AppState.appVersion = stats.app_version;
            AppState.githubUrl = stats.github_url || '';
        }

        // Store analytics for later use
        AppState.analytics = {
            checkpoints: stats.checkpoints || [],
            loras: stats.loras || [],
            top_tags: stats.top_tags || [],
            generatorCounts: genCounts,
            totalImages: reportedTotal,
            metadataPending,
            metadataStatus: stats.metadata_status || stats.metadata_status_counts || {},
            countsResolving,
            scanStatus,
            scanLibraryReady
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
    const cancelBtn = $('#btn-cancel-aesthetic');
    const chip = $('#aesthetic-status-chip');
    if (!button) return;

    const t = (key, fallback, params) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };

    if (cancelBtn) cancelBtn.style.display = running ? '' : 'none';

    if (!_aestheticStatus.available) {
        button.disabled = true;
        button.title = _aestheticStatus.message || t('gallery.aestheticUnavailable', 'Aesthetic scoring is unavailable');
        button.setAttribute('aria-label', button.title);
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (chip) {
            chip.style.display = 'inline-flex';
            chip.className = 'tagger-aesthetic-status is-warning';
            chip.textContent = t('gallery.aestheticUnavailableShort', 'Aesthetic unavailable');
            chip.title = button.title;
        }
        return;
    }

    button.disabled = running;
    button.title = running
        ? t('gallery.aestheticRunning', 'Scoring aesthetics...')
        : t('gallery.scoreAesthetic', 'Score Aesthetic');
    button.setAttribute('aria-label', button.title);

    if (running && chip) {
        chip.style.display = 'inline-flex';
        chip.className = 'tagger-aesthetic-status is-info';
        chip.textContent = t('gallery.aestheticProgress', '{completed}/{total} scored', {
            completed,
            total: Math.max(total, completed),
        });
        chip.title = chip.textContent;
    } else if (chip) {
        chip.style.display = 'inline-flex';
        chip.className = 'tagger-aesthetic-status is-safe';
        chip.textContent = t('gallery.aestheticReady', 'Aesthetic ready');
        chip.title = chip.textContent;
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
                aestheticOption.textContent = appT('sort.aestheticNoScores', 'Aesthetic Score (no scores yet - score from AI Tag)');
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
let _imageLoadSequence = 0;
let _activeImageLoadSequence = 0;

function cancelGalleryImageLoad() {
    const hadPendingGalleryLoad = AppState.isLoading
        || _pendingImageReload !== null
        || RequestManager.pendingRequests.has(IMAGE_LOAD_KEY);
    _imageLoadSequence += 1;
    _activeImageLoadSequence = 0;
    _pendingImageReload = null;
    RequestManager.cancel(IMAGE_LOAD_KEY);
    AppState.isLoading = false;
    if (hadPendingGalleryLoad) {
        AppState.galleryNeedsRefresh = true;
    }
    const galleryLoading = $('#gallery-loading');
    if (galleryLoading) galleryLoading.style.display = 'none';
}

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
        pageSizeOverride = null,
        suppressAutoLoadMore = false,
    } = options;

    if (AppState.isLoading && coalesce) {
        _pendingImageReload = { appendMode, options: { ...options } };
        return;
    }

    // Cancel any pending user-facing image load request
    if (!coalesce) {
        RequestManager.cancel(IMAGE_LOAD_KEY);
    }

    const loadSequence = ++_imageLoadSequence;
    _activeImageLoadSequence = loadSequence;
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
    let controller = null;

    try {
        controller = RequestManager.createAbortController(IMAGE_LOAD_KEY);
        const useCursorPagination = supportsCursorPagination(AppState.filters.sortBy);
        const overrideLimit = Number(pageSizeOverride);
        const pageLimit = Number.isFinite(overrideLimit) && overrideLimit > 0
            ? Math.floor(overrideLimit)
            : AppState.pagination.pageSize;
        const filters = {
            ...AppState.filters,
            limit: pageLimit,
            cursor: appendMode && useCursorPagination ? AppState.pagination.cursor : null,
            offset: appendMode && !useCursorPagination ? AppState.pagination.offset : undefined
        };
        const result = await API.getImages(filters, { signal: controller.signal });
        RequestManager.complete(IMAGE_LOAD_KEY, controller);

        if (result === null) return;
        if (loadSequence !== _imageLoadSequence || AppState.currentView !== 'gallery') {
            AppState.galleryNeedsRefresh = true;
            return;
        }

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

        // Clean stale selections on fresh load, but do not corrupt true filtered-result selection.
        if (AppState.selectedIds && AppState.selectedIds.size > 0 && !appendMode) {
            if (AppState.selectionScope === 'filtered') {
                const currentFilterKey = getSelectionFilterCacheKey(AppState.filters);
                if (AppState.selectionFilterKey && AppState.selectionFilterKey !== currentFilterKey) {
                    updateSelectionState((selection) => {
                        selection.selectedIds = new Set();
                        selection.scope = 'visible';
                        selection.filterKey = null;
                        selection.selectionToken = null;
                        selection.selectionTotal = 0;
                    });
                    if (typeof updateSelectionUI === 'function') updateSelectionUI();
                    emitSelectionStateChanged();
                }
            } else {
                const validIds = new Set(AppState.images.map(img => img.id));
                const staleIds = [...AppState.selectedIds].filter(id => !validIds.has(id));
                if (staleIds.length > 0) {
                    mutateSelectedIds((selectedIds) => {
                        staleIds.forEach((id) => selectedIds.delete(id));
                    });
                    if (typeof updateSelectionUI === 'function') updateSelectionUI();
                    emitSelectionStateChanged();
                }
            }
        }
        if (window.Gallery) {
            if (appendMode) {
                Gallery.appendImages(result.images);
            } else {
                Gallery.setImages(AppState.images);
            }
        }

        const emptyState = $('#gallery-empty-state');
        if (emptyState) {
            const shouldShow = AppState.images.length === 0;
            emptyState.style.display = shouldShow ? 'flex' : 'none';
            if (shouldShow) {
                // v3.2.2: differentiate "library is empty" from "filter
                // returned 0 results". The original empty state was the
                // onboarding card ("No images yet, import a folder") which
                // was misleading when the user had a 71k-image library and
                // had just tried a tag filter that returned nothing - they
                // would think their entire library disappeared.
                _applyGalleryEmptyStateVariant(emptyState);
            }
        }
        if (AppState.images.length > 0 && window.OnboardingTour) {
            OnboardingTour.markHasSeenImages();
        }
    } catch (error) {
        if (error.name === 'AbortError' || error.cancelled) {
            return;
        }
        showToast(formatUserError(error, appT('gallery.loadImagesFailed', 'Failed to load images')), 'error');
    } finally {
        if (controller) {
            RequestManager.complete(IMAGE_LOAD_KEY, controller);
        }
        const isLatestLoad = loadSequence === _imageLoadSequence;
        const isActiveLoad = _activeImageLoadSequence === loadSequence;

        if (isActiveLoad) {
            _activeImageLoadSequence = 0;
            AppState.isLoading = false;
            if (galleryLoading && !silent) {
                galleryLoading.style.display = 'none';
            }
        }

        if (!isLatestLoad) {
            return;
        }

        // Show/hide "Load More" button based on pagination state
        const loadMoreContainer = $('#gallery-load-more');
        if (loadMoreContainer) {
            loadMoreContainer.style.display = AppState.pagination.hasMore ? 'flex' : 'none';
        }

        requestAnimationFrame(() => {
            attachGalleryPaginationListener();
            if (!suppressAutoLoadMore) {
                _onGalleryScroll();
            }
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

function normalizeCheckpointFilterValue(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    text = text.replace(/\\/g, '/').split('/').pop().trim();
    text = text.replace(/\s+\[[0-9a-fA-F]{4,}\]\s*$/, '').trim();
    text = text.replace(/\.(safetensors|ckpt|pt|pth|bin|onnx)$/i, '').trim();
    return text;
}

function getCheckpointOptionValue(item) {
    return normalizeCheckpointFilterValue(item?.checkpoint_normalized || item?.checkpoint || item);
}

function openModelSelect(type) {
    AppState.modalSelection.type = type;
    AppState.modalSelection.search = '';
    const currentSelection = AppState.filters[`${type}s`] || [];
    AppState.modalSelection.tempSelected = new Set(
        type === 'checkpoint'
            ? currentSelection.map(normalizeCheckpointFilterValue).filter(Boolean)
            : currentSelection
    );

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
        const value = type === 'checkpoint' ? getCheckpointOptionValue(item) : item.lora;
        const label = type === 'checkpoint' ? (item.checkpoint || value) : item.lora;
        return String(label || value || '').toLowerCase().includes(search);
    });

    list.innerHTML = filtered.map(item => {
        const value = type === 'checkpoint' ? getCheckpointOptionValue(item) : item.lora;
        const label = type === 'checkpoint' ? (item.checkpoint || value) : item.lora;
        const isSelected = tempSelected.has(value);
        const safeValue = escapeHtml(value);
        const safeLabel = escapeHtml(label);

        return `
            <div class="model-select-item ${isSelected ? 'selected' : ''}" data-value="${safeValue}">
                <div class="checkbox-custom" style="background: ${isSelected ? 'var(--accent-primary)' : 'transparent'}; border-color: ${isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}">
                    ${isSelected ? '✓' : ''}
                </div>
                <div class="item-text" title="${safeLabel}">${safeLabel}</div>
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
    updateAppFilters((filters) => {
        filters[`${type}s`] = Array.from(tempSelected);
    });

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
    searchRequestId: 0,
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

async function fetchLibraryFacet(tab, { sortBy = 'frequency', query = '', optionData = null } = {}) {
    const normalizedQuery = String(query || '').trim();
    if (optionData && !normalizedQuery) {
        if (tab === 'tags' && optionData.tags?.length) {
            return { items: optionData.tags, total: optionData.tags.length };
        }
        if (tab === 'loras' && optionData.loras?.length) {
            return { items: optionData.loras, total: optionData.loras.length };
        }
        if (tab === 'prompts' && optionData.prompts?.length) {
            return { items: optionData.prompts, total: optionData.prompts.length };
        }
    }

    if (tab === 'tags') {
        const result = await API.getTagsLibrary(sortBy, { query: normalizedQuery || null });
        return { items: result.tags || [], total: result.total || 0 };
    }
    if (tab === 'loras') {
        const result = await API.getLorasLibrary({ query: normalizedQuery || null });
        return { items: result.loras || [], total: result.total || 0 };
    }
    const result = await API.getPromptsLibrary({ query: normalizedQuery || null });
    return { items: result.prompts || [], total: result.total || 0 };
}

function renderLibraryFacet(tab, items) {
    if (tab === 'tags') {
        libraryData.tags = items;
        renderLibraryTags(items);
    } else if (tab === 'loras') {
        libraryData.loras = items;
        renderLibraryLoras(items);
    } else {
        libraryData.prompts = items;
        renderLibraryPrompts(items);
    }
}

function setLibraryStatsText(tab, count) {
    const statsText = $('#library-stats-text');
    if (!statsText) return;
    const t = (key, params, fallback) => {
        const translated = window.I18n?.t?.(key, params);
        return translated && translated !== key ? translated : (fallback || key);
    };
    if (tab === 'tags') {
        statsText.textContent = t('library.tagsFound', { count }, `${count} unique tags found`);
    } else if (tab === 'loras') {
        statsText.textContent = t('library.lorasFound', { count }, `${count} unique LoRAs found`);
    } else {
        statsText.textContent = t('library.promptsFound', { count }, `${count} unique prompts found`);
    }
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
        const result = await fetchLibraryFacet(currentTab, {
            sortBy,
            optionData: libraryData.optionData,
        });
        renderLibraryFacet(currentTab, result.items);
        setLibraryStatsText(currentTab, result.total);
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

const filterLibraryContent = debounce(async () => {
    const query = $('#library-search')?.value || '';
    const tab = libraryData.currentTab;
    const requestId = ++libraryData.searchRequestId;

    try {
        const result = await fetchLibraryFacet(tab, {
            sortBy: $('#library-sort')?.value || 'frequency',
            query,
            optionData: libraryData.optionData,
        });
        if (requestId !== libraryData.searchRequestId || tab !== libraryData.currentTab) return;
        renderLibraryFacet(tab, result.items);
        setLibraryStatsText(tab, result.total);
    } catch (error) {
        Logger.error('Library search error:', error);
    }
}, 200);

// ============== Modal Tag/Prompt Autocomplete ==============

// searchModalTags and searchModalPrompts are defined in the Filter Modal section below
// (single definition, using API facet searches instead of pre-limited local caches)

// renderModalActiveTags and renderModalActivePrompts are defined in the Filter Modal section below

function updateSelectionUI() {
    const panel = $('#selection-actions');
    const countEl = $('#selection-count');
    const scopeEl = $('#selection-scope-summary');
    const grid = $('#gallery-grid');
    const selectedCount = getSelectedGalleryCount();
    const hasSelection = selectedCount > 0;
    const selectionPanelVisible = AppState.selectionMode && AppState.currentView === 'gallery';
    const canRunBatchActions = selectionPanelVisible && hasSelection;
    const buttonIds = [
        'btn-move-selected',
        'btn-copy-selected',
        'btn-export-selected',
        'btn-batch-export-tags',
        'btn-send-to-censor',
        'btn-send-selection-to-dataset-maker',
        'btn-remove-selected-gallery',
        'btn-delete-selected-files'
    ];

    syncSelectionModeButton();

    if (grid) {
        grid.classList.toggle('selection-mode', !!AppState.selectionMode);
    }

    const selectAllBtn = $('#btn-select-all');
    if (selectAllBtn) {
        selectAllBtn.disabled = !selectionPanelVisible || (AppState.pagination.total || 0) === 0;
    }

    const invertFilteredBtn = $('#btn-invert-selection-filtered');
    if (invertFilteredBtn) {
        invertFilteredBtn.disabled = !selectionPanelVisible || (AppState.pagination.total || 0) === 0;
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
                ? (window.I18n?.t?.('selection.count', { count: selectedCount }) || `${selectedCount} items selected`)
                : (window.I18n?.t?.('selection.emptyHint') || 'Select images, or choose all current filter matches.');
        }
        if (scopeEl) {
            scopeEl.textContent = getSelectionScopeSummaryText();
        }
        if (!hasSelection) {
            collapseSelectionMoreActions();
        }
        requestAnimationFrame(() => ensureSelectionPanelVisible(panel));
    } else if (panel) {
        panel.style.display = 'none';
        collapseSelectionMoreActions();
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
                <div class="analytics-item clickable" data-type="checkpoint" data-value="${escapeHtml(getCheckpointOptionValue(c))}">
                    <span class="item-name">${escapeHtml(c.checkpoint || getCheckpointOptionValue(c))}</span>
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
        updateAppFilters((filters) => {
            filters.checkpoints = [value];
        });
        updateModelSelectionSummaries();
    } else if (type === 'lora') {
        updateAppFilters((filters) => {
            filters.loras = [value];
        });
        updateModelSelectionSummaries();
    } else if (type === 'tag') {
        if (!AppState.filters.tags.includes(value)) {
            updateAppFilters((filters) => {
                filters.tags = [...filters.tags, value];
            });
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


let _currentExportModalData = null;
let _currentExportFormat = 'prompt';

function getExportFormatLabel(format) {
    const labels = {
        prompt: appT('export.formatPrompt', 'Prompt text'),
        prompt_numbered: appT('export.formatPromptNumbered', 'Prompt text + filenames'),
        negative: appT('export.formatNegative', 'Negative prompt'),
        prompt_negative: appT('export.formatPromptNegative', 'Prompt + Negative'),
        a1111: appT('export.formatA1111', 'A1111 / Forge block'),
        tags: appT('export.formatTags', 'Tags list'),
        caption_tags: appT('export.formatCaptionTags', 'Caption + Tags lines'),
        caption_merged: appT('export.formatCaptionMerged', 'Merged caption lines'),
        jsonl: appT('export.formatJsonl', 'JSONL'),
        csv: appT('export.formatCsv', 'CSV table'),
    };
    return labels[format] || labels.prompt;
}

function getExportFormatDescription(format) {
    const descriptions = {
        prompt: appT('export.descPrompt', 'One .txt: each image Prompt is separated by a blank line.'),
        prompt_numbered: appT('export.descPromptNumbered', 'One .txt: filename title + Prompt for each image.'),
        negative: appT('export.descNegative', 'One .txt: Negative prompt only, separated by blank lines.'),
        prompt_negative: appT('export.descPromptNegative', 'One .txt: Prompt plus Negative prompt for each image.'),
        a1111: appT('export.descA1111', 'One .txt: WebUI/A1111-style parameter blocks for regeneration.'),
        tags: appT('export.descTags', 'One .txt: merged unique Tags from all selected images.'),
        caption_tags: appT('export.descCaptionTags', 'One .txt: one AI caption + Tags line per image.'),
        caption_merged: appT('export.descCaptionMerged', 'One .txt: one merged caption line per image, built from AI caption, Prompt, and Tags.'),
        jsonl: appT('export.descJsonl', 'One .jsonl: one JSON object per image for scripts and dataset tools.'),
        csv: appT('export.descCsv', 'One .csv table: filename, Prompt, Tags, model, and size columns.'),
    };
    return descriptions[format] || descriptions.prompt;
}

function getBatchExportContentDescription(mode) {
    const descriptions = {
        caption_merged: appT('batchExport.descCaptionMerged', 'Writes one same-name .txt per image for LoRA training: optional Class Token + AI caption + Prompt + Tags, merged into one line.'),
        prompt: appT('batchExport.descPrompt', 'Writes one same-name .txt per image containing only Prompt text.'),
        tags: appT('batchExport.descTags', 'Writes one same-name .txt per image containing only Tags. The Class Token field is ignored.'),
        negative: appT('batchExport.descNegative', 'Writes one same-name .txt per image containing only Negative prompt.'),
        prompt_negative: appT('batchExport.descPromptNegative', 'Writes one same-name .txt per image with Prompt plus Negative prompt.'),
        a1111: appT('batchExport.descA1111', 'Writes one same-name .txt per image in A1111 / Forge parameter-block format for regeneration.'),
        caption_tags: appT('batchExport.descCaptionTags', 'Writes one same-name .txt per image with optional Class Token + AI caption + Tags, without the original Prompt.'),
        tags_nl: appT('batchExport.descTagsNl', 'Writes one same-name .txt per image with optional Class Token + Tags + Natural Language caption, without the original Prompt.'),
        nl_caption: appT('batchExport.descNlCaption', 'Writes one same-name .txt per image containing only the Natural Language caption.'),
        prompt_nl: appT('batchExport.descPromptNl', 'Writes one same-name .txt per image with Prompt plus Natural Language caption.'),
        json: appT('batchExport.descJson', 'Writes one same-name .json per image with Prompt, Tags, model, size, and generation parameters.'),
    };
    return descriptions[mode] || descriptions.caption_merged;
}

function updateExportFormatDescription(format) {
    const description = $('#export-format-description');
    if (description) {
        description.textContent = getExportFormatDescription(format || $('#export-format')?.value || _currentExportFormat || 'prompt');
    }
}

function updateBatchExportContentDescription(mode) {
    const description = $('#batch-export-content-description');
    if (description) {
        description.textContent = getBatchExportContentDescription(mode || $('#batch-export-content-mode')?.value || 'caption_merged');
    }
}

function normalizeExportTextPart(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueExportParts(parts) {
    const seen = new Set();
    const output = [];
    parts.forEach((part) => {
        const value = normalizeExportTextPart(part).replace(/^,+|,+$/g, '').trim();
        if (!value) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        output.push(value);
    });
    return output;
}

function buildExportGenerationParams(image = {}) {
    const params = image.generation_params && typeof image.generation_params === 'object'
        ? { ...image.generation_params }
        : {};
    if (!params.model && image.checkpoint) params.model = image.checkpoint;
    if (!params.size && image.width && image.height) params.size = `${image.width}x${image.height}`;
    return params;
}

function buildA1111ExportBlock(image = {}) {
    const prompt = String(image.prompt || '').trim();
    const negative = String(image.negative_prompt || '').trim();
    const params = buildExportGenerationParams(image);
    const lines = [];
    if (prompt) lines.push(prompt);
    if (negative) lines.push(`Negative prompt: ${negative}`);

    const order = [
        ['steps', 'Steps'],
        ['sampler', 'Sampler'],
        ['schedule_type', 'Schedule type'],
        ['cfg_scale', 'CFG scale'],
        ['seed', 'Seed'],
        ['size', 'Size'],
        ['model', 'Model'],
        ['model_hash', 'Model hash'],
        ['clip_skip', 'Clip skip'],
        ['denoising_strength', 'Denoising strength'],
        ['loras', 'LoRAs'],
    ];
    const emitted = new Set();
    const parts = [];
    order.forEach(([key, label]) => {
        const value = params[key];
        if (value == null || value === '') return;
        emitted.add(key);
        parts.push(`${label}: ${value}`);
    });
    Object.keys(params).sort().forEach((key) => {
        if (emitted.has(key)) return;
        const value = params[key];
        if (value == null || value === '') return;
        const label = key.split('_').map(part => part ? part.charAt(0).toUpperCase() + part.slice(1) : part).join(' ');
        parts.push(`${label}: ${value}`);
    });
    if (parts.length) lines.push(parts.join(', '));
    return lines.join('\n').trim();
}

function buildExportRecord(image = {}) {
    return {
        id: image.id,
        filename: image.filename || '',
        generator: image.generator || null,
        prompt: image.prompt || '',
        negative_prompt: image.negative_prompt || '',
        ai_caption: image.ai_caption || '',
        tags: Array.isArray(image.tags) ? image.tags : [],
        checkpoint: image.checkpoint || null,
        width: image.width || null,
        height: image.height || null,
        aesthetic_score: image.aesthetic_score ?? null,
        generation_params: buildExportGenerationParams(image),
    };
}

function escapeCsvField(value) {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildExportText(exportData, format) {
    const images = Array.isArray(exportData?.images) ? exportData.images : [];
    let text = '';

    if (format === 'prompt') {
        text = images.map(image => String(image.prompt || '').trim()).filter(Boolean).join('\n\n');
    } else if (format === 'prompt_numbered') {
        text = images.map((image, index) => {
            const prompt = String(image.prompt || '').trim();
            if (!prompt) return '';
            const filename = String(image.filename || `Image ${image.id || index + 1}`).trim();
            return `${index + 1}. ${filename}\n${prompt}`;
        }).filter(Boolean).join('\n\n');
    } else if (format === 'negative') {
        text = images.map(image => String(image.negative_prompt || '').trim()).filter(Boolean).join('\n\n');
    } else if (format === 'prompt_negative') {
        text = images.map((image) => {
            const prompt = String(image.prompt || '').trim();
            const negative = String(image.negative_prompt || '').trim();
            return [prompt, negative ? `Negative prompt: ${negative}` : ''].filter(Boolean).join('\n');
        }).filter(Boolean).join('\n\n');
    } else if (format === 'a1111') {
        text = images.map(buildA1111ExportBlock).filter(Boolean).join('\n\n');
    } else if (format === 'tags') {
        const allTags = new Set();
        images.forEach((image) => (image.tags || []).forEach(tag => allTags.add(tag)));
        text = Array.from(allTags).sort().join(', ');
    } else if (format === 'caption_tags') {
        text = images.map((image) => uniqueExportParts([image.ai_caption, ...(image.tags || [])]).join(', ')).filter(Boolean).join('\n');
    } else if (format === 'caption_merged') {
        text = images.map((image) => uniqueExportParts([image.ai_caption, image.prompt, ...(image.tags || [])]).join(', ')).filter(Boolean).join('\n');
    } else if (format === 'jsonl') {
        text = images.map(image => JSON.stringify(buildExportRecord(image))).join('\n');
    } else if (format === 'csv') {
        const header = ['id', 'filename', 'generator', 'prompt', 'negative_prompt', 'ai_caption', 'tags', 'checkpoint', 'width', 'height'];
        const rows = images.map((image) => {
            const record = buildExportRecord(image);
            const values = [
                record.id,
                record.filename,
                record.generator,
                record.prompt,
                record.negative_prompt,
                record.ai_caption,
                record.tags.join(', '),
                record.checkpoint,
                record.width,
                record.height,
            ];
            return values.map(escapeCsvField).join(',');
        });
        text = [header.join(','), ...rows].join('\n');
    }

    if (!text) {
        text = appT('export.noDataForFormat', 'No exportable data for this format in the selected preview.');
    }

    const totalSelected = Number(exportData?.total || images.length);
    const previewWindowSize = Number(exportData?.preview_count ?? exportData?.count ?? images.length);
    const previewCount = Math.min(totalSelected, previewWindowSize);
    const previewOnly = Boolean(exportData?.has_more) || totalSelected > previewCount;

    if (text.length > EXPORT_PREVIEW_MAX_CHARS) {
        text = `${text.slice(0, EXPORT_PREVIEW_MAX_CHARS)}\n\n${appT('export.previewTextTruncated', '[Preview truncated to keep the app responsive]')}`;
    }
    if (previewOnly) {
        text = `${text}\n\n${appT(
            'export.previewLimited',
            'Preview only shows the first {preview} of {total} selected images. Use "Same-name .txt" when you need one complete caption file per image.',
            { preview: previewCount, total: totalSelected }
        )}`;
    }
    return text;
}

function setExportModalMode(mode) {
    const exportAltBtn = $('#btn-export-tags-alt');
    if (!exportAltBtn) return;

    const normalizedMode = mode === 'tags' ? 'tags' : 'prompts';
    exportAltBtn.dataset.exportView = normalizedMode;
    exportAltBtn.innerHTML = normalizedMode === 'prompts'
        ? `🏷️ ${appT('export.tagsInstead', 'Show Tags')}`
        : `📤 ${appT('export.promptsInstead', 'Show Prompt Text')}`;
}

function renderExportModalText(format = null) {
    const selectedFormat = format || $('#export-format')?.value || _currentExportFormat || 'prompt';
    _currentExportFormat = selectedFormat;
    const select = $('#export-format');
    if (select && select.value !== selectedFormat) select.value = selectedFormat;

    $('#export-title').textContent = `${selectedFormat === 'tags' ? '🏷️' : '📤'} ${getExportFormatLabel(selectedFormat)}`;
    setExportModalMode(selectedFormat === 'tags' ? 'tags' : 'prompts');
    updateExportFormatDescription(selectedFormat);

    const textArea = $('#export-text');
    if (!textArea || !_currentExportModalData) return;
    textArea.value = buildExportText(_currentExportModalData, selectedFormat);
}

async function showExportModalWithFormat(format = 'prompt') {
    const selectedCount = getSelectedGalleryCount();
    if (selectedCount === 0) return;

    _currentExportModalData = null;
    _currentExportFormat = format;
    $('#export-count').textContent = appT('export.selectedCount', 'This export includes only {count} selected images.', {
        count: selectedCount,
    });
    const select = $('#export-format');
    if (select) select.value = format;
    setExportModalMode(format === 'tags' ? 'tags' : 'prompts');
    $('#export-title').textContent = `${format === 'tags' ? '🏷️' : '📤'} ${getExportFormatLabel(format)}`;
    updateExportFormatDescription(format);
    const textArea = $('#export-text');
    textArea.value = format === 'tags'
        ? appT('export.loadingTags', 'Loading tags...')
        : appT('export.loadingPrompts', 'Loading prompts...');

    showModal('export-modal');

    try {
        const ids = getSelectedGalleryIds();
        _currentExportModalData = await loadSelectionPreviewData(ids, EXPORT_PREVIEW_MAX_IMAGES);
        renderExportModalText(format);
    } catch (e) {
        textArea.value = appT('export.errorLoadingData', 'Error loading export data: {message}', {
            message: e.message,
        });
    }
}

async function showExportModal() {
    return showExportModalWithFormat('prompt');
}

async function showExportTagsModal() {
    return showExportModalWithFormat('tags');
}

function getExportFileExtension(format) {
    if (format === 'jsonl') return 'jsonl';
    if (format === 'csv') return 'csv';
    return 'txt';
}

function downloadCurrentExportText() {
    const text = $('#export-text')?.value || '';
    const format = $('#export-format')?.value || _currentExportFormat || 'prompt';
    const extension = getExportFileExtension(format);
    const filename = `sd-image-sorter-${format}-${new Date().toISOString().slice(0, 10)}.${extension}`;
    const blob = new Blob([text], { type: extension === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}


function showBatchExportModal() {
    const selectedCount = getSelectedGalleryCount();
    if (selectedCount === 0) {
        showToast(appT('export.selectImagesFirst', 'Please select images first'), 'error');
        return;
    }

    $('#batch-export-count').textContent = appT('batchExport.selectedCount', 'This batch export includes only {count} selected images.', {
        count: selectedCount,
    });
    const contentModeSelect = $('#batch-export-content-mode');
    if (contentModeSelect && !contentModeSelect.value) {
        contentModeSelect.value = 'caption_merged';
    }
    updateBatchExportContentDescription(contentModeSelect?.value || 'caption_merged');
    syncBatchExportOutputModeUi();
    $('#batch-export-progress').style.display = 'none';
    $('#btn-start-batch-export').disabled = false;
    showModal('batch-export-modal');
}

function syncBatchExportOutputModeUi() {
    // The "Save next to each image" option ignores Output Folder, so disable
    // the input + helper text when that mode is selected. Disabled inputs
    // visually reinforce that the field is not used and skip required-field
    // validation when the user clicks Export.
    const folderRadio = document.querySelector('input[name="batch-export-output-mode"][value="folder"]');
    const folderGroup = $('#batch-export-folder-group');
    const folderInput = $('#batch-export-folder');
    const isFolderMode = !!(folderRadio && folderRadio.checked);
    if (folderInput) {
        folderInput.disabled = !isFolderMode;
    }
    if (folderGroup) {
        folderGroup.classList.toggle('is-disabled', !isFolderMode);
    }
}

function getExportDataCacheKey(imageIds) {
    return imageIds.map((id) => String(id)).join(',');
}

function getTokenExportDataCacheKey(selectionToken, offset, limit) {
    return `token:${selectionToken}:${offset}:${limit}`;
}

function getActiveSelectionExportToken() {
    if (AppState.selectionScope !== 'filtered' || !AppState.selectionToken) {
        return null;
    }
    if (AppState.selectionFilterKey !== getSelectionFilterCacheKey(AppState.filters)) {
        return null;
    }
    return AppState.selectionToken;
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

async function loadSelectionDataByToken(selectionToken, { offset = 0, limit = EXPORT_PREVIEW_MAX_IMAGES } = {}) {
    const normalizedOffset = Math.max(0, Number(offset) || 0);
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || EXPORT_PREVIEW_MAX_IMAGES, 10000));
    const cacheKey = getTokenExportDataCacheKey(selectionToken, normalizedOffset, normalizedLimit);
    if (AppState.selectionDataCache.key === cacheKey && AppState.selectionDataCache.data) {
        return AppState.selectionDataCache.data;
    }

    const response = await API.getSelectionDataByToken(selectionToken, {
        offset: normalizedOffset,
        limit: normalizedLimit,
    });
    const responseIds = Array.isArray(response?.images)
        ? response.images.map((image) => Number(image?.id)).filter((id) => Number.isFinite(id) && id > 0)
        : [];
    const data = {
        ...buildSelectionDataPayload(responseIds, response),
        count: Number(response?.count ?? responseIds.length),
        preview_count: Number(response?.count ?? responseIds.length),
        total: Number(response?.total ?? responseIds.length),
        offset: Number(response?.offset ?? normalizedOffset),
        limit: Number(response?.limit ?? normalizedLimit),
        next_offset: response?.next_offset ?? null,
        has_more: Boolean(response?.has_more),
        source: response?.source || 'selection_token',
        exact_total: response?.exact_total !== false,
    };
    AppState.selectionDataCache = {
        key: cacheKey,
        data
    };
    return data;
}

async function loadSelectionPreviewData(ids, limit = EXPORT_PREVIEW_MAX_IMAGES) {
    const selectionToken = getActiveSelectionExportToken();
    if (selectionToken) {
        return loadSelectionDataByToken(selectionToken, { offset: 0, limit });
    }

    const previewIds = ids.slice(0, limit);
    const data = await loadSelectionData(previewIds);
    return {
        ...data,
        count: data.images.length,
        preview_count: previewIds.length,
        total: ids.length,
        offset: 0,
        limit: previewIds.length,
        has_more: ids.length > previewIds.length,
        source: 'image_ids',
        exact_total: true,
    };
}


async function executeBatchExport() {
    const outputModeRadio = document.querySelector('input[name="batch-export-output-mode"]:checked');
    const outputMode = outputModeRadio?.value === 'folder' ? 'folder' : 'beside_image';
    const outputFolder = $('#batch-export-folder')?.value?.trim() || '';
    if (outputMode === 'folder' && !outputFolder) {
        showToast(appT('export.outputFolderRequired', 'Please enter an output folder'), 'error');
        return;
    }

    const prefix = $('#batch-export-prefix')?.value || '';
    const blacklistText = $('#batch-export-blacklist')?.value || '';
    const blacklist = blacklistText ? blacklistText.split(',').map(t => t.trim()).filter(t => t) : [];
    const contentMode = $('#batch-export-content-mode')?.value || 'caption_merged';
    const overwritePolicy = $('#batch-export-overwrite')?.value || 'unique';

    const selectionToken = getActiveSelectionTokenForActions();
    const imageIds = selectionToken ? [] : Array.from(AppState.selectedIds);

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
        const templateOptions = contentMode === 'template' && window.V321Integration?.collectTemplateOptions
            ? window.V321Integration.collectTemplateOptions()
            : null;
        const imageOverrides = window.V321Integration?.collectEditedCaptionOverrides
            ? window.V321Integration.collectEditedCaptionOverrides()
            : null;
        const captionTransforms = window.V321Integration?.collectCaptionTransforms
            ? window.V321Integration.collectCaptionTransforms()
            : null;
        const normalizeTagUnderscores = $('#batch-export-normalize-underscores')
            ? !!$('#batch-export-normalize-underscores').checked
            : undefined;
        const result = await API.exportTagsBatch(imageIds, outputFolder, blacklist, prefix, contentMode, overwritePolicy, {
            selectionToken,
            outputMode,
            templateOptions,
            imageOverrides,
            captionTransforms,
            normalizeTagUnderscores,
        });

        $('#batch-export-progress-fill').style.width = '100%';

        const exported = Number(result?.exported || 0);
        const skipped = Number(result?.skipped || 0);
        const errorCount = Number(result?.error_count ?? result?.errors ?? 0);
        const errorMessages = Array.isArray(result?.error_messages) ? result.error_messages : [];

        if ((result.status === 'ok' || errorCount === 0) && exported > 0 && skipped === 0) {
            showToast(appT('export.success', 'Exported {count} tag files successfully.', {
                count: exported,
            }), 'success');
            hideModal('batch-export-modal');
        } else if (result.status === 'partial' || exported > 0 || skipped > 0) {
            const baseMessage = exported > 0
                ? appT('batchExport.partialSuccess', 'Exported {count} file(s). {failed} failed.')
                    .replace('{count}', exported)
                    .replace('{failed}', errorCount)
                : appT('batchExport.noFilesWritten', 'No .txt / .json files were written.');
            const skippedMessage = skipped > 0
                ? ` ${appT('batchExport.skippedExisting', 'Skipped {skipped} existing file(s).').replace('{skipped}', skipped)}`
                : '';
            showToast(`${baseMessage}${skippedMessage}`.trim(), errorCount > 0 || skipped > 0 ? 'warning' : 'success');
            hideModal('batch-export-modal');
        } else {
            showToast(appT('export.failedReason', 'Export failed: {reason}', {
                reason: errorMessages.join(', ') || appT('common.unknownError', 'Unknown error'),
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
    updateAppFilters((filters) => {
        filters.generators = generators;
    });

    // Get ratings
    const ratings = [];
    $$('#modal-rating-filters input[type="checkbox"]:checked').forEach(cb => {
        ratings.push(cb.value);
    });
    updateAppFilters((filters) => {
        filters.ratings = ratings;
    });
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
    updateAppFilters((filters) => {
        filters.generators = [...ALL_GENERATORS];
        filters.ratings = ['general', 'sensitive', 'questionable', 'explicit'];
        filters.tags = [];
        filters.search = '';
    });
    const freeTextSearch = $('#modal-free-text-search');
    if (freeTextSearch) freeTextSearch.value = '';
    const activeTags = $('#active-tags');
    if (activeTags) activeTags.innerHTML = '';
    loadImages();
}

function addTagFilter(tag) {
    if (!AppState.filters.tags.includes(tag)) {
        updateAppFilters((filters) => {
            filters.tags = [...filters.tags, tag];
        });
        renderActiveTagFilters();
    }
}

function removeTagFilter(tag) {
    updateAppFilters((filters) => {
        filters.tags = filters.tags.filter(t => t !== tag);
    });
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
    const brightnessMinInput = $('#filter-brightness-min');
    const brightnessMaxInput = $('#filter-brightness-max');
    if (brightnessMinInput) brightnessMinInput.value = filterState.brightnessMin ?? '';
    if (brightnessMaxInput) brightnessMaxInput.value = filterState.brightnessMax ?? '';
    $$('input[name="color-temperature"]').forEach(radio => {
        radio.checked = radio.value === (filterState.colorTemperature || '');
    });
    $$('input[name="brightness-distribution"]').forEach(radio => {
        radio.checked = radio.value === (filterState.brightnessDistribution || '');
    });
    $$('input[name="prompt-match-mode"]').forEach(radio => {
        radio.checked = radio.value === normalizePromptMatchMode(filterState.promptMatchMode);
    });
    $$('input[name="tag-match-mode"]').forEach(radio => {
        radio.checked = radio.value === (filterState.tagMode || 'and');
    });
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

    // v3.2.1 task #26: notify modules that the filter modal was just opened so
    // ColorBackfill (and future addons) can refresh their inline banners.
    try { window.dispatchEvent(new CustomEvent('filterModalOpened')); } catch (_e) {}
}

function renderModalActiveTags() {
    const container = $('#modal-active-tags');
    if (!container) return;
    container.innerHTML = '';

    const filterState = getFilterModalState();

    // Render included tags
    filterState.tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'active-tag';
        tagEl.title = 'Click to exclude; click again to remove';
        tagEl.appendChild(document.createTextNode(`${tag} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-modal-tag';
        removeEl.dataset.tag = tag;
        removeEl.textContent = '\u00d7';
        removeEl.addEventListener('click', (e) => {
            e.stopPropagation();
            filterState.tags = filterState.tags.filter(t => t !== tag);
            renderModalActiveTags();
        });

        tagEl.addEventListener('click', () => {
            // Cycle: include -> exclude
            filterState.tags = filterState.tags.filter(t => t !== tag);
            if (!filterState.excludeTags) filterState.excludeTags = [];
            if (!filterState.excludeTags.includes(tag)) filterState.excludeTags.push(tag);
            renderModalActiveTags();
        });

        tagEl.appendChild(removeEl);
        container.appendChild(tagEl);
    });

    // Render excluded tags
    (filterState.excludeTags || []).forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'active-tag active-tag-exclude';
        tagEl.title = 'Click to remove exclusion';
        tagEl.appendChild(document.createTextNode(`${tag} `));

        const removeEl = document.createElement('span');
        removeEl.className = 'remove-modal-tag';
        removeEl.dataset.tag = tag;
        removeEl.textContent = '\u00d7';
        removeEl.addEventListener('click', (e) => {
            e.stopPropagation();
            filterState.excludeTags = (filterState.excludeTags || []).filter(t => t !== tag);
            renderModalActiveTags();
        });

        tagEl.addEventListener('click', () => {
            // Cycle: exclude -> remove
            filterState.excludeTags = (filterState.excludeTags || []).filter(t => t !== tag);
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

function renderFeatureAvailabilityNotice() {
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (!summaryEl || !gridEl) return;

    let noticeEl = document.getElementById('feature-availability-notice');
    if (!noticeEl) {
        noticeEl = document.createElement('section');
        noticeEl.id = 'feature-availability-notice';
        noticeEl.className = 'feature-availability-notice';
        gridEl.parentElement.insertBefore(noticeEl, gridEl);
    }

    const readyItems = [
        appT('features.ready.gallery', 'Import / scan folders, browse gallery, read SD metadata'),
        appT('features.ready.filters', 'Filter, search, batch select, auto-separate, and WASD manual sort'),
        appT('features.ready.prompts', 'Prompt Lab, tag library, export sidecar .txt / .json files'),
        appT('features.ready.censorManual', 'Manual censor editor tools: brush, pen, eraser, clone, preview/save'),
        appT('features.ready.colorAnalysis', 'Color analysis: dominant colors, brightness, saturation, color temperature'),
        appT('features.ready.loraExport', 'LoRA training export: Caption Editor, template presets, batch export'),
    ];
    const prepareItems = [
        appT('features.prepare.wd14', 'WD14 / ONNX tagging: downloads model files and repairs Windows GPU runtime when needed'),
        appT('features.prepare.clip', 'CLIP similarity / duplicate search: installs fastembed and downloads CLIP files'),
        appT('features.prepare.aesthetic', 'Aesthetic scoring: installs torch + open-clip and downloads CLIP/head files'),
        appT('features.prepare.artist', 'Artist ID: installs torch/transformers/timm/safetensors/triton and downloads Kaloscope files'),
        appT('features.prepare.censorAi', 'AI censor detectors: NudeNet / Privacy YOLO / SAM3 install their own runtimes and model files'),
        appT('features.prepare.toriigate', 'ToriiGate VLM tagging: heavy PyTorch runtime + about 5 GB model download on first use'),
        appT('features.prepare.vlm', 'VLM natural language captioning: requires API keys (OpenAI/Anthropic/Gemini) or local Ollama'),
    ];

    noticeEl.innerHTML = `
        <div class="feature-availability-card is-ready">
            <strong>${escapeHtml(appT('features.readyTitle', 'Ready after first run.bat'))}</strong>
            <ul>${readyItems.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>
        <div class="feature-availability-card is-prepare">
            <strong>${escapeHtml(appT('features.prepareTitle', 'Needs Prepare / Download'))}</strong>
            <p>${escapeHtml(appT('features.prepareRestartNote', 'If Prepare installs Python packages, restart the app before using that feature. The UI will warn you when this happens.'))}</p>
            <ul>${prepareItems.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>
    `;
}

function getThumbnailCacheSettings(data = {}) {
    const settingsLimit = Number(data?.settings?.thumbnail_cache_max_mb);
    if (Number.isFinite(settingsLimit)) return settingsLimit;
    const statsLimit = Number(data?.thumbnail_cache?.max_size_mb);
    if (Number.isFinite(statsLimit)) return statsLimit;
    return 500;
}

async function requestCoreRuntimeRebuild() {
    const runtime = await API.getCacheStatus().then(data => data?.runtime_environment || {}).catch(() => ({}));
    const venvSize = runtime.venv_size_complete === false
        ? appT('disk.runtimeSizeUnknown', 'large / not fully scanned')
        : _formatBytes(Number(runtime.venv_size_bytes || 0));
    showConfirm(
        appT('disk.rebuildCoreConfirmTitle', 'Rebuild lightweight runtime on next start?'),
        appT('disk.rebuildCoreConfirmBody', 'This schedules the app-owned Python runtime to be rebuilt the next time you start the app, then core dependencies are reinstalled. User data, images.db, settings, caches, and downloaded models are not deleted. Current runtime size: {size}. Heavy AI Python packages must be prepared again later.', { size: venvSize }),
        async () => {
            const button = $('#btn-rebuild-core-runtime');
            const originalLabel = button?.textContent || '';
            if (button) {
                button.disabled = true;
                button.textContent = appT('disk.rebuildScheduling', 'Scheduling…');
            }
            try {
                await API.rebuildCoreRuntime();
                showToast(appT('disk.rebuildScheduled', 'Lightweight runtime rebuild scheduled. Close the app and start it again to free the old Python environment.'), 'warning');
                loadDiskUsage();
            } catch (error) {
                if (button) {
                    button.disabled = false;
                    button.textContent = originalLabel;
                }
                showToast(formatUserError(error, appT('disk.rebuildFailed', 'Failed to schedule runtime rebuild')), 'error');
            }
        }
    );
}

async function saveDiskSettings() {
    const input = $('#thumbnail-cache-limit-input');
    const button = $('#btn-save-cache-settings');
    if (!input || !button) return;

    const rawValue = Number(input.value);
    if (!Number.isFinite(rawValue) || rawValue < 0 || rawValue > 102400) {
        showToast(appT('disk.limitInvalid', 'Enter a cache limit from 0 to 102400 MB.'), 'warning');
        return;
    }

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = appT('disk.saving', 'Saving…');
    try {
        const result = await API.setDiskSettings({ thumbnail_cache_max_mb: Math.round(rawValue) });
        renderDiskUsage({
            ...(await API.getCacheStatus().catch(() => ({}))),
            ...result,
        });
        const freedBytes = Number(result?.limit_cleanup?.freed_bytes || 0);
        const message = freedBytes > 0
            ? appT('disk.limitSavedFreed', 'Cache limit saved. Freed {freed}.', { freed: _formatBytes(freedBytes) })
            : appT('disk.limitSaved', 'Cache limit saved.');
        showToast(message, 'success');
    } catch (error) {
        button.disabled = false;
        button.textContent = originalLabel;
        showToast(formatUserError(error, appT('disk.limitSaveFailed', 'Failed to save cache limit')), 'error');
    }
}


function bindDatasetAuditLazyInit() {
    const details = document.getElementById('audit-section');
    if (!details || details.dataset.auditBound === '1') return;
    details.dataset.auditBound = '1';
    details.addEventListener('toggle', () => {
        if (details.open && window.LibraryHealth && typeof window.LibraryHealth.init === 'function') {
            window.LibraryHealth.init();
        }
    });
}

async function openModelManager() {
    // Remove first-run pulse indicator once user has found the button
    const setupBtn = $('#btn-open-model-manager');
    if (setupBtn && setupBtn.classList.contains('setup-pulse')) {
        setupBtn.classList.remove('setup-pulse');
        localStorage.setItem('sd-image-sorter-setup-clicked', '1');
    }
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (summaryEl) {
        summaryEl.innerHTML = `<div class="model-manager-stat"><strong>${escapeHtml(appT('models.loadingTitle', 'Checking'))}</strong><span>${escapeHtml(appT('models.loadingBody', 'Checking what is ready on this computer...'))}</span></div>`;
    }
    if (gridEl) gridEl.innerHTML = '';
    showModal('model-manager-modal');

    // Disk usage loads independently so a slow model probe doesn't block it.
    loadDiskUsage();

    // Lazily initialize Dataset Audit only when the user expands it. Its data
    // call is heavier than disk usage, so we do not want it to fire on every
    // Setup open.
    bindDatasetAuditLazyInit();

    try {
        const result = await API.getModelStatus();
        renderModelManager(result.models || []);
    } catch (error) {
        if (summaryEl) {
            summaryEl.innerHTML = `<div class="model-manager-stat"><strong>${escapeHtml(appT('models.failedTitle', 'Load failed'))}</strong><span>${escapeHtml(error.message || appT('models.failedBody', 'Could not read local feature status right now.'))}</span></div>`;
        }
    }

    // Wire the "Download all" button. Idempotent — re-binding on each
    // openModelManager() call is fine because the previous handler was
    // removed when the DOM survived (the button is static markup).
    const bulkBtn = $('#btn-bulk-download-models');
    if (bulkBtn && !bulkBtn.dataset.bulkBound) {
        bulkBtn.dataset.bulkBound = '1';
        bulkBtn.addEventListener('click', () => {
            promptBulkDownloadModels().catch((err) => {
                console.error('Bulk download flow failed', err);
                showToast(formatUserError(err, appT('models.bulkFailed', 'Bulk download failed')), 'error');
            });
        });
    }
}

function _formatBulkBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function promptBulkDownloadModels() {
    let bundle;
    try {
        bundle = await API.getModelBulkBundle();
    } catch (err) {
        showToast(formatUserError(err, appT('models.bulkFetchFailed', 'Could not load the bulk download list. Please restart the app and try again.')), 'error');
        return;
    }

    const items = Array.isArray(bundle?.items) ? bundle.items : [];
    if (items.length === 0) {
        showToast(appT('models.bulkEmpty', 'No models are configured for bulk download.'), 'warning');
        return;
    }
    const pendingItems = items.filter((it) => it.status !== 'ready');
    if (pendingItems.length === 0) {
        showToast(appT('models.bulkAllReady', 'All recommended models are already downloaded.'), 'success');
        return;
    }
    const pendingTotalBytes = Number(bundle.pending_total_bytes) || pendingItems.reduce((s, it) => s + (Number(it.size_bytes) || 0), 0);

    // Build the confirmation HTML. We can't use showConfirm() directly
    // because it only takes plain text — we want a checklist with sizes.
    const listHtml = items.map((it) => {
        const isReady = it.status === 'ready';
        const cls = isReady ? 'is-ready' : 'is-pending';
        const sizeText = _formatBulkBytes(it.size_bytes);
        const pillText = isReady
            ? appT('models.bulkAlreadyReady', 'already ready')
            : appT('models.bulkWillDownload', 'will download');
        const safeLabel = escapeHtml(it.label || it.name || it.id);
        return `
            <div class="bulk-download-row ${cls}">
                <span class="bulk-download-name">${safeLabel}</span>
                <span class="bulk-download-pill">${escapeHtml(pillText)}</span>
                <span class="bulk-download-size">~${escapeHtml(sizeText)}</span>
            </div>
        `;
    }).join('');

    const totalText = _formatBulkBytes(pendingTotalBytes);
    const excludedItems = Array.isArray(bundle.excluded) ? bundle.excluded : [];
    const excludedHtml = excludedItems.length ? `
        <p class="model-card-hint" style="margin-top:8px;">
            ${escapeHtml(appT('models.bulkExcludedNote', 'Skipped:'))} ${
                excludedItems.map(e => escapeHtml(e.id)).join(', ')
            }
        </p>
    ` : '';

    const bodyHtml = `
        <p>${escapeHtml(appT(
            'models.bulkConfirmIntro',
            'About to download {count} model(s). Estimated disk space needed: {size}.',
            { count: pendingItems.length, size: totalText }
        ))}</p>
        <div class="bulk-download-list" role="list">${listHtml}</div>
        <div class="bulk-download-summary">
            <span>${escapeHtml(appT('models.bulkConfirmTotalLabel', 'Total to download'))}</span>
            <span>${escapeHtml(totalText)}</span>
        </div>
        ${excludedHtml}
        <p class="model-card-hint" style="margin-top:10px;">${escapeHtml(appT(
            'models.bulkConfirmNote',
            'Sizes are estimates. Some models also install Python packages on first run; restart the app if the progress text mentions a Python install. Downloads run sequentially and you can close this dialog to leave them running in the background.'
        ))}</p>
    `;

    // Re-use the existing #confirm-modal but inject HTML message. Bypass
    // showConfirm()'s plain-text content path — its lock means we have
    // to set message innerHTML manually after it opens.
    showConfirm(
        appT('models.bulkConfirmTitle', 'Are you sure? Download all recommended models'),
        '',
        async () => {
            unlockDynamicI18nText('#btn-confirm-ok', 'modal.yes', 'Yes, proceed');
            await runBulkDownload(pendingItems);
        },
        () => {
            // Cancel: restore the OK button to its default "Yes" text so
            // the next showConfirm() user gets the right wording.
            unlockDynamicI18nText('#btn-confirm-ok', 'modal.yes', 'Yes, proceed');
            const messageEl = document.getElementById('confirm-message');
            if (messageEl) {
                messageEl.style.maxHeight = '';
                messageEl.style.overflowY = '';
                messageEl.style.textAlign = '';
            }
        }
    );

    const messageEl = document.getElementById('confirm-message');
    if (messageEl) {
        // innerHTML sink: callers MUST pass pre-escaped/safe HTML. `bodyHtml`
        // is built above with escapeHtml() around every interpolated value
        // (model labels, sizes, excluded ids, and all appT() strings); appT()
        // does NOT escape its params, so unescaped user text here would be XSS.
        messageEl.innerHTML = bodyHtml;
        messageEl.style.maxHeight = '60vh';
        messageEl.style.overflowY = 'auto';
        messageEl.style.textAlign = 'left';
    }
    // Lock the OK button text so the global i18n auto-retranslate
    // (which honours data-i18n="modal.yes") doesn't overwrite our
    // dynamic "Download N model(s) (~X GB)" label.
    lockDynamicI18nText('#btn-confirm-ok', 'modal.yes');
    const okBtn = document.getElementById('btn-confirm-ok');
    if (okBtn) {
        okBtn.textContent = appT('models.bulkConfirmOk', 'Download {count} model(s) (~{size})', {
            count: pendingItems.length,
            size: totalText,
        });
    }
}

async function runBulkDownload(items) {
    const button = $('#btn-bulk-download-models');
    const originalLabel = button ? button.innerHTML : '';
    if (button) {
        button.disabled = true;
    }

    const total = items.length;
    let completed = 0;
    const failures = [];
    let needsRestart = false;

    // Pulse the Setup button so user knows something is running even if modal is closed
    const setupBtn = $('#btn-open-model-manager');
    if (setupBtn) setupBtn.classList.add('setup-pulse');

    // Show a persistent progress banner inside the model manager modal
    const gridEl = $('#model-manager-grid');
    let banner = document.getElementById('bulk-download-progress-banner');
    if (!banner && gridEl && gridEl.parentElement) {
        banner = document.createElement('div');
        banner.id = 'bulk-download-progress-banner';
        banner.style.cssText = 'padding:12px 16px;margin-bottom:12px;border-radius:8px;background:var(--bg-elevated);border:1px solid var(--accent-primary);font-size:13px;';
        gridEl.parentElement.insertBefore(banner, gridEl);
    }
    const updateBanner = (text) => { if (banner) banner.textContent = text; };

    for (const item of items) {
        updateBanner(appT('models.bulkProgress', 'Downloading {index}/{total}: {name}', { index: completed + 1, total, name: item.name || item.id }));
        if (button) {
            button.innerHTML = `<span aria-hidden="true">⏳</span> <span>${escapeHtml(appT(
                'models.bulkProgress',
                'Downloading {index}/{total}: {name}',
                { index: completed + 1, total, name: item.name || item.id }
            ))}</span>`;
        }

        try {
            await API.prepareModel(item.id, {
                variant: item.variant || null,
            });
        } catch (err) {
            failures.push({ id: item.id, message: err?.message || String(err) });
            continue;
        }

        // Poll progress until this model finishes (or another one starts).
        // Re-uses the existing /api/models/download-progress endpoint that
        // the per-card prepare buttons drive.
        let finished = false;
        let safetyTicks = 0;
        while (!finished) {
            await new Promise(r => setTimeout(r, 1500));
            safetyTicks += 1;
            // Hard guard: 1 hour absolute cap per model so the loop can
            // never deadlock if the backend never reports `prepare_result`.
            if (safetyTicks > 2400) {
                failures.push({ id: item.id, message: 'timeout waiting for prepare_result' });
                break;
            }
            try {
                const p = await API.get('/api/models/download-progress');
                const pr = p?.prepare_result;
                if (pr && !pr.active && pr.model_id === item.id && pr.status) {
                    finished = true;
                    if (pr.restart_recommended) needsRestart = true;
                    if (pr.status !== 'done' && pr.status !== 'ready' && pr.status !== 'warning') {
                        failures.push({ id: item.id, message: pr.message || pr.error || pr.status });
                    }
                    break;
                }
                if (button && p?.active && p.total > 0) {
                    const pct = Math.round((p.downloaded / p.total) * 100);
                    const detail = appT('models.bulkProgressDetail', '{index}/{total}: {name} {pct}%', { index: completed + 1, total, name: item.name || item.id, pct });
                    updateBanner(detail);
                    button.innerHTML = `<span aria-hidden="true">⏳</span> <span>${escapeHtml(detail)}</span>`;
                }
            } catch (err) {
                // Network blip — just retry the poll.
            }
        }
        completed += 1;
        // Notify per-model completion so user knows progress even if modal is closed
        if (failures.length === 0 || failures[failures.length - 1]?.id !== item.id) {
            showToast(appT('models.bulkItemDone', '✓ {name} ({index}/{total})', { name: item.name || item.id, index: completed, total }), 'success');
        }
    }

    // Stop the pulse indicator
    if (setupBtn) setupBtn.classList.remove('setup-pulse');

    // Refresh model status to reflect the new "ready" rows.
    try {
        const refreshed = await API.getModelStatus();
        renderModelManager(refreshed.models || []);
    } catch (err) {
        // Non-fatal — the user can re-open the modal.
    }

    if (button) {
        button.disabled = false;
        button.innerHTML = originalLabel
            || `<span aria-hidden="true">⬇️</span> <span>${escapeHtml(appT('models.bulkDownload', 'Download all recommended models'))}</span>`;
    }

    // Update banner with final result
    if (banner) {
        if (needsRestart) {
            banner.style.borderColor = 'var(--color-warning, #f59e0b)';
            banner.style.background = 'rgba(245, 158, 11, 0.1)';
            banner.innerHTML = `<strong>${escapeHtml(appT('models.bulkNeedsRestart', '⚠️ Restart required'))}</strong><br>${escapeHtml(appT('models.bulkRestartExplain', 'Some features installed Python packages. Close and restart the app, then click "Download all" again to finish downloading model files.'))}`;
        } else if (failures.length === 0) {
            banner.style.borderColor = 'var(--color-success, #22c55e)';
            banner.style.background = 'rgba(34, 197, 94, 0.1)';
            banner.textContent = appT('models.bulkDoneAll', 'All {count} model(s) downloaded successfully.', { count: total });
            setTimeout(() => { if (banner.parentNode) banner.remove(); }, 10000);
        } else {
            banner.style.borderColor = 'var(--color-danger, #ef4444)';
            banner.textContent = appT('models.bulkDoneMixed', 'Downloaded {ok}/{total}. Failed: {failed}.', { ok: total - failures.length, total, failed: failures.map(f => f.id).join(', ') });
        }
    }

    if (failures.length === 0 && !needsRestart) {
        showToast(appT('models.bulkDoneAll', 'All {count} model(s) downloaded successfully.', { count: total }), 'success');
    } else if (needsRestart) {
        showToast(appT('models.bulkNeedsRestart', '⚠️ Restart required — close and reopen the app, then click Download again.'), 'warning');
    } else {
        const okCount = total - failures.length;
        const failedIds = failures.map(f => f.id).join(', ');
        showToast(appT(
            'models.bulkDoneMixed',
            'Downloaded {ok}/{total}. Failed: {failed}. Open each model card to retry the failed ones.',
            { ok: okCount, total, failed: failedIds }
        ), 'warning');
    }
}

function renderModelManager(models = []) {
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (!summaryEl || !gridEl) return;

    const readyCount = models.filter(model => model.status === 'ready').length;
    const missingCount = models.filter(model => model.status === 'missing').length;

    summaryEl.innerHTML = `
        <div class="model-manager-stat">
            <strong>${readyCount}</strong>
            <span>${escapeHtml(appT('models.ready', 'Ready now'))}</span>
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

    renderFeatureAvailabilityNotice();

    API.getMirror().then((mirrorData) => {
        const current = mirrorData?.mirror || 'auto';
        const labels = { auto: 'Auto (HuggingFace → hf-mirror fallback)', 'hf-mirror': 'hf-mirror.com (HF mirror)', modelscope: 'ModelScope' };
        let mirrorRow = document.getElementById('model-mirror-row');
        if (!mirrorRow) {
            mirrorRow = document.createElement('div');
            mirrorRow.id = 'model-mirror-row';
            mirrorRow.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(191,219,254,0.08);border-radius:12px;';
            gridEl.parentElement.insertBefore(mirrorRow, gridEl);
        }
        const opts = (mirrorData?.options || ['auto', 'hf-mirror', 'modelscope']).map(
            o => `<option value="${escapeHtml(o)}"${o === current ? ' selected' : ''}>${escapeHtml(labels[o] || o)}</option>`
        ).join('');
        mirrorRow.innerHTML = `
            <label style="font-size:13px;font-weight:600;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(appT('models.mirrorLabel', 'Download Source'))}</label>
            <select class="input-field" id="model-mirror-select" style="flex:1;font-size:12px;padding:6px 8px;">${opts}</select>
        `;
        document.getElementById('model-mirror-select')?.addEventListener('change', async (e) => {
            try {
                await API.setMirror(e.target.value);
                showToast(appT('models.mirrorSaved', 'Download source saved: {mirror}').replace('{mirror}', labels[e.target.value] || e.target.value), 'success');
            } catch (err) {
                showToast(formatUserError(err, 'Failed to save'), 'error');
            }
        });
    }).catch(() => {});

    gridEl.innerHTML = models.map((model) => {
        const safeId = escapeHtml(model.id);
        const status = model.status || (model.available ? 'ready' : 'missing');
        const statusClass = status === 'ready' ? 'is-ready' : 'is-missing';
        const statusLabel = status === 'ready'
            ? appT('models.readyBadge', 'Ready')
            : appT('models.missingBadge', 'Missing');
        const sourceOptions = Array.isArray(model.sources) ? model.sources.map((source) => `
            <option value="${escapeHtml(source)}">${escapeHtml(source)}</option>
        `).join('') : '';
        const variantOptions = Array.isArray(model.variants) ? model.variants.map((variant) => `
            <option value="${escapeHtml(variant)}">${escapeHtml(variant)}</option>
        `).join('') : '';
        const installedVariants = Array.isArray(model.installed_variants) && model.installed_variants.length
            ? `<div class="model-card-hint">${escapeHtml(appT('models.installedVariants', 'Installed variants'))}: ${escapeHtml(model.installed_variants.join(', '))}</div>`
            : '';
        const externalLinks = Array.isArray(model.external_links) ? model.external_links.map((link) => {
            // Defense in depth: only allow http(s) URLs in the model registry. Block javascript:, data:,
            // file:, vbscript: and other surprising schemes even though the registry is backend-controlled.
            const rawUrl = String(link.url || '');
            const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '#';
            return `
            <a class="btn btn-ghost btn-small" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label || appT('models.openSource', 'Open source'))}</a>
        `;
        }).join('') : '';

        return `
            <article class="model-card ${statusClass}" data-model-id="${safeId}">
                <div class="model-card-header">
                    <div>
                        <div class="model-card-group">${escapeHtml(model.group_key ? appT(model.group_key, model.group || appT('models.groupFallback', 'Feature')) : (model.group || appT('models.groupFallback', 'Feature')))}</div>
                        <div class="model-card-title">${escapeHtml(model.name || model.id)}</div>
                    </div>
                    <span class="model-card-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                </div>
                <div class="model-card-message">${escapeHtml(model.message_key ? appT(model.message_key, model.message || '', model.message_params || {}) : (model.message || ''))}</div>
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
                ${Array.isArray(model.setup_steps) && model.setup_steps.length && status !== 'ready' ? `
                    <details class="model-card-setup-steps">
                        <summary>${escapeHtml(appT('models.setupSteps', 'Manual setup steps'))}</summary>
                        <div class="model-card-hint">${model.setup_steps.map((s, i) => `<div>${i + 1}. <code>${escapeHtml(s)}</code></div>`).join('')}</div>
                    </details>
                ` : ''}
                <div class="model-card-actions">
                    ${model.download_supported ? `<button class="btn btn-primary btn-prepare-model" data-model-id="${safeId}">${escapeHtml(status === 'ready' ? appT('models.repair', 'Recheck / Repair') : appT('models.prepare', 'Prepare / Download'))}</button>` : ''}
                    ${!model.download_supported && status !== 'ready' ? `<span class="model-card-hint">${escapeHtml(appT('models.noAutoDownload', 'Automatic download not available — follow manual steps above'))}</span>` : ''}
                    ${externalLinks}
                </div>
            </article>
        `;
    }).join('');

    const withRestartReminder = (message, prepareResult) => {
        if (!prepareResult?.restart_recommended) return message;
        const packages = Array.isArray(prepareResult.installed_packages)
            ? prepareResult.installed_packages.join(', ')
            : '';
        const reminder = packages
            ? appT('models.restartAfterInstallWithPackages', 'Installed Python packages: {packages}. Restart the app before using this feature.', { packages })
            : appT('models.restartAfterInstall', 'Restart the app before using this feature.');
        return message ? `${message} ${reminder}` : reminder;
    };

    gridEl.querySelectorAll('.btn-prepare-model').forEach((button) => {
        button.addEventListener('click', async () => {
            const modelId = button.dataset.modelId;
            const source = gridEl.querySelector(`.model-source-select[data-model-id="${CSS.escape(modelId)}"]`)?.value || null;
            const variant = gridEl.querySelector(`.model-variant-select[data-model-id="${CSS.escape(modelId)}"]`)?.value || null;
            const originalLabel = button.textContent;
            button.disabled = true;
            button.textContent = appT('models.working', 'Working...');
            try {
                await API.prepareModel(modelId, { source, variant });
            } catch (error) {
                showToast(formatUserError(error, appT('models.prepareFailed', 'Model setup failed')), 'error');
                button.disabled = false;
                button.textContent = originalLabel;
                return;
            }

            let finished = false;
            let pollCount = 0;
            let pollErrorStreak = 0;
            const MAX_POLL_COUNT = 300; // ~4 minutes at 800ms intervals
            const MAX_POLL_ERROR_STREAK = 8; // ~6s of consecutive poll failures before giving up

            // Insert a cancel button next to the prepare button
            let cancelBtn = button.parentElement.querySelector('.btn-cancel-download');
            if (!cancelBtn) {
                cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn btn-ghost btn-small btn-cancel-download';
                cancelBtn.textContent = appT('models.cancelDownload', 'Cancel');
                button.parentElement.insertBefore(cancelBtn, button.nextSibling);
            }
            cancelBtn.style.display = '';
            cancelBtn.onclick = () => {
                finished = true;
                cancelBtn.style.display = 'none';
                button.disabled = false;
                button.textContent = originalLabel;
                showToast(appT('models.downloadCancelled', 'Download cancelled.'), 'info');
            };

            const pollProgress = async () => {
                pollCount++;
                if (pollCount > MAX_POLL_COUNT && !finished) {
                    finished = true;
                    cancelBtn.style.display = 'none';
                    showToast(appT('models.downloadStalled', 'Download may have stalled. Check your network connection and try again.'), 'warning');
                    button.disabled = false;
                    button.textContent = originalLabel;
                    return;
                }
                try {
                    const p = await API.get('/api/models/download-progress');
                    pollErrorStreak = 0; // a successful read clears the transient-failure streak
                    if (p?.active && p.total > 0) {
                        const pct = Math.round((p.downloaded / p.total) * 100);
                        const mb = (p.downloaded / 1048576).toFixed(0);
                        const totalMb = (p.total / 1048576).toFixed(0);
                        button.textContent = `${p.filename || 'Downloading'}: ${mb}/${totalMb} MB (${pct}%)`;
                    } else if (p?.active) {
                        const mb = (p.downloaded / 1048576).toFixed(0);
                        button.textContent = `${p.filename || 'Downloading'}: ${mb} MB...`;
                    }
                    const pr = p?.prepare_result;
                    if (pr && !pr.active && pr.model_id === modelId && pr.status) {
                        finished = true;
                        cancelBtn.style.display = 'none';
                        if (pr.status === 'done') {
                            showToast(withRestartReminder(pr.message || appT('models.readyToast', '{model} is ready.', { model: modelId }), pr), pr.restart_recommended ? 'warning' : 'success');
                            const refreshed = await API.getModelStatus();
                            renderModelManager(refreshed.models || []);
                            document.dispatchEvent(new CustomEvent('model-status-changed', { detail: { modelId } }));
                            return;
                        }
                        if (pr.status === 'warning') {
                            showToast(withRestartReminder(pr.message || appT('models.needsRuntimeToast', 'Model files are present, but runtime setup is incomplete.'), pr), 'warning');
                            const refreshed = await API.getModelStatus();
                            renderModelManager(refreshed.models || []);
                            document.dispatchEvent(new CustomEvent('model-status-changed', { detail: { modelId } }));
                            return;
                        }
                        if (pr.status === 'error') {
                            // If the backend returned structured guidance
                            // (Civitai login wall on Privacy YOLO, archive
                            // verification failure, etc.), surface it as
                            // an actionable dialog instead of swallowing
                            // the recovery path into a toast.
                            const hasGuidance = Array.isArray(pr.manual_steps) && pr.manual_steps.length > 0;
                            if (hasGuidance) {
                                showModelSetupGuide(pr);
                            } else {
                                showToast(pr.message || appT('models.prepareFailed', 'Model setup failed'), 'error');
                            }
                            try {
                                const refreshed = await API.getModelStatus();
                                renderModelManager(refreshed.models || []);
                            } catch (_refreshErr) {
                                button.disabled = false;
                                button.textContent = originalLabel;
                            }
                            return;
                        }
                    }
                } catch (_pollErr) {
                    // A single poll failure is usually transient (server busy
                    // mid-download). Re-arm below, but bail out after a streak
                    // of consecutive failures so the button can't hang forever
                    // in "Working..." when the backend is truly gone.
                    pollErrorStreak++;
                    if (pollErrorStreak >= MAX_POLL_ERROR_STREAK && !finished) {
                        finished = true;
                        cancelBtn.style.display = 'none';
                        showToast(appT('models.downloadStalled', 'Download may have stalled. Check your network connection and try again.'), 'warning');
                        button.disabled = false;
                        button.textContent = originalLabel;
                        return;
                    }
                }
                if (!finished) {
                    setTimeout(pollProgress, 800);
                }
            };
            pollProgress();
        });
    });
}

function _formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

let _modelSetupGuideCleanup = null;

function showModelSetupGuide(pr) {
    // Build a one-off backdrop+dialog so the structured manual_steps from
    // the backend (Civitai login wall, archive verification failure, ...)
    // become an actionable recovery path instead of a stale toast.
    if (_modelSetupGuideCleanup) {
        _modelSetupGuideCleanup({ restoreFocus: false });
    }

    const provider = String(pr.provider || '').trim();
    const message = String(pr.message || appT('models.prepareFailed', 'Model setup failed'));
    const targetDir = String(pr.target_dir || '').trim();
    const externalUrl = String(pr.external_url || '').trim();
    const steps = Array.isArray(pr.manual_steps) ? pr.manual_steps : [];

    const titleText = appT('models.manualSetupTitle', 'Manual setup required');
    const providerLabel = provider
        ? appT('models.providerLabel', 'Source: {provider}', { provider })
        : '';
    const dirLabel = appT('models.targetDirLabel', 'Save the files into this folder:');
    const openLabel = appT('models.openDownloadPage', 'Open Download Page');
    const copyLabel = appT('models.copyTargetDir', 'Copy folder path');
    const closeLabel = appT('models.guideClose', 'Close');

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = document.createElement('div');
    backdrop.id = 'model-setup-guide-backdrop';
    backdrop.className = 'modal-backdrop visible';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,24,0.72);backdrop-filter:blur(6px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px;';

    const dialog = document.createElement('div');
    dialog.role = 'dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'model-setup-guide-title');
    dialog.style.cssText = 'background:var(--bg-card-solid,#0e1a2d);color:var(--text-primary,#eef2ff);border:1px solid var(--glass-border,rgba(191,219,254,0.18));border-radius:16px;padding:24px;max-width:560px;width:100%;max-height:calc(100vh - 48px);overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.5);';

    const stepsHtml = steps
        .map((step, i) => `<li style="margin:6px 0;line-height:1.5;">${escapeHtml(String(step))}</li>`)
        .join('');

    const targetDirHtml = targetDir
        ? `
            <div style="margin-top:14px;padding:12px;background:rgba(255,255,255,0.04);border-radius:10px;border:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:12px;color:var(--text-muted,#94a3b8);margin-bottom:6px;">${escapeHtml(dirLabel)}</div>
                <code id="model-setup-guide-dir" style="display:block;word-break:break-all;font-size:12px;line-height:1.4;font-family:ui-monospace,Consolas,monospace;color:var(--text-primary,#eef2ff);">${escapeHtml(targetDir)}</code>
                <button id="model-setup-guide-copy" type="button" class="btn btn-ghost btn-small" style="margin-top:8px;">${escapeHtml(copyLabel)}</button>
            </div>
        ` : '';

    dialog.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;">
            <div style="flex:1;">
                <h3 id="model-setup-guide-title" style="margin:0;font-size:18px;line-height:1.3;">${escapeHtml(titleText)}</h3>
                ${providerLabel ? `<div style="font-size:12px;color:var(--text-muted,#94a3b8);margin-top:4px;">${escapeHtml(providerLabel)}</div>` : ''}
            </div>
            <button id="model-setup-guide-close-x" type="button" aria-label="${escapeHtml(closeLabel)}" style="background:none;border:none;color:var(--text-muted,#94a3b8);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px;">×</button>
        </div>
        <p style="margin:0 0 12px;line-height:1.5;">${escapeHtml(message)}</p>
        ${steps.length ? `<ol style="margin:0;padding-left:22px;">${stepsHtml}</ol>` : ''}
        ${targetDirHtml}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap;">
            ${externalUrl ? `<button id="model-setup-guide-open" type="button" class="btn btn-primary">${escapeHtml(openLabel)}</button>` : ''}
            <button id="model-setup-guide-close" type="button" class="btn btn-secondary">${escapeHtml(closeLabel)}</button>
        </div>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const getFocusableElements = () => Array.from(dialog.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    });

    const close = ({ restoreFocus = true } = {}) => {
        document.removeEventListener('keydown', onKeydown);
        if (_modelSetupGuideCleanup === close) {
            _modelSetupGuideCleanup = null;
        }
        backdrop.remove();
        if (restoreFocus) previousFocus?.focus?.();
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'Tab') {
            const focusable = getFocusableElements();
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };

    // Backdrop click closes; dialog click does not bubble through.
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    dialog.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', onKeydown);
    _modelSetupGuideCleanup = close;

    document.getElementById('model-setup-guide-close-x')?.addEventListener('click', close);
    document.getElementById('model-setup-guide-close')?.addEventListener('click', close);

    if (externalUrl) {
        document.getElementById('model-setup-guide-open')?.addEventListener('click', () => {
            try {
                window.open(externalUrl, '_blank', 'noopener,noreferrer');
            } catch (_err) {
                showToast(appT('models.openDownloadPageFailed', 'Could not open the download page automatically.'), 'error');
            }
        });
    }

    if (targetDir) {
        document.getElementById('model-setup-guide-copy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(targetDir);
                showToast(appT('models.targetDirCopied', 'Folder path copied to clipboard'), 'success');
            } catch (_err) {
                // Fallback: select the code element so the user can Ctrl+C.
                const codeEl = document.getElementById('model-setup-guide-dir');
                if (codeEl) {
                    const range = document.createRange();
                    range.selectNodeContents(codeEl);
                    const sel = window.getSelection();
                    sel?.removeAllRanges();
                    sel?.addRange(range);
                }
                showToast(appT('models.targetDirCopyFailed', 'Could not copy automatically — select and copy manually.'), 'warning');
            }
        });
    }

    // Focus management for accessibility.
    setTimeout(() => {
        document.getElementById('model-setup-guide-open')
            ?? document.getElementById('model-setup-guide-close-x')
            ?? null;
        const focusTarget = document.getElementById('model-setup-guide-open')
            || document.getElementById('model-setup-guide-close');
        focusTarget?.focus();
    }, 50);
}

async function loadDiskUsage() {
    const bodyEl = $('#disk-usage-body');
    if (!bodyEl) return;
    bodyEl.innerHTML = `<div class="disk-usage-loading">${escapeHtml(appT('disk.loading', 'Reading disk usage…'))}</div>`;
    try {
        const data = await API.getCacheStatus();
        renderDiskUsage(data);
    } catch (error) {
        bodyEl.innerHTML = `<div class="disk-usage-error">${escapeHtml(formatUserError(error, appT('disk.loadFailed', 'Failed to read disk usage')))}</div>`;
    }
}

function renderDiskUsage(data) {
    const bodyEl = $('#disk-usage-body');
    if (!bodyEl) return;
    const safe = Array.isArray(data?.safe_to_clean) ? data.safe_to_clean : [];
    const preserved = Array.isArray(data?.preserved) ? data.preserved : [];

    const safeRows = safe.map((entry) => {
        const sizeUnknown = entry.size_complete === false;
        const checked = entry.size_bytes > 0 ? 'checked' : '';
        const sizeText = sizeUnknown ? appT('disk.sizeNotFullyScanned', 'large / not fully scanned') : _formatBytes(entry.size_bytes);
        return `
            <label class="disk-cache-row" data-key="${escapeHtml(entry.key)}">
                <input type="checkbox" class="disk-cache-checkbox" data-key="${escapeHtml(entry.key)}" ${checked}>
                <span class="disk-cache-name">${escapeHtml(appT(entry.label_key, entry.key))}</span>
                <span class="disk-cache-size">${escapeHtml(sizeText)}</span>
                <span class="disk-cache-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>
            </label>
        `;
    }).join('');

    const preservedRows = preserved.map((entry) => {
        const sizeLabel = entry.size_complete === false
            ? appT('disk.sizeNotFullyScanned', 'large / not fully scanned')
            : _formatBytes(entry.size_bytes);
        const pathHtml = entry.path
            ? `<span class="disk-preserved-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>`
            : '';
        return `
            <div class="disk-preserved-row">
                <span class="disk-preserved-name">${escapeHtml(appT(entry.label_key, entry.key))}</span>
                <span class="disk-preserved-size">${escapeHtml(sizeLabel)}</span>
                ${pathHtml}
            </div>
        `;
    }).join('');

    const totalSafeComplete = safe.every(e => e.size_complete !== false);
    const totalSafe = totalSafeComplete
        ? safe.reduce((sum, e) => sum + Number(e.size_bytes || 0), 0)
        : null;
    const totalSafeText = totalSafeComplete
        ? _formatBytes(totalSafe)
        : appT('disk.sizeNotFullyScanned', 'large / not fully scanned');
    const hasCleanableSafe = safe.some(e => e.exists && (e.size_complete === false || Number(e.size_bytes || 0) > 0));
    const totalPreservedComplete = preserved.every(e => e.size_complete !== false);
    const totalPreserved = totalPreservedComplete
        ? preserved.reduce((sum, e) => sum + Number(e.size_bytes || 0), 0)
        : null;
    const totalPreservedText = totalPreservedComplete
        ? _formatBytes(totalPreserved)
        : appT('disk.sizeNotFullyScanned', 'large / not fully scanned');
    const thumbnailLimit = getThumbnailCacheSettings(data);
    const thumbnailStats = data?.thumbnail_cache || {};
    const runtime = data?.runtime_environment || {};
    const thumbnailSafeEntry = safe.find(entry => entry.key === 'thumbnails');
    const thumbnailSizeKnown = thumbnailStats.total_size_bytes != null || thumbnailSafeEntry?.size_complete !== false;
    const thumbnailCurrent = Number(thumbnailStats.total_size_bytes ?? thumbnailSafeEntry?.size_bytes ?? 0);
    const thumbnailCurrentText = thumbnailSizeKnown
        ? _formatBytes(thumbnailCurrent)
        : appT('disk.sizeNotFullyScanned', 'large / not fully scanned');
    const thumbnailLimitText = thumbnailLimit > 0
        ? appT('disk.thumbnailLimitStatus', '{current} used / {limit} limit', { current: thumbnailCurrentText, limit: `${thumbnailLimit} MB` })
        : appT('disk.thumbnailLimitDisabled', 'Persistent thumbnail cache is disabled.');
    const runtimeSizeKnown = runtime.venv_size_complete !== false;
    const runtimeSize = Number(runtime.venv_size_bytes || 0);
    const rebuildPending = Boolean(runtime.rebuild_core_pending);
    const runtimeStatusText = rebuildPending
        ? appT('disk.rebuildPending', 'Rebuild scheduled for next start')
        : runtimeSizeKnown
            ? appT('disk.runtimeSizeStatus', '{size} currently used', { size: _formatBytes(runtimeSize) })
            : appT('disk.runtimeSizeUnknownStatus', 'Large / not fully scanned');

    bodyEl.innerHTML = `
        <div class="disk-section disk-settings-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.thumbnailLimitTitle', 'Thumbnail cache limit'))}</strong>
                <span class="disk-section-total">${escapeHtml(thumbnailLimitText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.thumbnailLimitHint', 'Default is 500 MB. Lower values save disk space but may regenerate thumbnails more often. 0 disables persistent thumbnail caching. Original images are never deleted.'))}</p>
            <p class="disk-section-hint disk-tradeoff-hint">${escapeHtml(appT('disk.thumbnailTradeoffHint', 'Storage vs speed: lowering this limit saves disk, but scrolling large galleries can use more CPU/IO because thumbnails must be recreated.'))}</p>
            <div class="disk-setting-row">
                <label for="thumbnail-cache-limit-input">${escapeHtml(appT('disk.thumbnailLimitLabel', 'Max thumbnail cache'))}</label>
                <input id="thumbnail-cache-limit-input" class="input-field" type="number" min="0" max="102400" step="50" value="${escapeHtml(String(thumbnailLimit))}">
                <span class="disk-setting-unit">MB</span>
                <button class="btn btn-primary btn-small" id="btn-save-cache-settings">${escapeHtml(appT('disk.saveSettings', 'Save'))}</button>
            </div>
        </div>
        <div class="disk-section disk-runtime-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.runtimeTitle', 'Python runtime environment'))}</strong>
                <span class="disk-section-total">${escapeHtml(runtimeStatusText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.runtimeHint', 'If an old install already pulled heavy AI Python packages, schedule a lightweight rebuild. The next launcher start rebuilds only the Python runtime and reinstalls core dependencies; data, images.db, settings, models, and caches are kept.'))}</p>
            <div class="disk-actions">
                <button class="btn btn-ghost btn-small" id="btn-rebuild-core-runtime" ${rebuildPending ? 'disabled' : ''}>${escapeHtml(rebuildPending ? appT('disk.rebuildPendingButton', 'Rebuild scheduled') : appT('disk.rebuildCoreRuntime', 'Rebuild lightweight runtime on next start'))}</button>
            </div>
        </div>
        <div class="disk-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.safeToClean', 'Safe to clean'))}</strong>
                <span class="disk-section-total">${escapeHtml(totalSafeText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.safeHint', 'These caches will be regenerated as needed if you delete them.'))}</p>
            <div class="disk-cache-list">${safeRows || `<div class="disk-empty">${escapeHtml(appT('disk.nothingToClean', 'Nothing to clean.'))}</div>`}</div>
            <div class="disk-actions">
                <button class="btn btn-primary btn-small" id="btn-clean-caches" ${hasCleanableSafe ? '' : 'disabled'}>${escapeHtml(appT('disk.cleanSelected', 'Clean Selected'))}</button>
                <button class="btn btn-ghost btn-small" id="btn-refresh-disk-usage">${escapeHtml(appT('disk.refresh', 'Refresh'))}</button>
            </div>
        </div>
        <div class="disk-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.preserved', 'Preserved (do not delete)'))}</strong>
                <span class="disk-section-total">${escapeHtml(totalPreservedText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.preservedHint', 'These contain models, settings, or your personal data. The app will not delete them from this screen.'))}</p>
            <div class="disk-preserved-list">${preservedRows}</div>
        </div>
    `;

    $('#btn-refresh-disk-usage')?.addEventListener('click', () => {
        loadDiskUsage();
    });
    $('#btn-save-cache-settings')?.addEventListener('click', saveDiskSettings);
    $('#btn-rebuild-core-runtime')?.addEventListener('click', requestCoreRuntimeRebuild);
    $('#thumbnail-cache-limit-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveDiskSettings();
    });
    $('#btn-clean-caches')?.addEventListener('click', async () => {
        const checked = Array.from(bodyEl.querySelectorAll('.disk-cache-checkbox:checked')).map((el) => el.dataset.key);
        if (checked.length === 0) {
            showToast(appT('disk.selectAtLeastOne', 'Select at least one cache to clean.'), 'warning');
            return;
        }
        const runClean = async () => {
            const btn = $('#btn-clean-caches');
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = appT('disk.cleaning', 'Cleaning…');
            try {
                const result = await API.cleanCaches(checked);
                const cleaned = Array.isArray(result?.cleaned) ? result.cleaned : [];
                const errors = Array.isArray(result?.errors) ? result.errors : [];
                const totalFreed = cleaned.reduce((sum, e) => sum + Number(e.freed_bytes || 0), 0);
                if (errors.length > 0) {
                    showToast(appT('disk.cleanedWithErrors', 'Cleaned {freed}, but {count} item(s) had problems.', { freed: _formatBytes(totalFreed), count: errors.length }), 'warning');
                } else {
                    showToast(appT('disk.cleanedSuccess', 'Freed {freed} of disk space.', { freed: _formatBytes(totalFreed) }), 'success');
                }
                loadDiskUsage();
            } catch (error) {
                showToast(formatUserError(error, appT('disk.cleanFailed', 'Failed to clean caches')), 'error');
                btn.disabled = false;
                btn.textContent = original;
            }
        };
        const unknownEntries = checked
            .map((key) => safe.find((entry) => entry.key === key))
            .filter((entry) => entry?.size_complete === false);
        if (unknownEntries.length > 0) {
            const names = unknownEntries
                .map((entry) => appT(entry.label_key, entry.key))
                .join(', ');
            showConfirm(
                appT('disk.cleanUnknownConfirmTitle', 'Clean cache with unknown size?'),
                appT('disk.cleanUnknownConfirmBody', 'The app could not fully scan the size for: {items}. Clean anyway? Only selected app-owned caches will be emptied; images.db, settings, models, and original images are not deleted.', { items: names }),
                runClean
            );
            return;
        }
        await runClean();
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

        renderCheckpointFilterList(data.checkpoints || [], t);
        renderLoraFilterList(data.loras || [], t);

        updateFilterModalSummary();
    } catch (e) {
        Logger.error('Failed to load filter lists:', e);
        // Show error state in lists
        if (cpList) cpList.innerHTML = `<div class="filter-empty-state">${escapeHtml(t('filter.failedLoadCheckpoints', null, 'Failed to load checkpoints.'))}</div>`;
        if (loraList) loraList.innerHTML = `<div class="filter-empty-state">${escapeHtml(t('filter.failedLoadLoras', null, 'Failed to load LoRAs.'))}</div>`;
        updateFilterModalSummary();
    }
}

function renderCheckpointFilterList(checkpoints, t = appT) {
    const cpList = $('#modal-checkpoint-list');
    if (!cpList) return;
    const filterState = getFilterModalState();
    const selectedCheckpointValues = new Set(
        (filterState.checkpoints || []).map(normalizeCheckpointFilterValue).filter(Boolean)
    );
    const normalizedItems = [...(checkpoints || [])];
    const presentValues = new Set(normalizedItems.map(getCheckpointOptionValue).filter(Boolean));
    selectedCheckpointValues.forEach((checkpointValue) => {
        if (!presentValues.has(checkpointValue)) {
            normalizedItems.push({
                checkpoint: checkpointValue,
                checkpoint_normalized: checkpointValue,
                count: '✓',
            });
        }
    });
    cpList.innerHTML = normalizedItems.length > 0 ? normalizedItems.map(cp => `
        <label class="checkbox-label">
            <input type="checkbox" value="${escapeHtml(getCheckpointOptionValue(cp))}" ${selectedCheckpointValues.has(getCheckpointOptionValue(cp)) ? 'checked' : ''}>
            <span class="checkbox-custom"></span>
            <span class="checkbox-text">${escapeHtml(cp.checkpoint || getCheckpointOptionValue(cp))}</span>
            <span class="checkbox-count">${cp.count}</span>
        </label>
    `).join('') : `<div class="filter-empty-state">${escapeHtml(t('filter.noCheckpoints', null, 'No checkpoints found yet.'))}</div>`;
}

function renderLoraFilterList(loras, t = appT) {
    const loraList = $('#modal-lora-list');
    if (!loraList) return;
    const filterState = getFilterModalState();
    const normalizedItems = [...(loras || [])];
    const presentValues = new Set(normalizedItems.map(l => l.lora).filter(Boolean));
    (filterState.loras || []).forEach((lora) => {
        if (lora && !presentValues.has(lora)) {
            normalizedItems.push({ lora, count: '✓' });
        }
    });
    loraList.innerHTML = normalizedItems.length > 0 ? normalizedItems.map(l => `
        <label class="checkbox-label">
            <input type="checkbox" value="${escapeHtml(l.lora)}" ${filterState.loras?.includes(l.lora) ? 'checked' : ''}>
            <span class="checkbox-custom"></span>
            <span class="checkbox-text">${escapeHtml(l.lora)}</span>
            <span class="checkbox-count">${l.count}</span>
        </label>
    `).join('') : `<div class="filter-empty-state">${escapeHtml(t('filter.noLoras', null, 'No LoRAs found yet.'))}</div>`;
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
    const brightnessMin = parseFloat($('#filter-brightness-min')?.value) || null;
    const brightnessMax = parseFloat($('#filter-brightness-max')?.value) || null;
    const colorTemperature = $('input[name="color-temperature"]:checked')?.value || '';
    const brightnessDistribution = $('input[name="brightness-distribution"]:checked')?.value || '';
    const colorCount = [brightnessMin, brightnessMax].filter(Boolean).length + (colorTemperature ? 1 : 0) + (brightnessDistribution ? 1 : 0);

    setCount('filter-modal-count-generators', `${generatorCount}/${generatorTotal}`);
    setCount('filter-modal-count-ratings', `${ratingCount}/${ratingTotal}`);
    setCount('filter-modal-count-tags', String(tagCount));
    setCount('filter-modal-count-prompts', String(promptCount));
    setCount('filter-modal-count-checkpoints', String(checkpointCount));
    setCount('filter-modal-count-loras', String(loraCount));
    setCount('filter-modal-count-dimensions', dimensionCount > 0 ? String(dimensionCount) : t('filter.any', null, 'Any'));
    setCount('filter-modal-count-colors', colorCount > 0 ? String(colorCount) : t('filter.any', null, 'Any'));

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
        dimensionCount > 0,
        colorCount > 0
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
                .slice(0, FACET_SUGGESTION_LIMIT);

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

        const result = await API.getTagsLibrary('frequency', {
            query,
            limit: FACET_SUGGESTION_LIMIT,
        });
        const filtered = result.tags || [];

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
                .slice(0, FACET_SUGGESTION_LIMIT);

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
                        const normalize = s => s.toLowerCase().replace(/_/g, ' ').trim();
                        const normalizedExisting = filterState.prompts.map(normalize);
                        if (!normalizedExisting.includes(normalize(prompt))) {
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

        const result = await API.getPromptsLibrary({
            query,
            limit: FACET_SUGGESTION_LIMIT,
        });
        const filtered = result.prompts || [];

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
                const normalize = s => s.toLowerCase().replace(/_/g, ' ').trim();
                const normalizedExisting = filterState.prompts.map(normalize);
                if (!normalizedExisting.includes(normalize(prompt))) {
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
    const promptMatchRadio = $('input[name="prompt-match-mode"]:checked');
    filterState.promptMatchMode = normalizePromptMatchMode(promptMatchRadio?.value);
    const tagModeRadio = $('input[name="tag-match-mode"]:checked');
    filterState.tagMode = tagModeRadio?.value || 'and';

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

    const brightnessMin = parseFloat($('#filter-brightness-min')?.value) || null;
    const brightnessMax = parseFloat($('#filter-brightness-max')?.value) || null;
    const colorTemperatureRadio = $('input[name="color-temperature"]:checked');
    const brightnessDistributionRadio = $('input[name="brightness-distribution"]:checked');
    filterState.brightnessMin = brightnessMin;
    filterState.brightnessMax = brightnessMax;
    filterState.colorTemperature = colorTemperatureRadio ? colorTemperatureRadio.value : '';
    filterState.brightnessDistribution = brightnessDistributionRadio ? brightnessDistributionRadio.value : '';

    const committedFilters = commitFilterModalState(filterState);

    hideModal('filter-modal');

    if (FilterModalController.onApply) {
        FilterModalController.onApply(cloneFilterState(committedFilters));
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
    filterState.promptMatchMode = 'exact';
    $$('input[name="prompt-match-mode"]').forEach(radio => {
        radio.checked = radio.value === 'exact';
    });
    const freeTextSearch = $('#modal-free-text-search');
    if (freeTextSearch) freeTextSearch.value = '';
    // Reset aesthetic inputs
    const minAeInput = $('#filter-aesthetic-min');
    const maxAeInput = $('#filter-aesthetic-max');
    if (minAeInput) minAeInput.value = '';
    if (maxAeInput) maxAeInput.value = '';
    const brightnessMinInput = $('#filter-brightness-min');
    const brightnessMaxInput = $('#filter-brightness-max');
    if (brightnessMinInput) brightnessMinInput.value = '';
    if (brightnessMaxInput) brightnessMaxInput.value = '';
    $$('input[name="color-temperature"]').forEach(r => r.checked = r.value === '');
    $$('input[name="brightness-distribution"]').forEach(r => r.checked = r.value === '');
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

    const committedFilters = commitFilterModalState(filterState);
    hideModal('filter-modal');

    if (FilterModalController.onReset) {
        FilterModalController.onReset(cloneFilterState(committedFilters));
        showToast(appT('filter.clearedToast', 'Filters cleared'), 'success');
        resetFilterModalController();
        return;
    }

    updateFilterSummary();
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
        ...cloneFilterState(AppState.filters),
        promptMatchMode: normalizePromptMatchMode(AppState.filters.promptMatchMode),
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

    // Apply preset via shared filter setter so FilterStore stays in sync.
    setAppFilters({
        ...AppState.filters,
        ...preset,
    });

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
    updateAppFilters((filters) => {
        filters.artist = null;
    });
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
            ...cloneFilterState(AppState.filters),
            promptMatchMode: normalizePromptMatchMode(AppState.filters.promptMatchMode),
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

    const colorSummary = $('#summary-colors');
    if (colorSummary) {
        colorSummary.removeAttribute('data-i18n');
        colorSummary.textContent = summary.colors || appT('filter.any', 'Any');
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
    if (_scanLastProgress) {
        _updateBgScanProgress(_scanLastProgress);
        updateScanDiagnosticsCard(_scanLastProgress);
        const scanCancelButton = $('#btn-cancel-scan');
        if (scanCancelButton?.dataset.liveLabel === '1') {
            setScanCancelButtonState(_scanLastProgress.status === 'cancelling' ? 'cancelling' : 'running');
        }
    }
    refreshLocalizedImageCount();
    updateFilterSummary();
    updateSelectionUI();
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
    syncTaggerModelUi({ applyModelDefaults: false });
    window.Gallery?.refreshLocalizedContent?.();
}

// ============== Initialization ==============

// Global keyboard shortcuts for gallery navigation
// ============== Gallery Drag-and-Drop Import ==============

function initGalleryDropZone() {
    const galleryView = document.getElementById('view-gallery');
    if (!galleryView) return;

    let overlay = document.getElementById('gallery-drop-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gallery-drop-overlay';
        overlay.className = 'gallery-drop-overlay';
        overlay.innerHTML = `
            <div class="gallery-drop-overlay-content">
                <span class="gallery-drop-overlay-icon" aria-hidden="true">📂</span>
                <span class="gallery-drop-overlay-text">${escapeHtml(appT('gallery.dropToImport', 'Drop folder or images to import'))}</span>
                <span class="gallery-drop-overlay-hint">${escapeHtml(appT('gallery.dropHint', 'Images will be imported from the dropped folder'))}</span>
            </div>`;
        galleryView.appendChild(overlay);
    }

    let dragCounter = 0;

    galleryView.addEventListener('dragenter', (e) => {
        if (AppState.currentView !== 'gallery') return;
        if (!_hasFolderOrImageFiles(e)) return;
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) overlay.classList.add('visible');
    });

    galleryView.addEventListener('dragover', (e) => {
        if (AppState.currentView !== 'gallery') return;
        if (!_hasFolderOrImageFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    galleryView.addEventListener('dragleave', (e) => {
        if (AppState.currentView !== 'gallery') return;
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            overlay.classList.remove('visible');
        }
    });

    galleryView.addEventListener('drop', (e) => {
        if (AppState.currentView !== 'gallery') return;
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('visible');
        _handleGalleryDrop(e);
    });
}

function _hasFolderOrImageFiles(e) {
    if (!e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    return types && (types.includes('Files') || types.indexOf('Files') >= 0);
}

async function _handleGalleryDrop(e) {
    const items = e.dataTransfer.items;
    const files = e.dataTransfer.files;
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif']);

    let isFolder = false;
    let folderName = '';

    if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry?.() || items[i].getAsEntry?.();
            if (entry && entry.isDirectory) {
                isFolder = true;
                folderName = entry.name || '';
                break;
            }
        }
    }

    if (isFolder) {
        _handleFolderDrop(folderName, files);
        return;
    }

    if (files && files.length > 0) {
        const imageFiles = Array.from(files).filter(f =>
            IMAGE_TYPES.has(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)
        );
        if (imageFiles.length > 0) {
            _handleImageFilesDrop(imageFiles);
            return;
        }
    }

    showModal('scan-modal');
}

async function _handleFolderDrop(folderName, files) {
    const droppedFiles = [];
    if (files && files.length > 0) {
        for (let i = 0; i < Math.min(files.length, 5); i++) {
            if (files[i].name) {
                droppedFiles.push({ name: files[i].name, size: files[i].size || 0 });
            }
        }
    }

    try {
        const result = await API.resolveDrop(folderName, droppedFiles);
        if (result?.folder_path) {
            _openScanWithPath(result.folder_path);
            return;
        }
    } catch (_) { /* fallback below */ }

    showModal('scan-modal');
    const input = document.getElementById('scan-folder-path');
    if (input && folderName) {
        input.value = folderName;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    showToast(
        appT('gallery.dropHintBrowse', 'Could not locate the full path for "{name}". Please browse or complete the path.')
            .replace('{name}', folderName || (droppedFiles[0]?.name) || ''),
        'warning'
    );
}

async function _handleImageFilesDrop(imageFiles) {
    showToast(
        appT('gallery.importingDropped', 'Importing {count} images...')
            .replace('{count}', String(imageFiles.length)),
        'info'
    );
    try {
        const result = await API.importFiles(imageFiles);
        const imported = result?.imported || 0;
        const errors = result?.errors || 0;
        if (imported > 0) {
            showToast(
                appT('gallery.importedDropped', 'Imported {count} images into gallery')
                    .replace('{count}', String(imported))
                    + (errors > 0 ? ` (${errors} failed)` : ''),
                'success'
            );
            await loadStats();
            await loadImages();
        } else {
            showToast(appT('gallery.importDroppedFailed', 'No images could be imported'), 'warning');
        }
    } catch (error) {
        showToast(formatUserError(error, appT('gallery.importDroppedError', 'Failed to import dropped images')), 'error');
    }
}

function _openScanWithPath(folderPath) {
    showModal('scan-modal');
    const input = document.getElementById('scan-folder-path');
    if (input) {
        input.value = folderPath;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    showToast(appT('gallery.dropFolderDetected', 'Folder detected: {path}').replace('{path}', folderPath), 'info');
}

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
            if (getSelectedGalleryCount() > 0) {
                e.preventDefault();
                clearSelectedIds({ scope: 'visible' });
                updateSelectionUI();
                emitSelectionStateChanged();
                if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
                    Gallery.syncSelectionState();
                }
                showToast(appT('gallery.selectionCleared', 'Selection cleared'), 'info');
            }
        }
        // Delete - Remove from gallery only; permanent disk delete stays behind the explicit dangerous button.
        else if (e.key === 'Delete') {
            if (getSelectedGalleryCount() > 0) {
                e.preventDefault();
                removeSelectedGalleryImages();
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initMissingFilterMarkup();
    initEventListeners();
    initInputModal();

    // Add pulse indicator to Setup button if user has never clicked it
    if (!localStorage.getItem('sd-image-sorter-setup-clicked')) {
        const setupBtn = $('#btn-open-model-manager');
        if (setupBtn) setupBtn.classList.add('setup-pulse');
    }
    initGlobalKeyboardShortcuts();
    initGalleryDropZone();
    loadTaggerModels();
    setTaggingUiState(false);
    setGalleryViewMode(AppState.viewMode);
    updateSortReverseButton();
    syncGallerySortLabels();
    switchView('gallery');
    loadStats();
    const aestheticStatusReady = refreshAestheticStatus();
    updateFilterSummary();
    updateSelectionUI();
    resumeScanProgress();
    resumeReconnectProgress();
    resumeTaggingProgress();
    _initBgTagProgressButtons();
    _initBgScanProgressButtons();
    _initBgReconnectProgressButtons();
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
    Promise.resolve(aestheticStatusReady).finally(() => {
        document.documentElement.dataset.appReady = '1';
        window.dispatchEvent(new Event('sd-image-sorter-ready'));
    });
});

function normalizeCensorQueueSource(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
    }

    const selectionToken = String(source.selectionToken || source.selection_token || '').trim();
    if (!selectionToken) return null;

    return {
        selectionToken,
        total: Math.max(0, Number(source.total ?? source.selectionTotal ?? source.selection_total ?? 0) || 0),
        exactTotal: source.exactTotal !== false && source.exact_total !== false,
        filterKey: typeof source.filterKey === 'string' ? source.filterKey : null,
        visibleImageIds: normalizeSelectionImageIds(source.visibleImageIds || source.visible_image_ids || []),
    };
}

function addToCensorQueue(imageIds = [], options = {}) {
    const tokenSource = normalizeCensorQueueSource(imageIds);
    const queuePayload = tokenSource || Array.from(
        new Set(
            (Array.isArray(imageIds) ? imageIds : [imageIds])
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value) && value > 0)
        )
    );

    if (typeof window.initCensorEdit === 'function') {
        window.initCensorEdit();
    }

    const runtimeHandler = window.CensorEdit?.addToQueue;
    if (typeof runtimeHandler === 'function') {
        return runtimeHandler(queuePayload, options);
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


async function openSimilarFromImage(imageId) {
    const normalizedId = Number(imageId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
        return false;
    }

    switchView('similar');
    if (typeof window.initSimilar === 'function') {
        window.initSimilar();
    }
    const input = $('#similar-search-id');
    if (input) input.value = String(normalizedId);
    if (window.SimilarImages?.searchByImage) {
        window.SimilarImages.searchByImage(normalizedId);
        return true;
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
        emitSelectionStateChanged,
        getSelectedGalleryCount,
        isFilteredSelectionActiveForCurrentFilters,
        showConfirm,
        showRandomImage,
        showAnalytics,
        showExportModal,
        showExportTagsModal,
        moveOrCopyGalleryImages,
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
        normalizePromptMatchMode,
        createDefaultFilterState,
        cloneFilterState,
        copyFilterState,
        buildSelectionFilterRequest,
        getSelectionFilterCacheKey,
        buildAdvancedFilterContract,
        getAdvancedFilterContractSignature,
        normalizeCheckpointFilterValue,
        FilterStore: AppFilterStore,
        setFilters: setAppFilters,
        updateFilters: updateAppFilters,
        createDefaultSelectionState,
        cloneSelectionState,
        SelectionStore: AppSelectionStore,
        setSelectionState,
        updateSelectionState,
        mutateSelectedIds,
        clearSelectedIds,
        setSelectionMode,
        updateSortReverseButton,
        syncGallerySortLabels,
        formatGeneratorLabel,
        loadSelectionData,
        loadSelectionDataByToken,
        resetSelectionDataCache,
        markGalleryNeedsRefresh,
        openTagsLibrary,
        switchLibraryTab,
        filterLibraryContent,
        switchView,
        openGalleryPreview,
        applyPromptFilter,
        addToCensorQueue,
        sendToCensor: addToCensorQueue,
        openPromptBuildFromImage,
        openReaderFromImage,
        openSimilarFromImage,
        deleteGalleryImagesByIds,
        removeGalleryImagesByIds,
        addRecentFolder,
        getRecentFolders,
        updateScanDiagnosticsCard,
        copyScanDiagnostics,
        openScanLogFile,
        clampTaggerChunkToAvailableOption,
        $,
        $$
    };
}

// Export for other modules
window.App = buildAppContext();
Object.seal(window.App);
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
