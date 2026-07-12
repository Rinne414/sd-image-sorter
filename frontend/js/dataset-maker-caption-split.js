/**
 * Dataset Maker — two-box caption editor (points 2 & 3).
 *
 * Splits the single caption editor into a BOORU-tags box (the existing
 * ``#dataset-editor-textarea`` — kept verbatim so all tag tooling, pills,
 * dedupe, undo, find/replace keep working against ``captions``/``captionEdits``)
 * and a parallel NATURAL-LANGUAGE box (``#dataset-editor-nl`` backed by
 * ``nlCaptions``/``nlEdits``). A per-image type toggle (booru | nl | both)
 * decides what each image exports, with bulk + auto helpers so the user never
 * has to tick boxes one image at a time on a large set.
 *
 * The export side is handled in the backend (per-image NL compose) — this module
 * only feeds ``image_types`` + ``image_nl_overrides`` via _buildExportPayload
 * (see local-import). Loaded LAST so its hooks/decorators register after the
 * part2 + local-import + pipeline ones.
 */
(function () {
    'use strict';

    const DM = window.DatasetMaker;
    if (!DM) return;

    const TYPES = ['booru', 'nl', 'both'];

    // ---------- per-image resolution helpers ----------
    DM._nlTextFor = function (id) {
        const n = Number(id);
        if (this.nlEdits.has(n)) return this.nlEdits.get(n) || '';
        return this.nlCaptions.get(n) || '';
    };

    DM._booruTextFor = function (id) {
        const n = Number(id);
        if (this.captionEdits.has(n)) return this.captionEdits.get(n) || '';
        return this.captions.get(n) || '';
    };

    // Effective type. An explicit user choice wins; otherwise "auto": images
    // that have a natural-language sentence default to "both" (so VLM captions
    // surface and export), the rest to "booru" (the pre-feature behavior).
    // The rule itself lives in CaptionCore so this editor and the v321
    // batch-export caption editor can never drift apart.
    DM._captionTypeFor = function (id) {
        const n = Number(id);
        const explicit = this.captionType.has(n) ? this.captionType.get(n) : null;
        const hasNl = String(this._nlTextFor(n) || '').trim().length > 0;
        if (window.CaptionCore) {
            return window.CaptionCore.effectiveType(explicit, hasNl, { autoBoth: true });
        }
        if (explicit) return explicit;
        return hasNl ? 'both' : 'booru';
    };

    // ---------- visibility ----------
    DM._applyCaptionBoxVisibility = function () {
        const typeWrap = document.getElementById('dataset-caption-type');
        const booruLabel = document.getElementById('dataset-booru-label');
        const ta = document.getElementById('dataset-editor-textarea');
        const pills = document.getElementById('dataset-tag-pills-section');
        const nlLabel = document.getElementById('dataset-nl-label');
        const nlBox = document.getElementById('dataset-editor-nl');

        if (this.activeId == null) {
            for (const el of [typeWrap, booruLabel, nlLabel, nlBox]) if (el) el.hidden = true;
            return;
        }

        const type = this._captionTypeFor(this.activeId);
        const showBooru = type === 'booru' || type === 'both';
        const showNl = type === 'nl' || type === 'both';

        if (typeWrap) typeWrap.hidden = false;
        if (booruLabel) booruLabel.hidden = !showBooru;
        if (ta) ta.hidden = !showBooru;
        // The tag pills follow the booru box; _renderTagPills un-hides itself
        // when there is an active image, so only force-hide it here.
        if (pills && !showBooru) pills.hidden = true;
        if (nlLabel) nlLabel.hidden = !showNl;
        if (nlBox) nlBox.hidden = !showNl;

        if (typeWrap) {
            for (const btn of typeWrap.querySelectorAll('.dataset-caption-type-btn')) {
                const on = btn.dataset.captionType === type;
                btn.classList.toggle('is-active', on);
                btn.setAttribute('aria-checked', on ? 'true' : 'false');
            }
        }
    };

    // Populate the NL box for the active image + apply visibility. The booru
    // textarea is populated by the base/local _setActive already.
    DM._refreshActiveCaptionBoxes = function () {
        if (this.activeId != null) {
            const nlBox = document.getElementById('dataset-editor-nl');
            if (nlBox) nlBox.value = this._nlTextFor(this.activeId);
        }
        this._applyCaptionBoxVisibility();
    };

    // ---------- set / bulk / auto ----------
    DM._setCaptionType = function (id, type, opts = {}) {
        const n = Number(id);
        if (!TYPES.includes(type)) return;
        this.captionType.set(n, type);
        if (Number(this.activeId) === n) this._refreshActiveCaptionBoxes();
        this._refreshQueueItem?.(n);
        if (!opts.silent) {
            this._scheduleSaveSession?.();
            this._refreshExportPreview?.();
        }
    };

    DM._applyCaptionTypeToScope = function (type, scope) {
        if (!TYPES.includes(type)) return;
        const ids = scope === 'selected'
            ? Array.from(this._queueSelection || []).map(Number)
            : Array.from(this.imageIds || []).map(Number);
        if (!ids.length) {
            this._toast(this._t('dataset.captionTypeNoScope',
                scope === 'selected' ? 'Select queue images first.' : 'No images in the queue.'),
                'warning', 2500);
            return;
        }
        for (const id of ids) this.captionType.set(id, type);
        this._refreshActiveCaptionBoxes();
        this._renderQueue?.();
        this._scheduleSaveSession?.();
        this._refreshExportPreview?.();
        const label = this._captionTypeLabel(type);
        this._toast(this._t('dataset.captionTypeApplied',
            'Set {count} image(s) to "{type}".', { count: ids.length, type: label }), 'success', 2500);
    };

    // Auto rule: images that HAVE a natural-language sentence become "both"
    // (tags + sentence), everything else stays "booru". One click instead of
    // ticking thousands of boxes.
    DM._autoAssignCaptionTypes = function () {
        const ids = Array.from(this.imageIds || []).map(Number);
        if (!ids.length) {
            this._toast(this._t('dataset.captionTypeNoScope', 'No images in the queue.'), 'warning', 2500);
            return;
        }
        let both = 0;
        let booru = 0;
        for (const id of ids) {
            const hasNl = String(this._nlTextFor(id) || '').trim().length > 0;
            this.captionType.set(id, hasNl ? 'both' : 'booru');
            if (hasNl) both += 1; else booru += 1;
        }
        this._refreshActiveCaptionBoxes();
        this._renderQueue?.();
        this._scheduleSaveSession?.();
        this._refreshExportPreview?.();
        this._toast(this._t('dataset.captionTypeAutoDone',
            'Auto: {both} both (have a sentence), {booru} booru.', { both, booru }), 'success', 3200);
    };

    DM._captionTypeLabel = function (type) {
        if (type === 'both') return this._t('dataset.captionTypeBoth', 'Both');
        if (type === 'nl') return this._t('dataset.captionTypeNl', 'NL');
        return this._t('dataset.captionTypeBooru', 'Booru');
    };

    // ---------- active-changed hook: populate NL box + type after the core runs ----------
    // Registered on the shared registry (FE-1 2b) instead of re-wrapping
    // DM._setActive; runs after part2's split/diff hooks and the confidence
    // pills hook, matching the old load-order wrapper chain.
    if (Array.isArray(DM._activeChangedHooks)) {
        DM._activeChangedHooks.push(function () {
            this._refreshActiveCaptionBoxes();
        });
    }

    // ---------- wrap _renderEmptyEditor: also clear/hide the NL box + type ----------
    const _origRenderEmpty = DM._renderEmptyEditor;
    DM._renderEmptyEditor = function () {
        if (typeof _origRenderEmpty === 'function') _origRenderEmpty.call(this);
        const nlBox = document.getElementById('dataset-editor-nl');
        if (nlBox) nlBox.value = '';
        this._applyCaptionBoxVisibility();
    };

    // ---------- wrap _renderTagPills: keep pills hidden in NL-only mode ----------
    const _origRenderTagPills = DM._renderTagPills;
    if (typeof _origRenderTagPills === 'function') {
        DM._renderTagPills = function () {
            _origRenderTagPills.call(this);
            if (this.activeId != null && this._captionTypeFor(this.activeId) === 'nl') {
                const pills = document.getElementById('dataset-tag-pills-section');
                if (pills) pills.hidden = true;
            }
            // point 4: decorate each tag pill with its (中文) reading aid.
            this._decorateTagPillsZh?.();
        };
    }

    // ---------- point 4: inline Chinese reading aid (tag → "tag (中文)") ----------
    // The Chinese is rendered in a SEPARATE child span next to each tag pill. It
    // is a reading aid ONLY and never becomes part of the tag value or the
    // exported caption — the booru box, tag removal, and export all use the
    // English tag text exclusively.
    DM._tagZhCache = DM._tagZhCache || new Map();

    DM._zhAidOn = function () {
        return !!document.getElementById('dataset-translation-show-zh')?.checked;
    };

    DM._decorateTagPillsZh = function () {
        if (!this._zhAidOn()) return;
        const wrap = document.getElementById('dataset-tag-pills-wrap');
        if (!wrap) return;
        const missing = [];
        for (const pill of wrap.querySelectorAll('.dataset-tag-pill')) {
            if (pill.querySelector('.dataset-tag-zh')) continue; // already decorated
            const label = pill.querySelector('span');
            const tag = (label?.textContent || '').trim();
            if (!tag) continue;
            const zh = this._tagZhCache.get(tag.toLowerCase());
            if (zh) {
                const span = document.createElement('span');
                span.className = 'dataset-tag-zh';
                span.textContent = ` (${zh})`;
                const x = pill.querySelector('.dataset-tag-pill-x');
                if (x) pill.insertBefore(span, x); else pill.appendChild(span);
            } else if (zh === undefined) {
                missing.push(tag);
            }
        }
        if (missing.length) this._fetchTagZh(missing);
    };

    DM._fetchTagZh = function (tags) {
        const unique = Array.from(new Set((tags || []).map((t) => String(t).trim()).filter(Boolean)))
            .filter((t) => !this._tagZhCache.has(t.toLowerCase()));
        if (!unique.length) return;
        if (this._zhFetchInFlight) { this._zhFetchPending = true; return; }
        const batch = unique.slice(0, 200);
        this._zhFetchInFlight = true;
        fetch('/api/dataset/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                texts: batch,
                mode: 'tags',
                target_lang: 'zh-CN',
                provider_mode: document.getElementById('dataset-translation-provider-mode')?.value || 'vlm',
                external_provider: document.getElementById('dataset-translation-external-provider')?.value || '',
                prompt: document.getElementById('dataset-translation-prompt')?.value || '',
            }),
        }).then((r) => (r.ok ? r.json() : null)).then((body) => {
            const translations = (body && body.translations) || [];
            batch.forEach((tag, i) => {
                this._tagZhCache.set(tag.toLowerCase(), String(translations[i] || '').trim());
            });
            if (this._zhAidOn()) this._renderTagPills?.();
        }).catch(() => {
            // Mark as attempted (empty) so a failing provider isn't hammered.
            batch.forEach((tag) => {
                if (!this._tagZhCache.has(tag.toLowerCase())) this._tagZhCache.set(tag.toLowerCase(), '');
            });
        }).finally(() => {
            this._zhFetchInFlight = false;
            if (this._zhFetchPending) {
                this._zhFetchPending = false;
                if (this._zhAidOn()) this._decorateTagPillsZh();
            }
        });
    };

    // ---------- queue-item decorator: add a small type chip ----------
    // Registered on part2's decorator registry (FE-1 2b) instead of
    // re-wrapping _buildQueueItem; runs after local-import's decorator,
    // matching the old load-order wrapper chain.
    if (Array.isArray(DM._queueItemDecorators)) {
        DM._queueItemDecorators.push(function (item, id) {
            try {
                const type = this._captionTypeFor(id);
                if (type === 'nl' || type === 'both') {
                    const chip = document.createElement('span');
                    chip.className = `dataset-queue-captype dataset-queue-captype-${type}`;
                    // Chip short label goes through i18n so the two-letter
                    // abbreviation can be localized if a locale needs it.
                    chip.textContent = type === 'both'
                        ? (this._t('dataset.captionTypeChipBoth', 'B+N') || 'B+N')
                        : (this._t('dataset.captionTypeChipNl', 'NL') || 'NL');
                    chip.title = type === 'both'
                        ? this._t('dataset.captionTypeBothTip', 'Exports tags, then the sentence')
                        : this._t('dataset.captionTypeNlTip', 'Exports the sentence only');
                    const metaWrap = item.querySelector('.dataset-queue-meta');
                    (metaWrap || item).appendChild(chip);
                }
            } catch (_e) { /* chip is cosmetic */ }
        });
    }

    // ---------- bind events once ----------
    function bind() {
        if (DM._captionSplitBound) return;
        DM._captionSplitBound = true;

        // NL box -> nlEdits (debounced, mirrors the booru box's 200ms debounce)
        const nlBox = document.getElementById('dataset-editor-nl');
        if (nlBox) {
            let timer = null;
            nlBox.addEventListener('input', () => {
                if (DM.activeId == null) return;
                const id = Number(DM.activeId);
                const value = nlBox.value;
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = null;
                    DM.nlEdits.set(id, value);
                    DM._refreshQueueItem?.(id);
                    DM._scheduleSaveSession?.();
                    DM._refreshExportPreview?.();
                }, 200);
            });
        }

        // Per-image type segmented control (delegated).
        const typeWrap = document.getElementById('dataset-caption-type');
        if (typeWrap) {
            typeWrap.addEventListener('click', (e) => {
                const btn = e.target.closest('.dataset-caption-type-btn');
                if (!btn || DM.activeId == null) return;
                DM._setCaptionType(DM.activeId, btn.dataset.captionType);
            });
        }

        const activeType = () => (DM.activeId != null ? DM._captionTypeFor(DM.activeId) : 'both');
        document.getElementById('btn-dataset-captype-selected')
            ?.addEventListener('click', () => DM._applyCaptionTypeToScope(activeType(), 'selected'));
        document.getElementById('btn-dataset-captype-all')
            ?.addEventListener('click', () => DM._applyCaptionTypeToScope(activeType(), 'all'));
        document.getElementById('btn-dataset-captype-auto')
            ?.addEventListener('click', () => DM._autoAssignCaptionTypes());

        // point 4: Chinese reading-aid toggle + provider changes re-render pills.
        document.getElementById('dataset-translation-show-zh')
            ?.addEventListener('change', () => DM._renderTagPills?.());
        for (const id of ['dataset-translation-provider-mode',
                          'dataset-translation-external-provider',
                          'dataset-translation-prompt']) {
            document.getElementById(id)?.addEventListener('change', () => {
                // Provider / prompt changed → previously cached translations are
                // stale; drop them and re-decorate if the aid is on.
                DM._tagZhCache.clear();
                if (DM._zhAidOn()) DM._renderTagPills?.();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
