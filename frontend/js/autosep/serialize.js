/**
 * autosep/serialize.js — autosep.js decomposition (from frontend/js/autosep.js,
 * pre-split lines 490-547; buildAutoSepScopeFilters added 2026-09-30):
 * serializeAutoSepFilters — the full Gallery filter shape (every key is checked
 * by test_filter_scope_parity; the same keys recur on purpose in preview.js) —
 * buildAutoSepScopeFilters (the bundle move-progress.js sends) and
 * buildAutoSepFilterContract.
 * Classic script: loads after autosep/state-constants.js (base).
 */
function serializeAutoSepFilters(filters) {
    const source = filters || {};
    return {
        generators: [...(source.generators || ['comfyui', 'nai', 'webui', 'forge', 'unknown'])],
        ratings: [...(source.ratings || ['general', 'sensitive', 'questionable', 'explicit'])],
        tags: [...(source.tags || [])],
        tagMode: source.tagMode === 'or' || source.tag_mode === 'or' ? 'or' : 'and',
        checkpoints: [...(source.checkpoints || [])],
        loras: [...(source.loras || [])],
        prompts: [...(source.prompts || [])],
        promptMatchMode: normalizeAutoSepPromptMatchMode(source.promptMatchMode || source.prompt_match_mode),
        artist: source.artist || null,
        search: source.search || '',
        minWidth: source.minWidth ?? null,
        maxWidth: source.maxWidth ?? null,
        minHeight: source.minHeight ?? null,
        maxHeight: source.maxHeight ?? null,
        aspectRatio: source.aspectRatio || '',
        minAesthetic: source.minAesthetic ?? null,
        maxAesthetic: source.maxAesthetic ?? null,
        // v3.2.2 per-item exclude filters
        excludeTags: [...(source.excludeTags || [])],
        excludeGenerators: [...(source.excludeGenerators || [])],
        excludeRatings: [...(source.excludeRatings || [])],
        excludeCheckpoints: [...(source.excludeCheckpoints || [])],
        excludeLoras: [...(source.excludeLoras || [])],
        // v3.3.x gallery-scope parity: these fields were silently dropped when
        // copying AppState.filters, so "Copy from Gallery" produced a WIDER
        // move/copy scope than the gallery displayed (collection/folder/
        // star-rating/exclude-prompts/colors/brightness lost). Keep this list
        // in sync with App.buildSelectionFilterRequest (app.js).
        excludePrompts: [...(source.excludePrompts || [])],
        excludeColors: [...(source.excludeColors || [])],
        minUserRating: source.minUserRating ?? null,
        brightnessMin: source.brightnessMin ?? null,
        brightnessMax: source.brightnessMax ?? null,
        colorTemperature: source.colorTemperature || '',
        brightnessDistribution: source.brightnessDistribution || '',
        collectionId: source.collectionId ?? null,
        scope: 'library',
        folder: source.folder ? String(source.folder).trim() : null,
        hasMetadata: typeof source.hasMetadata === 'boolean' ? source.hasMetadata : null,
        // Hue, Aurora Phase 3 and file-date filters: dropped here before, so a
        // move touched more pictures than the gallery showed.
        colorHues: [...(source.colorHues || [])],
        excludeColorHues: [...(source.excludeColorHues || [])],
        noCaption: source.noCaption === true ? true : null,
        aestheticUnscored: source.aestheticUnscored === true ? true : null,
        minSaturation: source.minSaturation ?? null,
        maxSaturation: source.maxSaturation ?? null,
        seed: source.seed !== null && source.seed !== '' && Number.isFinite(Number(source.seed))
            ? Number(source.seed)
            : null,
        dateFrom: source.dateFrom || null,
        dateTo: source.dateTo || null,
    };
}

// The gallery-scope keys API.batchMove takes as one bundle (every filter that
// is not one of its positional arguments).
function buildAutoSepScopeFilters(contract) {
    return {
        excludePrompts: contract.excludePrompts,
        excludeColors: contract.excludeColors,
        minUserRating: contract.minUserRating,
        brightnessMin: contract.brightnessMin,
        brightnessMax: contract.brightnessMax,
        colorTemperature: contract.colorTemperature,
        brightnessDistribution: contract.brightnessDistribution,
        collectionId: contract.collectionId,
        scope: contract.scope,
        folder: contract.folder,
        hasMetadata: contract.hasMetadata,
        colorHues: contract.colorHues,
        excludeColorHues: contract.excludeColorHues,
        noCaption: contract.noCaption,
        aestheticUnscored: contract.aestheticUnscored,
        minSaturation: contract.minSaturation,
        maxSaturation: contract.maxSaturation,
        seed: contract.seed,
        dateFrom: contract.dateFrom,
        dateTo: contract.dateTo,
    };
}

function buildAutoSepFilterContract(filters) {
    const source = serializeAutoSepFilters(filters);
    const normalizeCheckpoint = window.App?.normalizeCheckpointFilterValue;
    const checkpoints = Array.isArray(source.checkpoints) ? source.checkpoints : [];
    return {
        ...source,
        checkpoints: checkpoints
            .map((value) => typeof normalizeCheckpoint === 'function' ? normalizeCheckpoint(value) : String(value || '').trim())
            .filter(Boolean),
        artist: source.artist ? String(source.artist).trim() : null,
        search: source.search || '',
    };
}

