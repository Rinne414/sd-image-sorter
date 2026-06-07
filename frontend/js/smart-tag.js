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
(function () {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    /** Shared timer handle for the progress poll loop. */
    let progressTimer = null;
    let activeJobId = null;
    let taggerModelCatalog = [];
    let taggerModelDefault = '';
    const LARGE_EXPLICIT_SOURCE_LIMIT = 5000;

    const t = (key, fallback) => {
        const value = window.I18n?.t?.(key);
        return value && value !== key ? value : fallback;
    };

    function toFiniteThreshold(value, fallback) {
        const num = parseFloat(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(0, Math.min(1, num));
    }

    function getDatasetSources() {
        const imageIds = [];
        const imagePaths = [];
        let selectionToken = null;
        let selectionTotal = 0;
        let datasetScanToken = null;
        let datasetScanTotal = 0;
        if (window.DatasetMaker && Array.isArray(window.DatasetMaker.imageIds)) {
            let localCount = 0;
            for (const rawId of window.DatasetMaker.imageIds) {
                const id = Number(rawId);
                if (!Number.isFinite(id)) continue;
                if (window.DatasetMaker.isLocalId?.(id)) {
                    localCount += 1;
                    const path = window.DatasetMaker.localItemPaths?.get?.(id);
                    if (path) imagePaths.push(path);
                } else if (id > 0) {
                    imageIds.push(id);
                }
            }
            datasetScanToken = String(window.DatasetMaker._folderScanToken || '').trim() || null;
            datasetScanTotal = Number(window.DatasetMaker._folderScanTotal || 0);
            if (datasetScanToken && datasetScanTotal > 0 && localCount === datasetScanTotal) {
                imagePaths.length = 0;
            } else {
                datasetScanToken = null;
                datasetScanTotal = 0;
            }

            const activeSelectionToken = window.AppFilterAccess?.getActiveSelectionToken?.() || null;
            const activeSelectionTotal = Number(window.AppFilterAccess?.getSelectionTotal?.() || 0);
            if (
                activeSelectionToken
                && activeSelectionTotal === imageIds.length
                && imageIds.length > LARGE_EXPLICIT_SOURCE_LIMIT
                && imagePaths.length === 0
                && !datasetScanToken
            ) {
                imageIds.length = 0;
                selectionToken = activeSelectionToken;
                selectionTotal = activeSelectionTotal;
            }
            const datasetTotal = imageIds.length + imagePaths.length + datasetScanTotal;
            const sourceTotal = datasetTotal + selectionTotal;
            if (sourceTotal > 0) {
                return {
                    imageIds,
                    imagePaths,
                    selectionToken,
                    selectionTotal,
                    datasetScanToken,
                    datasetScanTotal,
                    total: sourceTotal,
                    source: 'dataset',
                };
            }
        }
        const fromDom = $$('#dataset-queue-list [data-image-id]')
            .map((el) => parseInt(el.dataset.imageId, 10))
            .filter((n) => Number.isFinite(n) && n > 0);
        if (fromDom.length > 0) {
            return {
                imageIds: fromDom,
                imagePaths: [],
                selectionToken: null,
                selectionTotal: 0,
                datasetScanToken: null,
                datasetScanTotal: 0,
                total: fromDom.length,
                source: 'dataset-dom',
            };
        }

        selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.() || null;
        if (selectionToken) {
            selectionTotal = Number(window.AppFilterAccess?.getSelectionTotal?.() || 0);
            return {
                imageIds: [],
                imagePaths: [],
                selectionToken,
                selectionTotal,
                datasetScanToken: null,
                datasetScanTotal: 0,
                total: selectionTotal,
                source: 'gallery-filter',
            };
        }
        const selectedIds = (window.AppFilterAccess?.getSelectedImageIds?.() || [])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0);
        return {
            imageIds: selectedIds,
            imagePaths: [],
            selectionToken: null,
            selectionTotal: 0,
            datasetScanToken: null,
            datasetScanTotal: 0,
            total: selectedIds.length,
            source: 'gallery-selection',
        };
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
        if (cancelBtn) {
            cancelBtn.hidden = !show;
            // Reset the disabled state so a fresh job can be cancelled
            // even if a previous cancel left the button disabled.
            if (show) cancelBtn.disabled = false;
        }
    }

    function ensureSmartTagStyles() {
        if (document.getElementById('smart-tag-inline-styles')) return;
        const style = document.createElement('style');
        style.id = 'smart-tag-inline-styles';
        style.textContent = `
.smart-tag-ollama-warning {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.85rem;
    margin: 0 0 0.75rem 0;
    background: rgba(255, 176, 46, 0.12);
    border: 1px solid rgba(255, 176, 46, 0.35);
    border-radius: 8px;
    color: var(--text-primary, #f0f0f0);
    font-size: 0.9rem;
    line-height: 1.35;
}
.smart-tag-ollama-warning .smart-tag-ollama-icon { font-size: 1.1rem; flex: 0 0 auto; }
.smart-tag-ollama-warning .smart-tag-ollama-text { flex: 1 1 auto; }
.smart-tag-ollama-warning .smart-tag-ollama-action { flex: 0 0 auto; }
.smart-tag-tagger-help {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.8rem;
    font-style: italic;
    color: var(--text-muted, rgba(255, 255, 255, 0.6));
}
`;
        document.head.appendChild(style);
    }

    function ensureOllamaWarningBanner() {
        let banner = document.getElementById('smart-tag-ollama-warning');
        if (banner) return banner;
        const naturalSection = document.getElementById('smart-tag-natural-section');
        if (!naturalSection || !naturalSection.parentNode) return null;
        ensureSmartTagStyles();
        banner = document.createElement('div');
        banner.id = 'smart-tag-ollama-warning';
        banner.className = 'smart-tag-ollama-warning';
        banner.hidden = true;
        banner.innerHTML = `
            <span class="smart-tag-ollama-icon" aria-hidden="true">⚠️</span>
            <span class="smart-tag-ollama-text">
                自然语言描述器尚未配置 — 请打开 VLM 设置，填入云端 API 端点（如 OpenAI / OpenRouter / Gemini），或确认本地 Ollama 正在运行。<br>
                No natural-language captioner configured — open VLM Settings to add a cloud API endpoint (OpenAI / OpenRouter / Gemini, etc.), or start a local Ollama.
            </span>
            <button type="button" class="btn btn-small btn-primary smart-tag-ollama-action" id="btn-smart-tag-open-vlm-from-warning">
                Open VLM Settings
            </button>
        `;
        naturalSection.parentNode.insertBefore(banner, naturalSection);
        banner.querySelector('#btn-smart-tag-open-vlm-from-warning')?.addEventListener('click', () => {
            if (window.VLMCaption && typeof window.VLMCaption.openSettingsModal === 'function') {
                window.VLMCaption.openSettingsModal();
            } else if (typeof window.showModal === 'function') {
                window.showModal('vlm-settings-modal');
            } else {
                document.getElementById('vlm-settings-modal')?.classList.add('visible');
            }
        });
        return banner;
    }

    async function refreshOllamaWarning() {
        const banner = ensureOllamaWarningBanner();
        if (!banner) return;
        const naturalEnabled = !!$('#smart-tag-enable-vlm')?.checked;
        const nlMode = $('#smart-tag-nl-mode')?.value || 'vlm';
        // Only relevant when the user actually plans to use the
        // VLM-via-endpoint path. ToriiGate runs in-process and doesn't
        // care about the Ollama daemon.
        if (!naturalEnabled || nlMode !== 'vlm') {
            banner.hidden = true;
            return;
        }
        // A configured VLM endpoint (cloud API such as OpenAI / OpenRouter /
        // aihubmix / Anthropic / Gemini, or any local server) OR Vertex means
        // the captioner does NOT depend on Ollama — so the "Ollama required"
        // banner must not fire. The banner is only for the truly-unconfigured
        // case where the implicit default would be a local Ollama daemon.
        //
        // Bug fix: this used to query ONLY /api/vlm/local-models/recommended,
        // so a user who had pointed Smart Tag at a cloud API was still nagged
        // to install / start Ollama (the API had in fact tagged their images).
        try {
            const settings = await getJson('/api/vlm/settings');
            const endpoint = String(settings?.endpoint || '').trim();
            if (endpoint.length > 0 || settings?.use_vertex === true) {
                banner.hidden = true;
                return;
            }
        } catch (_err) {
            // Couldn't read settings — fall through to the Ollama probe rather
            // than assuming a cloud captioner is configured.
        }
        try {
            const data = await getJson('/api/vlm/local-models/recommended');
            const unavailable = !data?.ollama_installed || !data?.ollama_running;
            banner.hidden = !unavailable;
        } catch (_err) {
            // No configured endpoint AND the Ollama probe failed — we can't
            // confirm any captioner is reachable, so show the banner with a
            // path to fix it.
            banner.hidden = false;
        }
    }

    async function openModal() {
        const modal = $('#smart-tag-modal');
        if (!modal) return;

        // Refresh image-count summary every time we open.
        const sources = getDatasetSources();
        const total = sources.total || 0;
        const countEl = $('#smart-tag-image-count');
        if (countEl) countEl.textContent = String(total);

        // Disable run button if there are no images to process.
        const runBtn = $('#btn-smart-tag-run');
        if (runBtn) runBtn.disabled = total === 0 && !sources.selectionToken && !sources.datasetScanToken;

        loadSmartTaggerModels();
        syncSmartTagVoteUi();
        // Fire-and-forget; banner appears/disappears on its own once
        // /api/vlm/local-models/recommended responds. Re-checking on
        // every openModal lets a user who fixes Ollama mid-session
        // see the cleared state without reloading the app.
        refreshOllamaWarning();

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

    function isBooruTaggerModel(model) {
        const backend = String(model?.runtime_backend || '').toLowerCase();
        const role = String(model?.smart_tag_role || '').toLowerCase();
        return Boolean(model?.name)
            && role !== 'natural_language'
            && backend !== 'toriigate'
            && model.name !== 'toriigate-0.5';
    }

    function getEnabledBooruTaggerModels() {
        return taggerModelCatalog.filter((model) => isBooruTaggerModel(model) && !model.disabled);
    }

    function getModelDefaultThresholds(modelName) {
        const model = taggerModelCatalog.find((item) => item?.name === modelName);
        const general = toFiniteThreshold(
            model?.default_threshold,
            toFiniteThreshold($('#smart-tag-general-threshold')?.value, 0.35)
        );
        return {
            general_threshold: general,
            character_threshold: toFiniteThreshold(
                model?.default_character_threshold,
                toFiniteThreshold($('#smart-tag-character-threshold')?.value, 0.85)
            ),
            copyright_threshold: toFiniteThreshold(
                model?.default_copyright_threshold,
                toFiniteThreshold($('#smart-tag-copyright-threshold')?.value, general)
            ),
        };
    }

    function getModelDefaultMaxTags(modelName) {
        const model = taggerModelCatalog.find((item) => item?.name === modelName);
        const value = parseInt(model?.default_max_tags_per_image, 10);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    function toFiniteMaxTags(value, fallback) {
        const num = parseInt(value, 10);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(0, Math.min(2000, num));
    }

    function thresholdInputsWereTouched() {
        return ['#smart-tag-general-threshold', '#smart-tag-character-threshold', '#smart-tag-copyright-threshold']
            .some((selector) => $(selector)?.dataset.userTouched === 'true');
    }

    function maxTagsInputWasTouched() {
        return $('#smart-tag-max-tags')?.dataset.userTouched === 'true';
    }

    function getPayloadThresholdsForModel(modelName, sharedThresholds) {
        return thresholdInputsWereTouched()
            ? sharedThresholds
            : getModelDefaultThresholds(modelName);
    }

    function getPayloadMaxTagsForModels(modelNames) {
        const input = $('#smart-tag-max-tags');
        if (maxTagsInputWasTouched()) {
            return toFiniteMaxTags(input?.value, 0);
        }
        const values = modelNames
            .map((name) => getModelDefaultMaxTags(name))
            .filter((value) => value > 0);
        if (!values.length) return undefined;
        return Math.min(...values);
    }

    function applyMaxTagsDefault(modelNames, { force = false } = {}) {
        const input = $('#smart-tag-max-tags');
        if (!input || (!force && input.dataset.userTouched === 'true')) return;
        const value = getPayloadMaxTagsForModels(modelNames);
        input.value = String(Number.isFinite(value) ? value : 0);
    }

    function applyThresholdDefaults(modelName, { force = false } = {}) {
        const defaults = getModelDefaultThresholds(modelName);
        const pairs = [
            ['#smart-tag-general-threshold', defaults.general_threshold],
            ['#smart-tag-character-threshold', defaults.character_threshold],
            ['#smart-tag-copyright-threshold', defaults.copyright_threshold],
        ];
        for (const [selector, value] of pairs) {
            const input = $(selector);
            if (!input) continue;
            if (force || input.dataset.userTouched !== 'true') {
                input.value = Number(value).toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
            }
        }
    }

    function ensureTaggerHelpElement(selectId, helpId) {
        let help = document.getElementById(helpId);
        if (help) return help;
        const select = document.getElementById(selectId);
        if (!select || !select.parentNode) return null;
        ensureSmartTagStyles();
        help = document.createElement('small');
        help.id = helpId;
        help.className = 'smart-tag-tagger-help';
        help.textContent = '';
        // Insert right after the select element so it sits directly
        // under the dropdown regardless of the surrounding wrapper.
        select.parentNode.insertBefore(help, select.nextSibling);
        return help;
    }

    function updateTaggerHelpFor(selectId, helpId) {
        const help = ensureTaggerHelpElement(selectId, helpId);
        if (!help) return;
        const select = document.getElementById(selectId);
        const value = (select?.value || '').trim();
        const model = taggerModelCatalog.find((m) => m?.name === value);
        help.textContent = model?.best_for ? String(model.best_for) : '';
    }

    function updateAllTaggerHelp() {
        updateTaggerHelpFor('smart-tag-tagger-1', 'smart-tag-tagger-1-help');
        updateTaggerHelpFor('smart-tag-tagger-2', 'smart-tag-tagger-2-help');
    }

    function populateSmartTaggerSelects() {
        const select1 = $('#smart-tag-tagger-1');
        const select2 = $('#smart-tag-tagger-2');
        if (!select1 || !select2) return;

        const enabledModels = getEnabledBooruTaggerModels();
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

        for (const model of taggerModelCatalog.filter(isBooruTaggerModel)) {
            appendTaggerOption(select1, model, selected1);
        }

        const offOption = document.createElement('option');
        offOption.value = '';
        offOption.textContent = t('smartTag.taggerDisabled', 'Off');
        select2.appendChild(offOption);
        for (const model of taggerModelCatalog.filter(isBooruTaggerModel)) {
            appendTaggerOption(select2, model, selected2);
        }
        select2.value = selected2;
        applyThresholdDefaults(selected1, { force: false });
        applyMaxTagsDefault([selected1, selected2].filter(Boolean), { force: false });
        syncSmartTagVoteUi();
        updateAllTaggerHelp();
    }

    function syncSmartTagVoteUi() {
        const select1 = $('#smart-tag-tagger-1');
        const select2 = $('#smart-tag-tagger-2');
        const consensusMode = $('#smart-tag-consensus-mode');
        const booruSection = $('#smart-tag-booru-section');
        const naturalSection = $('#smart-tag-natural-section');
        const booruEnabled = !!$('#smart-tag-enable-wd14')?.checked;
        const naturalEnabled = !!$('#smart-tag-enable-vlm')?.checked;
        const nlMode = $('#smart-tag-nl-mode')?.value || 'vlm';
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
        if (booruSection) {
            booruSection.classList.toggle('is-disabled', !booruEnabled);
            booruSection.querySelectorAll('select, input[type="number"]').forEach((el) => {
                el.disabled = !booruEnabled;
            });
        }
        if (naturalSection) {
            naturalSection.classList.toggle('is-disabled', !naturalEnabled);
            naturalSection.querySelectorAll('select').forEach((el) => {
                el.disabled = !naturalEnabled;
            });
        }
        const settingsBtn = $('#btn-smart-tag-vlm-settings');
        if (settingsBtn) settingsBtn.disabled = !naturalEnabled || nlMode !== 'vlm';
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
        const booruEnabled = !!$('#smart-tag-enable-wd14')?.checked;
        const naturalEnabled = !!$('#smart-tag-enable-vlm')?.checked;
        const generalThreshold = toFiniteThreshold($('#smart-tag-general-threshold')?.value, 0.35);
        const characterThreshold = toFiniteThreshold($('#smart-tag-character-threshold')?.value, 0.85);
        const copyrightThreshold = toFiniteThreshold($('#smart-tag-copyright-threshold')?.value, generalThreshold);
        const tagger1 = ($('#smart-tag-tagger-1')?.value || '').trim();
        const tagger2 = ($('#smart-tag-tagger-2')?.value || '').trim();
        const selectedTaggers = booruEnabled ? [tagger1, tagger2].filter(Boolean) : [];
        const uniqueTaggers = Array.from(new Set(selectedTaggers));
        const maxTagsPerImage = getPayloadMaxTagsForModels(uniqueTaggers);
        const sharedThresholds = {
            general_threshold: generalThreshold,
            character_threshold: characterThreshold,
            copyright_threshold: copyrightThreshold,
        };
        const primaryThresholds = getPayloadThresholdsForModel(uniqueTaggers[0] || '', sharedThresholds);
        const sources = getDatasetSources();
        const form = {
            image_ids: sources.imageIds,
            selection_token: sources.selectionToken || undefined,
            image_paths: sources.imagePaths,
            dataset_scan_token: sources.datasetScanToken || undefined,
            training_purpose: $('#smart-tag-purpose')?.value || 'general',
            trigger_word: ($('#smart-tag-trigger')?.value || '').trim(),
            merge_strategy: $('#smart-tag-merge')?.value || 'replace',
            auto_strip_noise: !!$('#smart-tag-strip-noise')?.checked,
            enable_wd14: booruEnabled,
            enable_vlm: naturalEnabled,
            natural_language_mode: $('#smart-tag-nl-mode')?.value || 'vlm',
            use_gpu: !!$('#smart-tag-use-gpu')?.checked,
            general_threshold: primaryThresholds.general_threshold,
            character_threshold: primaryThresholds.character_threshold,
            copyright_threshold: primaryThresholds.copyright_threshold,
            max_tags_per_image: maxTagsPerImage,
            // Empty tagger_model is still allowed as the backend default fallback.
            tagger_model: uniqueTaggers[0] || '',
            consensus_min: consensusMode === 'and' ? 2 : 1,
        };
        if (uniqueTaggers.length >= 2) {
            form.tagger_model = '';
            form.taggers = uniqueTaggers.slice(0, 2).map((model) => ({
                ...getPayloadThresholdsForModel(model, sharedThresholds),
                model,
                weight: 1,
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
                await onJobFinished(snap);
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
        const status = snap.status || 'idle';
        const stage = snap.stage || '';

        // v3.2.2: prefer phase_completion (0-1 within current phase) over raw
        // processed/total so a multi-tagger + VLM run shows a single smooth bar
        // instead of jumping back to 0% between phases.
        const phaseCompletion = typeof snap.phase_completion === 'number' ? snap.phase_completion : null;
        let percent;
        if (phaseCompletion != null) {
            const settings = snap.settings || {};
            const hasVlm = settings.enable_vlm === true && settings.natural_language_mode !== 'off';
            const hasTagging = (settings.taggers && settings.taggers.length > 0)
                || settings.enable_wd14 === true;
            const bothPhases = hasTagging && hasVlm;
            if (!bothPhases) {
                percent = Math.max(0, Math.min(1, phaseCompletion)) * 100;
            } else if (stage === 'tagging' || stage === 'consensus') {
                percent = Math.max(0, Math.min(1, phaseCompletion)) * 50;
            } else if (stage === 'vlm') {
                percent = 50 + Math.max(0, Math.min(1, phaseCompletion)) * 50;
            } else {
                percent = total > 0 ? (processed / total) * 100 : 0;
            }
        } else {
            percent = total > 0 ? (processed / total) * 100 : 0;
        }

        let text = snap.message || status;
        if (total > 0) {
            let stagePrefix = '';
            if (stage === 'tagging') {
                stagePrefix = t('smartTag.stageTagging', 'Tagging');
            } else if (stage === 'vlm') {
                stagePrefix = t('smartTag.stageVlm', 'VLM captioning');
            }
            if (stagePrefix) {
                text = `${stagePrefix} ${processed}/${total} — ${snap.succeeded || 0} ok, ${snap.failed || 0} failed`;
            } else {
                text = `${snap.message || status} — ${processed}/${total} (${snap.succeeded || 0} ok, ${snap.failed || 0} failed)`;
            }
        }
        setProgressUI({
            percent,
            text,
            preview: snap.last_caption_preview || '',
        });
    }

    async function applyPathCaptions(jobId, mergeStrategy) {
        const dm = window.DatasetMaker;
        if (!jobId || !dm?.localItemPaths || !dm?.captionEdits) return 0;
        const idByPath = new Map();
        for (const [id, path] of dm.localItemPaths.entries()) {
            idByPath.set(String(path), Number(id));
        }
        let offset = 0;
        let applied = 0;
        while (true) {
            const page = await getJson(`/api/smart-tag/results?job_id=${encodeURIComponent(jobId)}&offset=${offset}&limit=1000`);
            for (const item of (page.results || [])) {
                const id = idByPath.get(String(item.path || ''));
                const caption = String(item.caption || '').trim();
                if (!id || !caption) continue;
                const existing = dm.captionEdits.get(id) || dm.captions?.get?.(id) || '';
                const next = mergeStrategy === 'append' && existing && existing !== caption
                    ? `${existing}, ${caption}`.replace(/^,\s*/, '').replace(/,\s*$/, '')
                    : caption;
                dm.captionEdits.set(id, next);
                applied += 1;
            }
            offset += page.results?.length || 0;
            if (!page.has_more || !page.results?.length) break;
        }
        if (applied > 0) {
            dm._renderQueue?.();
            if (dm.activeId != null) dm._setActive?.(dm.activeId);
            dm._refreshVocab?.();
        }
        return applied;
    }

    async function onJobFinished(snap) {
        const status = snap.status || 'completed';
        const ok = (snap.succeeded || 0);
        const fail = (snap.failed || 0);
        const total = snap.total || 0;
        showProgress(false);
        if (status === 'completed' && (snap.caption_result_count || 0) > 0) {
            try {
                await applyPathCaptions(snap.job_id, snap.settings?.merge_strategy || 'replace');
            } catch (err) {
                if (typeof window.showToast === 'function') {
                    window.showToast(`Smart Tag captions were generated but could not be applied: ${err.message || err}`, 'error');
                }
            }
        }

        // Reuse the existing toast helper if available; fall back to alert.
        const noiseStripped = snap.noise_stripped_count || 0;
        const noiseSuffix = noiseStripped > 0 ? ` · ${noiseStripped} noise tags removed` : '';
        const message = status === 'cancelled'
            ? `Smart Tag cancelled at ${ok + fail}/${total}${noiseSuffix}`
            : status === 'failed'
                ? `Smart Tag failed: ${snap.message || 'unknown error'}`
                : `Smart Tag finished: ${ok} ok, ${fail} failed${noiseSuffix}.`;

        if (typeof window.showToast === 'function') {
            window.showToast(message, status === 'failed' ? 'error' : 'success');
        } else {
            (window.Logger?.info || console.log)('[smart-tag]', message);
        }

        // Surface the new captions in Dataset Maker so they show up in the
        // editor + queue without requiring a re-import (Bug: gallery-source
        // images previously needed a manual re-import from the gallery before
        // Smart Tag results appeared here).
        const dm = window.DatasetMaker;
        if (dm) {
            try {
                // When the run produced natural-language captions, seed them
                // from the DB ai_caption into the editor — the booru-tags
                // template the editor renders omits {nl_caption}, so VLM/API
                // captions were only visible in the gallery before.
                const usedVlm = snap.settings?.enable_vlm === true
                    && (snap.settings?.natural_language_mode || 'vlm') !== 'off';
                if (usedVlm && typeof dm._seedAiCaptions === 'function' && Array.isArray(dm.imageIds)) {
                    const galleryIds = dm.imageIds.filter((id) => !(dm.isLocalId?.(id)));
                    if (galleryIds.length) await dm._seedAiCaptions(galleryIds);
                }
            } catch (_e) { /* non-fatal: gallery still shows ai_caption */ }
            // Re-render queue tiles + export preview + active editor from the
            // refreshed caption state (this is what a re-import used to force).
            if (typeof dm._refreshAllCaptions === 'function') {
                try { await dm._refreshAllCaptions(); } catch (_e) { /* ignore */ }
            }
        }
        activeJobId = null;
    }

    async function runSmartTag() {
        const form = readForm();
        if (
            !form.image_ids.length
            && !form.image_paths.length
            && !form.selection_token
            && !form.dataset_scan_token
        ) {
            if (typeof window.showToast === 'function') {
                window.showToast('No images in Dataset Maker. Add images first.', 'warning');
            } else {
                alert('No images in Dataset Maker. Add images first.');
            }
            return;
        }
        if ((form.image_ids.length + form.image_paths.length) > LARGE_EXPLICIT_SOURCE_LIMIT
            && !form.selection_token
            && !form.dataset_scan_token) {
            console.warn(
                '[smart-tag] large explicit source list; selection_token or dataset_scan_token would be more efficient.',
                form.image_ids.length + form.image_paths.length
            );
        }
        if (!form.enable_wd14 && !form.enable_vlm) {
            if (typeof window.showToast === 'function') {
                window.showToast(t('smartTag.pickOneMode', 'Pick booru tags, natural-language captioning, or both.'), 'warning');
            }
            return;
        }

        // Destructive-replace guard: replace mode overwrites existing
        // captions and DB images don't get a backup, so confirm before
        // we commit a large overwrite the user can't undo.
        if (form.merge_strategy === 'replace') {
            const explicitTotal = (form.image_ids?.length || 0) + (form.image_paths?.length || 0);
            const tokenTotal = Number(form.selection_token ? (getDatasetSources().selectionTotal || 0) : 0)
                + Number(form.dataset_scan_token ? (getDatasetSources().datasetScanTotal || 0) : 0);
            const total = explicitTotal + tokenTotal;
            if (total > 100) {
                const proceed = window.confirm(
                    `This will overwrite existing captions on ${total} images. Continue?`
                );
                if (!proceed) return;
            }
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
        const cancelBtn = $('#btn-smart-tag-cancel-job');
        try {
            await postJson('/api/smart-tag/cancel', null);
            // Immediately reflect intent in the UI so the user gets
            // feedback instead of watching the progress bar keep moving
            // for ~1s until the worker checks the cancel flag.
            if (cancelBtn) cancelBtn.disabled = true;
            setProgressUI({ text: 'Cancelling — already-tagged results will be kept' });
            if (typeof window.showToast === 'function') {
                window.showToast('Smart Tag cancellation requested', 'info');
            }
        } catch (err) {
            // 404 means the job already finished between the user
            // clicking Stop and the request landing — surface that
            // explicitly instead of swallowing it silently.
            if (err && err.status === 404) {
                if (typeof window.showToast === 'function') {
                    window.showToast('Job already finished', 'info');
                }
            }
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

        $('#smart-tag-tagger-1')?.addEventListener('change', () => {
            applyThresholdDefaults($('#smart-tag-tagger-1')?.value || '', { force: false });
            applyMaxTagsDefault([
                $('#smart-tag-tagger-1')?.value || '',
                $('#smart-tag-tagger-2')?.value || '',
            ].filter(Boolean), { force: false });
            syncSmartTagVoteUi();
            updateAllTaggerHelp();
        });
        $('#smart-tag-tagger-2')?.addEventListener('change', () => {
            applyMaxTagsDefault([
                $('#smart-tag-tagger-1')?.value || '',
                $('#smart-tag-tagger-2')?.value || '',
            ].filter(Boolean), { force: false });
            syncSmartTagVoteUi();
            updateAllTaggerHelp();
        });
        $('#smart-tag-consensus-mode')?.addEventListener('change', syncSmartTagVoteUi);
        $('#smart-tag-enable-wd14')?.addEventListener('change', syncSmartTagVoteUi);
        $('#smart-tag-enable-vlm')?.addEventListener('change', () => {
            syncSmartTagVoteUi();
            refreshOllamaWarning();
        });
        $('#smart-tag-nl-mode')?.addEventListener('change', () => {
            syncSmartTagVoteUi();
            refreshOllamaWarning();
        });
        ['#smart-tag-general-threshold', '#smart-tag-character-threshold', '#smart-tag-copyright-threshold'].forEach((selector) => {
            const input = $(selector);
            if (input) input.addEventListener('input', () => { input.dataset.userTouched = 'true'; });
        });
        $('#smart-tag-max-tags')?.addEventListener('input', (event) => {
            event.currentTarget.dataset.userTouched = 'true';
        });
        $('#btn-smart-tag-vlm-settings')?.addEventListener('click', () => {
            if (window.VLMCaption && typeof window.VLMCaption.openSettingsModal === 'function') {
                window.VLMCaption.openSettingsModal();
            } else if (typeof window.showModal === 'function') {
                window.showModal('vlm-settings-modal');
            } else {
                document.getElementById('vlm-settings-modal')?.classList.add('visible');
            }
        });

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
