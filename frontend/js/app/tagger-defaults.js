/**
 * app/tagger-defaults.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 641-1016 (of 10,152): syncTaggerModelUi + tagger default capture/persist/apply.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function syncTaggerModelUi(options = {}) {
    const { applyModelDefaults = false, toastOnAutoSafe = false, resetAdvancedToPreference = false } = options;
    const modelSelect = $('#tag-model-select');
    const useGpu = $('#tag-use-gpu');
    const modelHelp = $('#tag-model-help');
    const gpuHelp = $('#tag-gpu-help');
    const runtimeSummary = $('#tag-runtime-summary');
    const runtimeDetail = $('#tag-runtime-detail');
    const runtimeModeChip = $('#tag-runtime-mode-chip');
    const runtimeProviderChip = $('#tag-runtime-provider-chip');
    const runtimeAdvanced = $('#tag-runtime-advanced');
    const runtimeAdvancedHint = $('#tag-runtime-advanced-hint');
    const customProfileGroup = $('#custom-profile-group');
    const customProfileSelect = $('#tag-custom-profile-select');
    const customModelGroup = $('#custom-model-group');
    const customTagsGroup = $('#custom-tags-group');
    const disabledNotice = $('#tagger-disabled-notice');
    const disabledTitle = $('#tagger-disabled-title');
    const disabledBody = $('#tagger-disabled-body');
    if (!modelSelect) return;

    const rawValue = modelSelect.value || '';
    const isCustom = rawValue === 'custom';
    const normalizedModel = normalizeTaggerModelName(rawValue, 'wd-swinv2-tagger-v3');
    const effectiveModelForUi = getEffectiveTaggerModelForUi(normalizedModel, { isCustom });
    const rawMeta = getTaggerModelMeta(effectiveModelForUi === 'custom' ? normalizedModel : effectiveModelForUi);
    const meta = getLocalizedTaggerMeta(effectiveModelForUi === 'custom' ? normalizedModel : effectiveModelForUi, rawMeta);
    const isToriiGate = isToriiGateTaggerModel(effectiveModelForUi, { isCustom: false });
    const gpuLocked = isGpuLockedTaggerModel(effectiveModelForUi, { isCustom });
    const gpuUserChosen = useGpu?.dataset.userChosen === '1';
    const currentGpuSelection = useGpu?.checked ?? true;
    const activeHardwareRecommendation = getTaggerHardwareRecommendation(effectiveModelForUi, { isCustom: effectiveModelForUi === 'custom', useGpu: currentGpuSelection });
    const gpuHardwareRecommendation = getTaggerHardwareRecommendation(effectiveModelForUi, { isCustom: effectiveModelForUi === 'custom', useGpu: true });
    const hardwareRecommendation = activeHardwareRecommendation || gpuHardwareRecommendation;
    const providerState = getTaggerProviderState();
    const hardwareProbeLoaded = providerState.probeLoaded;
    const onnxGpuAvailable = providerState.hasCuda || providerState.hasDml;
    const torchGpuAvailable = providerState.hasTorchCuda || providerState.hasCuda || providerState.hasTensorRt;
    const hardwareRisk = String(hardwareRecommendation?.risk_level || '').toLowerCase();
    const hardwarePrefersGpu = true;
    const hardwareHighRisk = hardwareRisk === 'high';
    const taggingIsRunning = $('#btn-start-tag')?.disabled === true;
    const modelDisabled = !isCustom && Boolean(meta?.disabled);
    const modelPrefersGpu = Boolean(meta?.gpu_default ?? true);
    const recommendedGpu = gpuLocked ? false : (modelPrefersGpu && hardwarePrefersGpu);

    if (customProfileGroup) customProfileGroup.style.display = isCustom ? 'block' : 'none';
    if (customProfileSelect) customProfileSelect.disabled = taggingIsRunning;
    if (customModelGroup) customModelGroup.style.display = isCustom ? 'block' : 'none';
    if (customTagsGroup) customTagsGroup.style.display = isCustom ? 'block' : 'none';
    renderTaggerModelSnapshot(meta, { isCustom, modelDisabled, rawMeta });
    syncTaggerThresholdUi({ isToriiGate });

    if (applyModelDefaults && meta && (!isCustom || effectiveModelForUi !== 'custom')) {
        applyTaggerModelThresholdDefaults(meta);
    }

    if (useGpu && gpuLocked) {
        useGpu.checked = false;
    } else if (useGpu && applyModelDefaults && !gpuUserChosen) {
        useGpu.checked = recommendedGpu;
    }

    if (runtimeAdvanced && applyModelDefaults && !taggingIsRunning) {
        runtimeAdvanced.open = false;
    }

    if (useGpu) {
        useGpu.disabled = taggingIsRunning ? true : (gpuLocked || modelDisabled);
        useGpu.setAttribute('aria-disabled', String(useGpu.disabled));
    }

    if (modelHelp) {
        if (isCustom) {
            const customProfile = getCustomTaggerProfile();
            if (customProfile === 'camie-tagger-v2') {
                modelHelp.textContent = appT('tagger.customCamieHelp', 'Custom Camie ONNX: use the Camie metadata JSON. Logits are sigmoid-normalized before thresholds.');
            } else if (customProfile === 'pixai-tagger-v0.9') {
                modelHelp.textContent = appT('tagger.customPixaiHelp', 'Custom PixAI ONNX: use selected_tags.csv. PixAI preprocessing and rating fallback are enabled.');
            } else {
                modelHelp.textContent = (useGpu?.checked ?? false)
                    ? appT('tagger.customModelHelpGpuPreferred', 'Custom ONNX model. GPU mode is on for this run.')
                    : appT('tagger.customModelHelp', 'Custom ONNX model. CPU mode is selected for this run.');
            }
        } else if (modelDisabled) {
            modelHelp.textContent = meta?.disabled_reason || appT('tagger.modelListedFuture', 'This model is listed for future integration but is not runnable in the current build.');
        } else {
            modelHelp.textContent = describeTaggerModel(meta);
        }
    }

    const gpuEnabled = useGpu?.checked ?? false;
    const riskyGpu = modelDisabled ? false : isRiskyTaggerGpuSelection(effectiveModelForUi, {
        isCustom: isCustom && effectiveModelForUi === 'custom',
        useGpu: gpuEnabled,
        recommendedGpu
    });
    const liveRuntime = taggingIsRunning ? (window.__liveTagProgress || null) : null;
    const liveTargetBackend = String(liveRuntime?.runtime_backend_target || (gpuEnabled ? 'gpu' : 'cpu')).toLowerCase();
    const liveActualBackend = String(liveRuntime?.runtime_backend_actual || '').toLowerCase();
    const liveRuntimeReason = String(liveRuntime?.runtime_backend_reason || '').trim();
    const liveMemoryPressure = String(liveRuntime?.memory_pressure_warning || '').trim();
    const hasLiveRuntime = Boolean(liveActualBackend) && !modelDisabled;

    if (runtimeSummary) {
        let summary = modelDisabled
            ? (meta?.disabled_reason || appT('tagger.modelUnavailable', 'This model is currently unavailable in the app runtime.'))
            : describeTaggerRuntime({
            isCustom,
            gpuLocked,
            gpuEnabled,
            riskyGpu,
            meta
        });
        const recommendedChunk = getRecommendedTaggerChunkSize(normalizedModel, { isCustom, useGpu: gpuEnabled });
        if (hasLiveRuntime) {
            summary = `Requested ${liveTargetBackend.toUpperCase()}, actual ${liveActualBackend.toUpperCase()}.`;
            if (liveRuntimeReason) {
                summary += ` ${liveRuntimeReason}`;
            }
            if (liveMemoryPressure) {
                summary += ` ${liveMemoryPressure}`;
            }
        }
        runtimeSummary.textContent = summary;
    }

    if (runtimeDetail) {
        if (modelDisabled) {
            runtimeDetail.textContent = appT('tagger.catalogOnlyDetail', 'This is a planned integration, listed for reference. It can\'t run yet.');
        } else if (hasLiveRuntime) {
            let detail = `Actual backend: ${liveActualBackend.toUpperCase()}.`;
            if (liveTargetBackend && liveTargetBackend !== liveActualBackend) {
                detail += ` Target requested ${liveTargetBackend.toUpperCase()}.`;
            }
            if (liveRuntimeReason) {
                detail += ` ${liveRuntimeReason}`;
            }
            if (liveMemoryPressure) {
                detail += ` ${liveMemoryPressure}`;
            }
            runtimeDetail.textContent = detail;
        } else if (meta) {
            runtimeDetail.textContent = getTaggerMinimumHardwareText(meta);
        } else if (isToriiGate) {
            runtimeDetail.textContent = gpuEnabled
                ? appT('tagger.toriiGateGpuDetail', 'ToriiGate runs on PyTorch CUDA. WD14 thresholds don\'t apply.')
                : appT('tagger.toriiGateCpuDetail', 'ToriiGate can run on CPU, but much slower than CUDA. WD14 thresholds don\'t apply.');
        } else if (isCustom) {
            runtimeDetail.textContent = onnxGpuAvailable
                ? appT('tagger.customGpuAvailDetail', 'A GPU is available, but whether this model runs stably on it is only known once it loads.')
                : appT('tagger.customCpuOnlyDetail', 'ONNX Runtime can\'t use CUDA right now, so the custom model will run on CPU.');
        } else if (!hardwareProbeLoaded) {
            runtimeDetail.textContent = appT('tagger.hardwarePendingDetail', 'Still checking the hardware. GPU stays on until the check finishes.');
        } else if (providerState.hasCuda || providerState.hasDml) {
            runtimeDetail.textContent = appT('tagger.cudaAvailDetail', 'CUDA is available here. If the model loads cleanly, it runs on the GPU.');
        } else if (providerState.hasTorchCuda) {
            runtimeDetail.textContent = appT('tagger.pytorchCudaOnlyDetail', 'PyTorch can use CUDA, but ONNX Runtime is still CPU-only on this computer.');
        } else {
            runtimeDetail.textContent = appT('tagger.cpuOnlyDetail', 'ONNX Runtime didn\'t detect CUDA, so this run uses the CPU.');
        }
    }

    if (runtimeModeChip) {
        setTaggerStatusChip(
            runtimeModeChip,
            modelDisabled
                ? appT('tagger.chipCatalogOnly', 'Catalog Only')
                : (hasLiveRuntime
                ? `${liveTargetBackend.toUpperCase()} target -> ${liveActualBackend.toUpperCase()} actual`
                    : (gpuEnabled ? appT('tagger.chipGpuTarget', 'GPU Target') : appT('tagger.chipCpuTarget', 'CPU Target'))),
            modelDisabled ? 'is-danger' : (!hardwareProbeLoaded && !hasLiveRuntime ? 'is-info' : ((hasLiveRuntime ? liveActualBackend === 'gpu' : gpuEnabled) ? 'is-safe' : 'is-warning'))
        );
    }

    if (runtimeProviderChip) {
        const providerLabel = modelDisabled
            ? appT('tagger.chipVlmNeeded', 'VLM Backend Needed')
            : (hasLiveRuntime
                ? `Actual ${liveActualBackend.toUpperCase()}`
                : (!hardwareProbeLoaded
                    ? appT('tag.providerUnknown', 'Provider unknown')
                : (isToriiGate
                    ? ((window.__taggerSystemInfo?.system_info?.torch_cuda_available && gpuEnabled) ? appT('tagger.chipPytorchCuda', 'PyTorch CUDA') : appT('tagger.chipPytorchCpu', 'PyTorch CPU'))
                    : ((providerState.hasCuda || providerState.hasDml || providerState.hasTorchCuda) ? providerState.label : appT('tagger.chipCpuRuntime', 'CPU Runtime')))));
        const providerTone = modelDisabled
            ? 'is-danger'
            : (hasLiveRuntime
                ? (liveActualBackend === 'gpu' ? 'is-safe' : 'is-warning')
                : (!hardwareProbeLoaded
                    ? 'is-info'
                : (isToriiGate
                ? (gpuEnabled ? 'is-safe' : 'is-warning')
                : providerState.tone)));
        setTaggerStatusChip(runtimeProviderChip, providerLabel, providerTone);
    }

    if (disabledNotice && disabledTitle && disabledBody) {
        if (modelDisabled) {
            disabledNotice.hidden = false;
            disabledTitle.textContent = appT('tagger.disabledNotRunnable', '{model} is not runnable in the current build.').replace('{model}', normalizedModel);
            disabledBody.textContent = meta?.disabled_reason || appT('tagger.disabledFallback', 'Use one of the ONNX taggers above for now.');
        } else {
            disabledNotice.hidden = true;
        }
    }

    if (runtimeAdvancedHint) {
        if (gpuLocked) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintStressTest', 'Optional. Change this only if you are stress-testing.');
        } else if (hardwareHighRisk && !gpuEnabled) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintHighRisk', 'Optional. This computer is flagged as risky for long GPU tagging runs.');
        } else if (isCustom) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintCustom', 'Optional. Change this only when troubleshooting a custom model.');
        } else if (gpuEnabled && !riskyGpu) {
            runtimeAdvancedHint.textContent = appT('tagger.advHintRecommended', 'Optional. The recommended mode is already active.');
        } else {
            runtimeAdvancedHint.textContent = appT('tagger.advHintDefault', 'Optional. Change this only when troubleshooting or tuning.');
        }
    }

    if (gpuHelp) {
        if (modelDisabled) {
            gpuHelp.textContent = meta?.disabled_reason || appT('tagger.modelNotStartable', 'This model cannot be started in the current build.');
        } else if (hasLiveRuntime) {
            let helpText = `Actual backend: ${liveActualBackend.toUpperCase()}.`;
            if (liveRuntimeReason) {
                helpText += ` ${liveRuntimeReason}`;
            }
            if (liveMemoryPressure) {
                helpText += ` ${liveMemoryPressure}`;
            }
            gpuHelp.textContent = helpText;
        } else if (isToriiGate) {
            gpuHelp.textContent = gpuEnabled
                ? appT('tagger.gpuHelpToriiGateGpu', 'ToriiGate is using the multimodal PyTorch backend on GPU. Keep chunk size small.')
                : appT('tagger.gpuHelpToriiGateCpu', 'ToriiGate is using the multimodal PyTorch backend on CPU. This is valid but much slower than CUDA.');
        } else if (!hardwareProbeLoaded) {
            gpuHelp.textContent = appT('tagger.gpuHelpPendingProbe', 'Hardware probe is still loading. GPU remains enabled by default while the runtime check finishes.');
        } else if (gpuLocked) {
            gpuHelp.textContent = appT('tagger.gpuHelpAdaptive', 'Adaptive runtime is active for this model. The app prefers GPU throughput.');
        } else if (!gpuEnabled) {
            gpuHelp.textContent = isCustom
                ? appT('tagger.gpuHelpCustomCpu', 'CPU mode is active for the custom model. Switch GPU back on if you want acceleration.')
                : (hardwareHighRisk
                    ? appT('tagger.gpuHelpHighRiskCpu', 'CPU mode is active. GPU acceleration is disabled for this run.')
                    : appT('tagger.gpuHelpCpuSafe', 'CPU mode is active. GPU acceleration is disabled for this run.'));
        } else if (riskyGpu) {
            gpuHelp.textContent = appT('tagger.gpuHelpRiskyOverride', 'GPU mode is active. Automatic hardware limits still apply.');
        } else if (meta?.safe_mode_note) {
            gpuHelp.textContent = appT('tagger.gpuHelpRecommendedNote', 'Recommended GPU mode is active. {note}').replace('{note}', meta.safe_mode_note);
        } else {
            gpuHelp.textContent = appT('tagger.gpuHelpRecommendedDefault', 'GPU mode is active for this model.');
        }
    }

    syncTaggerRuntimeChunkUi({
        modelName: effectiveModelForUi,
        gpuEnabled,
        gpuLocked,
        riskyGpu,
        isCustom: isCustom && effectiveModelForUi === 'custom',
        isToriiGate
    });

    syncTagAdvancedUi({ resetToPreference: resetAdvancedToPreference || applyModelDefaults });
}

function getAvailableTaggerOptionValue(value) {
    const select = $('#tag-model-select');
    const requested = String(value || '').trim();
    if (!select || !requested) return '';
    const option = Array.from(select.querySelectorAll('option')).find((item) => item.value === requested && !item.disabled);
    return option ? requested : '';
}

function captureTaggerDefaultsFromDom() {
    const modelSelect = $('#tag-model-select');
    const thresholdInput = $('#tag-threshold');
    const characterThresholdInput = $('#tag-character-threshold');
    const useGpu = $('#tag-use-gpu');
    const batchSelect = $('#tagger-batch-size');
    return {
        modelName: modelSelect?.value || '',
        threshold: finiteNumberInRange(thresholdInput?.value, 0, 1, 0.35),
        characterThreshold: finiteNumberInRange(characterThresholdInput?.value, 0, 1, 0.85),
        useGpu: useGpu ? !!useGpu.checked : true,
        batchSize: batchSelect?.value || '',
        customProfile: $('#tag-custom-profile-select')?.value || '',
        customModelPath: $('#tag-model-path')?.value || '',
        customTagsPath: $('#tag-tags-path')?.value || '',
    };
}

function persistTaggerDefaultsFromDom() {
    if (_suppressTaggerPreferencePersistence) return false;
    const saved = AppPreferences.setTaggerDefaults(captureTaggerDefaultsFromDom());
    syncSettingsPreferenceStatus();
    return saved;
}

function applyStoredTaggerDefaults(options = {}) {
    const defaults = options.defaults || AppPreferences.getTaggerDefaults();
    if (!defaults || typeof defaults !== 'object') return false;

    const modelSelect = $('#tag-model-select');
    const modelValue = getAvailableTaggerOptionValue(defaults.modelName);
    if (modelSelect && modelValue) {
        modelSelect.value = modelValue;
    }

    const customProfile = $('#tag-custom-profile-select');
    if (customProfile && defaults.customProfile) customProfile.value = defaults.customProfile;
    const customModelPath = $('#tag-model-path');
    if (customModelPath && defaults.customModelPath) customModelPath.value = defaults.customModelPath;
    const customTagsPath = $('#tag-tags-path');
    if (customTagsPath && defaults.customTagsPath) customTagsPath.value = defaults.customTagsPath;

    const threshold = finiteNumberInRange(defaults.threshold, 0, 1, null);
    const thresholdInput = $('#tag-threshold');
    const thresholdValue = $('#tag-threshold-value');
    if (thresholdInput && threshold !== null) {
        thresholdInput.value = String(threshold);
        thresholdInput.dataset.userChosen = '1';
        if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
    }

    const characterThreshold = finiteNumberInRange(defaults.characterThreshold, 0, 1, null);
    const characterThresholdInput = $('#tag-character-threshold');
    const characterThresholdValue = $('#tag-character-threshold-value');
    if (characterThresholdInput && characterThreshold !== null) {
        characterThresholdInput.value = String(characterThreshold);
        characterThresholdInput.dataset.userChosen = '1';
        if (characterThresholdValue) characterThresholdValue.textContent = characterThresholdInput.value;
    }

    const useGpu = $('#tag-use-gpu');
    const savedGpu = booleanPreference(defaults.useGpu, null);
    if (useGpu && savedGpu !== null) {
        useGpu.checked = savedGpu;
        useGpu.dataset.userChosen = '1';
    }

    const batchSelect = $('#tagger-batch-size');
    if (batchSelect && defaults.batchSize) {
        batchSelect.value = String(defaults.batchSize);
        batchSelect.dataset.userChosen = '1';
    }

    syncTaggerModelUi({ applyModelDefaults: false, resetAdvancedToPreference: true });
    syncSettingsPreferenceStatus();
    return true;
}

function resetTaggerDefaultControls() {
    const modelSelect = $('#tag-model-select');
    if (modelSelect) {
        const defaultModel = getAvailableTaggerOptionValue('wd-swinv2-tagger-v3') || modelSelect.querySelector('option:not([disabled])')?.value || modelSelect.value;
        modelSelect.value = defaultModel;
    }

    ['tag-threshold', 'tag-character-threshold', 'tag-use-gpu', 'tagger-batch-size'].forEach((id) => {
        const element = document.getElementById(id);
        if (element?.dataset) delete element.dataset.userChosen;
    });

    const customProfile = $('#tag-custom-profile-select');
    if (customProfile) customProfile.value = 'wd14';
    const customModelPath = $('#tag-model-path');
    if (customModelPath) customModelPath.value = '';
    const customTagsPath = $('#tag-tags-path');
    if (customTagsPath) customTagsPath.value = '';

    syncTaggerModelUi({ applyModelDefaults: true, resetAdvancedToPreference: true });
}

