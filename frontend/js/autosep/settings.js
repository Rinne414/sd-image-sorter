/**
 * autosep/settings.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 757-898: settings load/save, destination persistence,
 * applyAutoSepSettingsToUi, updateAutoSepSettingsSummary and the settings
 * modal open/close/save-from-ui/reset. Classic script: loads after
 * autosep/state-constants.js (base).
 */
function loadAutoSepSettings() {
    try {
        const rawSettings = localStorage.getItem(AUTOSEP_SETTINGS_KEY);
        const parsed = rawSettings ? JSON.parse(rawSettings) : {};
        AutoSepState.settings = {
            ...DEFAULT_AUTOSEP_SETTINGS,
            ...(parsed && typeof parsed === 'object' ? parsed : {}),
        };
    } catch (_) {
        AutoSepState.settings = { ...DEFAULT_AUTOSEP_SETTINGS };
    }
}

function saveAutoSepSettings() {
    localStorage.setItem(AUTOSEP_SETTINGS_KEY, JSON.stringify(AutoSepState.settings));
}

function persistAutoSepDestination(value) {
    if (!AutoSepState.settings.rememberDestination) return;
    if (value) {
        localStorage.setItem(AUTOSEP_DESTINATION_KEY, value);
    } else {
        localStorage.removeItem(AUTOSEP_DESTINATION_KEY);
    }
}

function getSavedAutoSepDestination() {
    return localStorage.getItem(AUTOSEP_DESTINATION_KEY) || '';
}

function applyAutoSepSettingsToUi() {
    const destinationInput = document.getElementById('autosep-destination');

    syncAutoSepBooleanSetting('rememberDestination');
    syncAutoSepBooleanSetting('autoPreview');
    syncAutoSepBooleanSetting('confirmBeforeMove');
    syncAutoSepOperationControls();

    if (destinationInput && AutoSepState.settings.rememberDestination && !destinationInput.value.trim()) {
        destinationInput.value = getSavedAutoSepDestination();
    }

    updateAutoSepActionUi();
}

function updateAutoSepSettingsSummary() {
    const summaryEl = document.getElementById('autosep-settings-summary');
    if (!summaryEl) return;

    const destination = document.getElementById('autosep-destination')?.value?.trim() || '';
    const parts = [];

    parts.push(
        AutoSepState.settings.rememberDestination
            ? tKey('autosep.summaryRememberOn', 'Destination memory: On', '目标路径记忆：开启')
            : tKey('autosep.summaryRememberOff', 'Destination memory: Off', '目标路径记忆：关闭')
    );
    parts.push(
        AutoSepState.settings.autoPreview
            ? tKey('autosep.summaryAutoPreviewOn', 'Auto-preview: On', '自动预览：开启')
            : tKey('autosep.summaryAutoPreviewOff', 'Auto-preview: Off', '自动预览：关闭')
    );
    parts.push(
        AutoSepState.settings.confirmBeforeMove
            ? tKey('autosep.summaryConfirmOn', 'Confirmation: On', '执行确认：开启')
            : tKey('autosep.summaryConfirmOff', 'Confirmation: Off', '执行确认：关闭')
    );
    parts.push(
        _formatAutoSepI18n('autosep.summaryOperation', 'Action mode: {mode}', {
            mode: getAutoSepOperationLabel(),
        })
    );

    if (destination) {
        parts.push(
            tKey('autosep.summaryDestination', 'Current destination: {path}', '当前目标：{path}')
                .replace('{path}', destination)
        );
    }

    summaryEl.textContent = parts.join(' • ');
}

function openAutoSepSettingsModal() {
    applyAutoSepSettingsToUi();
    updateAutoSepSettingsSummary();
    if (typeof showModal === 'function') {
        showModal('autosep-settings-modal');
    } else {
        document.getElementById('autosep-settings-modal')?.classList.add('visible');
    }
}

function closeAutoSepSettingsModal() {
    if (typeof hideModal === 'function') {
        hideModal('autosep-settings-modal');
    } else {
        document.getElementById('autosep-settings-modal')?.classList.remove('visible');
    }
}

function saveAutoSepSettingsFromUi() {
    AutoSepState.settings.rememberDestination = getAutoSepBooleanSettingFromUi('rememberDestination');
    AutoSepState.settings.autoPreview = getAutoSepBooleanSettingFromUi('autoPreview');
    AutoSepState.settings.confirmBeforeMove = getAutoSepBooleanSettingFromUi('confirmBeforeMove');
    AutoSepState.settings.operationMode = normalizeAutoSepOperationMode(
        document.querySelector('input[data-autosep-operation-mode]:checked')?.value || getAutoSepOperationMode()
    );
    saveAutoSepSettings();

    const destination = document.getElementById('autosep-destination')?.value?.trim() || '';
    if (AutoSepState.settings.rememberDestination) {
        persistAutoSepDestination(destination);
    } else {
        localStorage.removeItem(AUTOSEP_DESTINATION_KEY);
    }

    applyAutoSepSettingsToUi();
    updateAutoSepSettingsSummary();
    updateAutoSepActionUi();
    closeAutoSepSettingsModal();
    window.App?.showToast?.(
        tKey('autosep.settingsSaved', 'Auto-Separate settings saved', '自动分类设置已保存'),
        'success'
    );
}

function resetAutoSepSettings() {
    AutoSepState.settings = { ...DEFAULT_AUTOSEP_SETTINGS };
    saveAutoSepSettings();
    localStorage.removeItem(AUTOSEP_DESTINATION_KEY);
    const destinationInput = document.getElementById('autosep-destination');
    if (destinationInput) destinationInput.value = '';
    applyAutoSepSettingsToUi();
    updateAutoSepSettingsSummary();
    updateAutoSepActionUi();
    window.App?.showToast?.(
        tKey('autosep.settingsReset', 'Saved Auto-Separate settings cleared', '自动分类已保存设置已清除'),
        'info'
    );
}

