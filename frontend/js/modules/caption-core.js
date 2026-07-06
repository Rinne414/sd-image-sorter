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
     * An explicit valid choice always wins. Without one, both the Dataset Maker
     * and the v321 batch-export editor default images that already carry an NL
     * sentence to 'both' and everything else to 'booru' (opts.autoBoth = true).
     * The autoBoth=false path remains for callers that want the strict "no
     * output change without a user action" default.
     */
    function effectiveType(explicitType, hasNl, opts = {}) {
        if (TYPES.includes(explicitType)) return explicitType;
        return (opts.autoBoth && hasNl) ? 'both' : 'booru';
    }

    /**
     * Join rule — keep byte-identical to compose_caption_with_nl (backend).
     * The NL sentence is whitespace-flattened (P1-7): kohya-style trainers
     * read caption line 1 only, so a multi-line sentence would truncate.
     */
    function compose(booru, nl, type) {
        const ctype = TYPES.includes(type) ? type : 'booru';
        if (ctype === 'booru') return String(booru ?? '');
        const base = String(booru || '').trim();
        const text = String(nl || '').split(/\s+/).filter(Boolean).join(' ');
        if (ctype === 'nl') return text || base;
        if (base && text) return `${base}, ${text}`;
        return base || text;
    }

    window.CaptionCore = { TYPES: TYPES.slice(), effectiveType, compose };
})();
