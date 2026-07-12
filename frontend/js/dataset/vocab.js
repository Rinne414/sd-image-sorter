/**
 * Dataset Maker — tag vocabulary panel (POST /api/dataset/vocab): render, refresh, common/blacklist toggles, DM._refreshVocab/_getDatasetVocabItems.
 * Moved VERBATIM from dataset-maker-pipeline.js L871-1044 (+ documented
 * non-verbatim: duplicated $() helper and the per-module init split).
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;
    // Duplicated VERBATIM from dataset/audit.js (module-scope helper; per-
    // module duplication is the split protocol for IIFE-local helpers).
    function $(id) { return document.getElementById(id); }


    // ============== Tag Vocabulary panel (T10) ==============

    const VOCAB_STATE = {
        items: [],            // [{tag, count, sample_image_id}, ...]
        filter: '',
        states: new Map(),    // tag -> 'common' | 'blacklist' | undefined
    };

    function readTextareaList(id) {
        // Accept newline OR comma separators: #dataset-blacklist is newline by
        // convention (TraitPruner appends with '\n'), while writeTextareaList
        // joins with ', '. Splitting on comma alone turned a trait-pruned,
        // newline-joined blacklist into one unmatchable blob.
        return new Set(
            String(document.getElementById(id)?.value || '')
                .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
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

    function setTagState(tag, nextState) {
        const common = readTextareaList('dataset-common-tags');
        const blacklist = readTextareaList('dataset-blacklist');
        common.delete(tag);
        blacklist.delete(tag);
        if (nextState === 'common') {
            common.add(tag);
        } else if (nextState === 'blacklist') {
            blacklist.add(tag);
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
            const node = document.createElement('div');
            node.className = 'dataset-vocab-tag';
            const state = VOCAB_STATE.states.get(it.tag);
            if (state) node.classList.add(`state-${state}`);
            const lbl = document.createElement('span');
            lbl.className = 'dataset-vocab-tag-label';
            lbl.title = it.tag;
            lbl.textContent = it.tag;
            const c = document.createElement('span');
            c.className = 'dataset-vocab-tag-count';
            c.textContent = String(it.count);
            const actions = document.createElement('span');
            actions.className = 'dataset-vocab-tag-actions';
            const commonBtn = document.createElement('button');
            commonBtn.type = 'button';
            commonBtn.className = 'dataset-vocab-action';
            if (state === 'common') commonBtn.classList.add('active-common');
            commonBtn.textContent = '+';
            commonBtn.title = DM._t('dataset.vocabAddCommon', 'Add to Common tags');
            commonBtn.setAttribute('aria-label', `${commonBtn.title}: ${it.tag}`);
            commonBtn.addEventListener('click', () => setTagState(it.tag, state === 'common' ? null : 'common'));
            const blacklistBtn = document.createElement('button');
            blacklistBtn.type = 'button';
            blacklistBtn.className = 'dataset-vocab-action';
            if (state === 'blacklist') blacklistBtn.classList.add('active-blacklist');
            blacklistBtn.textContent = '-';
            blacklistBtn.title = DM._t('dataset.vocabAddBlacklist', 'Add to Blacklist');
            blacklistBtn.setAttribute('aria-label', `${blacklistBtn.title}: ${it.tag}`);
            blacklistBtn.addEventListener('click', () => setTagState(it.tag, state === 'blacklist' ? null : 'blacklist'));
            actions.append(commonBtn, blacklistBtn);
            node.append(lbl, c, actions);
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
            DM._refreshCleanupButtons?.();
            return VOCAB_STATE.items;
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
                    top_n: 2000,
                }),
            });
            if (!r.ok) return VOCAB_STATE.items;
            const data = await r.json();
            VOCAB_STATE.items = data.vocab || [];
            syncVocabStateFromTextareas();
            renderVocab();
            DM._refreshCleanupButtons?.();
            return VOCAB_STATE.items;
        } catch { /* swallow */ }
        return VOCAB_STATE.items;
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
    DM._getDatasetVocabItems = function () {
        return VOCAB_STATE.items.slice();
    };

    // Split of dataset-maker-pipeline.js's single init() (forced
    // non-verbatim) — this module keeps only its own binder. See
    // dataset/audit.js for the full note.
    function init() {
        bindVocab();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
