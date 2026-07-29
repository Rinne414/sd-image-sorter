/**
 * Dataset Maker — caption fetch/render: scope + option builders, dedupe, _fetchMissingMeta/_fetchMissingCaptions/_refreshAllCaptions/_fetchCaptionsFor/_seedAiCaptions.
 * Moved VERBATIM from dataset-maker-part3.js L133-380.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;
    const CAPTION_FETCH_APPLIED = Object.freeze({ status: 'applied', error: '' });

    const captionFetchFailure = (status, error) => Object.freeze({ status, error });

    const captionTokenKey = (value) => String(value || '')
        .replace(/[\s_]+/g, ' ')
        .trim()
        .toLowerCase();

    const splitCaptionList = (value) => String(value || '')
        .split(/[\n,]+/)
        .map((part) => part.trim())
        .filter(Boolean);

    const annotationRevisionContext = (revision) => {
        if (!revision) return null;
        const content = revision.content || {};
        return {
            id: Number(revision.id),
            content_sha256: String(revision.content_sha256 || ''),
            content: {
                content_version: Number(content.content_version),
                booru_caption: String(content.booru_caption || ''),
                nl_caption: String(content.nl_caption || ''),
                caption_type: String(content.caption_type || ''),
            },
        };
    };

    const triggerQuickfillContext = (datasetMaker) => {
        const activeProject = datasetMaker._activeProject;
        const annotationOwner = datasetMaker._annotationHeadsOwner;
        const annotationHeadsReady = activeProject
            && typeof datasetMaker._annotationHeadsReadyForProject === 'function'
            && datasetMaker._annotationHeadsReadyForProject(activeProject);
        const queue = Array.from(datasetMaker.imageIds || []).map((rawId) => {
            const imageId = Number(rawId);
            if (!datasetMaker.isLocalId?.(imageId)) return { image_id: imageId };
            return {
                image_id: imageId,
                ds_id: String(datasetMaker.localItemDsIds?.get?.(imageId) || ''),
                path: String(datasetMaker.localItemPaths?.get?.(imageId) || ''),
            };
        });
        const annotationRevisions = annotationHeadsReady
            ? queue.flatMap((item) => {
                const revision = datasetMaker.annotationHeads
                    ?.get?.(Number(item.image_id))
                    ?.active_revision;
                return revision
                    ? [{
                        image_id: Number(item.image_id),
                        revision: annotationRevisionContext(revision),
                    }]
                    : [];
            })
            : [];
        return {
            active_project: activeProject
                ? { id: Number(activeProject.id), revision: Number(activeProject.revision) }
                : null,
            annotation_heads: activeProject
                ? {
                    status: String(datasetMaker._annotationHeadsStatus || 'idle'),
                    owner: annotationOwner
                        ? {
                            project_id: Number(annotationOwner.project_id),
                            project_revision: Number(annotationOwner.project_revision),
                        }
                        : null,
                    revisions: annotationRevisions,
                }
                : null,
            queue,
            trigger: datasetMaker._canonicalDatasetTrigger(
                String(document.getElementById('dataset-trigger')?.value || ''),
            ),
            common_tags: String(document.getElementById('dataset-common-tags')?.value || ''),
            quickfilled_trigger: String(datasetMaker._quickfilledTrigger || ''),
        };
    };

    const annotationHeadsError = (datasetMaker) => {
        const activeProject = datasetMaker._activeProject;
        if (!activeProject) return '';
        const status = String(datasetMaker._annotationHeadsStatus || 'idle');
        if (
            status === 'ready'
            && typeof datasetMaker._annotationHeadsReadyForProject === 'function'
            && datasetMaker._annotationHeadsReadyForProject(activeProject)
        ) return '';
        if (status === 'loading') {
            return 'Dataset project caption versions are still loading. Wait for loading to finish and retry.';
        }
        if (status === 'ready') {
            const owner = datasetMaker._annotationHeadsOwner;
            return (
                'Dataset project caption versions belong to a different project revision '
                + `(active_project_id=${Number(activeProject.id)}, `
                + `active_project_revision=${Number(activeProject.revision)}, `
                + `heads_project_id=${String(owner?.project_id ?? 'none')}, `
                + `heads_project_revision=${String(owner?.project_revision ?? 'none')}). `
                + 'Wait for the selected project to finish loading and retry.'
            );
        }
        return (
            `Dataset project caption versions are unavailable (status=${status}). `
            + 'Reload the project before adding the trigger.'
        );
    };

    const validateQuickfillTriggerBlacklist = (options, trigger) => {
        const triggerKey = captionTokenKey(trigger);
        const blocked = new Set((options.blacklist || []).map(captionTokenKey).filter(Boolean));
        if (blocked.has(triggerKey)) {
            return `Trigger "${trigger}" is blocked by the caption blacklist. Remove it from the blacklist and retry.`;
        }
        return '';
    };

    const usesDynamicCaptionSource = (datasetMaker, imageId) => {
        const numericId = Number(imageId);
        const captionType = typeof datasetMaker._captionTypeFor === 'function'
            ? datasetMaker._captionTypeFor(numericId)
            : 'booru';
        return captionType !== 'nl'
            && !datasetMaker.captionEdits.has(numericId)
            && !datasetMaker.annotationHeads?.get?.(numericId)?.active_revision;
    };

    const completeCaptionRefresh = (datasetMaker, result) => {
        if (result.status !== 'applied') return result;
        if (datasetMaker.activeId != null && !datasetMaker.captionEdits.has(datasetMaker.activeId)) {
            const textarea = document.getElementById('dataset-editor-textarea');
            if (textarea) textarea.value = datasetMaker.captions.get(datasetMaker.activeId) || '';
        }
        datasetMaker._renderQueue?.();
        return result;
    };

    const captionFetchRequestSummary = (imageIds) => {
        const sample = imageIds.slice(0, 20);
        return `image_ids(first ${sample.length} of ${imageIds.length})=${JSON.stringify(sample)}`;
    };

    const parseCaptionBatchResults = (value, requestedIds) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError('Caption response must be an object.');
        }
        if (!Array.isArray(value.results)) {
            throw new TypeError('Caption response results must be an array.');
        }
        const requested = new Set(requestedIds);
        const seen = new Set();
        const parsed = value.results.map((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                throw new TypeError(`Caption response results[${index}] must be an object.`);
            }
            if (!Number.isSafeInteger(item.image_id) || item.image_id <= 0) {
                throw new TypeError(
                    `Caption response results[${index}].image_id must be a positive safe integer.`,
                );
            }
            if (!requested.has(item.image_id)) {
                throw new RangeError(
                    `Caption response returned unexpected image_id=${item.image_id}.`,
                );
            }
            if (seen.has(item.image_id)) {
                throw new RangeError(
                    `Caption response returned duplicate image_id=${item.image_id}.`,
                );
            }
            if (typeof item.rendered !== 'string') {
                throw new TypeError(
                    `Caption response results[${index}].rendered must be a string.`,
                );
            }
            for (const field of ['filename', 'thumbnail_path', 'nl_caption', 'ai_caption']) {
                if (item[field] !== undefined && item[field] !== null && typeof item[field] !== 'string') {
                    throw new TypeError(
                        `Caption response results[${index}].${field} must be a string or null.`,
                    );
                }
            }
            seen.add(item.image_id);
            return Object.freeze({
                image_id: item.image_id,
                rendered: item.rendered,
                filename: item.filename ?? '',
                thumbnail_path: item.thumbnail_path ?? '',
                nl_caption: item.nl_caption ?? null,
                ai_caption: item.ai_caption ?? null,
            });
        });
        const missing = requestedIds.filter((imageId) => !seen.has(imageId));
        if (missing.length > 0) {
            throw new RangeError(
                `Caption response missing image_ids=${JSON.stringify(missing)}.`,
            );
        }
        return parsed;
    };

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
        const trigger = this._requireDatasetTrigger(
            document.getElementById('dataset-trigger')?.value || '',
            'settings.caption_render.trigger',
        );
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

    DM._triggerQuickfillCaptionOptions = function (trigger, commonTags) {
        const options = this._datasetTemplateOptions();
        options.trigger = this._requireDatasetTrigger(
            String(trigger || ''),
            'settings.caption_render.trigger',
        );
        options.append = splitCaptionList(commonTags);
        return options;
    };

    DM._triggerQuickfillSignature = function (trigger, commonTags) {
        return JSON.stringify({
            context: triggerQuickfillContext(this),
            content_mode: this._exportContentMode(),
            template_options: this._triggerQuickfillCaptionOptions(trigger, commonTags),
            caption_transforms: this._captionTransforms(),
        });
    };

    DM._supersedeCaptionFetch = function () {
        this._captionFetchGeneration = Number(this._captionFetchGeneration || 0) + 1;
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
        const missing = this.imageIds.filter(id => (
            !this.isLocalId?.(id) && !this.meta.has(id)
        ));
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
        const missing = this.imageIds.filter(id => (
            !this.isLocalId?.(id) && !this.captions.has(id)
        ));
        if (missing.length === 0) return CAPTION_FETCH_APPLIED;
        return this._fetchCaptionsFor(missing, { limit: 500 });
    };

    DM._refreshAllCaptions = async function () {
        // Re-render captions for the whole queue to reflect updated
        // common-tags / blacklist / underscore settings.
        if (this.imageIds.length === 0) return CAPTION_FETCH_APPLIED;
        const result = await this._fetchCaptionsFor(
            this.imageIds.filter((id) => !(this.isLocalId?.(id))),
            {},
        );
        return completeCaptionRefresh(this, result);
    };

    DM._refreshAllCaptionsForTrigger = async function (trigger, commonTags, transactionSignature) {
        const cleanTrigger = String(trigger || '').trim();
        const projectVersionError = annotationHeadsError(this);
        if (projectVersionError) return captionFetchFailure('failed', projectVersionError);
        const dynamicIds = this.imageIds.filter((id) => usesDynamicCaptionSource(this, id));
        const captionOptions = this._triggerQuickfillCaptionOptions(cleanTrigger, commonTags);
        const optionError = validateQuickfillTriggerBlacklist(captionOptions, cleanTrigger);
        if (optionError) return captionFetchFailure('failed', optionError);
        const result = await this._fetchCaptionsFor(
            dynamicIds.filter((id) => !(this.isLocalId?.(id))),
            {
                captionOptions,
                transactionTrigger: cleanTrigger,
                requiredCommonTags: String(commonTags || ''),
                transactionSignature: String(transactionSignature || ''),
            },
        );
        return completeCaptionRefresh(this, result);
    };

    DM._fetchCaptionsFor = async function (ids, options = {}) {
        const requestGeneration = Number(this._captionFetchGeneration || 0) + 1;
        this._captionFetchGeneration = requestGeneration;
        if (ids.length === 0) return CAPTION_FETCH_APPLIED;
        const opts = options.captionOptions || this._captionOptions();
        try {
            this._requireDatasetTrigger(
                String(opts.trigger || ''),
                'settings.caption_render.trigger',
            );
        } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
                return captionFetchFailure('failed', error.message);
            }
            throw error;
        }
        const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : ids.length;
        const targetIds = ids.slice(0, limit || ids.length);
        const batchSize = 500;
        const stagedResults = [];
        try {
            for (let i = 0; i < targetIds.length; i += batchSize) {
                const batch = targetIds.slice(i, i + batchSize);
                const r = await fetch('/api/tags/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: batch, ...opts }),
                });
                if (!r.ok) {
                    const responseBody = (await r.text()).slice(0, 2000);
                    const error = (
                        `POST /api/tags/export-preview returned HTTP ${r.status}; `
                        + `${captionFetchRequestSummary(batch)}; response=${responseBody}`
                    );
                    window.Logger?.error?.('dataset_caption_fetch_failed', {
                        endpoint: '/api/tags/export-preview',
                        status_code: r.status,
                        response_body: responseBody,
                        image_ids: batch,
                    });
                    return captionFetchFailure('failed', error);
                }
                const data = await r.json();
                stagedResults.push(...parseCaptionBatchResults(data, batch));
            }
        } catch (e) {
            const error = (
                'POST /api/tags/export-preview failed before a valid response; '
                + `${captionFetchRequestSummary(targetIds)}; `
                + `cause=${e instanceof Error ? e.message : String(e)}`
            );
            window.Logger?.error?.('dataset_caption_fetch_failed', {
                endpoint: '/api/tags/export-preview',
                error_type: e?.constructor?.name || typeof e,
                message: e instanceof Error ? e.message : String(e),
                image_ids: targetIds,
            });
            return captionFetchFailure('failed', error);
        }
        if (requestGeneration !== this._captionFetchGeneration) {
            return captionFetchFailure(
                'superseded',
                'Caption refresh was superseded by newer Dataset Maker settings. Try again.',
            );
        }
        const requiredTrigger = String(options.requiredTrigger || '').trim();
        if (requiredTrigger) {
            const triggerError = validateRenderedTrigger(stagedResults, requiredTrigger);
            if (triggerError) {
                window.Logger?.error?.('dataset_caption_trigger_validation_failed', {
                    trigger: requiredTrigger,
                    image_ids: targetIds,
                    message: triggerError,
                });
                return captionFetchFailure('failed', triggerError);
            }
        }
        const transactionSignature = String(options.transactionSignature || '');
        if (transactionSignature) {
            if (typeof this._triggerQuickfillSignature !== 'function') {
                throw new TypeError('Dataset trigger signature function is unavailable.');
            }
            const currentSignature = this._triggerQuickfillSignature(
                String(options.transactionTrigger || '').trim(),
                String(options.requiredCommonTags || ''),
            );
            if (currentSignature !== transactionSignature) {
                return captionFetchFailure(
                    'superseded',
                    'Caption refresh was superseded by newer Dataset Maker state. Try again.',
                );
            }
        }
        for (const item of stagedResults) {
            const imageId = Number(item.image_id);
            if (item.rendered != null) this.captions.set(imageId, item.rendered);
            // Seed the natural-language baseline without clobbering a user edit.
            const nlText = String(item.nl_caption || item.ai_caption || '').trim();
            if (nlText) this.nlCaptions.set(imageId, nlText);
            if (!this.meta.has(imageId)) {
                this.meta.set(imageId, {
                    filename: item.filename || '',
                    thumbnail_path: item.thumbnail_path || '',
                });
            }
        }
        return CAPTION_FETCH_APPLIED;
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
