/**
 * app/tagger-model-ui.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 6-640 (of 10,152): tagger model meta/threshold/runtime/snapshot UI + view mode.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ============== View Navigation ==============

function setGalleryViewMode(mode) {
    const nextMode = ['grid', 'large', 'waterfall'].includes(mode) ? mode : 'grid';
    AppState.viewMode = nextMode;
    AppState.pagination.pageSize = getDefaultGalleryPageSize(nextMode);
    localStorage.setItem(GALLERY_VIEW_MODE_KEY, nextMode);

    $$('.view-btn').forEach(btn => {
        const isActive = btn.dataset.size === nextMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });

    const grid = $('#gallery-grid');
    if (grid) {
        grid.classList.toggle('large', nextMode === 'large');
        grid.classList.toggle('waterfall', nextMode === 'waterfall');
        grid.classList.toggle('selection-mode', !!AppState.selectionMode);
    }

    if (window.Gallery) {
        Gallery.setViewMode(nextMode);
    }

    requestAnimationFrame(() => {
        attachGalleryPaginationListener();
        _onGalleryScroll();
    });
}

const TAGGER_MODEL_ALIASES = {
    'best quality': 'wd-eva02-large-tagger-v3',
    'best-quality': 'wd-eva02-large-tagger-v3',
    'eva02': 'wd-eva02-large-tagger-v3',
    'quality': 'wd-eva02-large-tagger-v3',
    'recommended': 'wd-swinv2-tagger-v3',
    'balanced': 'wd-swinv2-tagger-v3',
    'fast': 'wd-vit-tagger-v3',
    'lightweight': 'wd-vit-tagger-v3',
    'camie': 'camie-tagger-v2',
    'camie v2': 'camie-tagger-v2',
    'pixai': 'pixai-tagger-v0.9',
};

const TAGGER_MODEL_I18N_PREFIXES = {
    'wd-eva02-large-tagger-v3': 'tagger.model.wdEva02',
    'wd-swinv2-tagger-v3': 'tagger.model.wdSwinv2',
    'wd-convnext-tagger-v3': 'tagger.model.wdConvnext',
    'wd-vit-tagger-v3': 'tagger.model.wdVit',
    'wd-vit-large-tagger-v3': 'tagger.model.wdVitLarge',
    'camie-tagger-v2': 'tagger.model.camieV2',
    'pixai-tagger-v0.9': 'tagger.model.pixaiV09',
    'toriigate-0.5': 'tagger.model.toriigate05',
};

function getTaggerLocalizedScale(value) {
    const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return appT(`tagger.scale.${key}`, value);
}

let _taggerModelCatalog = [];
let _taggerModelCatalogMap = new Map();
let _suppressTaggerPreferencePersistence = false;
const TAGGER_CHUNK_OPTIONS = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 24, 32, 48, 64];

function normalizeTaggerModelName(value, fallback = 'wd-swinv2-tagger-v3') {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) {
        return fallback;
    }

    return TAGGER_MODEL_ALIASES[rawValue.toLowerCase()] || rawValue;
}

function getTaggerModelMeta(modelName) {
    const normalizedName = normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    return _taggerModelCatalogMap.get(normalizedName) || null;
}

function getLocalizedTaggerMeta(modelName, meta) {
    if (!meta) return null;

    const prefix = TAGGER_MODEL_I18N_PREFIXES[normalizeTaggerModelName(modelName, '')];
    if (!prefix) return meta;

    const summaryFallback = meta.description || meta.summary || appT('tagger.defaultSummary', 'WD14 tagger model');
    return {
        ...meta,
        summary: appT(`${prefix}.summary`, summaryFallback),
        description: appT(`${prefix}.summary`, summaryFallback),
        best_for: meta.best_for ? appT(`${prefix}.bestFor`, meta.best_for) : meta.best_for,
        runtime_note: meta.runtime_note ? appT(`${prefix}.runtimeNote`, meta.runtime_note) : meta.runtime_note,
        safe_mode_note: meta.safe_mode_note ? appT(`${prefix}.safeModeNote`, meta.safe_mode_note) : meta.safe_mode_note,
    };
}

// v321-ui.js (SmartTag model picker) reads the localized catalog meta through
// this window hook to show each tagger card's description/best-for line. Without
// it the call site got `undefined` and every card fell back to a bare title.
window.getTaggerModelMetaForV321 = (modelName) =>
    getLocalizedTaggerMeta(modelName, getTaggerModelMeta(modelName));

function getCustomTaggerProfile() {
    return normalizeTaggerModelName($('#tag-custom-profile-select')?.value || 'wd14', 'wd14');
}

function getEffectiveTaggerModelForUi(modelName, options = {}) {
    const { isCustom = false } = options;
    if (!isCustom) return normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    const customProfile = getCustomTaggerProfile();
    if (customProfile === 'camie-tagger-v2' || customProfile === 'pixai-tagger-v0.9') {
        return customProfile;
    }
    return 'custom';
}

function isToriiGateTaggerModel(modelName, options = {}) {
    const { isCustom = false } = options;
    if (isCustom) return false;
    return normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3') === 'toriigate-0.5';
}

function isGpuLockedTaggerModel(modelName, options = {}) {
    const { isCustom = false } = options;
    if (isCustom) return false;

    const meta = getTaggerModelMeta(modelName);
    return Boolean(meta?.gpu_locked);
}

function isRiskyTaggerGpuSelection(modelName, options = {}) {
    const {
        isCustom = false,
        useGpu = false,
        recommendedGpu = null
    } = options;
    if (!useGpu) return false;
    if (isCustom) return true;
    if (isGpuLockedTaggerModel(modelName, { isCustom })) return false;

    if (typeof recommendedGpu === 'boolean') {
        return useGpu && !recommendedGpu;
    }

    return false;
}

function describeTaggerModel(meta) {
    if (!meta) {
        return appT('tagger.descDefault', 'Balanced default. Good speed, good quality, and solid stability.');
    }

    const summary = meta.description || meta.summary || appT('tagger.defaultSummary', 'WD14 tagger model');
    const quality = Number(meta.quality_score || 0);
    const speed = Number(meta.speed_score || 0);
    const stability = Number(meta.stability_score || 0);
    return appT('tagger.descSummaryFormat', '{summary} Q{quality}/5 \u2022 S{speed}/5 \u2022 Stable {stability}/5.')
        .replace('{summary}', summary)
        .replace('{quality}', quality)
        .replace('{speed}', speed)
        .replace('{stability}', stability);
}

function describeTaggerRuntime(options = {}) {
    const {
        isCustom = false,
        gpuLocked = false,
        gpuEnabled = false,
        riskyGpu = false,
        meta = null
    } = options;

    if (gpuLocked) {
        return appT('tagger.runtimeAdaptiveMax', 'Adaptive max-throughput mode is active. The app uses GPU first, then falls back only if the GPU provider fails.');
    }

    if (isCustom) {
        if (gpuEnabled) {
            return appT('tagger.runtimeCustomGpu', 'Custom model on GPU.');
        }
        return appT('tagger.runtimeCustomCpu', 'Custom model is set to CPU only.');
    }

    if (riskyGpu) {
        return appT('tagger.runtimeRiskyGpu', 'GPU mode is enabled. Automatic hardware limits still apply.');
    }

    if (gpuEnabled) {
        const focus = meta?.best_for
            ? appT('tagger.bestForPrefix', ' Best for: {bestFor}.').replace('{bestFor}', meta.best_for)
            : '';
        return `${appT('tagger.runtimeAdaptiveGpu', 'Adaptive GPU mode is active. The app is already using the recommended fast path for this hardware.')}${focus}`;
    }

    return appT('tagger.runtimeCpuSafe', 'CPU mode is active. GPU acceleration is off for this run.');
}

function getTaggerHardwareRecommendation(modelName = null, options = {}) {
    const { isCustom = false, useGpu = true } = options;
    const info = window.__taggerSystemInfo || {};
    const recommendationsByModel = info.recommendations_by_model || {};
    const normalizedModel = isCustom
        ? 'custom'
        : normalizeTaggerModelName(modelName, 'wd-swinv2-tagger-v3');
    const modeKey = useGpu ? 'gpu' : 'cpu';

    if (recommendationsByModel[normalizedModel]?.[modeKey]) {
        return recommendationsByModel[normalizedModel][modeKey];
    }

    return info.recommendation || null;
}

function getRecommendedTaggerChunkSize(modelName = null, options = {}) {
    const recommendation = getTaggerHardwareRecommendation(modelName, options);
    const size = Number(recommendation?.recommended_batch_size || 8);
    return Number.isFinite(size) && size > 0 ? size : 8;
}

function clampTaggerChunkToAvailableOption(value) {
    const safeValue = Math.max(1, Number(value) || 1);
    const descending = [...TAGGER_CHUNK_OPTIONS].sort((a, b) => b - a);
    const match = descending.find((option) => option <= safeValue);
    return String(match || TAGGER_CHUNK_OPTIONS[0]);
}

function applyTaggerChunkOptions(batchSelect, maxChunk) {
    if (!batchSelect) return;
    const safeMax = Math.max(1, Number(maxChunk) || 1);
    Array.from(batchSelect.options).forEach((option) => {
        const optionValue = Number(option.value || 0);
        const enabled = optionValue > 0 && optionValue <= safeMax;
        option.disabled = !enabled;
        option.hidden = !enabled;
    });
}

function hasLoadedTaggerSystemInfo() {
    return Boolean(window.__taggerSystemInfo && (window.__taggerSystemInfo.system_info || window.__taggerSystemInfo.recommendation));
}

function getTaggerProviderState() {
    const probeLoaded = hasLoadedTaggerSystemInfo();
    if (!probeLoaded) {
        return {
            providers: [],
            hasCuda: false,
            hasDml: false,
            hasTensorRt: false,
            hasTorchCuda: false,
            label: appT('tag.providerUnknown', 'Provider unknown'),
            tone: 'is-info',
            probeLoaded: false,
        };
    }

    const systemInfo = window.__taggerSystemInfo?.system_info || {};
    const providers = Array.isArray(systemInfo.onnx_providers)
        ? systemInfo.onnx_providers.map((provider) => String(provider))
        : [];
    const hasCuda = providers.includes('CUDAExecutionProvider');
    const hasDml = providers.includes('DmlExecutionProvider');
    const hasTensorRt = providers.includes('TensorrtExecutionProvider');
    const hasTorchCuda = Boolean(systemInfo.torch_cuda_available);
    const label = hasTensorRt
        ? appT('tagger.tensorrtReady', 'TensorRT + CUDA ready')
        : hasCuda
            ? appT('tagger.cudaReady', 'CUDA ready')
            : hasDml
                ? appT('tagger.directmlReady', 'DirectML ready')
                : hasTorchCuda
                    ? appT('tagger.pytorchCudaOnly', 'PyTorch CUDA only')
                    : appT('tagger.cpuRuntime', 'CPU runtime');
    const tone = (hasCuda || hasTensorRt) ? 'is-safe' : 'is-warning';

    return {
        providers,
        hasCuda,
        hasDml,
        hasTensorRt,
        hasTorchCuda,
        label,
        tone,
        probeLoaded: true,
    };
}

function setTaggerStatusChip(element, text, tone = '') {
    if (!element) return;
    element.removeAttribute('data-i18n');
    element.textContent = text;
    const baseClass = element.classList.contains('system-info-chip') ? 'system-info-chip' : 'tag-runtime-chip';
    const safeTone = VALID_TONES.has(tone) ? tone : '';
    element.className = safeTone ? `${baseClass} ${safeTone}` : baseClass;
    // Ensure ARIA live region so screen readers announce chip changes
    if (!element.getAttribute('aria-live')) {
        element.setAttribute('aria-live', 'polite');
    }
}

const VALID_TONES = new Set(['', 'is-highlight', 'is-warning', 'is-danger', 'is-safe', 'is-info']);

function getTaggerSafetyTierLabel(meta) {
    const tier = String(meta?.runtime_safety_tier || '').toLowerCase();
    if (tier === 'light') return appT('tagger.tierLight', 'Light');
    if (tier === 'heavy') return appT('tagger.tierHeavy', 'Heavy');
    if (tier === 'vlm') return appT('tagger.tierVlm', 'VLM');
    return appT('tagger.tierBalanced', 'Balanced');
}

function getTaggerMinimumHardwareText(meta) {
    if (!meta) return '';

    const gpuRam = Number(meta.minimum_total_ram_gb || 0);
    const gpuFreeRam = Number(meta.minimum_available_ram_gb || 0);
    const gpuVramMb = Number(meta.minimum_gpu_vram_mb || 0);
    const gpuFreeVramMb = Number(meta.minimum_gpu_available_vram_mb || 0);
    const cpuRam = Number(meta.minimum_cpu_total_ram_gb || 0);
    const cpuFreeRam = Number(meta.minimum_cpu_available_ram_gb || 0);

    if (gpuRam || gpuVramMb || cpuRam) {
        const gpuParts = [];
        if (gpuRam) gpuParts.push(`${gpuRam} GB RAM`);
        if (gpuFreeRam) gpuParts.push(`${gpuFreeRam} GB free RAM`);
        if (gpuVramMb) gpuParts.push(`${Math.round(gpuVramMb / 1024)} GB VRAM`);
        if (gpuFreeVramMb) gpuParts.push(`${Math.round(gpuFreeVramMb / 1024)} GB free VRAM`);

        const cpuParts = [];
        if (cpuRam) cpuParts.push(`${cpuRam} GB RAM`);
        if (cpuFreeRam) cpuParts.push(`${cpuFreeRam} GB free RAM`);

        const segments = [];
        if (gpuParts.length) {
            segments.push(
                appT('tagger.minimumGpuPrefix', 'GPU minimum: {requirements}.').replace('{requirements}', gpuParts.join(' + '))
            );
        }
        if (cpuParts.length) {
            segments.push(
                appT('tagger.minimumCpuPrefix', 'CPU minimum: {requirements}.').replace('{requirements}', cpuParts.join(' + '))
            );
        }
        return segments.join(' ');
    }

    return appT(
        'tagger.minimumAdaptive',
        'No hard minimum. The runtime still clamps chunk size against current free VRAM/RAM for this model.'
    );
}

function renderTaggerModelSnapshot(meta, options = {}) {
    const {
        isCustom = false,
        modelDisabled = false,
        rawMeta = null,
    } = options;
    const subtitleEl = $('#tag-model-subtitle');
    const badgesEl = $('#tag-model-badges');
    const noteEl = $('#tag-model-note');
    if (!subtitleEl || !badgesEl || !noteEl) return;

    if (isCustom) {
        subtitleEl.textContent = appT('tagger.customSubtitle', 'Custom local ONNX model. The app cannot infer its schema or stability in advance.');
        badgesEl.innerHTML = [
            `<span class="tagger-model-badge is-warning">${escapeHtml(appT('tagger.customBadge', 'Custom'))}</span>`,
            `<span class="tagger-model-badge">${escapeHtml(appT('tagger.onnxOnlyBadge', 'ONNX only'))}</span>`,
            `<span class="tagger-model-badge">${escapeHtml(appT('tagger.schemaUnknownBadge', 'Schema unknown'))}</span>`,
        ].join('');
        const profileName = getCustomTaggerProfile();
        const profileMeta = profileName && profileName !== 'wd14' ? getLocalizedTaggerMeta(profileName, getTaggerModelMeta(profileName)) : null;
        if (profileMeta?.description) {
            subtitleEl.textContent = appT('tagger.customProfileSubtitle', 'Custom local model using {profile} profile.').replace('{profile}', profileName);
            badgesEl.innerHTML = [
                `<span class="tagger-model-badge is-warning">${escapeHtml(appT('tagger.customBadge', 'Custom'))}</span>`,
                `<span class="tagger-model-badge">${escapeHtml(profileName)}</span>`,
                `<span class="tagger-model-badge">${escapeHtml(appT('tagger.profileAwareBadge', 'Profile aware'))}</span>`,
            ].join('');
            noteEl.textContent = appT('tagger.customProfileNote', "The app will use this profile's preprocessing, metadata parser, confidence normalization, and rating behavior.");
            return;
        }
        noteEl.textContent = appT('tagger.customNote', 'Start from one stable run first. Raise chunk size only after that.');
        return;
    }

    const summary = meta?.description || meta?.summary || appT('tagger.defaultSummary', 'WD14 tagger model');
    subtitleEl.textContent = summary;

    const badges = [];
    if (meta?.recommended) badges.push({ text: appT('tagger.badgeRecommended', 'Recommended'), tone: 'is-highlight' });
    if (meta?.speed) {
        badges.push({
            text: appT('tagger.badgeSpeed', 'Speed {value}').replace('{value}', getTaggerLocalizedScale(meta.speed)),
        });
    }
    if (meta?.memory) {
        const memorySource = String(rawMeta?.memory || meta.memory || '');
        badges.push({
            text: appT('tagger.badgeMemory', 'Memory {value}').replace('{value}', getTaggerLocalizedScale(meta.memory)),
            tone: /high/i.test(memorySource) ? 'is-warning' : '',
        });
    }
    if (meta?.runtime_safety_tier) badges.push({ text: getTaggerSafetyTierLabel(meta) });
    if (meta?.best_for) badges.push({ text: meta.best_for, tone: 'is-highlight' });
    if (modelDisabled) badges.push({ text: appT('tagger.chipCatalogOnly', 'Catalog Only'), tone: 'is-warning' });

    badgesEl.innerHTML = badges
        .map((badge) => {
            const safeTone = VALID_TONES.has(badge.tone) ? badge.tone : '';
            return `<span class="tagger-model-badge${safeTone ? ` ${safeTone}` : ''}">${escapeHtml(badge.text)}</span>`;
        })
        .join('');

    const minimumHardwareText = getTaggerMinimumHardwareText(meta);
    noteEl.textContent = meta?.disabled_reason
        || meta?.safe_mode_note
        || meta?.runtime_note
        || minimumHardwareText
        || appT('tagger.defaultNote', 'The selected model changes speed, quality, and load.');
}

function applyTaggerModelThresholdDefaults(meta) {
    const thresholdInput = $('#tag-threshold');
    const thresholdValue = $('#tag-threshold-value');
    const characterThresholdInput = $('#tag-character-threshold');
    const characterThresholdValue = $('#tag-character-threshold-value');
    if (!thresholdInput || !characterThresholdInput) return;

    delete thresholdInput.dataset.userChosen;
    delete characterThresholdInput.dataset.userChosen;

    const generalThreshold = Number(meta?.default_threshold);
    const characterThreshold = Number(meta?.default_character_threshold);

    if (Number.isFinite(generalThreshold) && generalThreshold > 0) {
        thresholdInput.value = String(generalThreshold);
        if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
    }

    if (Number.isFinite(characterThreshold) && characterThreshold > 0) {
        characterThresholdInput.value = String(characterThreshold);
        if (characterThresholdValue) characterThresholdValue.textContent = characterThresholdInput.value;
    }
}

function hasActiveScanAdvancedOptions() {
    return Boolean(
        $('#scan-force-reparse')?.checked ||
        $('#scan-cleanup-missing')?.checked ||
        $('#scan-auto-tag')?.checked
    );
}

function syncScanAdvancedUi(options = {}) {
    const { resetToPreference = false } = options;
    const advancedDetails = $('#scan-advanced-options');
    if (!advancedDetails) return;

    if (resetToPreference) {
        advancedDetails.open = hasActiveScanAdvancedOptions() || readStoredBoolean(SCAN_ADVANCED_OPEN_KEY, false);
        return;
    }

    if (hasActiveScanAdvancedOptions()) {
        advancedDetails.open = true;
    }
}

function hasActiveTagAdvancedOptions() {
    return Boolean(
        ($('#tag-model-select')?.value || '') === 'custom' ||
        $('#tag-retag-all')?.checked ||
        $('#tag-use-gpu')?.dataset.userChosen === '1' ||
        $('#tagger-batch-size')?.dataset.userChosen === '1' ||
        $('#tag-threshold')?.dataset.userChosen === '1' ||
        $('#tag-character-threshold')?.dataset.userChosen === '1'
    );
}

function syncTagAdvancedUi(options = {}) {
    const { resetToPreference = false } = options;
    const advancedDetails = $('#tag-advanced-options');
    const advancedHint = $('#tag-advanced-options-hint');
    const isCustom = ($('#tag-model-select')?.value || '') === 'custom';
    const hasActiveAdvanced = hasActiveTagAdvancedOptions();
    if (!advancedDetails) return;

    if (advancedHint) {
        advancedHint.textContent = isCustom
            ? appT('tagger.advancedHintCustomPanel', 'Custom local model selected. Fill in these fields before starting.')
            : (hasActiveAdvanced
                ? appT('tagger.advancedHintActivePanel', 'Advanced settings are active for this run.')
                : appT('tagger.advancedHintPanel', 'Optional. Open this only if you want more control.'));
    }

    if (resetToPreference) {
        advancedDetails.open = isCustom || hasActiveAdvanced || readStoredBoolean(TAG_ADVANCED_OPEN_KEY, false);
        return;
    }

    if (isCustom || hasActiveAdvanced) {
        advancedDetails.open = true;
    }
}

function syncTaggerThresholdUi(options = {}) {
    const { isToriiGate = false } = options;
    const thresholdSection = $('#tag-threshold-section');
    const thresholdNote = $('#tag-threshold-note');
    const thresholdInput = $('#tag-threshold');
    const characterThresholdInput = $('#tag-character-threshold');
    const thresholdValue = $('#tag-threshold-value');
    const characterThresholdValue = $('#tag-character-threshold-value');
    if (!thresholdInput || !characterThresholdInput) return;

    if (thresholdSection) {
        thresholdSection.hidden = isToriiGate;
        thresholdSection.setAttribute('aria-hidden', String(isToriiGate));
    }
    if (thresholdNote) {
        thresholdNote.hidden = !isToriiGate;
    }

    thresholdInput.disabled = isToriiGate;
    characterThresholdInput.disabled = isToriiGate;
    thresholdInput.setAttribute('aria-disabled', String(isToriiGate));
    characterThresholdInput.setAttribute('aria-disabled', String(isToriiGate));
    if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
    if (characterThresholdValue) characterThresholdValue.textContent = characterThresholdInput.value;
}

function syncTaggerRuntimeChunkUi(options = {}) {
    const {
        modelName = 'wd-swinv2-tagger-v3',
        gpuEnabled = false,
        gpuLocked = false,
        riskyGpu = false,
        isCustom = false,
        isToriiGate = false
    } = options;

    const batchSelect = $('#tagger-batch-size');
    const batchHelp = $('#tag-batch-help');
    const batchRecommendation = $('#tag-batch-recommendation');
    const chunkChip = $('#tag-runtime-chunk-chip');
    if (!batchSelect || !batchHelp) return;

    if (isToriiGate) {
        batchSelect.value = '1';
        batchSelect.disabled = true;
        batchSelect.setAttribute('aria-disabled', 'true');
        delete batchSelect.dataset.userChosen;

        if (batchRecommendation) {
            batchRecommendation.textContent = appT('tagger.chunkHelpToriiGateFixed', 'ToriiGate uses a fixed chunk size of 1.');
        }
        if (chunkChip) {
            setTaggerStatusChip(chunkChip, 'Chunk 1', 'is-safe');
        }
        batchHelp.textContent = gpuEnabled
            ? appT('tagger.chunkHelpToriiGateGpu', 'ToriiGate uses the multimodal PyTorch backend. Chunk size is fixed to 1 for this backend.')
            : appT('tagger.chunkHelpToriiGateCpu', 'ToriiGate on CPU uses fixed chunk size 1.');
        return;
    }

    batchSelect.disabled = false;
    batchSelect.setAttribute('aria-disabled', 'false');
    const recommendation = getTaggerHardwareRecommendation(modelName, { isCustom, useGpu: gpuEnabled }) || getTaggerHardwareRecommendation(modelName, { isCustom, useGpu: true });
    const recommendedChunk = getRecommendedTaggerChunkSize(modelName, { isCustom, useGpu: gpuEnabled });
    applyTaggerChunkOptions(batchSelect, recommendedChunk);
    if (batchSelect.dataset.userChosen !== '1') {
        batchSelect.value = clampTaggerChunkToAvailableOption(recommendedChunk);
    }

    if (Number(batchSelect.value || 0) > recommendedChunk) {
        batchSelect.value = clampTaggerChunkToAvailableOption(recommendedChunk);
    }

    const selectedChunk = parseInt(batchSelect.value, 10) || recommendedChunk;
    const riskLevel = String(recommendation?.risk_level || 'medium').toLowerCase();

    if (batchRecommendation) {
        batchRecommendation.textContent = (isCustom
            ? (gpuEnabled
                ? appT('tagger.chunkHelpRecommendedCustomGpu', 'Recommended starting chunk size: {chunk}. Keep custom GPU runs conservative until the model proves stable.')
                : appT('tagger.chunkHelpRecommendedCustomCpu', 'Recommended starting chunk size: {chunk}. Increase only when tuning throughput.'))
            : appT('tagger.chunkHelpRecommended', 'Recommended chunk size: {chunk}. Leave this alone unless you are deliberately tuning throughput.'))
            .replace('{chunk}', recommendedChunk);
    }

    if (chunkChip) {
        setTaggerStatusChip(
            chunkChip,
            `Chunk ${selectedChunk}`,
            selectedChunk > recommendedChunk ? 'is-warning' : 'is-safe'
        );
    }

    if (gpuLocked) {
        batchHelp.textContent = appT('tagger.chunkHelpAdaptive', 'This model already uses adaptive runtime limits. Only change chunk size if you are stress-testing.');
        return;
    }

    if (selectedChunk > recommendedChunk) {
        batchHelp.textContent = gpuEnabled
            ? appT('tagger.chunkHelpOverGpu', 'You chose {chosen}, above the recommended {recommended}. Expect higher VRAM pressure and more crash risk.').replace('{chosen}', selectedChunk).replace('{recommended}', recommendedChunk)
            : appT('tagger.chunkHelpOverCpu', 'You chose {chosen}, above the recommended {recommended}. This may help throughput, but it raises RAM pressure.').replace('{chosen}', selectedChunk).replace('{recommended}', recommendedChunk);
        return;
    }

    if (riskyGpu) {
        batchHelp.textContent = appT('tagger.chunkHelpRiskyGpu', 'This controls true WD14 batching where supported. Risky GPU mode now starts directly, so use it only when you intentionally want more throughput.');
        return;
    }

    if (isCustom) {
        batchHelp.textContent = appT('tagger.chunkHelpCustom', 'Custom models may or may not support true batching. Start from the recommended value.');
        return;
    }

    if (riskLevel === 'high') {
        batchHelp.textContent = appT('tagger.chunkHelpHighRisk', 'This machine is marked high-risk for long GPU tagging. Leave the recommended chunk size alone.');
        return;
    }

    batchHelp.textContent = appT('tagger.chunkHelpDefault', 'This controls the true WD14 batch size when the selected model supports dynamic batching.');
}

