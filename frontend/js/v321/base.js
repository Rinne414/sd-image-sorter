/**
 * v321/base.js - v321-ui.js decomposition (family base; MUST LOAD FIRST).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 1-35 (file
 * header + `const V321Integration = {` + the shared data props), 761-773
 * (_escapeHtml/_escapeAttr), 2996-2999 (_i18n), 3159 (the object-literal
 * `};` closer) and 3162-3164 (the window.V321Integration publish) of 3,164.
 * Declares the ONE unsealed object every other v321/*.js file
 * Object.assign()s onto - this file must load before the rest of the
 * family; v321/boot.js registers the DOMContentLoaded init LAST.
 */
/**
 * SD Image Sorter v3.2.1 — UI integration for:
 * (A) VLM as a primary tagger backend in the Tag modal
 * (B) LoRA training preset selector + template options in batch export modal
 * (C) Live export preview with per-image edit and override on save
 */

const V321Integration = {
    // === Shared state ===
    presets: [],           // List of LoRA presets from /api/tags/export-presets
    selectedPreset: 'illustrious_pony',  // default
    previewCache: new Map(),  // image_id -> rendered caption (auto-generated)
    editedCaptions: new Map(),  // image_id -> user-edited caption
    // Aurora #25c caption consolidation (two-box editor, shared w/ Dataset Maker):
    nlCache: new Map(),       // image_id -> stored NL sentence (nl_caption || ai_caption)
    editedNl: new Map(),      // image_id -> user-edited NL sentence
    captionTypes: new Map(),  // image_id -> explicit 'nl' | 'both' (absent = 'booru')
    previewResults: [],    // legacy array OR sparse metadata cache (kept for compat)
    previewMetadata: new Map(), // image_id -> {filename, thumbnail_path}
    queueImageIds: [],     // explicit IDs or the currently cached token window
    queueSelectionToken: null,
    queueIdByIndex: new Map(),
    queueIndexById: new Map(),
    queueTotalCount: 0,    // total count for display
    queueSourceMode: 'ids',
    activePreviewImageId: null,
    activePreviewIndex: 0,
    captionTransforms: { prepend: [], append: [], remove: [], remove_categories: [], dedupe: false },
    previewLimit: null, // No artificial cap — virtual scroll handles any count
    vlmActive: false,
    _queueScrollContainer: null,
    _queueRenderVisible: null,
    _queueMetadataInFlight: new Set(),
    _captionEditorKeyHandler: null,

    _escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    },

    _escapeAttr(value) {
        return this._escapeHtml(value);
    },
    _i18n(key, fallback, params) {
        const translated = window.I18n?.t?.(key, params);
        return (translated && translated !== key) ? translated : fallback;
    },
};

// Expose for debugging
window.V321Integration = V321Integration;
