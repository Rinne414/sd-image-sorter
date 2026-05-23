/**
 * Dataset Maker — pipeline stepper + audit panel (v3.2.2 T8 + T9 frontend).
 *
 * Two pieces of UI in one file:
 *   1. ``.dataset-stepper`` — the 5-step header. Each pill scrolls to a
 *      labelled anchor inside the Dataset Maker view.
 *   2. ``#dataset-step-audit`` — the LoRA-readiness audit panel. Default
 *      collapsed. User opens it, fills the thresholds they care about
 *      (all optional), runs the audit, sees badge counts they can click
 *      to filter the queue.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ============== 5-step stepper ==============

    function bindStepper() {
        const pills = document.querySelectorAll('.dataset-stepper .dataset-step-pill');
        for (const pill of pills) {
            pill.addEventListener('click', () => {
                const target = pill.getAttribute('data-step-target');
                if (!target) return;
                const anchor = document.getElementById(target);
                if (anchor) {
                    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        }
    }

    // ============== Audit panel ==============

    const AUDIT_STATE = {
        lastReport: null,
        activeFilter: null,    // one of "low_quality", "untagged", "small", "duplicate"
    };

    function $(id) { return document.getElementById(id); }

    function setStatus(text) {
        const el = $('dataset-audit-status');
        if (el) el.textContent = text || '';
    }

    function makeBadge(flag, label, count) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dataset-audit-badge';
        btn.dataset.flag = flag;
        const lbl = document.createElement('span');
        lbl.textContent = label;
        const countEl = document.createElement('span');
        countEl.className = 'dataset-audit-badge-count';
        countEl.textContent = String(count);
        btn.append(lbl, countEl);
        btn.addEventListener('click', () => toggleFilter(flag));
        return btn;
    }

    function toggleFilter(flag) {
        AUDIT_STATE.activeFilter = (AUDIT_STATE.activeFilter === flag) ? null : flag;
        applyFilterToQueue();
        // Reflect active state in the badges
        for (const b of document.querySelectorAll('.dataset-audit-badge')) {
            b.classList.toggle('active', b.dataset.flag === AUDIT_STATE.activeFilter);
        }
    }

    function applyFilterToQueue() {
        const flag = AUDIT_STATE.activeFilter;
        const items = document.querySelectorAll('#dataset-queue-list .dataset-queue-item');
        if (!flag || !AUDIT_STATE.lastReport) {
            for (const it of items) it.classList.remove('audit-flagged');
            return;
        }
        const flaggedIds = new Set();
        const flaggedPaths = new Set();

        if (flag === 'duplicate') {
            for (const grp of (AUDIT_STATE.lastReport.duplicate_groups || [])) {
                for (const id of grp.image_ids || []) {
                    if (id > 0) flaggedIds.add(Number(id));
                }
                for (const p of grp.abs_paths || []) {
                    if (p) flaggedPaths.add(p);
                }
            }
        } else {
            for (const it of (AUDIT_STATE.lastReport.items || [])) {
                if (!(it.flags || []).includes(flag)) continue;
                if (it.image_id && it.image_id > 0) flaggedIds.add(Number(it.image_id));
                if (it.abs_path) flaggedPaths.add(String(it.abs_path));
            }
        }

        for (const it of items) {
            const id = Number(it.dataset.imageId || 0);
            const meta = DM.meta?.get?.(id) || {};
            const absPath = meta.abs_path || '';
            const match = (id > 0 && flaggedIds.has(id))
                || (absPath && flaggedPaths.has(absPath));
            it.classList.toggle('audit-flagged', !!match);
        }
    }

    function renderResults(report) {
        AUDIT_STATE.lastReport = report;
        const wrap = $('dataset-audit-results');
        const badges = $('dataset-audit-badges');
        if (!wrap || !badges) return;
        badges.innerHTML = '';

        const t = (key, fb) => DM._t(key, fb);
        const summary = report.summary || {};
        const dupes = (report.duplicate_groups || []).length;

        if ((summary.low_quality_count || 0) > 0) {
            badges.appendChild(makeBadge('low_quality', t('dataset.auditBadgeLowQuality', 'Low quality'), summary.low_quality_count));
        }
        if (dupes > 0) {
            badges.appendChild(makeBadge('duplicate', t('dataset.auditBadgeDuplicate', 'Duplicates'), dupes));
        }
        if ((summary.untagged_count || 0) > 0) {
            badges.appendChild(makeBadge('untagged', t('dataset.auditBadgeUntagged', 'Untagged'), summary.untagged_count));
        }
        if ((summary.small_count || 0) > 0) {
            badges.appendChild(makeBadge('small', t('dataset.auditBadgeSmall', 'Small'), summary.small_count));
        }
        if (badges.children.length === 0) {
            const ok = document.createElement('span');
            ok.className = 'dataset-audit-status';
            ok.textContent = t('dataset.auditAllClean', 'No issues found in the active checks.');
            badges.appendChild(ok);
        }

        wrap.hidden = false;
        const dlBtn = $('btn-dataset-audit-download');
        if (dlBtn) dlBtn.hidden = false;
    }

    async function runAudit() {
        if (!DM.imageIds || DM.imageIds.length === 0) {
            setStatus(DM._t('dataset.auditNoImages', 'Add some images first.'));
            return;
        }

        const aMax = ($('dataset-audit-aesthetic-max')?.value || '').trim();
        const pMax = ($('dataset-audit-phash-max')?.value || '').trim();
        const dMin = ($('dataset-audit-dim-min')?.value || '').trim();

        const aestheticMax = aMax === '' ? null : Number(aMax);
        const phashMax = pMax === '' ? null : parseInt(pMax, 10);
        const dimMin = dMin === '' ? null : parseInt(dMin, 10);

        // Split into image_ids (positive) and image_paths (resolved
        // from negative ds_id-derived ids).
        const imageIds = [];
        const imagePaths = [];
        for (const id of DM.imageIds) {
            if (DM.isLocalId && DM.isLocalId(id)) {
                const p = DM.localItemPaths?.get?.(id);
                if (p) imagePaths.push(p);
            } else {
                imageIds.push(Number(id));
            }
        }

        // Local items have no DB tags; supply a per-path tag count
        // proxy derived from whether captionEdits has a non-empty
        // string for them. The audit treats >0 as "tagged".
        const extraTagCounts = {};
        if (DM.localItemPaths) {
            for (const [id, absPath] of DM.localItemPaths.entries()) {
                const edit = DM.captionEdits?.get?.(id);
                if (edit && String(edit).trim()) {
                    // Use the comma count + 1 as a rough tag count.
                    extraTagCounts[absPath] = String(edit).split(',').filter(Boolean).length || 1;
                }
            }
        }

        setStatus(DM._t('dataset.auditRunning', 'Running audit...'));
        const btn = $('btn-dataset-audit-run');
        if (btn) btn.disabled = true;

        try {
            const r = await fetch('/api/dataset/audit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: imageIds,
                    image_paths: imagePaths,
                    aesthetic_max: aestheticMax,
                    phash_max: phashMax,
                    dim_min: dimMin,
                    enable_aesthetic: aestheticMax !== null,
                    enable_phash: phashMax !== null,
                    extra_tag_counts: extraTagCounts,
                }),
            });
            if (!r.ok) {
                const body = await r.text();
                setStatus(`HTTP ${r.status}: ${body.slice(0, 200)}`);
                return;
            }
            const data = await r.json();
            renderResults(data);
            const counts = data.summary || {};
            setStatus(DM._t('dataset.auditDoneStatus',
                'Audit complete: {low} low-quality, {dupes} duplicate groups, {untagged} untagged, {small} small.',
                {
                    low: counts.low_quality_count || 0,
                    dupes: (data.duplicate_groups || []).length,
                    untagged: counts.untagged_count || 0,
                    small: counts.small_count || 0,
                }));
        } catch (e) {
            setStatus(e.message || String(e));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function downloadReport() {
        if (!AUDIT_STATE.lastReport) return;
        const blob = new Blob([JSON.stringify(AUDIT_STATE.lastReport, null, 2)],
                              { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dataset-audit-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function bindAudit() {
        $('btn-dataset-audit-run')?.addEventListener('click', runAudit);
        $('btn-dataset-audit-download')?.addEventListener('click', downloadReport);
    }

    // ============== Tag Vocabulary panel (T10) ==============

    const VOCAB_STATE = {
        items: [],            // [{tag, count, sample_image_id}, ...]
        filter: '',
        states: new Map(),    // tag -> 'common' | 'blacklist' | undefined
    };

    function readTextareaList(id) {
        return new Set(
            String(document.getElementById(id)?.value || '')
                .split(',').map((s) => s.trim()).filter(Boolean)
        );
    }

    function writeTextareaList(id, set) {
        const ta = document.getElementById(id);
        if (!ta) return;
        ta.value = Array.from(set).join(', ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function syncVocabStateFromTextareas() {
        VOCAB_STATE.states.clear();
        const common = readTextareaList('dataset-common-tags');
        const blacklist = readTextareaList('dataset-blacklist');
        for (const t of common) VOCAB_STATE.states.set(t, 'common');
        for (const t of blacklist) VOCAB_STATE.states.set(t, 'blacklist');
    }

    function cycleTag(tag) {
        const common = readTextareaList('dataset-common-tags');
        const blacklist = readTextareaList('dataset-blacklist');
        if (common.has(tag)) {
            // common -> blacklist
            common.delete(tag);
            blacklist.add(tag);
        } else if (blacklist.has(tag)) {
            // blacklist -> neutral
            blacklist.delete(tag);
        } else {
            // neutral -> common
            common.add(tag);
        }
        writeTextareaList('dataset-common-tags', common);
        writeTextareaList('dataset-blacklist', blacklist);
        syncVocabStateFromTextareas();
        renderVocab();
    }

    function renderVocab() {
        const list = $('dataset-vocab-list');
        const count = $('dataset-vocab-count');
        if (!list) return;
        list.innerHTML = '';
        const filter = (VOCAB_STATE.filter || '').toLowerCase();
        const items = VOCAB_STATE.items.filter((it) => !filter || String(it.tag).toLowerCase().includes(filter));
        for (const it of items) {
            const node = document.createElement('button');
            node.type = 'button';
            node.className = 'dataset-vocab-tag';
            const state = VOCAB_STATE.states.get(it.tag);
            if (state) node.classList.add(`state-${state}`);
            const lbl = document.createElement('span');
            lbl.textContent = it.tag;
            const c = document.createElement('span');
            c.className = 'dataset-vocab-tag-count';
            c.textContent = String(it.count);
            node.append(lbl, c);
            node.addEventListener('click', () => cycleTag(it.tag));
            list.appendChild(node);
        }
        if (count) {
            count.textContent = `${items.length} / ${VOCAB_STATE.items.length}`;
        }
    }

    async function refreshVocab() {
        if (!DM.imageIds || DM.imageIds.length === 0) {
            VOCAB_STATE.items = [];
            renderVocab();
            return;
        }
        const galleryIds = [];
        const localCaptions = {};
        for (const id of DM.imageIds) {
            if (DM.isLocalId && DM.isLocalId(id)) {
                const p = DM.localItemPaths?.get?.(id);
                const cap = DM.captionEdits?.get?.(id);
                if (p && cap) localCaptions[p] = cap;
            } else {
                galleryIds.push(Number(id));
            }
        }
        try {
            const r = await fetch('/api/dataset/vocab', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: galleryIds,
                    path_caption_overrides: localCaptions,
                    top_n: 300,
                }),
            });
            if (!r.ok) return;
            const data = await r.json();
            VOCAB_STATE.items = data.vocab || [];
            syncVocabStateFromTextareas();
            renderVocab();
        } catch { /* swallow */ }
    }

    function bindVocab() {
        $('btn-dataset-vocab-refresh')?.addEventListener('click', refreshVocab);
        const search = $('dataset-vocab-search');
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    VOCAB_STATE.filter = search.value || '';
                    renderVocab();
                }, 120);
            });
        }
        // Auto-refresh on first open
        const panel = $('dataset-vocab-panel');
        if (panel) {
            panel.addEventListener('toggle', () => {
                if (panel.open && VOCAB_STATE.items.length === 0) {
                    refreshVocab();
                }
            });
        }
        // When the user types in common/blacklist directly, keep the
        // visual state in sync.
        for (const id of ['dataset-common-tags', 'dataset-blacklist']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.addEventListener('input', () => {
                syncVocabStateFromTextareas();
                renderVocab();
            });
        }
    }

    DM._refreshVocab = refreshVocab;

    // ============== Anime LoRA-friendly defaults (T11) ==============

    const ANIME_DEFAULTS_FLAG = 'sd-image-sorter-dataset-customized';

    function applyAnimeDefaults({ silent = false } = {}) {
        // Common tags pre-fill (only if empty so we don't clobber user input).
        const ct = document.getElementById('dataset-common-tags');
        if (ct && !String(ct.value || '').trim()) {
            ct.value = 'masterpiece, best_quality';
            ct.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Underscore-to-space ON (preserve user choice if already changed).
        const us = document.getElementById('dataset-underscore-to-space');
        if (us && !us.dataset.userTouched) {
            us.checked = true;
        }
        // Naming preset = renumber (better LoRA workflow than 'keep' random filenames).
        const renumberRadio = document.querySelector('input[name="dataset-naming-preset"][value="renumber"]');
        const keepRadio = document.querySelector('input[name="dataset-naming-preset"][value="keep"]');
        const presetUserTouched = (keepRadio && keepRadio.dataset.userTouched)
            || (renumberRadio && renumberRadio.dataset.userTouched);
        if (renumberRadio && !presetUserTouched) {
            renumberRadio.checked = true;
            renumberRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Trigger placeholder hint if the user has typed nothing yet.
        const trigger = document.getElementById('dataset-trigger');
        if (trigger && !String(trigger.value || '').trim()) {
            trigger.placeholder = 'your_lora_trigger';
        }
        if (!silent && typeof DM._toast === 'function') {
            DM._toast(DM._t('dataset.animeDefaultsApplied',
                'Applied Anime LoRA recommended defaults.'), 'success');
        }
    }

    function bindAnimeDefaults() {
        const btn = document.getElementById('btn-dataset-anime-defaults');
        if (btn) {
            btn.addEventListener('click', () => {
                // Force reset by clearing user-touched flags first.
                document.querySelectorAll('[data-user-touched="1"]').forEach((el) => {
                    delete el.dataset.userTouched;
                });
                // Clear fields so applyAnimeDefaults will repopulate them.
                const ct = document.getElementById('dataset-common-tags');
                if (ct) ct.value = '';
                applyAnimeDefaults({ silent: false });
                try { localStorage.removeItem(ANIME_DEFAULTS_FLAG); } catch {}
            });
        }
        // Mark fields as user-touched once they edit them so the defaults
        // never override their choices on subsequent inits.
        const fields = [
            'dataset-common-tags', 'dataset-underscore-to-space',
            'dataset-blacklist', 'dataset-trigger',
        ];
        for (const id of fields) {
            const el = document.getElementById(id);
            if (!el) continue;
            const evt = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'input';
            el.addEventListener(evt, () => {
                el.dataset.userTouched = '1';
                try { localStorage.setItem(ANIME_DEFAULTS_FLAG, '1'); } catch {}
            }, { once: true });
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                radio.dataset.userTouched = '1';
                try { localStorage.setItem(ANIME_DEFAULTS_FLAG, '1'); } catch {}
            }, { once: true });
        });

        // Apply defaults on the first init (no localStorage flag yet).
        const customized = (() => {
            try { return localStorage.getItem(ANIME_DEFAULTS_FLAG) === '1'; }
            catch { return false; }
        })();
        if (!customized) {
            applyAnimeDefaults({ silent: true });
        }
    }

    DM._applyAnimeDefaults = applyAnimeDefaults;

    // ============== Renamed-pair preview chip (T12) ==============

    function refreshPairChip() {
        const png = document.getElementById('dataset-pair-chip-png');
        const txt = document.getElementById('dataset-pair-chip-txt');
        if (!png || !txt) return;
        const trigger = (document.getElementById('dataset-trigger')?.value || '').trim();
        const preset = (document.querySelector('input[name="dataset-naming-preset"]:checked')?.value) || 'keep';
        let stem;
        if (preset === 'keep') {
            stem = 'your_image_name';
        } else if (preset === 'renumber') {
            stem = `${(trigger || 'your_lora_trigger')}_001`;
        } else {
            const pattern = (document.getElementById('dataset-naming-pattern')?.value || '{trigger}_{index:03d}');
            stem = pattern
                .replace(/\{trigger\}/g, trigger || 'your_lora_trigger')
                .replace(/\{index:0*(\d+)d\}/g, (_m, w) => '1'.padStart(parseInt(w, 10) || 1, '0'))
                .replace(/\{index\}/g, '1')
                .replace(/\{filename\}/g, 'your_image_name')
                .replace(/\{generator\}/g, 'webui')
                .replace(/\{ext\}/g, 'png')
                .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));
        }
        png.textContent = `${stem}.png`;
        txt.textContent = `${stem}.txt`;
    }

    function bindPairChip() {
        for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
            document.getElementById(id)?.addEventListener('input', refreshPairChip);
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((r) => {
            r.addEventListener('change', refreshPairChip);
        });
        refreshPairChip();
    }

    DM._refreshPairChip = refreshPairChip;

    // ---- public hooks ----
    DM._runAudit = runAudit;
    DM._auditState = AUDIT_STATE;

    function init() {
        bindStepper();
        bindAudit();
        bindVocab();
        bindAnimeDefaults();
        bindPairChip();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
