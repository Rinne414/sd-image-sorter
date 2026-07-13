/**
 * manual-sort/state-constants.js — manual-sort.js decomposition (the base).
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 1-94: the ManualSortState session-state object, every
 * MANUAL_SORT_* storage-key const, MANUAL_SORT_MODES / MANUAL_SORT_SLOT_KEYS,
 * MAX_MINIMAP_IMAGES, the prompt-match mode set, KEY_MAP and DIRECTION_MAP —
 * the lexical-const base every other family file reads at runtime. Classic
 * script: one shared global lexical env; this tag loads FIRST in the family.
 */
/**
 * SD Image Sorter - Manual Sort Module
 * Rhythm-game style keyboard-driven image sorting
 */

const ManualSortState = {
    active: false,
    isProcessing: false,  // Lock to prevent race conditions during rapid keypresses
    currentImage: null,
    currentTags: [],
    folders: { w: '', a: '', s: '', d: '' },
    // v3.3.1: per-slot collection ids ({ key: collectionId|null }). A slot with
    // a non-null id is "collection-typed": pressing it adds the current image to
    // that collection by reference (no file move) instead of moving the file.
    collectionSlots: { w: null, a: null, s: null, d: null },
    collectionsCache: [],
    operationMode: 'copy',
    index: 0,
    total: 0,
    combo: 0,
    lastActionTime: 0,
    history: [],
    images: [],  // For gallery preview
    // Enhanced tracking
    sortedCount: 0,
    skippedCount: 0,
    undoAvailable: false,
    redoAvailable: false,
    startTime: null,
    actionTimestamps: [],  // For speed calculation
    filters: null,
    hasSavedFilterState: false,
    inheritedCurrentGalleryFilters: false,
    scopeMeta: null,
    resumeBannerSessionSnapshot: null,
    // v3.3.0 USR-4: optional action cooldown (opt-in, default OFF). When > 0,
    // presses within the window after the previous action completes are
    // ignored so an autoclicker can't fire a chaotic burst. lastActionCompletedAt
    // is set in the finally block of performMove/performSkip.
    actionCooldownMs: 0,
    lastActionCompletedAt: 0,
    // v3.3.2 WB-S3: active session mode. "slot" = WASD folder sort (default);
    // "bracket" = A/B king-of-the-hill culling. Set from the server's
    // result.mode so a resumed session renders the right interface.
    mode: 'slot',
};

const MANUAL_SORT_COOLDOWN_KEY = 'manual_sort_cooldown_ms_v1';
// v3.3.2 WB-S3: remembers the mode chosen in the setup screen across reloads.
const MANUAL_SORT_MODE_KEY = 'manual_sort_mode_v1';
const MANUAL_SORT_MODES = new Set(['slot', 'bracket', 'cull']);
// v3.3.2 WB-S6: remembers the A/B Showdown winner destination ('' none,
// 'fav' Favorites, or a collection id).
const MANUAL_SORT_BRACKET_WINNER_KEY = 'manual_sort_bracket_winner_v1';
// v3.3.2 FF-1: remembers the 留/汰 cull keep/reject destinations (same value
// space as the bracket winner: '' none, 'fav' Favorites, or a collection id).
const MANUAL_SORT_CULL_KEEP_KEY = 'manual_sort_cull_keep_v1';
const MANUAL_SORT_CULL_REJECT_KEY = 'manual_sort_cull_reject_v1';

const MANUAL_SORT_FILTER_STATE_KEY = 'manual_sort_filter_state_v1';
const MANUAL_SORT_SCOPE_META_KEY = 'manual_sort_scope_meta_v1';
const MANUAL_SORT_OPERATION_MODE_KEY = 'manual_sort_operation_mode_v1';
// v3.3.1: persists per-slot collection assignments ({ key: collectionId|null }).
const MANUAL_SORT_SLOT_COLLECTIONS_KEY = 'manual_sort_slot_collections_v1';
const MANUAL_SORT_SLOT_KEYS = ['w', 'a', 's', 'd'];
// Aurora Phase 3 Slice 2 — Sort enhancements.
// Focus (zen) mode preference: collapse the app chrome during a slot session.
const MANUAL_SORT_ZEN_KEY = 'manual_sort_zen_v1';
// Named full-config presets (folders + collection slots + slot layout + mode +
// action + filters). Array of { name, savedAt, mode, operationMode, filters,
// collectionSlots, folders }.
const MANUAL_SORT_PRESETS_KEY = 'manual_sort_presets_v1';
const MAX_MINIMAP_IMAGES = 1000;
const MANUAL_SORT_PROMPT_MATCH_MODES = new Set(['exact', 'contains']);

// Key mappings
const KEY_MAP = {
    'w': 'w', 'W': 'w', 'ArrowUp': 'w',
    'a': 'a', 'A': 'a', 'ArrowLeft': 'a',
    's': 's', 'S': 's', 'ArrowDown': 's',
    'd': 'd', 'D': 'd', 'ArrowRight': 'd',
    ' ': 'skip',
    'z': 'undo', 'Z': 'undo',
    'y': 'redo', 'Y': 'redo',
    'Escape': 'exit'
};

const DIRECTION_MAP = {
    'w': 'up',
    'a': 'left',
    's': 'down',
    'd': 'right'
};

