/**
 * v321/caption-model.js - v321-ui.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 1635-2133
 * (of 3,164): (C) CaptionCore glue, transforms, token ops, collect* payloads.
 * Classic script: joins the ONE unsealed window.V321Integration object
 * declared in v321/base.js (loads FIRST); v321/boot.js registers the
 * DOMContentLoaded init LAST; index.html lists the family in original
 * line order.
 */
Object.assign(window.V321Integration, {

    _getPreviewItem(imageId = this.activePreviewImageId) {
        const id = Number(imageId);
        // Try metadata Map first (virtual scroll path)
        const meta = this.previewMetadata.get(id);
        if (meta) return { image_id: id, filename: meta.filename || '', thumbnail_path: meta.thumbnail_path || '', rendered: this.previewCache.get(id) || '' };
        if (Number.isFinite(id) && id > 0 && (this.queueIndexById.has(id) || this.queueImageIds.includes(id))) {
            return { image_id: id, filename: `Image ${id}`, thumbnail_path: '', rendered: this.previewCache.get(id) || '' };
        }
        // Legacy array fallback
        const found = this.previewResults.find((item) => Number(item.image_id) === id);
        if (found) return found;
        // Fallback to first item
        if (this.queueImageIds.length) {
            const firstId = this.queueImageIds[0];
            const firstMeta = this.previewMetadata.get(firstId);
            if (firstMeta) return { image_id: firstId, filename: firstMeta.filename || '', thumbnail_path: firstMeta.thumbnail_path || '', rendered: this.previewCache.get(firstId) || '' };
        }
        return this.previewResults[0] || null;
    },

    _getRenderedCaption(imageId) {
        const id = Number(imageId);
        const raw = this.editedCaptions.has(id)
            ? (this.editedCaptions.get(id) || '')
            : (this.previewCache.get(id) || this._getPreviewItem(id)?.rendered || '');
        return this._applyCaptionTransformsToText(raw);
    },

    _setPreviewCaption(imageId, value) {
        const id = Number(imageId);
        const text = String(value || '');
        const auto = this.previewCache.get(id) || '';
        if (text !== auto) {
            this.editedCaptions.set(id, text);
        } else {
            this.editedCaptions.delete(id);
        }
    },

    // ---- Aurora #25c: per-image caption type + NL sentence (CaptionCore) ----

    /** IDs whose caption state is client-side known (preview loaded or edited). */
    _loadedPreviewIds() {
        return Array.from(new Set([
            ...Array.from(this.previewCache.keys()).map(Number),
            ...Array.from(this.editedCaptions.keys()).map(Number),
            ...Array.from(this.editedNl.keys()).map(Number),
        ])).filter((id) => Number.isFinite(id) && id > 0);
    },

    _getNlText(imageId) {
        const id = Number(imageId);
        return this.editedNl.has(id) ? (this.editedNl.get(id) || '') : (this.nlCache.get(id) || '');
    },

    _setNlEdit(imageId, value) {
        const id = Number(imageId);
        const text = String(value || '');
        // Track only real deviations from the stored sentence; an explicit
        // empty string is a valid override (suppresses the stored NL).
        if (text !== (this.nlCache.get(id) || '')) {
            this.editedNl.set(id, text);
        } else {
            this.editedNl.delete(id);
        }
    },

    _getCaptionType(imageId) {
        const id = Number(imageId);
        const explicit = this.captionTypes.get(id) || null;
        // Unified with the Dataset Maker (autoBoth): an image that carries an NL
        // sentence defaults to 'both' so its VLM caption exports without the
        // user ticking every row; images without NL stay 'booru'. Explicit user
        // choices still win. The rule lives in CaptionCore so the two editors
        // never drift.
        const hasNl = String(this._getNlText(id) || '').trim().length > 0;
        return window.CaptionCore
            ? window.CaptionCore.effectiveType(explicit, hasNl, { autoBoth: true })
            : (explicit || (hasNl ? 'both' : 'booru'));
    },

    _setCaptionType(imageId, type) {
        const id = Number(imageId);
        if (type === 'nl' || type === 'both') {
            this.captionTypes.set(id, type);
        } else {
            this.captionTypes.delete(id);
        }
    },

    /** The NL compose only applies in template/tags modes (backend gate). */
    _composeEligible() {
        const mode = document.getElementById('batch-export-content-mode')?.value || 'caption_merged';
        return mode === 'template' || mode === 'tags';
    },

    /** The string the export will actually write for this image — same order
     *  as the backend: (edit | render) -> NL compose -> caption_transforms. */
    _getExportedCaption(imageId) {
        const id = Number(imageId);
        const raw = this.editedCaptions.has(id)
            ? (this.editedCaptions.get(id) || '')
            : (this.previewCache.get(id) || this._getPreviewItem(id)?.rendered || '');
        const composed = (window.CaptionCore && this._composeEligible())
            ? window.CaptionCore.compose(raw, this._getNlText(id), this._getCaptionType(id))
            : raw;
        return this._applyCaptionTransformsToText(composed);
    },

    _seedNlFromPreviewItem(item) {
        const id = Number(item?.image_id);
        if (!Number.isFinite(id) || id <= 0) return;
        if (item.nl_caption !== undefined || item.ai_caption !== undefined) {
            this.nlCache.set(id, String(item.nl_caption || item.ai_caption || ''));
        }
    },

    _captionTypeDisplayLabel(type) {
        if (type === 'both') return this._i18n('dataset.captionTypeBoth', 'Both');
        if (type === 'nl') return this._i18n('dataset.captionTypeNl', 'NL');
        return this._i18n('dataset.captionTypeBooru', 'Booru');
    },

    _applyCaptionTypeToLoaded(type) {
        const ids = this._loadedPreviewIds();
        if (!ids.length) return;
        for (const id of ids) this._setCaptionType(id, type);
        if (typeof window.showToast === 'function') {
            window.showToast(
                this._i18n('dataset.captionTypeApplied', 'Set {count} image(s) to "{type}".',
                    { count: ids.length, type: this._captionTypeDisplayLabel(type) }),
                'success'
            );
        }
        this._renderPreviewWorkbench();
    },

    _autoAssignTypesLoaded() {
        const ids = this._loadedPreviewIds();
        if (!ids.length) return;
        let both = 0;
        let booru = 0;
        for (const id of ids) {
            const hasNl = String(this._getNlText(id) || '').trim().length > 0;
            this._setCaptionType(id, hasNl ? 'both' : 'booru');
            if (hasNl) both += 1; else booru += 1;
        }
        if (typeof window.showToast === 'function') {
            window.showToast(
                this._i18n('dataset.captionTypeAutoDone', 'Auto: {both} both (have a sentence), {booru} booru.',
                    { both, booru }),
                'success'
            );
        }
        this._renderPreviewWorkbench();
    },

    _normalizeTransformToken(token) {
        return String(token || '').replace(/_/g, ' ').split(/\s+/).join(' ').trim().toLowerCase();
    },

    _addCaptionTransform(kind, token) {
        const clean = String(token || '').trim();
        if (!clean) return;
        if (!this.captionTransforms || typeof this.captionTransforms !== 'object') {
            this.captionTransforms = { prepend: [], append: [], remove: [], remove_categories: [], dedupe: false };
        }
        const key = kind === 'append' ? 'append' : kind === 'remove' ? 'remove' : 'prepend';
        const arr = Array.isArray(this.captionTransforms[key]) ? this.captionTransforms[key] : [];
        const normalized = this._normalizeTransformToken(clean);
        if (!arr.some((item) => this._normalizeTransformToken(item) === normalized)) {
            arr.push(clean);
        }
        this.captionTransforms[key] = arr;
        if (key === 'remove') {
            this.captionTransforms.prepend = (this.captionTransforms.prepend || [])
                .filter((item) => this._normalizeTransformToken(item) !== normalized);
            this.captionTransforms.append = (this.captionTransforms.append || [])
                .filter((item) => this._normalizeTransformToken(item) !== normalized);
        }
    },

    _addCaptionCategoryTransform(category) {
        const clean = String(category || '').trim().toLowerCase();
        if (!clean) return;
        if (!this.captionTransforms || typeof this.captionTransforms !== 'object') {
            this.captionTransforms = { prepend: [], append: [], remove: [], remove_categories: [], dedupe: false };
        }
        const arr = Array.isArray(this.captionTransforms.remove_categories)
            ? this.captionTransforms.remove_categories
            : [];
        if (!arr.includes(clean)) arr.push(clean);
        this.captionTransforms.remove_categories = arr;
    },

    _applyCaptionTransformsToText(text) {
        const transforms = this.captionTransforms || {};
        const prepend = Array.isArray(transforms.prepend) ? transforms.prepend : [];
        const append = Array.isArray(transforms.append) ? transforms.append : [];
        const remove = Array.isArray(transforms.remove) ? transforms.remove : [];
        const removeCategories = Array.isArray(transforms.remove_categories) ? transforms.remove_categories : [];
        const dedupe = !!transforms.dedupe || prepend.length || append.length || remove.length || removeCategories.length;
        if (!prepend.length && !append.length && !remove.length && !removeCategories.length && !dedupe) return String(text || '');
        const removeSet = new Set(remove.map((token) => this._normalizeTransformToken(token)));
        const tokens = this._splitCaptionTokens(text)
            .filter((token) => !removeSet.has(this._normalizeTransformToken(token)));
        const merged = [...prepend, ...tokens, ...append];
        if (!dedupe) return merged.join(', ');
        const seen = new Set();
        const out = [];
        for (const token of merged) {
            const key = this._normalizeTransformToken(token);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(token);
        }
        return out.join(', ');
    },

    collectCaptionTransforms() {
        const transforms = this.captionTransforms || {};
        const payload = {};
        for (const key of ['prepend', 'append', 'remove', 'remove_categories']) {
            const values = Array.isArray(transforms[key])
                ? transforms[key].map((item) => String(item || '').trim()).filter(Boolean)
                : [];
            if (values.length) payload[key] = values;
        }
        if (transforms.dedupe) payload.dedupe = true;
        return Object.keys(payload).length ? payload : null;
    },

    _queueActionCount() {
        return this.queueTotalCount || this.queueImageIds?.length || this.previewResults?.length || 0;
    },

    _splitCaptionTokens(value) {
        return String(value || '')
            .replace(/\n/g, ',')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
    },

    _joinCaptionTokens(tokens) {
        const seen = new Set();
        const output = [];
        for (const raw of tokens || []) {
            const token = String(raw || '').trim();
            if (!token) continue;
            const key = token.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            output.push(token);
        }
        return output.join(', ');
    },

    _normalizeCaptionToken(token) {
        return String(token || '').split(/\s+/).join(' ').trim().toLowerCase();
    },

    _getBlacklistTokens() {
        const raw = document.getElementById('batch-export-blacklist')?.value || '';
        return raw.split(',').map((part) => part.trim()).filter(Boolean);
    },

    _getLoraBoilerplateTokens() {
        return [
            'newest', 'highres', 'normal quality',
            'score_1', 'score_2', 'score_3', 'score_4', 'score_5', 'score_6', 'score_7', 'score_8', 'score_9',
            'safe', 'sensitive', 'questionable', 'explicit',
            'rating_safe', 'rating_sensitive', 'rating_questionable', 'rating_explicit',
        ];
    },

    _applyTokenToCaption(imageId, token, mode, position = 'prepend') {
        const clean = String(token || '').trim();
        if (!clean) return;
        const id = Number(imageId);
        const tokens = this._splitCaptionTokens(this._getRenderedCaption(id));
        const key = clean.toLowerCase();
        let next;
        if (mode === 'remove') {
            next = tokens.filter((part) => part.toLowerCase() !== key);
        } else if (position === 'prepend') {
            next = tokens.includes(clean) ? tokens : [clean, ...tokens];
        } else {
            next = tokens.includes(clean) ? tokens : [...tokens, clean];
        }
        this._setPreviewCaption(id, this._joinCaptionTokens(next));
    },

    async _ensurePreviewCaptionsLoaded(ids) {
        const unloaded = ids.filter(id => !this.previewCache.has(id) && !this.editedCaptions.has(id));
        if (unloaded.length > 0) {
            const batchSize = 200;
            for (let i = 0; i < unloaded.length; i += batchSize) {
                const batch = unloaded.slice(i, i + batchSize);
                try {
                    const opts = this._getCurrentExportOptions();
                    const r = await fetch('/api/tags/export-preview', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image_ids: batch, ...opts }),
                    });
                    if (r.ok) {
                        const data = await r.json();
                        for (const item of (data.results || data || [])) {
                            const itemId = Number(item.image_id);
                            if (!this.previewCache.has(itemId)) {
                                this.previewCache.set(itemId, item.rendered || '');
                            }
                            this._seedNlFromPreviewItem(item);
                        }
                    }
                } catch (_) { /* best effort */ }
            }
        }
    },

    async _applyTokenToAll(token, mode, position = 'prepend') {
        const transformKey = mode === 'remove' ? 'remove' : (position === 'append' ? 'append' : 'prepend');
        this._addCaptionTransform(transformKey, token);
        const loadedIds = new Set([
            ...Array.from(this.previewCache.keys()).map(Number),
            ...Array.from(this.editedCaptions.keys()).map(Number),
            ...this.previewResults.map(item => Number(item.image_id)),
        ]);
        for (const id of loadedIds) {
            if (Number.isFinite(id) && id > 0) this._applyTokenToCaption(id, token, mode, position);
        }
        this._renderPreviewWorkbench();
    },

    _cleanupPreviewCaption(imageId, options = {}) {
        const id = Number(imageId);
        let tokens = this._splitCaptionTokens(this._getRenderedCaption(id));
        const removeSet = new Set();
        if (options.blacklist) {
            for (const token of this._getBlacklistTokens()) removeSet.add(this._normalizeCaptionToken(token));
        }
        if (options.boilerplate) {
            for (const token of this._getLoraBoilerplateTokens()) removeSet.add(this._normalizeCaptionToken(token));
        }
        if (removeSet.size) {
            tokens = tokens.filter((token) => !removeSet.has(this._normalizeCaptionToken(token)));
        }
        if (options.dedupe || removeSet.size) {
            this._setPreviewCaption(id, this._joinCaptionTokens(tokens));
        }
    },

    async _cleanupAllPreviewCaptions(options = {}) {
        if (options.dedupe) this.captionTransforms.dedupe = true;
        if (options.blacklist) {
            for (const token of this._getBlacklistTokens()) this._addCaptionTransform('remove', token);
        }
        if (options.boilerplate) {
            for (const token of this._getLoraBoilerplateTokens()) this._addCaptionTransform('remove', token);
        }
        const ids = Array.from(new Set([
            ...Array.from(this.previewCache.keys()).map(Number),
            ...Array.from(this.editedCaptions.keys()).map(Number),
            ...this.previewResults.map(item => Number(item.image_id)),
        ])).filter((id) => Number.isFinite(id) && id > 0);
        for (const id of ids) {
            this._cleanupPreviewCaption(id, options);
        }
        this._renderPreviewWorkbench();
    },

    async _removeTagsByCategory(category) {
        const clean = String(category || '').trim().toLowerCase();
        if (!clean) return;
        const count = this._queueActionCount();
        if (!confirm(this._i18n('batchExport.confirmCategoryRemoveAll', `Remove ${clean} tags from all ${count} images during export?`, { count, category: clean }))) return;
        this._addCaptionCategoryTransform(clean);

        // Update the loaded preview sample best-effort so the user sees the
        // rule took effect. The actual full selection is handled by the backend
        // transform at export time, including images that are not loaded in the
        // virtual queue.
        const ids = this.queueImageIds.length ? this.queueImageIds : this.previewResults.map(item => Number(item.image_id));
        try {
            await this._ensurePreviewCaptionsLoaded(ids);
            const allTokens = new Set();
            for (const id of ids) {
                for (const token of this._splitCaptionTokens(this._getRenderedCaption(id))) {
                    allTokens.add(token);
                }
            }
            if (allTokens.size) {
                const resp = await fetch('/api/prompts/categorize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify([...allTokens]),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const toRemove = (data.results || [])
                        .filter(item => String(item.category || '').toLowerCase() === clean)
                        .map(item => item.tag);
                    for (const tag of toRemove) {
                        this._addCaptionTransform('remove', tag);
                    }
                }
            }
        } catch (_) { /* backend export still applies remove_categories */ }
        this._renderPreviewWorkbench();
    },

    async _copyCurrentPreviewCaption() {
        const active = this._getPreviewItem();
        if (!active) return;
        const text = this._getRenderedCaption(active.image_id);
        try {
            await navigator.clipboard.writeText(text);
            window.showToast?.(
                this._i18n('batchExport.copyCurrentCaptionDone', 'Current caption copied.'),
                'success'
            );
        } catch (error) {
            window.showToast?.(
                this._i18n('batchExport.copyCurrentCaptionFailed', 'Could not copy the current caption.'),
                'error'
            );
        }
    },

    _resetPreviewCaption(imageId) {
        this.editedCaptions.delete(Number(imageId));
        this.editedNl.delete(Number(imageId));
        this.captionTypes.delete(Number(imageId));
        this._renderPreviewWorkbench();
    },

    _resetAllPreviewCaptions() {
        const ids = this.queueImageIds.length ? this.queueImageIds : this.previewResults.map(item => Number(item.image_id));
        for (const id of ids) {
            this.editedCaptions.delete(Number(id));
            this.editedNl.delete(Number(id));
            this.captionTypes.delete(Number(id));
        }
        this.captionTransforms = { prepend: [], append: [], remove: [], remove_categories: [], dedupe: false };
        this._renderPreviewWorkbench();
    },

    collectEditedCaptionOverrides() {
        const overrides = {};
        for (const [id, text] of this.editedCaptions.entries()) {
            const numericId = Number(id);
            if (Number.isFinite(numericId) && numericId > 0) {
                overrides[numericId] = String(text || '');
            }
        }
        return Object.keys(overrides).length ? overrides : null;
    },

    /** Aurora #25c: per-image caption types for the export payload. Resolves
     *  every loaded image through _getCaptionType so the auto-both rule
     *  (NL-bearing images default to 'both') reaches the backend exactly as the
     *  Dataset Maker's _buildExportPayload does — the export matches the
     *  preview. A missing key means 'booru' on the backend, so only 'nl'/'both'
     *  need sending; explicit user choices are already resolved in _getCaptionType. */
    collectCaptionTypes() {
        // If caption-core.js somehow failed to load, the preview never
        // composes — keep the payload consistent so the user can't get an
        // export that differs from what the editor showed.
        if (!window.CaptionCore) return null;
        const map = {};
        const ids = new Set([
            ...this._loadedPreviewIds(),
            ...Array.from(this.captionTypes.keys()).map(Number),
        ]);
        for (const rawId of ids) {
            const numericId = Number(rawId);
            if (!Number.isFinite(numericId) || numericId <= 0) continue;
            const type = this._getCaptionType(numericId);
            if (type === 'nl' || type === 'both') {
                map[numericId] = type;
            }
        }
        return Object.keys(map).length ? map : null;
    },

    /** Aurora #25c: user-edited NL sentences ('' = suppress the stored one). */
    collectNlOverrides() {
        if (!window.CaptionCore) return null;  // mirror collectCaptionTypes
        const map = {};
        for (const [id, text] of this.editedNl.entries()) {
            const numericId = Number(id);
            if (Number.isFinite(numericId) && numericId > 0) {
                map[numericId] = String(text || '');
            }
        }
        return Object.keys(map).length ? map : null;
    },
});
