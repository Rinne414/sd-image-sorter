/**
 * autosep/configs.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 548-756: saved-config load/save/render plus the create/save/load/
 * rename/delete CRUD and applyAutoSepConfig (which reaches its own family
 * exports via typeof-guarded window.* calls — runtime-only, order-
 * independent). Classic script: loads after autosep/state-constants.js
 * (base).
 */
function loadAutoSepConfigs() {
    try {
        const raw = localStorage.getItem(AUTOSEP_CONFIGS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        AutoSepState.configs = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        AutoSepState.configs = [];
    }
}

function saveAutoSepConfigs() {
    // localStorage.setItem throws on quota-exceeded or when storage is disabled
    // (private mode / locked-down browser). Swallowing it silently let a config
    // vanish while the UI still claimed "Saved". Report and signal failure.
    try {
        localStorage.setItem(AUTOSEP_CONFIGS_KEY, JSON.stringify(AutoSepState.configs));
        return true;
    } catch (e) {
        if (window.Logger) Logger.error('Failed to persist auto-separate configs:', e);
        window.App?.showToast?.(
            tKey('autosep.configSaveFailed', 'Could not save config — browser storage is unavailable', '配置保存失败 — 浏览器存储不可用'),
            'error'
        );
        return false;
    }
}

function getSelectedAutoSepConfigId() {
    return document.getElementById('autosep-config-select')?.value || '';
}

function getAutoSepConfigById(configId) {
    return AutoSepState.configs.find((config) => String(config.id) === String(configId)) || null;
}

function renderAutoSepConfigControls() {
    const select = document.getElementById('autosep-config-select');
    const summary = document.getElementById('autosep-config-summary');
    if (!select || !summary) return;

    const currentValue = select.value;
    const defaultLabel = tKey('autosep.noConfigSelected', 'Select a saved config', '选择一个已保存配置');
    select.innerHTML = `<option value="">${defaultLabel}</option>` + AutoSepState.configs.map((config) =>
        `<option value="${escapeHtml(String(config.id))}">${escapeHtml(config.name || `Config ${config.id}`)}</option>`
    ).join('');

    if (currentValue && AutoSepState.configs.some((config) => String(config.id) === String(currentValue))) {
        select.value = currentValue;
    }

    const selectedConfig = getAutoSepConfigById(select.value);
    if (!selectedConfig) {
        summary.textContent = AutoSepState.configs.length
            ? tKey('autosep.configHelp', 'Save filters + destination for quick reuse.', '保存筛选+目标路径，方便下次直接用。')
            : tKey('autosep.noConfigsYet', 'No saved configs yet.', '还没有保存配置。');
    } else {
        const filters = selectedConfig.filters || {};
        const summaryParts = [];
        if (selectedConfig.destination) {
            summaryParts.push(
                tKey('autosep.summaryDestination', 'Current destination: {path}', '当前目标：{path}')
                    .replace('{path}', selectedConfig.destination)
            );
        }
        const filterSummary = window.formatFilterSummary?.(filters);
        if (filterSummary) {
            summaryParts.push(`${tKey('filter.tags', 'Tags', '标签')}: ${filterSummary.tags}`);
            summaryParts.push(`${tKey('filter.prompts', 'Prompts', '提示词')}: ${filterSummary.prompts}`);
            summaryParts.push(`${tKey('filter.sizeRules', 'Size Rules', '尺寸规则')}: ${filterSummary.dimensions}`);
        }
        summary.textContent = summaryParts.join(' • ');
    }

    const hasSelected = Boolean(selectedConfig);
    const renameBtn = document.getElementById('btn-autosep-rename-config');
    const deleteBtn = document.getElementById('btn-autosep-delete-config');
    const loadBtn = document.getElementById('btn-autosep-load-config');
    if (renameBtn) renameBtn.disabled = !hasSelected;
    if (deleteBtn) deleteBtn.disabled = !hasSelected;
    if (loadBtn) loadBtn.disabled = !hasSelected;
}

function buildAutoSepConfigPayload(name) {
    return {
        id: Date.now().toString(36),
        name,
        filters: serializeAutoSepFilters(getAutoSepFilters()),
        destination: document.getElementById('autosep-destination')?.value?.trim() || '',
        savedAt: new Date().toISOString(),
    };
}

async function createAutoSepConfig() {
    const suggestedName = `Config ${AutoSepState.configs.length + 1}`;
    const name = await window.App.showInputModal(
        tKey('autosep.newConfigTitle', 'New Auto-Separate Config', '新建自动分类配置'),
        tKey('autosep.newConfigMessage', 'Enter a name for this config:', '请输入这个配置的名称：'),
        suggestedName
    );
    if (!name) return;

    AutoSepState.configs.push(buildAutoSepConfigPayload(name.trim()));
    const persisted = saveAutoSepConfigs();
    renderAutoSepConfigControls();
    const select = document.getElementById('autosep-config-select');
    if (select) select.value = AutoSepState.configs[AutoSepState.configs.length - 1].id;
    renderAutoSepConfigControls();
    // saveAutoSepConfigs already surfaced its own error toast on failure — only
    // claim success when the config actually persisted.
    if (persisted) {
        window.App?.showToast?.(
            tKey('autosep.configSaved', 'Saved config "{name}"', '已保存配置“{name}”').replace('{name}', name.trim()),
            'success'
        );
    }
}

async function saveCurrentAutoSepConfig() {
    const configId = getSelectedAutoSepConfigId();
    if (!configId) {
        await createAutoSepConfig();
        return;
    }

    const config = getAutoSepConfigById(configId);
    if (!config) return;
    const updated = buildAutoSepConfigPayload(config.name);
    updated.id = config.id;
    const index = AutoSepState.configs.findIndex((entry) => entry.id === config.id);
    if (index >= 0) {
        AutoSepState.configs[index] = updated;
        const persisted = saveAutoSepConfigs();
        renderAutoSepConfigControls();
        const select = document.getElementById('autosep-config-select');
        if (select) select.value = config.id;
        if (persisted) {
            window.App?.showToast?.(
                tKey('autosep.configUpdated', 'Updated config "{name}"', '已更新配置“{name}”').replace('{name}', config.name),
                'success'
            );
        }
    }
}

function applyAutoSepConfig(config) {
    if (!config) return;
    setAutoSepFilters(config.filters || {});
    markAutoSepScopeCustomized();

    const destinationInput = document.getElementById('autosep-destination');
    if (destinationInput) {
        destinationInput.value = config.destination || '';
        persistAutoSepDestination(destinationInput.value.trim());
    }

    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
}

function loadSelectedAutoSepConfig() {
    const config = getAutoSepConfigById(getSelectedAutoSepConfigId());
    if (!config) return;
    applyAutoSepConfig(config);
    renderAutoSepConfigControls();
    updateAutoSepSettingsSummary();
    window.App?.showToast?.(
        tKey('autosep.configLoaded', 'Loaded config "{name}"', '已载入配置“{name}”').replace('{name}', config.name),
        'success'
    );
}

async function renameSelectedAutoSepConfig() {
    const config = getAutoSepConfigById(getSelectedAutoSepConfigId());
    if (!config) return;
    const nextName = await window.App.showInputModal(
        tKey('autosep.renameConfigTitle', 'Rename Config', '重命名配置'),
        tKey('autosep.renameConfigMessage', 'Enter the new name for this config:', '请输入这个配置的新名称：'),
        config.name
    );
    if (!nextName) return;

    config.name = nextName.trim();
    saveAutoSepConfigs();
    renderAutoSepConfigControls();
    const select = document.getElementById('autosep-config-select');
    if (select) select.value = config.id;
    renderAutoSepConfigControls();
}

function deleteSelectedAutoSepConfig() {
    const config = getAutoSepConfigById(getSelectedAutoSepConfigId());
    if (!config) return;

    window.App.showConfirm(
        tKey('autosep.deleteConfigTitle', 'Delete Config', '删除配置'),
        tKey('autosep.deleteConfigMessage', 'Delete "{name}"? This only removes the saved config.', '要删除“{name}”吗？这只会移除已保存的配置。')
            .replace('{name}', config.name),
        () => {
            AutoSepState.configs = AutoSepState.configs.filter((entry) => entry.id !== config.id);
            saveAutoSepConfigs();
            renderAutoSepConfigControls();
            window.App?.showToast?.(
                tKey('autosep.configDeleted', 'Deleted config "{name}"', '已删除配置“{name}”').replace('{name}', config.name),
                'info'
            );
        }
    );
}

