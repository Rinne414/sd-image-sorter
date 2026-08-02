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
        rememberAutoSepDestinationMru(value);
    } else {
        localStorage.removeItem(AUTOSEP_DESTINATION_KEY);
    }
}

function getSavedAutoSepDestination() {
    return localStorage.getItem(AUTOSEP_DESTINATION_KEY) || '';
}

/** B3: recent destinations MRU (local only; max AUTOSEP_DESTINATION_MRU_LIMIT). */
function getAutoSepDestinationMru() {
    try {
        const raw = JSON.parse(localStorage.getItem(AUTOSEP_DESTINATION_MRU_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw.map((item) => String(item || '').trim()).filter(Boolean).slice(0, AUTOSEP_DESTINATION_MRU_LIMIT);
    } catch (_) {
        return [];
    }
}

function rememberAutoSepDestinationMru(path) {
    const value = String(path || '').trim();
    if (!value) return;
    const next = [value, ...getAutoSepDestinationMru().filter((item) => item !== value)]
        .slice(0, AUTOSEP_DESTINATION_MRU_LIMIT);
    try {
        localStorage.setItem(AUTOSEP_DESTINATION_MRU_KEY, JSON.stringify(next));
    } catch (_) { /* ignore quota */ }
}

function renderAutoSepDestinationMru() {
    const host = document.getElementById('autosep-destination-mru');
    if (!host) return;
    const items = getAutoSepDestinationMru();
    if (!items.length) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }
    host.hidden = false;
    const label = window.I18n?.t?.('autosep.recentDestinations') || 'Recent';
    host.innerHTML = `<span class="autosep-mru-label">${escapeHtml(label)}</span>` + items.map((path) => {
        const short = path.length > 36 ? `…${path.slice(-34)}` : path;
        return `<button type="button" class="autosep-mru-chip" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(short)}</button>`;
    }).join('');
    host.querySelectorAll('.autosep-mru-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            const path = btn.getAttribute('data-path') || '';
            const input = document.getElementById('autosep-destination');
            if (!input || !path) return;
            input.value = path;
            persistAutoSepDestination(path);
            updateAutoSepSettingsSummary();
            renderAutoSepDestinationMru();
        });
    });
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
    if (typeof renderAutoSepDestinationMru === 'function') {
        renderAutoSepDestinationMru();
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

