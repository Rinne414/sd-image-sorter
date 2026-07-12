/**
 * app/filter-state.js — app.js decomposition, stage 2 (leaf sections).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js,
 * pre-split lines 250-500. Classic script: shares ONE global lexical
 * environment with app.js and the other app/ parts; index.html loads
 * every app/ file BEFORE app.js, so these top-level declarations stay
 * visible there. No behavior change intended.
 */
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
        dateFrom: null,
        dateTo: null,
        minUserRating: null,
        brightnessMin: null,
        brightnessMax: null,
        colorTemperature: '',
        brightnessDistribution: '',
        excludeTags: [],
        excludeGenerators: [],
        excludeRatings: [],
        excludeCheckpoints: [],
        excludeLoras: [],
        excludePrompts: [],
        excludeColors: [],
        colorHues: [],
        excludeColorHues: [],
        folder: null,
        hasMetadata: null,
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
        dateFrom: source.dateFrom ?? null,
        dateTo: source.dateTo ?? null,
        minUserRating: source.minUserRating ?? null,
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
        excludePrompts: [...(source.excludePrompts || [])],
        excludeColors: [...(source.excludeColors || [])],
        colorHues: [...(source.colorHues || [])],
        excludeColorHues: [...(source.excludeColorHues || [])],
        collectionId: source.collectionId ?? null,
        folder: source.folder ? String(source.folder).trim() : null,
        hasMetadata: typeof source.hasMetadata === 'boolean' ? source.hasMetadata : null,
        // Aurora Phase 3 toolbar/24d filters
        noCaption: source.noCaption === true ? true : null,
        aestheticUnscored: source.aestheticUnscored === true ? true : null,
        minSaturation: source.minSaturation ?? null,
        maxSaturation: source.maxSaturation ?? null,
        seed: source.seed ?? null,
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
        dateFrom: source.dateFrom ?? null,
        dateTo: source.dateTo ?? null,
        minUserRating: source.minUserRating ?? null,
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
        excludePrompts: [...(source.excludePrompts || [])],
        excludeColors: [...(source.excludeColors || [])],
        colorHues: [...(source.colorHues || [])],
        excludeColorHues: [...(source.excludeColorHues || [])],
        collectionId: source.collectionId ?? null,
        folder: source.folder ? String(source.folder).trim() : null,
        hasMetadata: typeof source.hasMetadata === 'boolean' ? source.hasMetadata : null,
        // Aurora Phase 3 toolbar/24d filters
        noCaption: source.noCaption === true ? true : null,
        aestheticUnscored: source.aestheticUnscored === true ? true : null,
        minSaturation: source.minSaturation ?? null,
        maxSaturation: source.maxSaturation ?? null,
        seed: source.seed ?? null,
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
        dateFrom: request.dateFrom ?? null,
        dateTo: request.dateTo ?? null,
        minUserRating: request.minUserRating ?? null,
        brightnessMin: request.brightnessMin ?? null,
        brightnessMax: request.brightnessMax ?? null,
        colorTemperature: request.colorTemperature || '',
        brightnessDistribution: request.brightnessDistribution || '',
        excludeTags: request.excludeTags,
        excludeGenerators: request.excludeGenerators,
        excludeRatings: request.excludeRatings,
        excludeCheckpoints: request.excludeCheckpoints,
        excludeLoras: request.excludeLoras,
        excludePrompts: request.excludePrompts,
        excludeColors: request.excludeColors,
        colorHues: request.colorHues,
        excludeColorHues: request.excludeColorHues,
        collectionId: request.collectionId ?? null,
        folder: request.folder || null,
        hasMetadata: request.hasMetadata ?? null,
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

