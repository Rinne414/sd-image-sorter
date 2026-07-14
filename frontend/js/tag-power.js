/**
 * Tag Images modal: Pre-tag filter wiring (v3.2.2 T-power-PR1).
 *
 * Owns the small <details id="tag-power-card"> block:
 *   - quickfill buttons populate the blacklist textarea with curated lists
 *   - base-model dropdown keeps untouched max-tags aligned with its suggestion
 *
 * The textarea + max-tags input are read by app.js startTagging() at submit
 * time (no separate state, no separate request). This keeps the surface
 * area tight: this module only wires UX, not data flow.
 */
(function () {
    'use strict';

    // Curated blacklist sets aligned with backend Smart Tag noise vocabularies.
    const QUALITY_TAGS = [
        'masterpiece', 'best_quality', 'good_quality', 'normal_quality',
        'low_quality', 'worst_quality', 'high_quality', 'lowres', 'highres',
        'absurdres',
        'score_9', 'score_8', 'score_7', 'score_6', 'score_5', 'score_4',
        'score_9_up', 'score_8_up', 'score_7_up', 'score_6_up',
    ];
    const META_TAGS = [
        'signature', 'watermark', 'jpeg_artifacts', 'official_art',
        'sketch', 'monochrome', 'greyscale', 'grayscale',
        'censored', 'mosaic_censoring', 'bar_censor',
    ];

    // Base-model -> recommended max_tags (matches the README research notes;
    // not a hard cap; users can override it explicitly).
    const MAX_TAGS_BY_PRESET = {
        'sdxl': 50,
        'flux': 120,
        'anima_style': 200,
        'anima_character': 200,
    };

    function $(id) { return document.getElementById(id); }

    function readBlacklistTextarea() {
        const ta = $('tag-pre-blacklist');
        if (!ta) return new Set();
        const set = new Set();
        for (const token of String(ta.value || '').split(/[,\n]+/)) {
            const t = token.trim();
            if (t) set.add(t);
        }
        return set;
    }

    function writeBlacklistTextarea(set) {
        const ta = $('tag-pre-blacklist');
        if (!ta) return;
        ta.value = Array.from(set).join('\n');
    }

    function appendTags(tags) {
        const set = readBlacklistTextarea();
        const seenLower = new Set(Array.from(set).map((t) => t.toLowerCase()));
        for (const t of tags) {
            if (!seenLower.has(t.toLowerCase())) {
                set.add(t);
                seenLower.add(t.toLowerCase());
            }
        }
        writeBlacklistTextarea(set);
    }

    function clearBlacklist() {
        const ta = $('tag-pre-blacklist');
        if (ta) ta.value = '';
    }

    function syncMaxTagsFromBaseModel() {
        const sel = $('tag-base-model');
        const max = $('tag-max-tags-per-image');
        if (!sel || !max) return;
        const preset = sel.value || '';
        const suggested = MAX_TAGS_BY_PRESET[preset];
        const userTouched = max.dataset.userTouched === '1' || max.dataset.userTouched === 'true';
        if (suggested) {
            max.placeholder = `0 = unlimited (suggested for ${sel.options[sel.selectedIndex]?.text?.split('(')[0]?.trim() || preset}: ${suggested})`;
        } else {
            max.placeholder = '0 = unlimited';
        }
        // Automatic values follow every preset change until the user edits the input.
        if (!userTouched) {
            max.value = suggested ? String(suggested) : '0';
        }
    }

    function bind() {
        $('btn-tag-prebl-quality')?.addEventListener('click', () => appendTags(QUALITY_TAGS));
        $('btn-tag-prebl-meta')?.addEventListener('click', () => appendTags(META_TAGS));
        $('btn-tag-prebl-clear')?.addEventListener('click', clearBlacklist);

        $('tag-base-model')?.addEventListener('change', syncMaxTagsFromBaseModel);

        // Mark the max-tags input as user-touched once they type, so a base-model
        // preset change after that DOESN'T overwrite their value.
        const maxTags = $('tag-max-tags-per-image');
        if (maxTags) {
            maxTags.addEventListener('input', () => {
                maxTags.dataset.userTouched = '1';
            }, { once: true });
        }

        // Initial pass so the placeholder reflects the default option.
        syncMaxTagsFromBaseModel();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }

    // Expose curated lists for the Dataset Maker reuse in PR-2/PR-3.
    window.TagPower = { QUALITY_TAGS, META_TAGS, MAX_TAGS_BY_PRESET };
})();
