/**
 * Smart Tag wizard wiring (frontend half of the LoraHub-style smart-tag pipeline).
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
(function () {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    /** Shared timer handle for the progress poll loop. */
    let progressTimer = null;
    let activeJobId = null;
    let taggerModelCatalog = [];
    let taggerModelDefault = '';

    const t = (key, fallback) => {
        const value = window.I18n?.t?.(key);
        return value && value !== key ? value : fallback;
    };

    function toFiniteThreshold(value, fallback) {
        const num = parseFloat(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function getDatasetImageIds() {
        // Preferred: the dataset-maker module exposes an authoritative list.
        if (window.DatasetMaker) {
            // Modern shape: a getImageIds() method.
            if (typeof window.DatasetMaker.getImageIds === 'function') {
                try {
                    const ids = window.DatasetMaker.getImageIds();
                    if (Array.isArray(ids) && ids.length) return ids.slice();
                } catch (_e) { /* fall through */ }
            }
            // Current shape: a public imageIds array on the DM object.
            if (Array.isArray(window.DatasetMaker.imageIds) && window.DatasetMaker.imageIds.length) {
                return window.DatasetMaker.imageIds.slice();
            }
        }
        // Fallback: scrape the queue DOM. Keeps this module decoupled.
        const fromDom = $$('#dataset-queue-list [data-image-id]')
            .map((el) => parseInt(el.dataset.imageId, 10))
            .filter((n) => Number.isFinite(n) && n > 0);
        return fromDom;
    }

    function setProgressUI({ percent, text, preview }) {
        const fill = $('#smart-tag-progress-fill');
        const txt = $('#smart-tag-progress-text');
        const prev = $('#smart-tag-progress-preview');
        if (fill && Number.isFinite(percent)) {
            fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        }
        if (txt && typeof text === 'string') txt.textContent = text;
        if (prev && typeof preview === 'string') prev.textContent = preview;
    }

    function showProgress(show) {
        const wrap = $('#smart-tag-progress');
        if (wrap) wrap.hidden = !show;
        const runBtn = $('#btn-smart-tag-run');
        const cancelBtn = $('#btn-smart-tag-cancel-job');
        if (runBtn) runBtn.disabled = show;
        if (cancelBtn) cancelBtn.hidden = !show;
    }

    async function openModal() {
        const modal = $('#smart-tag-modal');
        if (!modal) return;

        // Refresh image-count summary every time we open.
        const ids = getDatasetImageIds();
        const countEl = $('#smart-tag-image-count');
        if (countEl) countEl.textContent = String(ids.length);

        // Disable run button if there are no images to process.
        const runBtn = $('#btn-smart-tag-run');
        if (runBtn) runBtn.disabled = ids.length === 0;

        loadSmartTaggerModels();

        // Use the project-wide showModal helper so Escape, focus-trap,
        // focus-restore, and aria semantics all work the same way as
        // every other modal in the app. The helper applies the
        // ``visible`` class (the canonical project convention) which
        // matches the modal stylesheet — the older ``show`` class this
        // file used to write was a no-op CSS selector.
        if (typeof window.showModal === 'function') {
            window.showModal('smart-tag-modal');
        } else {
            // Fallback for very early bootstrapping where app.js
            // hasn't registered the helper yet.
            modal.classList.add('visible');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function setSelectLoading(select, label) {
        if (!select) return;
        select.innerHTML = '';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = label;
        select.appendChild(option);
    }

    function appendTaggerOption(select, model, selectedValue) {
        const option = document.createElement('option');
        const name = String(model?.name || model?.path || '').trim();
        option.value = name;
        option.textContent = name + (model?.recommended ? ` (${t('smartTag.taggerRecommended', 'Recommended')})` : '');
        if (model?.best_for) option.title = `${name} - ${model.best_for}`;
        if (model?.disabled) {
            option.disabled = true;
            option.setAttribute('aria-disabled', 'true');
            option.textContent += ` (${t('smartTag.taggerUnavailable', 'Unavailable')})`;
            if (model?.disabled_reason) option.title = model.disabled_reason;
        }
        if (name === selectedValue) option.selected = true;
        select.appendChild(option);
    }

    function getEnabledTaggerModels() {
        return taggerModelCatalog.filter((model) => model?.name && !model.disabled);
    }

    function getModelDefaultThresholds(modelName) {
        const model = taggerModelCatalog.find((item) => item?.name === modelName);
        return {
            general_threshold: toFiniteThreshold(
                model?.default_threshold,
                toFiniteThreshold($('#tag-threshold')?.value, 0.35)
            ),
            character_threshold: toFiniteThreshold(
                model?.default_character_threshold,
                toFiniteThreshold($('#tag-character-threshold')?.value, 0.85)
            ),
        };
    }

    function populateSmartTaggerSelects() {
        const select1 = $('#smart-tag-tagger-1');
        const select2 = $('#smart-tag-tagger-2');
        if (!select1 || !select2) return;

        const enabledModels = getEnabledTaggerModels();
        const fallbackDefault = enabledModels[0]?.name || taggerModelDefault || '';
        const previous1 = select1.value || taggerModelDefault || fallbackDefault;
        const previous2 = select2.value || '';
        const selected1 = enabledModels.some((model) => model.name === previous1) ? previous1 : fallbackDefault;
        const selected2 = enabledModels.some((model) => model.name === previous2) && previous2 !== selected1
            ? previous2
            : '';

        select1.innerHTML = '';
        select2.innerHTML = '';

        if (!taggerModelCatalog.length) {
            setSelectLoading(select1, t('smartTag.taggerLoadFailed', 'Failed to load taggers'));
            setSelectLoading(select2, t('smartTag.taggerDisabled', 'Off'));
            return;
        }

        for (const model of taggerModelCatalog) {
            appendTaggerOption(select1, model, selected1);
        }

        const offOption = document.createElement('option');
        offOption.value = '';
        offOption.textContent = t('smartTag.taggerDisabled', 'Off');
        select2.appendChild(offOption);
        for (const model of taggerModelCatalog) {
            appendTaggerOption(select2, model, selected2);
        }
        select2.value = selected2;
        syncSmartTagVoteUi();
    }

    function syncSmartTagVoteUi() {
        const select1 = $('#smart-tag-tagger-1');
        const select2 = $('#smart-tag-tagger-2');
        const consensusMode = $('#smart-tag-consensus-mode');
        const details = $('.smart-tag-vote-details');
        if (!select1 || !select2) return;

        for (const option of Array.from(select2.options)) {
            option.disabled = option.value !== '' && option.value === select1.value;
        }
        if (select2.value && select2.value === select1.value) {
            select2.value = '';
        }

        const dualTagger = Boolean(select1.value && select2.value);
        if (consensusMode) {
            consensusMode.disabled = !dualTagger;
            consensusMode.setAttribute('aria-disabled', String(!dualTagger));
        }
        if (details) {
            details.classList.toggle('is-dual-tagger', dualTagger);
            details.classList.toggle('is-single-tagger', !dualTagger);
        }
    }

    async function loadSmartTaggerModels() {
        const select1 = $('#smart-tag-tagger-1');
        const select2 = $('#smart-tag-tagger-2');
        if (!select1 || !select2) return;

        setSelectLoading(select1, t('smartTag.taggerLoading', 'Loading taggers...'));
        setSelectLoading(select2, t('smartTag.taggerLoading', 'Loading taggers...'));
        try {
            const data = await getJson('/api/tagger/models');
            taggerModelCatalog = Array.isArray(data.models) ? data.models : [];
            taggerModelDefault = String(data.default || '').trim();
            populateSmartTaggerSelects();
        } catch (err) {
            taggerModelCatalog = [];
            taggerModelDefault = '';
            populateSmartTaggerSelects();
            if (typeof window.showToast === 'function') {
                window.showToast(
                    t('smartTag.taggerLoadFailedToast', 'Failed to load Smart Tag tagger list. The backend default will be used.'),
                    'warning'
                );
            }
        }
    }

    function closeModal() {
        const modal = $('#smart-tag-modal');
        if (!modal) return;
        if (typeof window.hideModal === 'function') {
            window.hideModal('smart-tag-modal');
        } else {
            modal.classList.remove('visible');
            modal.setAttribute('aria-hidden', 'true');
        }
        stopProgressPolling();
        showProgress(false);
        setProgressUI({ percent: 0, text: '', preview: '' });
    }

    function readForm() {
        const consensusMode = $('#smart-tag-consensus-mode')?.value || 'or';
        const generalThreshold = toFiniteThreshold($('#tag-threshold')?.value, 0.35);
        const characterThreshold = toFiniteThreshold($('#tag-character-threshold')?.value, 0.85);
        const tagger1 = ($('#smart-tag-tagger-1')?.value || '').trim();
        const tagger2 = ($('#smart-tag-tagger-2')?.value || '').trim();
        const selectedTaggers = [tagger1, tagger2].filter(Boolean);
        const uniqueTaggers = Array.from(new Set(selectedTaggers));
        const form = {
            image_ids: getDatasetImageIds(),
            training_purpose: $('#smart-tag-purpose')?.value || 'general',
            trigger_word: ($('#smart-tag-trigger')?.value || '').trim(),
            merge_strategy: $('#smart-tag-merge')?.value || 'replace',
            auto_strip_noise: !!$('#smart-tag-strip-noise')?.checked,
            enable_wd14: !!$('#smart-tag-enable-wd14')?.checked,
            enable_vlm: !!$('#smart-tag-enable-vlm')?.checked,
            use_gpu: !!$('#smart-tag-use-gpu')?.checked,
            general_threshold: generalThreshold,
            character_threshold: characterThreshold,
            // Empty tagger_model is still allowed as the backend default fallback.
            tagger_model: uniqueTaggers[0] || '',
            consensus_min: consensusMode === 'and' ? 2 : 1,
        };
        if (uniqueTaggers.length >= 2) {
            form.tagger_model = '';
            form.taggers = uniqueTaggers.slice(0, 2).map((model) => ({
                model,
                weight: 1,
                ...getModelDefaultThresholds(model),
            }));
            form.consensus_min = consensusMode === 'and' ? 2 : 1;
            form.consensus_skip_categories = ['character', 'copyright'];
        }
        return form;
    }

    async function postJson(url, body) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body == null ? null : JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const detail = data && data.detail ? data.detail : `HTTP ${resp.status}`;
            const err = new Error(detail);
            err.status = resp.status;
            err.payload = data;
            throw err;
        }
        return data;
    }

    async function getJson(url) {
        const resp = await fetch(url);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const err = new Error(data?.detail || `HTTP ${resp.status}`);
            err.status = resp.status;
            throw err;
        }
        return data;
    }

    function stopProgressPolling() {
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
    }

    function startProgressPolling() {
        stopProgressPolling();
        progressTimer = setInterval(pollProgressOnce, 1000);
    }

    async function pollProgressOnce() {
        try {
            const url = activeJobId
                ? `/api/smart-tag/progress?job_id=${encodeURIComponent(activeJobId)}`
                : '/api/smart-tag/progress';
            const snap = await getJson(url);
            renderSnapshot(snap);
            if (!snap.active && snap.status !== 'queued' && snap.status !== 'running') {
                stopProgressPolling();
                onJobFinished(snap);
            }
        } catch (err) {
            // 404 is the "no such job" response — stop polling silently.
            stopProgressPolling();
        }
    }

    function renderSnapshot(snap) {
        if (!snap) return;
        const total = snap.total || 0;
        const processed = snap.processed || 0;
        const percent = total > 0 ? (processed / total) * 100 : 0;
        const status = snap.status || 'idle';
        let text = snap.message || status;
        if (total > 0) {
            text = `${snap.message || status} — ${processed}/${total} (${snap.succeeded || 0} ok, ${snap.failed || 0} failed)`;
        }
        setProgressUI({
            percent,
            text,
            preview: snap.last_caption_preview || '',
        });
    }

    function onJobFinished(snap) {
        const status = snap.status || 'completed';
        const ok = (snap.succeeded || 0);
        const fail = (snap.failed || 0);
        const total = snap.total || 0;
        showProgress(false);

        // Reuse the existing toast helper if available; fall back to alert.
        const message = status === 'cancelled'
            ? `Smart Tag cancelled at ${ok + fail}/${total}.`
            : status === 'failed'
                ? `Smart Tag failed: ${snap.message || 'unknown error'}`
                : `Smart Tag finished: ${ok} ok, ${fail} failed.`;

        if (typeof window.showToast === 'function') {
            window.showToast(message, status === 'failed' ? 'error' : 'success');
        } else {
            console.log('[smart-tag]', message);
        }

        // Tell Dataset Maker to refresh its captions so the new ones show up
        // in the editor without requiring a tab switch.
        if (window.DatasetMaker && typeof window.DatasetMaker.refresh === 'function') {
            try { window.DatasetMaker.refresh(); } catch (_e) { /* ignore */ }
        }
        activeJobId = null;
    }

    async function runSmartTag() {
        const form = readForm();
        if (!form.image_ids.length) {
            if (typeof window.showToast === 'function') {
                window.showToast('No images in Dataset Maker. Add some from Gallery first.', 'warning');
            } else {
                alert('No images in Dataset Maker. Add some from Gallery first.');
            }
            return;
        }
        if (!form.enable_wd14 && !form.enable_vlm) {
            if (typeof window.showToast === 'function') {
                window.showToast('Pick at least one of WD14 / VLM to run.', 'warning');
            }
            return;
        }

        showProgress(true);
        setProgressUI({ percent: 0, text: 'Starting...', preview: '' });
        try {
            const snap = await postJson('/api/smart-tag/start', form);
            activeJobId = snap.job_id || null;
            renderSnapshot(snap);
            startProgressPolling();
        } catch (err) {
            showProgress(false);
            const msg = err.message || String(err);
            if (typeof window.showToast === 'function') {
                window.showToast(`Smart Tag failed to start: ${msg}`, 'error');
            } else {
                alert(`Smart Tag failed to start: ${msg}`);
            }
        }
    }

    async function cancelSmartTag() {
        try {
            await postJson('/api/smart-tag/cancel', null);
        } catch (_err) {
            // 404 means there's nothing to cancel — that's fine.
        }
    }

    function bindHandlers() {
        const openBtn = $('#btn-dataset-smart-tag');
        if (openBtn) openBtn.addEventListener('click', openModal);

        const closeBtn = $('#btn-smart-tag-close');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        const cancelModalBtn = $('#btn-smart-tag-cancel-modal');
        if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeModal);

        const runBtn = $('#btn-smart-tag-run');
        if (runBtn) runBtn.addEventListener('click', runSmartTag);

        const cancelBtn = $('#btn-smart-tag-cancel-job');
        if (cancelBtn) cancelBtn.addEventListener('click', cancelSmartTag);

        $('#smart-tag-tagger-1')?.addEventListener('change', syncSmartTagVoteUi);
        $('#smart-tag-tagger-2')?.addEventListener('change', syncSmartTagVoteUi);
        $('#smart-tag-consensus-mode')?.addEventListener('change', syncSmartTagVoteUi);

        // Click-outside on the backdrop closes the modal too.
        const modal = $('#smart-tag-modal');
        if (modal) {
            const backdrop = modal.querySelector('.modal-backdrop');
            if (backdrop) backdrop.addEventListener('click', closeModal);
        }

        // -------- v3.2.2 task #5: Tag Images modal hint banner --------
        // The banner inside #tag-modal points returning users at the
        // Smart Tag wizard. localStorage flag persists dismissal.
        const HINT_DISMISSED_KEY = 'sd-image-sorter-tag-modal-smart-tag-hint-dismissed';

        const tagModal = document.getElementById('tag-modal');
        const hintBanner = document.getElementById('tag-modal-smart-tag-hint');
        if (tagModal && hintBanner) {
            const isDismissed = () => {
                try { return localStorage.getItem(HINT_DISMISSED_KEY) === '1'; }
                catch { return false; }
            };
            const refreshHintVisibility = () => {
                hintBanner.hidden = isDismissed();
            };
            // Initial state.
            refreshHintVisibility();

            // Re-evaluate every time the Tag modal becomes visible (because
            // the canonical project class for "open" is .visible, applied
            // via window.showModal). We use a MutationObserver instead of
            // forking showModal to keep this self-contained.
            const obs = new MutationObserver(() => {
                if (tagModal.classList.contains('visible')) {
                    refreshHintVisibility();
                }
            });
            obs.observe(tagModal, { attributes: true, attributeFilter: ['class'] });

            const goBtn = document.getElementById('btn-tag-modal-smart-tag-go');
            if (goBtn) {
                goBtn.addEventListener('click', () => {
                    // Close Tag modal, switch to Dataset Maker view, open
                    // the Smart Tag modal so the user lands in the right
                    // workflow without extra clicks.
                    if (typeof window.hideModal === 'function') {
                        try { window.hideModal('tag-modal'); } catch (_e) {}
                    }
                    if (typeof window.switchView === 'function') {
                        try { window.switchView('dataset'); } catch (_e) {}
                    }
                    setTimeout(() => {
                        try { openModal(); } catch (_e) {}
                    }, 220);
                });
            }
            const dismissBtn = document.getElementById('btn-tag-modal-smart-tag-dismiss');
            if (dismissBtn) {
                dismissBtn.addEventListener('click', () => {
                    try { localStorage.setItem(HINT_DISMISSED_KEY, '1'); } catch {}
                    hintBanner.hidden = true;
                });
            }
        }
    }

    // Defer binding until the DOM is ready (this script may load
    // before or after DOMContentLoaded depending on script order).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindHandlers, { once: true });
    } else {
        bindHandlers();
    }

    // Public hooks for other modules (Color Analysis "Send to Dataset
    // Maker" will eventually call openSmartTagModal() after pushing
    // images into the queue).
    window.SmartTag = {
        open: openModal,
        close: closeModal,
        run: runSmartTag,
        cancel: cancelSmartTag,
    };
})();
