/**
 * Dataset Maker — caption fetch/render: scope + option builders, dedupe, _fetchMissingMeta/_fetchMissingCaptions/_refreshAllCaptions/_fetchCaptionsFor/_seedAiCaptions.
 * Moved VERBATIM from dataset-maker-part3.js L133-380.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    DM._captionScope = function () {
        return document.getElementById('dataset-caption-scope')?.value || 'all';
    };

    DM._captionScopeIds = function () {
        const scope = this._captionScope();
        if (scope === 'active') {
            return this.activeId == null ? [] : [Number(this.activeId)];
        }
        if (scope === 'selected') {
            return Array.from(this._queueSelection || []).map(Number);
        }
        return Array.from(this.imageIds || []).map(Number);
    };

    DM._captionOptions = function () {
        const trigger = document.getElementById('dataset-trigger')?.value?.trim() || '';
        const blacklistText = document.getElementById('dataset-blacklist')?.value || '';
        // #dataset-blacklist is newline-separated by convention (TraitPruner
        // appends with '\n', see dataset-maker.js) but users/paste may use
        // commas — accept BOTH so trait-pruned entries are not silently dropped.
        const blacklist = blacklistText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
        const commonText = document.getElementById('dataset-common-tags')?.value || '';
        const append = commonText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
        const normalize = !!document.getElementById('dataset-underscore-to-space')?.checked;
        const opts = {
            preset_id: 'custom',
            template_override: '{trigger}, {tags:filtered}, {append}',
            trigger,
            blacklist,
            replace_rules: {},
            max_tags: 0,
            append,
        };
        opts.underscore_to_space_override = !!normalize;
        opts.preserve_underscore_prefixes_override = ['score_'];
        return opts;
    };

    DM._parseDatasetReplaceRules = function () {
        const raw = document.getElementById('dataset-replace-rules')?.value || '';
        const rules = {};
        raw.split(/\r?\n/).forEach((line) => {
            const text = line.trim();
            if (!text) return;
            const parts = text.includes('->') ? text.split('->') : text.split('=>');
            if (parts.length < 2) return;
            const from = parts.shift().trim();
            const to = parts.join('->').trim();
            if (from) rules[from] = to;
        });
        return rules;
    };

    DM._exportContentMode = function () {
        return document.getElementById('dataset-export-content-mode')?.value || 'template';
    };

    DM._datasetTemplateOptions = function () {
        const opts = this._captionOptions();
        const override = document.getElementById('dataset-template-override')?.value || '';
        opts.template_override = override.trim() || '{trigger}, {tags:filtered}, {append}';
        opts.replace_rules = this._parseDatasetReplaceRules();
        opts.max_tags = Math.max(0, parseInt(document.getElementById('dataset-max-tags')?.value || '0', 10) || 0);
        return opts;
    };

    DM._captionTransforms = function () {
        return {};
    };

    DM._dedupeCaptionTags = function () {
        const scope = this._captionScope();
        const ids = this._captionScopeIds();
        if (scope === 'selected' && ids.length === 0) {
            this._toast(this._t('dataset.dedupeNoSelection', 'Select images first, or switch scope to All images.'), 'warning', 3500);
            return;
        }
        if (scope === 'active' && ids.length === 0) {
            this._toast(this._t('dataset.noActiveImage', 'Select an image first.'), 'warning', 3000);
            return;
        }
        let changedImages = 0;
        let removedTags = 0;
        for (const rawId of ids) {
            const id = Number(rawId);
            const caption = this.captionEdits.has(id) ? this.captionEdits.get(id) : (this.captions.get(id) || '');
            const parts = String(caption || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (parts.length <= 1) continue;
            const seen = new Set();
            const kept = [];
            for (const part of parts) {
                // Fold underscores like find/replace and the export
                // underscore_to_space option do — "long_hair" and "long hair"
                // are the same tag everywhere else in the pipeline (latent
                // inconsistency found by the 2026-07 pin sweep; pin flipped in
                // the same commit).
                const key = part.replace(/[_\s]+/g, ' ').trim().toLowerCase();
                if (seen.has(key)) {
                    removedTags += 1;
                    continue;
                }
                seen.add(key);
                kept.push(part);
            }
            if (kept.length !== parts.length) {
                const next = kept.join(', ');
                this.captionEdits.set(id, next);
                changedImages += 1;
                this._refreshQueueItem?.(id);
                if (Number(this.activeId) === id) {
                    const ta = document.getElementById('dataset-editor-textarea');
                    if (ta) ta.value = next;
                }
            }
        }
        this._renderTagPills?.();
        this._refreshVocab?.();
        this._refreshExportPreview?.();
        this._toast(this._t('dataset.dedupeDone',
            'Removed {tags} duplicate tags across {images} images.',
            { tags: removedTags, images: changedImages }), changedImages ? 'success' : 'info', 3500);
        this._saveSession?.();
    };

    DM._fetchMissingMeta = async function () {
        const missing = this.imageIds.filter(id => !this.meta.has(id));
        if (missing.length === 0) return;
        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: missing.slice(0, 500), preset_id: 'custom' }),
            });
            if (!r.ok) return;
            const data = await r.json();
            for (const item of (data.results || [])) {
                this.meta.set(Number(item.image_id), {
                    filename: item.filename || '',
                    thumbnail_path: item.thumbnail_path || '',
                });
                // point 7 fix: do NOT seed ``captions`` here. This endpoint is
                // called with a bare ``preset_id:'custom'`` (no trigger/append/
                // blacklist), so its ``rendered`` is a stripped booru template.
                // Pre-filling captions made the very next call,
                // _fetchMissingCaptions (which skips ids already in ``captions``),
                // a no-op — so the full-options booru render AND the NL seeding
                // never ran and the natural-language caption was lost on import.
            }
        } catch (e) { /* swallow - queue will just show fallback labels */ }
    };

    DM._fetchMissingCaptions = async function () {
        const missing = this.imageIds.filter(id => !this.captions.has(id));
        if (missing.length === 0) return;
        await this._fetchCaptionsFor(missing, { limit: 500 });
    };

    DM._refreshAllCaptions = async function () {
        // Re-render captions for the whole queue to reflect updated
        // common-tags / blacklist / underscore settings.
        if (this.imageIds.length === 0) return;
        await this._fetchCaptionsFor(this.imageIds.filter((id) => !(this.isLocalId?.(id))));
        // If the user is editing one, refresh its textarea (unless they
        // already typed an override -- their edits are sticky)
        if (this.activeId != null && !this.captionEdits.has(this.activeId)) {
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) ta.value = this.captions.get(this.activeId) || '';
        }
    };

    DM._fetchCaptionsFor = async function (ids, options = {}) {
        if (ids.length === 0) return;
        const opts = this._captionOptions();
        const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : ids.length;
        const targetIds = ids.slice(0, limit || ids.length);
        const batchSize = 500;
        try {
            for (let i = 0; i < targetIds.length; i += batchSize) {
                const batch = targetIds.slice(i, i + batchSize);
                const r = await fetch('/api/tags/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: batch, ...opts }),
                });
                if (!r.ok) return;
                const data = await r.json();
                for (const item of (data.results || [])) {
                    if (item.rendered != null) this.captions.set(Number(item.image_id), item.rendered);
                    // point 2/3: seed the natural-language baseline so the NL box
                    // and the per-image "both" default have a value on import.
                    // Don't clobber a user's NL edit; only set the baseline.
                    // Fall back to the fused ai_caption for rows tagged before
                    // the nl_caption split existed (same as _seedAiCaptions and
                    // the backend's _compose_nl_caption) — without it, those
                    // rows show an empty NL box in "NL"/"Both" mode.
                    const nlText = String(item.nl_caption || item.ai_caption || '').trim();
                    if (nlText) this.nlCaptions.set(Number(item.image_id), nlText);
                    if (!this.meta.has(Number(item.image_id))) {
                        this.meta.set(Number(item.image_id), {
                            filename: item.filename || '',
                            thumbnail_path: item.thumbnail_path || '',
                        });
                    }
                }
            }
        } catch (e) { /* */ }
    };

    // After a VLM / Smart Tag run the natural-language sentence lives in the
    // image's DB ``nl_caption`` (pure prose). The booru tags went to the tag
    // table and are rendered into the booru box separately by
    // _refreshAllCaptions. Seed the sentence into ``nlCaptions`` so the editor's
    // NL box shows it and the per-image type auto-defaults to "both" (tags + NL).
    // (Pre-split builds dumped the fused ai_caption into the single caption box;
    // with the two-box editor that prose belongs in the NL box, not the tags.)
    DM._seedAiCaptions = async function (ids) {
        const galleryIds = (ids || [])
            .map(Number)
            .filter((id) => Number.isFinite(id) && id > 0 && !(this.isLocalId?.(id)));
        if (!galleryIds.length) return 0;
        let applied = 0;
        const batchSize = 500;
        for (let i = 0; i < galleryIds.length; i += batchSize) {
            const batch = galleryIds.slice(i, i + batchSize);
            let data;
            try {
                const r = await fetch('/api/tags/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: batch, preset_id: 'custom' }),
                });
                if (!r.ok) continue;
                data = await r.json();
            } catch (_e) {
                continue;
            }
            for (const item of (data.results || [])) {
                const id = Number(item.image_id);
                // Prefer the pure nl_caption; fall back to the fused ai_caption
                // for rows tagged before the split column existed.
                const nl = String(item.nl_caption || item.ai_caption || '').trim();
                if (!Number.isFinite(id) || !nl) continue;
                this.nlCaptions.set(id, nl);
                applied += 1;
            }
        }
        // Reflect the seeded NL in the open editor's NL box immediately so the
        // active image surfaces its sentence without a re-select.
        this._refreshActiveCaptionBoxes?.();
        return applied;
    };
})();
