/**
 * CaptionCore — single source of truth for the per-image caption-type
 * semantics (booru | nl | both) shared by the Dataset Maker inline editor
 * and the v321 batch-export caption editor (Aurora #25c consolidation).
 *
 * compose() mirrors backend tag_export_service.compose_caption_with_nl
 * EXACTLY (which dataset_export_service also delegates to) — the composed
 * string shown in either editor must be the string the export writes.
 * Change the two together.
 */
(function () {
    'use strict';

    const TYPES = ['booru', 'nl', 'both'];

    /**
     * Resolve the effective caption type for an image.
     * An explicit valid choice always wins. Without one, the Dataset Maker
     * defaults images that already carry an NL sentence to 'both'
     * (opts.autoBoth = true); the v321 batch-export editor keeps 'booru' so
     * existing export output never changes without a user action.
     */
    function effectiveType(explicitType, hasNl, opts = {}) {
        if (TYPES.includes(explicitType)) return explicitType;
        return (opts.autoBoth && hasNl) ? 'both' : 'booru';
    }

    /** Join rule — keep byte-identical to compose_caption_with_nl (backend). */
    function compose(booru, nl, type) {
        const ctype = TYPES.includes(type) ? type : 'booru';
        if (ctype === 'booru') return String(booru ?? '');
        const base = String(booru || '').trim();
        const text = String(nl || '').trim();
        if (ctype === 'nl') return text || base;
        if (base && text) return `${base}, ${text}`;
        return base || text;
    }

    window.CaptionCore = { TYPES: TYPES.slice(), effectiveType, compose };
})();
