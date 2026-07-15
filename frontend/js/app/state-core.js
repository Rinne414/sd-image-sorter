/**
 * app/state-core.js — app.js decomposition, stage 4 (the state core).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, pre-split
 * lines 6-332: FilterModalController, saved-filter hydration, store creation +
 * window handles (AppFilterStore/AppSelectionStore/AppFilterAccess), AppState,
 * both store subscriptions and the state setters. ONE load-time EXEC chunk —
 * do not split. Classic script: loads after app/api-features.js, before app.js.
 */
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
        const selectionTotal = Number(state.selectionTotal);
        return {
            selectedIds: state.selectedIds,
            scope: state.scope,
            filterKey: state.filterKey || null,
            selectionToken: state.selectionToken || null,
            selectionTotal: Number.isFinite(selectionTotal) ? Math.max(0, selectionTotal) : 0,
            selectionTokenPending: typeof isFilteredSelectionTokenRefreshPending === 'function'
                ? isFilteredSelectionTokenRefreshPending()
                : false,
        };
    },
    getActiveSelectionToken() {
        const state = AppSelectionStore?.getState?.();
        if (!state || state.scope !== 'filtered' || !state.selectionToken) return null;
        const tokenPending = typeof isFilteredSelectionTokenRefreshPending === 'function'
            && isFilteredSelectionTokenRefreshPending();
        if (tokenPending) return null;
        const selectionTotal = Number(state.selectionTotal);
        if (!Number.isFinite(selectionTotal) || selectionTotal <= 0) return null;
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
        const selectionTotal = Number(state?.selectionTotal);
        return Number.isFinite(selectionTotal) ? Math.max(0, selectionTotal) : 0;
    },
    /** Returns only explicitly selected IDs already held by the UI. */
    getSelectedImageIds() {
        const state = AppSelectionStore?.getState?.();
        if (!state) return [];
        if (state.scope === 'filtered' && state.selectionToken) return [];
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
        if (filters.dateFrom) params.set('date_from', filters.dateFrom);
        if (filters.dateTo) params.set('date_to', filters.dateTo);
        if (filters.minAesthetic) params.set('min_aesthetic', filters.minAesthetic);
        if (filters.maxAesthetic) params.set('max_aesthetic', filters.maxAesthetic);
        if (filters.minUserRating) params.set('min_user_rating', filters.minUserRating);
        if (filters.brightnessMin) params.set('brightness_min', filters.brightnessMin);
        if (filters.brightnessMax) params.set('brightness_max', filters.brightnessMax);
        if (filters.colorTemperature) params.set('color_temperature', filters.colorTemperature);
        if (filters.colorHues?.length) params.set('color_hues', filters.colorHues.join(','));
        if (filters.excludeColorHues?.length) params.set('exclude_color_hues', filters.excludeColorHues.join(','));
        if (filters.brightnessDistribution) params.set('brightness_distribution', filters.brightnessDistribution);
        // v3.2.2 per-item exclude filters
        if (filters.excludeTags?.length) params.set('exclude_tags', filters.excludeTags.join(','));
        if (filters.excludeGenerators?.length) params.set('exclude_generators', filters.excludeGenerators.join(','));
        if (filters.excludeRatings?.length) params.set('exclude_ratings', filters.excludeRatings.join(','));
        if (filters.excludeCheckpoints?.length) params.set('exclude_checkpoints', filters.excludeCheckpoints.join(','));
        if (filters.excludeLoras?.length) params.set('exclude_loras', filters.excludeLoras.join(','));
        if (filters.excludePrompts?.length) params.set('exclude_prompts', filters.excludePrompts.join(','));
        if (filters.excludeColors?.length) params.set('exclude_colors', filters.excludeColors.join(','));
        if (filters.folder) params.set('folder', filters.folder);
        if (filters.hasMetadata != null) params.set('has_metadata', String(filters.hasMetadata));
        // Aurora Phase 3 toolbar/24d filters
        if (filters.noCaption === true) params.set('no_caption', 'true');
        if (filters.aestheticUnscored === true) params.set('aesthetic_unscored', 'true');
        if (filters.minSaturation != null) params.set('min_saturation', filters.minSaturation);
        if (filters.maxSaturation != null) params.set('max_saturation', filters.maxSaturation);
        if (filters.seed != null) params.set('seed', filters.seed);
        return params;
    },
};

// App State
const AppState = {
    currentView: 'gallery',
    viewMode: localStorage.getItem(GALLERY_VIEW_MODE_KEY) || 'grid',
    images: [],
    // cloneFilterState normalizes snapshots persisted by OLDER builds: any
    // list/scalar field added since (e.g. colorHues) gets its default instead
    // of being undefined and crashing list operations downstream.
    filters: AppFilterStore ? AppFilterStore.getState() : cloneFilterState(savedFilters || createDefaultFilterState()),
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
        channel: null,
        channelError: null,
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
        // Keep the gallery-header aspect quick-toggle (FE-7) in sync with the
        // single source of truth, regardless of what changed aspectRatio.
        if (typeof syncAspectToggleWithFilters === 'function') {
            syncAspectToggleWithFilters();
        }
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

