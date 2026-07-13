/**
 * smart-tag/state.js — smart-tag.js decomposition (the base; loads FIRST).
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines 1-20 +
 * 22-58 (of 1,246): the file docblock, the IIFE's 'use strict' (kept as a
 * file-level directive here and ADDED to every other family file — the
 * image-reader precedent; the original file was strict throughout), the
 * DOM query helpers, the closure state shared by the whole family
 * (progressTimer, pollFailureCount, activeJobId, pipelineQueuedSince,
 * taggerModelCatalog, taggerModelDefault, pendingExplicitScope),
 * LARGE_EXPLICIT_SOURCE_LIMIT, the i18n helper and toFiniteThreshold.
 * Classic script: top-level let/const/function declarations land in the
 * one shared global lexical environment (autosep/censor precedent), so
 * the family keeps a single call graph. Only the IIFE frame lines
 * (pre-split 21 and 1,246) were dropped.
 * Family renames (global-uniqueness census; applied at every use site
 * across the family): $ -> smartTag$, $$ -> smartTag$$, t -> smartTagT,
 * closeModal -> closeSmartTagModal. Everything else is byte-identical.
 */
/**
 * Smart Tag wizard wiring (frontend half of the local smart-caption pipeline).
 *
 * Owns:
 *   - The "✨ Smart Tag (WD14 + VLM)" button inside Dataset Maker
 *   - The Smart Tag modal (#smart-tag-modal) with its purpose / trigger / merge / toggles
 *   - The progress bar + preview ticker that polls /api/smart-tag/progress
 *   - Cancel + close handlers
 *
 * Talks to the backend through:
 *   POST /api/smart-tag/start
 *   GET  /api/smart-tag/progress
 *   POST /api/smart-tag/cancel
 *
 * Reads the current dataset image_ids from the global Dataset Maker state
 * (window.DatasetMaker exposes getImageIds()). If that helper isn't
 * present we fall back to scraping data-image-id attributes off the
 * dataset queue list, so this module doesn't hard-couple to the
 * dataset-maker module's internal state shape.
 */
    'use strict';

    const smartTag$ = (sel) => document.querySelector(sel);
    const smartTag$$ = (sel) => Array.from(document.querySelectorAll(sel));

    /** Shared timer handle for the progress poll loop. */
    let progressTimer = null;
    /** Consecutive poll failures — reset on every successful poll. */
    let pollFailureCount = 0;
    let activeJobId = null;
    // v3.4.1 AI job queue: timestamp of our queued (not-yet-started) start.
    // 0 when we are not waiting in the unified pipeline queue. Guards the
    // pipeline_queue.last_start_error check against stale errors from
    // older runs.
    let pipelineQueuedSince = 0;
    let taggerModelCatalog = [];
    let taggerModelDefault = '';
    const LARGE_EXPLICIT_SOURCE_LIMIT = 5000;

    // Aurora Phase 3 (#25b): a one-shot explicit scope handed in when the modal
    // is opened from the Gallery [打标] armed selection (via openScoped). It takes
    // priority over the Dataset-Maker-first heuristic so the run + summary reflect
    // "the images I selected in Gallery", not a stale Dataset Maker queue. Cleared
    // on close and on a plain (unscoped) open.
    let pendingExplicitScope = null;

    const smartTagT = (key, fallback) => {
        const value = window.I18n?.t?.(key);
        return value && value !== key ? value : fallback;
    };

    function toFiniteThreshold(value, fallback) {
        const num = parseFloat(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(0, Math.min(1, num));
    }

