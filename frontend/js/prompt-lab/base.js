/**
 * prompt-lab/base.js - prompt-lab.js decomposition (family base; MUST LOAD FIRST).
 * Moved BYTE-IDENTICAL from frontend/js/prompt-lab.js pre-cut lines 1-55 (file
 * header + escapeHtml fallback + `const PromptLab = {` + the shared data props),
 * 156-179 (_escapeValue/_safeDataValue/_decodeDataValue/_t/_renderStatsEmpty),
 * 2473 (the object-literal `};` closer) and 2484 (the window.PromptLab publish)
 * of 2,485. Declares the ONE unsealed object every other prompt-lab/*.js file
 * Object.assign()s onto - this file must load before the rest of the family;
 * prompt-lab/boot.js declares the initPromptLab boot LAST.
 */
/**
 * SD Image Sorter - Prompt Lab Module
 * Interactive prompt builder with category browser, tag sets, exclusion rules,
 * and weighted random generation.
 */

// escapeHtml fallback — main definition is in app.js
if (typeof escapeHtml === 'undefined') {
    var escapeHtml = function(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };
}

const PromptLab = {
    categories: {},
    tagSets: [],
    exclusionRules: [],
    presets: [],
    generatedPrompt: '',
    generatedPromptCore: '',
    isReady: false,
    eventsBound: false,
    randomizeExcludedCategories: new Set(['unknown', 'rating', 'meta']),
    imagePickerTarget: '',
    imageCatalog: [],
    imageCatalogLoaded: false,
    imageCatalogPromise: null,
    statsVisibleCounts: {
        topTags: 20,
        highTags: 20,
        checkpoints: 12,
        bestCheckpoints: 8,
        scoredImages: 8,
        recipes: 8,
    },
    categoryBoardState: null,
    categoryBoardOriginal: null,
    categoryBoardActiveTag: '',
    buildCategoryState: null,

    // User-controlled fixed tags for generated prompts.
    prependTags: '',
    appendTags: '',

    // Current builder state (slot-based)
    slots: {},       // { category: [selected tags] }
    weights: {},     // { category: weight 0-100 }
    locked: {},      // { category: bool } - locked slots survive randomize

    _escapeValue(value) {
        return escapeHtml(value);
    },

    _safeDataValue(value) {
        return encodeURIComponent(String(value ?? ''));
    },

    _decodeDataValue(value) {
        try {
            return decodeURIComponent(String(value ?? ''));
        } catch (e) {
            return String(value ?? '');
        }
    },

    _t(key, fallback, params) {
        const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : (fallback || key);
    },

    _renderStatsEmpty(message) {
        return `<div class="promptlab-empty-note">${escapeHtml(message)}</div>`;
    },

};
window.PromptLab = PromptLab;
