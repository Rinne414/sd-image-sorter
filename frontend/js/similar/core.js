/**
 * similar/core.js — similar.js decomposition (family base; MUST LOAD FIRST).
 * Moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut lines 1-66 +
 * 1495-1496 + 1509 (of 1,517): the file header, the one-file `escapeHtml`
 * `var` fallback guard, `const SimilarImages = {` + every state field, _t,
 * _applyLocalizedDefaults, the object-literal `};` closer and the
 * `window.SimilarImages = SimilarImages;` publish. Declares the ONE
 * unsealed object every other similar/*.js file Object.assign()s onto —
 * this file must load before the rest of the family; similar/boot.js
 * publishes initSimilar LAST. No 'use strict' anywhere in the family:
 * the original was a non-strict classic script (gallery precedent;
 * image-reader's per-file directives preserved its strict IIFE —
 * semantics preservation cuts both ways).
 */
/**
 * SD Image Sorter - Similar Images Module
 * Handles similarity search UI, duplicate finder, and embedding management.
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

const SimilarImages = {
    isEmbedding: false,
    isCheckingEmbeddingStatus: false,
    embedProgress: { processed: 0, total: 0, errors: 0 },
    embedProgressTracker: null,
    modelStatus: null,
    stats: null,
    searchResults: [],
    duplicateResults: [],
    currentSearchId: null,
    searchPageSize: 100,
    duplicatePageSize: 500,
    currentSearchOffset: 0,
    currentDuplicateOffset: 0,
    currentSearchFile: null,
    currentSearchMode: null,
    currentSearchThreshold: 0.5,
    currentDuplicateThreshold: 0.95,
    lastSearchCount: 0,
    lastDuplicateCount: 0,
    searchHasMore: false,
    duplicateHasMore: false,
    totalSearchCount: 0,
    totalDuplicateCount: 0,
    requestSequence: 0,
    activeSearchToken: 0,
    activeDuplicateToken: 0,
    searchEmptyMessage: '',
    duplicateEmptyMessage: '',
    uploadDropzoneActive: false,
    collectionId: null,
    scopeCollections: [],

    _t(key, fallback, params) {
        const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : (fallback || key);
    },

    _applyLocalizedDefaults() {
        this.searchEmptyMessage = this._t(
            'similar.defaultSearchEmpty',
            'No similar images found. Try generating embeddings first.'
        );
        this.duplicateEmptyMessage = this._t(
            'similar.defaultDuplicateEmpty',
            'No duplicates found at this threshold.'
        );
    },

};

window.SimilarImages = SimilarImages;
