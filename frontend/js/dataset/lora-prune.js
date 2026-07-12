/**
 * Dataset Maker — LoRA-type tag pruning (non-destructive blacklist append; wraps DM.init — the ONLY module allowed to wrap init).
 * Moved VERBATIM from dataset-maker-cleanups.js L1-416 (whole file).
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
/**
 * Dataset Maker — LoRA-type tag pruning (export blacklist, non-destructive).
 *
 * Replaces the old five fixed "quick remove a category" buttons. The user
 * picks a LoRA training type, which pre-ticks the tag CATEGORIES that type
 * usually wants dropped from captions; every category is then an independent
 * checkbox so the quick default can be fine-tuned. Categories come from the
 * same authoritative 14-class danbooru classifier the caption pills use
 * (DM._classifyTagCategory / DM._ensureTagCategories, backed by
 * POST /api/prompts/categorize), so the colors ticked here match the pill
 * colors exactly — and the checkbox row doubles as an interactive color legend.
 *
 * "Pruning" is NON-DESTRUCTIVE: matched tags are appended to the export
 * blacklist textarea (#dataset-blacklist) and removed from the common-tags box.
 * Original DB tags are untouched; the export engine drops blacklisted tags at
 * caption-render time. Power users can still hand-edit the blacklist, or use
 * the gallery filter's exclude-tags path for the same effect at query time.
 *
 * Why this lives in its own file: keeps the dataset-maker module chunks small
 * and reviewable, and isolates the LoRA-type preset knowledge in one place.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // The 14 danbooru categories, in caption order. 'unknown' is shown in the
    // color legend but is NOT a prunable checkbox — we never blanket-drop
    // unclassified tags. The color CLASS reused on each chip/checkbox/swatch is
    // the same pill rule from frontend/css/dataset-maker.css, so there is one
    // source of truth for the palette.
    const CATEGORY_META = [
        { key: 'quality',    emoji: '🛡️', i18n: 'dataset.cat.quality',    desc: 'dataset.cat.qualityDesc' },
        { key: 'meta',       emoji: '🏷️', i18n: 'dataset.cat.meta',       desc: 'dataset.cat.metaDesc' },
        { key: 'rating',     emoji: '🔞', i18n: 'dataset.cat.rating',     desc: 'dataset.cat.ratingDesc' },
        { key: 'character',  emoji: '🪪', i18n: 'dataset.cat.character',  desc: 'dataset.cat.characterDesc' },
        { key: 'body',       emoji: '👤', i18n: 'dataset.cat.body',       desc: 'dataset.cat.bodyDesc' },
        { key: 'outfit',     emoji: '👗', i18n: 'dataset.cat.outfit',     desc: 'dataset.cat.outfitDesc' },
        { key: 'expression', emoji: '😊', i18n: 'dataset.cat.expression', desc: 'dataset.cat.expressionDesc' },
        { key: 'pose',       emoji: '🧍', i18n: 'dataset.cat.pose',       desc: 'dataset.cat.poseDesc' },
        { key: 'action',     emoji: '🏃', i18n: 'dataset.cat.action',     desc: 'dataset.cat.actionDesc' },
        { key: 'angle',      emoji: '🎥', i18n: 'dataset.cat.angle',      desc: 'dataset.cat.angleDesc' },
        { key: 'background', emoji: '🏞️', i18n: 'dataset.cat.background', desc: 'dataset.cat.backgroundDesc' },
        { key: 'style',      emoji: '🎨', i18n: 'dataset.cat.style',      desc: 'dataset.cat.styleDesc' },
        { key: 'artist',     emoji: '🖌️', i18n: 'dataset.cat.artist',     desc: 'dataset.cat.artistDesc' },
        { key: 'unknown',    emoji: '❓', i18n: 'dataset.cat.unknown',    desc: 'dataset.cat.unknownDesc' },
    ];
    const PRUNABLE = CATEGORY_META.filter((c) => c.key !== 'unknown');
    const PRUNABLE_KEYS = new Set(PRUNABLE.map((c) => c.key));

    // LoRA type -> default-ticked categories. QUICK DEFAULTS only: the user can
    // tick/untick anything afterwards (which flips the type select to "custom").
    // quality/meta/rating are training noise dropped for every type. The
    // judgment-call extras (character LoRA also dropping `outfit`, style LoRA
    // also dropping `background`) are deliberately LEFT OFF here and offered as
    // optional ticks — the hint text points them out.
    const LORA_TYPE_PRESETS = {
        character: ['character', 'body', 'quality', 'meta', 'rating'],
        style:     ['style', 'artist', 'meta', 'quality', 'rating'],
        outfit:    ['outfit', 'quality', 'meta', 'rating'],
        pose:      ['pose', 'action', 'angle', 'quality', 'meta', 'rating'],
        concept:   ['quality', 'meta', 'rating'],
        general:   ['quality', 'meta', 'rating'],
        custom:    [],
    };
    const DEFAULT_TYPE = 'character';

    let refreshInFlight = false;
    let refreshQueued = false;

    function t(key, fallback, params) {
        return typeof DM._t === 'function' ? DM._t(key, fallback, params) : (fallback || key);
    }

    function normTag(s) {
        return String(s).replace(/_/g, ' ').toLowerCase().trim();
    }

    function vocabItems() {
        return typeof DM._getDatasetVocabItems === 'function'
            ? (DM._getDatasetVocabItems() || [])
            : [];
    }

    function classify(tag) {
        return typeof DM._classifyTagCategory === 'function'
            ? DM._classifyTagCategory(tag)
            : 'unknown';
    }

    // Bucket the live vocabulary tag names by their 14-class category. Reads the
    // cached backend classification (filled by _ensureTagCategories);
    // _classifyTagCategory already falls back to the local regex first-paint
    // guess when a tag isn't cached yet.
    function tagsByCategory() {
        const buckets = Object.create(null);
        for (const meta of CATEGORY_META) buckets[meta.key] = [];
        for (const it of vocabItems()) {
            const tag = String(it.tag || '').trim();
            if (!tag) continue;
            let cat = classify(tag);
            if (!buckets[cat]) cat = 'unknown';
            buckets[cat].push({ tag, count: Number(it.count || 0) });
        }
        for (const key of Object.keys(buckets)) {
            buckets[key].sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
        }
        return buckets;
    }

    function checkedCategories() {
        return Array.from(document.querySelectorAll('#dataset-lora-prune-cats input[type="checkbox"]:checked'))
            .map((el) => el.dataset.cat)
            .filter((c) => PRUNABLE_KEYS.has(c));
    }

    function setCheckedCategories(cats) {
        const want = new Set((cats || []).filter((c) => PRUNABLE_KEYS.has(c)));
        document.querySelectorAll('#dataset-lora-prune-cats input[type="checkbox"]').forEach((el) => {
            el.checked = want.has(el.dataset.cat);
        });
    }

    // ---- UI construction ---------------------------------------------------

    function buildCheckboxes() {
        const host = document.getElementById('dataset-lora-prune-cats');
        if (!host || host.dataset.built === '1') return;
        host.innerHTML = '';
        for (const meta of PRUNABLE) {
            const label = document.createElement('label');
            // Reusing the pill color class gives each checkbox the same hue as
            // the matching caption pill, with zero palette duplication.
            label.className = `dataset-lora-cat dataset-tag-pill-category-${meta.key}`;
            label.title = t(meta.desc, '');

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.cat = meta.key;
            input.addEventListener('change', onCheckboxChange);

            const name = document.createElement('span');
            name.className = 'dataset-lora-cat-name';
            name.textContent = `${meta.emoji} ${t(meta.i18n, meta.key)}`;

            const count = document.createElement('span');
            count.className = 'dataset-lora-cat-count';
            count.dataset.countFor = meta.key;
            count.textContent = '';

            label.append(input, name, count);
            host.appendChild(label);
        }
        host.dataset.built = '1';
    }

    function renderColorLegend() {
        const body = document.getElementById('dataset-tag-color-legend-body');
        if (!body) return;
        body.innerHTML = '';
        for (const meta of CATEGORY_META) {
            const row = document.createElement('div');
            row.className = 'dataset-tag-legend-row';

            const swatch = document.createElement('span');
            swatch.className = `dataset-tag-legend-swatch dataset-tag-pill-category-${meta.key}`;
            swatch.textContent = `${meta.emoji} ${t(meta.i18n, meta.key)}`;

            const desc = document.createElement('span');
            desc.className = 'dataset-tag-legend-desc';
            desc.textContent = t(meta.desc, '');

            row.append(swatch, desc);
            body.appendChild(row);
        }
    }

    function applyTypeText(type) {
        const sel = document.getElementById('dataset-lora-type');
        if (sel && sel.value !== type) sel.value = type;
        const hint = document.getElementById('dataset-lora-type-hint');
        if (hint) {
            hint.textContent = t(`dataset.loraTypeHint.${type}`,
                t('dataset.loraTypeHint.custom',
                  'Tick the tag categories to remove from every exported caption.'));
        }
    }

    // ---- Counts + apply-button label --------------------------------------

    function updateCountsFromBuckets(buckets) {
        for (const meta of PRUNABLE) {
            const el = document.querySelector(`#dataset-lora-prune-cats [data-count-for="${meta.key}"]`);
            if (!el) continue;
            const n = (buckets[meta.key] || []).length;
            el.textContent = n > 0 ? `(${n})` : '';
        }
        updateApplyButton(buckets);
    }

    function updateApplyButton(buckets) {
        const btn = document.getElementById('btn-dataset-lora-prune-apply');
        if (!btn) return;
        const checked = checkedCategories();
        const seen = new Set();
        let total = 0;
        for (const cat of checked) {
            for (const it of (buckets[cat] || [])) {
                const k = normTag(it.tag);
                if (seen.has(k)) continue;
                seen.add(k);
                total += 1;
            }
        }
        btn.dataset.pruneTotal = String(total);
        btn.disabled = total === 0;
        btn.textContent = total > 0
            ? t('dataset.loraPruneApplyN', 'Add {count} tags to blacklist', { count: total })
            : t('dataset.loraPruneApply', 'Add to blacklist');
    }

    // Resolve real backend categories for the current vocabulary, then refresh
    // the per-category counts. Coalesces concurrent calls so a burst of
    // vocab-refresh events only triggers one classify round.
    async function refreshCounts() {
        if (!document.getElementById('dataset-lora-prune-cats')) return;
        if (refreshInFlight) { refreshQueued = true; return; }
        refreshInFlight = true;
        try {
            const names = vocabItems()
                .map((it) => String(it.tag || '').trim())
                .filter(Boolean);
            if (names.length && typeof DM._ensureTagCategories === 'function') {
                try { await DM._ensureTagCategories(names); } catch (_e) { /* keep local fallback */ }
            }
            updateCountsFromBuckets(tagsByCategory());
        } finally {
            refreshInFlight = false;
            if (refreshQueued) { refreshQueued = false; refreshCounts(); }
        }
    }

    // ---- Blacklist mutation (non-destructive, export-time) ----------------

    function appendTagsToBlacklist(tags) {
        const ta = document.getElementById('dataset-blacklist');
        if (!ta || !tags.length) return 0;

        const existing = (ta.value || '').split(',').map((s) => s.trim()).filter(Boolean);
        // Normalize for comparison so we never add a duplicate that differs only
        // by underscore-vs-space or case.
        const seen = new Set(existing.map(normTag));
        const added = [];
        for (const tag of tags) {
            const k = normTag(tag);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            added.push(tag);
        }
        if (!added.length) return 0;

        ta.value = [...existing, ...added].join(', ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));

        // Anything we just blacklisted should leave the common-tags box, or the
        // export engine would re-add it as a prepended common tag.
        const common = document.getElementById('dataset-common-tags');
        if (common) {
            const removeSet = new Set(added.map(normTag));
            const kept = (common.value || '')
                .split(',').map((s) => s.trim()).filter(Boolean)
                .filter((tag) => !removeSet.has(normTag(tag)));
            if (kept.join(', ') !== (common.value || '').trim()) {
                common.value = kept.join(', ');
                common.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        return added.length;
    }

    async function applyPrune() {
        const btn = document.getElementById('btn-dataset-lora-prune-apply');
        const cats = checkedCategories();
        if (!cats.length) {
            DM._toast(t('dataset.loraPruneNoCategory',
                'Tick at least one tag category to prune.'), 'warning', 3000);
            return;
        }
        if (btn) btn.disabled = true;
        try {
            // Make sure counts reflect the freshest vocabulary classification
            // before we collect the tags to drop.
            if ((!DM._getDatasetVocabItems || DM._getDatasetVocabItems().length === 0)
                && typeof DM._refreshVocab === 'function') {
                await DM._refreshVocab();
            }
            const names = vocabItems().map((it) => String(it.tag || '').trim()).filter(Boolean);
            if (names.length && typeof DM._ensureTagCategories === 'function') {
                try { await DM._ensureTagCategories(names); } catch (_e) { /* local fallback */ }
            }
            const buckets = tagsByCategory();
            const toAdd = [];
            for (const cat of cats) {
                for (const it of (buckets[cat] || [])) toAdd.push(it.tag);
            }
            const added = appendTagsToBlacklist(toAdd);
            if (added === 0) {
                DM._toast(t('dataset.loraPruneNothing',
                    'No matching tags in the current dataset need blacklisting.'), 'info', 3000);
            } else {
                DM._toast(t('dataset.loraPruneAdded',
                    'Added {count} tags to the blacklist.', { count: added }), 'success', 3000);
            }
            updateCountsFromBuckets(buckets);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ---- Event handlers ----------------------------------------------------

    function onTypeChange() {
        const sel = document.getElementById('dataset-lora-type');
        const type = sel?.value || 'custom';
        setCheckedCategories(LORA_TYPE_PRESETS[type] || []);
        applyTypeText(type);
        updateApplyButton(tagsByCategory());
    }

    function onCheckboxChange() {
        // A manual tick/untick means the selection no longer matches a named
        // preset — reflect that by switching the type label to "custom" unless
        // the new set still equals the active preset exactly.
        const sel = document.getElementById('dataset-lora-type');
        const current = new Set(checkedCategories());
        const active = sel?.value || 'custom';
        const preset = new Set((LORA_TYPE_PRESETS[active] || []).filter((c) => PRUNABLE_KEYS.has(c)));
        const sameAsPreset = current.size === preset.size
            && [...current].every((c) => preset.has(c));
        if (!sameAsPreset && active !== 'custom') applyTypeText('custom');
        updateApplyButton(tagsByCategory());
    }

    function onClear() {
        setCheckedCategories([]);
        applyTypeText('custom');
        updateApplyButton(tagsByCategory());
    }

    // The checkbox labels, legend, hint and apply button are built/written from
    // JS (no data-i18n), so applyToDOM won't retranslate them on a language
    // switch. Re-render their text when the app fires `languageChanged`,
    // preserving the current checked state and counts.
    function relocalize() {
        for (const meta of PRUNABLE) {
            const nameEl = document.querySelector(
                `#dataset-lora-prune-cats input[data-cat="${meta.key}"]`
            )?.parentElement?.querySelector('.dataset-lora-cat-name');
            if (nameEl) nameEl.textContent = `${meta.emoji} ${t(meta.i18n, meta.key)}`;
        }
        renderColorLegend();
        applyTypeText(document.getElementById('dataset-lora-type')?.value || 'custom');
        updateApplyButton(tagsByCategory());
    }

    // ---- Init --------------------------------------------------------------

    DM._initLoraPrune = function () {
        const host = document.getElementById('dataset-lora-prune-cats');
        if (!host) return;
        buildCheckboxes();
        renderColorLegend();

        const sel = document.getElementById('dataset-lora-type');
        if (sel && !sel.dataset.wired) {
            sel.value = DEFAULT_TYPE;
            sel.addEventListener('change', onTypeChange);
            sel.dataset.wired = '1';
        }
        const applyBtn = document.getElementById('btn-dataset-lora-prune-apply');
        if (applyBtn && !applyBtn.dataset.wired) {
            applyBtn.addEventListener('click', applyPrune);
            applyBtn.dataset.wired = '1';
        }
        const clearBtn = document.getElementById('btn-dataset-lora-prune-clear');
        if (clearBtn && !clearBtn.dataset.wired) {
            clearBtn.addEventListener('click', onClear);
            clearBtn.dataset.wired = '1';
        }

        // Apply the quick default for the initial type, set the button label
        // synchronously (so it is never the static HTML fallback), then fill
        // counts from the backend classifier.
        setCheckedCategories(LORA_TYPE_PRESETS[DEFAULT_TYPE] || []);
        applyTypeText(DEFAULT_TYPE);
        updateApplyButton(tagsByCategory());
        refreshCounts();

        if (!DM._loraPruneI18nBound) {
            document.addEventListener('languageChanged', relocalize);
            DM._loraPruneI18nBound = true;
        }
    };

    // Keep the legacy name so the existing vocab-refresh call sites in
    // dataset-maker-pipeline.js (DM._refreshCleanupButtons?.()) drive the new
    // per-category counts without changing those modules.
    DM._refreshCleanupButtons = refreshCounts;

    // Wire on view init (DM.init runs once when the view first becomes active).
    const originalInit = DM.init;
    DM.init = function () {
        originalInit.call(this);
        this._initLoraPrune();
    };
})();
