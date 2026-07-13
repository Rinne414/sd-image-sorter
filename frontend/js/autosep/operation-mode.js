/**
 * autosep/operation-mode.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 44-145 + 1469: the prompt-match + operation-mode normalizers (the
 * corrupt-value → 'copy' fallback is locked by Principle #11 and the
 * release-build pin), tKey (an autosep-internal bare global —
 * artist-ident.js's tKey is an unrelated object METHOD; do not DRY),
 * the operation get/label/sync/set helpers, the boolean-setting helpers,
 * getAutoSepCompletedLabel, and updateAutoSepActionUi with its window
 * publish (each publish stays in the file that declares its function).
 * Classic script: loads after autosep/state-constants.js (base).
 */
function normalizeAutoSepPromptMatchMode(value) {
    const appNormalize = window.App?.normalizePromptMatchMode;
    if (typeof appNormalize === 'function') {
        return appNormalize(value);
    }
    const text = String(value || '').trim().toLowerCase();
    return AUTOSEP_PROMPT_MATCH_MODES.has(text) ? text : 'exact';
}

function tKey(key, enText, zhText = enText) {
    const translated = window.I18n?.t?.(key);
    if (translated && translated !== key) return translated;
    return window.I18n?.getLang?.() === 'zh-CN' ? zhText : enText;
}

function normalizeAutoSepOperationMode(mode) {
    // Default to 'copy' when the stored value is unrecognized so a
    // corrupt localStorage entry can never flip a brand-new user into
    // the destructive 'move' path. Locked by Principle #11 in
    // docs/AI_PRINCIPLES.md.
    return mode === 'move' ? 'move' : 'copy';
}

function getAutoSepOperationMode() {
    return normalizeAutoSepOperationMode(AutoSepState.settings.operationMode);
}

function getAutoSepOperationLabel(mode = getAutoSepOperationMode()) {
    return mode === 'copy'
        ? tKey('autosep.operationModeCopy', 'Copy and keep originals', '复制并保留原图')
        : tKey('autosep.operationModeMove', 'Move originals', '移动原图');
}

function syncAutoSepOperationControls() {
    const operationMode = getAutoSepOperationMode();
    document.querySelectorAll('input[data-autosep-operation-mode]').forEach((input) => {
        input.checked = normalizeAutoSepOperationMode(input.value) === operationMode;
    });
}

function setAutoSepOperationMode(mode, { persist = false } = {}) {
    AutoSepState.settings.operationMode = normalizeAutoSepOperationMode(mode);
    syncAutoSepOperationControls();
    if (persist) saveAutoSepSettings();
    updateAutoSepSettingsSummary();
    updateAutoSepActionUi();
}

function syncAutoSepBooleanSetting(settingKey) {
    const value = Boolean(AutoSepState.settings[settingKey]);
    document.querySelectorAll(`input[data-autosep-setting="${settingKey}"]`).forEach((input) => {
        input.checked = value;
    });
}

function setAutoSepBooleanSetting(settingKey, value, { persist = false } = {}) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_AUTOSEP_SETTINGS, settingKey)) return;
    AutoSepState.settings[settingKey] = Boolean(value);
    syncAutoSepBooleanSetting(settingKey);

    if (settingKey === 'rememberDestination') {
        const destination = document.getElementById('autosep-destination')?.value?.trim() || '';
        if (AutoSepState.settings.rememberDestination) {
            persistAutoSepDestination(destination);
        } else {
            localStorage.removeItem(AUTOSEP_DESTINATION_KEY);
        }
    }

    if (persist) saveAutoSepSettings();
    updateAutoSepSettingsSummary();
}

function getAutoSepBooleanSettingFromUi(settingKey) {
    const input = document.querySelector(`input[data-autosep-setting="${settingKey}"]`);
    return input ? Boolean(input.checked) : Boolean(AutoSepState.settings[settingKey]);
}

function getAutoSepCompletedLabel(mode = getAutoSepOperationMode(), count = '{count}') {
    return mode === 'copy'
        ? _formatAutoSepI18n('autosep.progressCopied', '{count} copied', { count })
        : _formatAutoSepI18n('autosep.progressMoved', '{count} moved', { count });
}

function updateAutoSepActionUi() {
    const executeBtn = document.getElementById('btn-execute-autosep');
    const labelSpan = executeBtn?.querySelector('[data-i18n], .ui-label, span:last-child');
    const operationMode = getAutoSepOperationMode();
    const labelKey = operationMode === 'copy' ? 'autosep.copyBtn' : 'autosep.moveBtn';
    const labelText = operationMode === 'copy'
        ? tKey(labelKey, 'Copy Images', '复制图片')
        : tKey(labelKey, 'Move Images', '移动图片');
    if (labelSpan) {
        labelSpan.setAttribute('data-i18n', labelKey);
        labelSpan.textContent = labelText;
    }
    if (executeBtn) {
        executeBtn.title = labelText;
        executeBtn.setAttribute('aria-label', labelText);
    }
}

window.updateAutoSepActionUi = updateAutoSepActionUi;
