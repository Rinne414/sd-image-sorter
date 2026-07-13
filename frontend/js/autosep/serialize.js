/**
 * autosep/serialize.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 490-547: serializeAutoSepFilters — the full v3.3.x gallery-scope
 * shape (the nine scope keys are pinned by test_frontend_contract's
 * sorting-payloads test; the same keys recur on purpose in preview.js and
 * move-progress.js — do not DRY) — and buildAutoSepFilterContract.
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
        folder: source.folder ? String(source.folder).trim() : null,
        hasMetadata: typeof source.hasMetadata === 'boolean' ? source.hasMetadata : null,
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

