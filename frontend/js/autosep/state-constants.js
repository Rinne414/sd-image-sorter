/**
 * autosep/state-constants.js — autosep.js decomposition (the base).
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 1-43: the module header, _previewRequestId/_autosepPreviewTimer, the
 * five AUTOSEP_*_KEY storage keys, the preview/overflow fetch limits,
 * AUTOSEP_PROMPT_MATCH_MODES, DEFAULT_AUTOSEP_SETTINGS (operationMode 'copy'
 * — Principle #11 + the release-build copy-default pin, ADR comment kept
 * verbatim) and the AutoSepState session object — the lexical-const base
 * every other family file reads at runtime. Classic script: one shared
 * global lexical env; this tag loads FIRST in the family.
 */
/**
 * SD Image Sorter - Auto-Separate Module
 * Handles batch filtering and moving of images
 */

let _previewRequestId = 0;
let _autosepPreviewTimer = null;
const AUTOSEP_SETTINGS_KEY = 'autosep_settings_v1';
const AUTOSEP_DESTINATION_KEY = 'autosep_destination_v1';
const AUTOSEP_CONFIGS_KEY = 'autosep_configs_v1';
const AUTOSEP_FILTER_STATE_KEY = 'autosep_filter_state_v1';
const AUTOSEP_SCOPE_META_KEY = 'autosep_scope_meta_v1';
const AUTOSEP_PREVIEW_FETCH_LIMIT = 200;
const AUTOSEP_OVERFLOW_PAGE_SIZE = 200;
const AUTOSEP_PROMPT_MATCH_MODES = new Set(['exact', 'contains']);

const DEFAULT_AUTOSEP_SETTINGS = {
    rememberDestination: true,
    autoPreview: false,
    confirmBeforeMove: true,
    // Default to ``copy`` so first-time users do not destructively move files
    // before they understand the workflow. Locked by Principle #11 in
    // docs/AI_PRINCIPLES.md and the corresponding ADR.
    operationMode: 'copy',
};

const AutoSepState = {
    matchCount: 0,
    previewImages: [],
    previewSignature: null,
    overflowImages: [],
    overflowSignature: null,
    overflowNextCursor: null,
    overflowHasMore: false,
    overflowLoading: false,
    settings: { ...DEFAULT_AUTOSEP_SETTINGS },
    configs: [],
    filters: null,
    hasSavedFilterState: false,
    inheritedCurrentGalleryFilters: false,
    scopeMeta: null,
};

