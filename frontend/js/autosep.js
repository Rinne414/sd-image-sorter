/**
 * SD Image Sorter - Auto-Separate Module
 * Handles batch filtering and moving of images
 */

let _previewRequestId = 0;
let _autosepPreviewTimer = null;
const AUTOSEP_SETTINGS_KEY = 'autosep_settings_v1';
const AUTOSEP_DESTINATION_KEY = 'autosep_destination_v1';
const AUTOSEP_CONFIGS_KEY = 'autosep_configs_v1';
const AUTOSEP_FILTER_STATE_KEY = 'autosep_filter_state_v1';

const DEFAULT_AUTOSEP_SETTINGS = {
    rememberDestination: true,
    autoPreview: false,
    confirmBeforeMove: true,
};

const AutoSepState = {
    matchCount: 0,
    previewImages: [],
    previewSignature: null,
    settings: { ...DEFAULT_AUTOSEP_SETTINGS },
    configs: [],
    filters: null,
};

function tKey(key, enText, zhText = enText) {
    const translated = window.I18n?.t?.(key);
    if (translated && translated !== key) return translated;
    return window.I18n?.getLang?.() === 'zh-CN' ? zhText : enText;
}

function getFallbackAutoSepFilters() {
    const clone = window.App?.cloneFilterState;
    if (typeof clone === 'function') {
        return serializeAutoSepFilters(clone(window.App?.AppState?.filters || null));
    }
    return serializeAutoSepFilters({});
}

function loadAutoSepFilters() {
    try {
        const raw = localStorage.getItem(AUTOSEP_FILTER_STATE_KEY);
        if (raw) {
            AutoSepState.filters = serializeAutoSepFilters(JSON.parse(raw));
            return;
        }
    } catch (_) {
        // Fall back to a safe default when the saved state is invalid.
    }
    AutoSepState.filters = getFallbackAutoSepFilters();
}

function saveAutoSepFilters() {
    localStorage.setItem(AUTOSEP_FILTER_STATE_KEY, JSON.stringify(serializeAutoSepFilters(AutoSepState.filters || {})));
}

function setAutoSepFilters(nextFilters) {
    AutoSepState.filters = serializeAutoSepFilters(nextFilters || {});
    saveAutoSepFilters();
}

function getAutoSepFilters() {
    if (!AutoSepState.filters) {
        loadAutoSepFilters();
    }
    return AutoSepState.filters;
}

// ============== Initialization ==============

function initAutoSeparate() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);
    loadAutoSepFilters();
    loadAutoSepSettings();
    applyAutoSepSettingsToUi();
    updateAutoSepSettingsSummary();
    loadAutoSepConfigs();
    renderAutoSepConfigControls();

    // Edit Filters button - opens unified filter modal
    const filterBtn = $('#btn-autosep-filters');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            if (window.App && window.App.openFilterModal) {
                window.App.openFilterModal({
                    mode: 'auto-separate',
                    titleText: tKey('autosep.filterTitle', 'Auto-Separate Filters', '自动分类筛选'),
                    applyButtonText: tKey('autosep.applyFilters', 'Apply to Auto-Separate', '应用到自动分类'),
                    resetButtonText: tKey('autosep.resetFilters', 'Reset Auto-Separate Filters', '重置自动分类筛选'),
                    filterState: getAutoSepFilters(),
                    onApply: (filters) => {
                        setAutoSepFilters(filters);
                        updateAutoSepSummary();
                        invalidateAutoSepPreview();
                        renderAutoSepConfigControls();
                    },
                    onReset: (filters) => {
                        setAutoSepFilters(filters);
                        updateAutoSepSummary();
                        invalidateAutoSepPreview();
                        renderAutoSepConfigControls();
                    },
                });
            } else {
                Logger.error('openFilterModal not available');
            }
        });
    }

    // Preview button
    const previewBtn = $('#btn-preview-autosep');
    if (previewBtn) {
        previewBtn.addEventListener('click', updateAutoSepPreview);
    }

    // Execute button
    const executeBtn = $('#btn-execute-autosep');
    if (executeBtn) {
        executeBtn.addEventListener('click', executeAutoSeparateWithProgress);
    }

    // Browse button for destination folder
    const browseBtn = $('#btn-browse-destination');
    if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
            const input = $('#autosep-destination');
            // Browser can't access filesystem directly, prompt user for path
            const currentPath = input ? input.value : '';
            const path = await window.App.showInputModal(
                'Destination Folder',
                'Enter the destination folder path.\nExample: D:\\sorted\\my-folder',
                currentPath
            );
            if (path !== null && input) {
                input.value = path;
                persistAutoSepDestination(path);
                updateAutoSepSettingsSummary();
            }
        });
    }

    $('#autosep-destination')?.addEventListener('input', (event) => {
        persistAutoSepDestination(String(event.target.value || '').trim());
        updateAutoSepSettingsSummary();
    });

    $('#btn-autosep-settings')?.addEventListener('click', openAutoSepSettingsModal);
    $('#btn-close-autosep-settings')?.addEventListener('click', closeAutoSepSettingsModal);
    $('#btn-cancel-autosep-settings')?.addEventListener('click', closeAutoSepSettingsModal);
    $('#autosep-settings-modal .modal-backdrop')?.addEventListener('click', closeAutoSepSettingsModal);
    $('#btn-save-autosep-settings')?.addEventListener('click', saveAutoSepSettingsFromUi);
    $('#btn-reset-autosep-settings')?.addEventListener('click', resetAutoSepSettings);
    $('#btn-autosep-new-config')?.addEventListener('click', createAutoSepConfig);
    $('#btn-autosep-save-config')?.addEventListener('click', saveCurrentAutoSepConfig);
    $('#btn-autosep-load-config')?.addEventListener('click', loadSelectedAutoSepConfig);
    $('#btn-autosep-rename-config')?.addEventListener('click', renameSelectedAutoSepConfig);
    $('#btn-autosep-delete-config')?.addEventListener('click', deleteSelectedAutoSepConfig);
    $('#autosep-config-select')?.addEventListener('change', renderAutoSepConfigControls);

    resumeAutosepMoveProgress();
}

function serializeAutoSepFilters(filters) {
    const source = filters || {};
    return {
        generators: [...(source.generators || ['comfyui', 'nai', 'webui', 'forge', 'unknown'])],
        ratings: [...(source.ratings || ['general', 'sensitive', 'questionable', 'explicit'])],
        tags: [...(source.tags || [])],
        checkpoints: [...(source.checkpoints || [])],
        loras: [...(source.loras || [])],
        prompts: [...(source.prompts || [])],
        artist: source.artist || null,
        search: source.search || '',
        minWidth: source.minWidth || null,
        maxWidth: source.maxWidth || null,
        minHeight: source.minHeight || null,
        maxHeight: source.maxHeight || null,
        aspectRatio: source.aspectRatio || '',
        minAesthetic: source.minAesthetic || null,
        maxAesthetic: source.maxAesthetic || null,
    };
}

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
    localStorage.setItem(AUTOSEP_CONFIGS_KEY, JSON.stringify(AutoSepState.configs));
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
            ? tKey('autosep.configHelp', 'Saved configs keep your current filters and destination for later reuse.', '已保存配置会记住你当前的筛选条件和目标目录，方便以后直接复用。')
            : tKey('autosep.noConfigsYet', 'No saved configs yet. Save your current setup as Config 1, Config 2, and more.', '还没有保存配置。你可以把当前规则保存成 Config 1、Config 2 等方案。');
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
    saveAutoSepConfigs();
    renderAutoSepConfigControls();
    const select = document.getElementById('autosep-config-select');
    if (select) select.value = AutoSepState.configs[AutoSepState.configs.length - 1].id;
    renderAutoSepConfigControls();
    window.App?.showToast?.(
        tKey('autosep.configSaved', 'Saved config "{name}"', '已保存配置“{name}”').replace('{name}', name.trim()),
        'success'
    );
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
        saveAutoSepConfigs();
        renderAutoSepConfigControls();
        const select = document.getElementById('autosep-config-select');
        if (select) select.value = config.id;
        window.App?.showToast?.(
            tKey('autosep.configUpdated', 'Updated config "{name}"', '已更新配置“{name}”').replace('{name}', config.name),
            'success'
        );
    }
}

function applyAutoSepConfig(config) {
    if (!config) return;
    setAutoSepFilters(config.filters || {});

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
    const rememberDestination = document.getElementById('autosep-remember-destination');
    const autoPreview = document.getElementById('autosep-auto-preview');
    const confirmMove = document.getElementById('autosep-confirm-move');

    if (rememberDestination) rememberDestination.checked = Boolean(AutoSepState.settings.rememberDestination);
    if (autoPreview) autoPreview.checked = Boolean(AutoSepState.settings.autoPreview);
    if (confirmMove) confirmMove.checked = Boolean(AutoSepState.settings.confirmBeforeMove);

    if (destinationInput && AutoSepState.settings.rememberDestination && !destinationInput.value.trim()) {
        destinationInput.value = getSavedAutoSepDestination();
    }
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
            ? tKey('autosep.summaryConfirmOn', 'Confirm move: On', '移动确认：开启')
            : tKey('autosep.summaryConfirmOff', 'Confirm move: Off', '移动确认：关闭')
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
    AutoSepState.settings.rememberDestination = Boolean(document.getElementById('autosep-remember-destination')?.checked);
    AutoSepState.settings.autoPreview = Boolean(document.getElementById('autosep-auto-preview')?.checked);
    AutoSepState.settings.confirmBeforeMove = Boolean(document.getElementById('autosep-confirm-move')?.checked);
    saveAutoSepSettings();

    const destination = document.getElementById('autosep-destination')?.value?.trim() || '';
    if (AutoSepState.settings.rememberDestination) {
        persistAutoSepDestination(destination);
    } else {
        localStorage.removeItem(AUTOSEP_DESTINATION_KEY);
    }

    updateAutoSepSettingsSummary();
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
    window.App?.showToast?.(
        tKey('autosep.settingsReset', 'Saved Auto-Separate settings cleared', '自动分类已保存设置已清除'),
        'info'
    );
}

// ============== Update Summary Display ==============

function updateAutoSepSummary() {
    const { $ } = window.App;
    const filters = getAutoSepFilters();
    if (!filters) return;

    // Use shared filter summary formatter
    const summary = window.formatFilterSummary(filters);

    // Generators
    const genEl = $('#autosep-summary-generators');
    if (genEl) genEl.textContent = summary.generators;

    // Tags
    const tagEl = $('#autosep-summary-tags');
    if (tagEl) tagEl.textContent = summary.tags;

    // Ratings
    const ratingEl = $('#autosep-summary-ratings');
    if (ratingEl) ratingEl.textContent = summary.ratings;

    // Checkpoints
    const cpEl = $('#autosep-summary-checkpoints');
    if (cpEl) cpEl.textContent = summary.checkpoints;

    // Loras
    const loraEl = $('#autosep-summary-loras');
    if (loraEl) loraEl.textContent = summary.loras;

    // Prompts
    const promptEl = $('#autosep-summary-prompts');
    if (promptEl) promptEl.textContent = summary.prompts;

    // Search
    const searchEl = $('#autosep-summary-search');
    if (searchEl) searchEl.textContent = summary.search;

    // Dimensions
    const dimEl = $('#autosep-summary-dimensions');
    if (dimEl) dimEl.textContent = summary.dimensions;
}

function getAutoSepFilterSignature(filters) {
    return JSON.stringify({
        generators: filters.generators || [],
        tags: filters.tags || [],
        ratings: filters.ratings || [],
        checkpoints: filters.checkpoints || [],
        loras: filters.loras || [],
        prompts: filters.prompts || [],
        search: filters.search || '',
        minWidth: filters.minWidth || null,
        maxWidth: filters.maxWidth || null,
        minHeight: filters.minHeight || null,
        maxHeight: filters.maxHeight || null,
        aspectRatio: filters.aspectRatio || null,
        minAesthetic: filters.minAesthetic ?? null,
        maxAesthetic: filters.maxAesthetic ?? null,
    });
}

function renderAutoSepPreviewList(images = [], totalCount = 0) {
    const { $, API, openGalleryPreview } = window.App;
    const container = $('#autosep-preview-list');
    if (!container) return;

    container.innerHTML = '';

    if (!images.length) {
        const empty = document.createElement('div');
        empty.className = 'autosep-preview-empty';
        empty.textContent = window.I18n?.t?.('autosep.previewEmptyInitial') || 'No preview yet. Click "Preview Results" to inspect matching images.';
        container.appendChild(empty);
        return;
    }

    images.forEach((image) => {
        const button = document.createElement('button');
        button.className = 'autosep-preview-item';
        button.type = 'button';
        button.dataset.imageId = String(image.id);
        button.title = `Open ${image.filename}`;

        const img = document.createElement('img');
        img.className = 'autosep-preview-thumb';
        img.src = API.getThumbnailUrl(image.id, 256);
        img.alt = image.filename;

        const name = document.createElement('span');
        name.className = 'autosep-preview-name';
        name.textContent = image.filename;

        button.append(img, name);
        button.addEventListener('click', () => {
            const imageId = parseInt(button.dataset.imageId, 10);
            if (typeof openGalleryPreview === 'function') {
                openGalleryPreview(imageId);
            }
        });

        container.appendChild(button);
    });

    const remaining = totalCount - images.length;
    if (remaining > 0) {
        const more = document.createElement('div');
        more.className = 'autosep-preview-more';
        more.textContent = `+${remaining} more matches`;
        container.appendChild(more);
    }
}


// ============== Preview ==============

async function updateAutoSepPreview() {
    const requestId = ++_previewRequestId;
    const { $, API } = window.App;
    const filters = getAutoSepFilters();

    // Update summary display
    updateAutoSepSummary();

    const currentSignature = getAutoSepFilterSignature(filters);

    // Check if any meaningful filters are set
    const hasFilters =
        (filters.generators?.length > 0 && filters.generators.length < 5) ||
        (filters.tags?.length > 0) ||
        (filters.ratings?.length > 0 && filters.ratings.length < 4) ||
        (filters.checkpoints?.length > 0) ||
        (filters.loras?.length > 0) ||
        (filters.prompts?.length > 0) ||
        Boolean(filters.search?.trim()) ||
        filters.minWidth || filters.maxWidth || filters.minHeight || filters.maxHeight ||
        filters.aspectRatio || filters.minAesthetic != null || filters.maxAesthetic != null;

    if (!hasFilters) {
        $('#autosep-preview .stat-number').textContent = '0';
        AutoSepState.matchCount = 0;
        AutoSepState.previewImages = [];
        AutoSepState.previewSignature = currentSignature;
        renderAutoSepPreviewList([], 0);
        return;
    }

    try {
        const allImages = [];
        let cursor = null;
        let hasMore = true;

        while (hasMore) {
            const result = await API.getImages({
                generators: filters.generators?.length > 0 ? filters.generators : null,
                tags: filters.tags?.length > 0 ? filters.tags : null,
                ratings: filters.ratings?.length < 4 ? filters.ratings : null,
                checkpoints: filters.checkpoints?.length > 0 ? filters.checkpoints : null,
                loras: filters.loras?.length > 0 ? filters.loras : null,
                prompts: filters.prompts?.length > 0 ? filters.prompts : null,
                search: filters.search?.trim() || null,
                minWidth: filters.minWidth,
                maxWidth: filters.maxWidth,
                minHeight: filters.minHeight,
                maxHeight: filters.maxHeight,
                aspectRatio: filters.aspectRatio,
                minAesthetic: filters.minAesthetic,
                maxAesthetic: filters.maxAesthetic,
                limit: 500,
                cursor,
            });

            const rows = Array.isArray(result?.images) ? result.images : [];
            allImages.push(...rows);
            cursor = result?.next_cursor || null;
            hasMore = Boolean(result?.has_more && cursor);
            if (requestId !== _previewRequestId) return;
        }

        if (requestId !== _previewRequestId) return; // Stale request, discard
        AutoSepState.matchCount = allImages.length;
        AutoSepState.previewImages = allImages;
        AutoSepState.previewSignature = currentSignature;
        $('#autosep-preview .stat-number').textContent = AutoSepState.matchCount;
        renderAutoSepPreviewList(AutoSepState.previewImages, AutoSepState.matchCount);

    } catch (error) {
        Logger.error('Failed to preview:', error);
    }
}

function invalidateAutoSepPreview() {
    const statNumber = document.querySelector('#autosep-preview .stat-number');
    AutoSepState.matchCount = 0;
    AutoSepState.previewImages = [];
    AutoSepState.previewSignature = null;
    if (statNumber) statNumber.textContent = '0';
    renderAutoSepPreviewList([], 0);

    if (AutoSepState.settings.autoPreview) {
        clearTimeout(_autosepPreviewTimer);
        _autosepPreviewTimer = setTimeout(() => {
            const autosepView = document.getElementById('view-autosep');
            if (autosepView && autosepView.style.display !== 'none') {
                updateAutoSepPreview();
            }
        }, 250);
    }
}

// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    initAutoSeparate();
});

// Export for use by app.js filter modal
window.updateAutoSepSummary = updateAutoSepSummary;
window.invalidateAutoSepPreview = invalidateAutoSepPreview;


// ============== Enhanced Execute with Progress ==============

// State for move operation
let autosepMoveController = null;
let autosepMoveTracker = null;

function showAutosepMoveProgress(total) {
    const container = document.querySelector('.preview-section');
    if (!container) return;
    
    // Check if progress element already exists
    let progressEl = document.getElementById('autosep-move-progress');
    if (!progressEl) {
        progressEl = document.createElement('div');
        progressEl.id = 'autosep-move-progress';
        progressEl.className = 'autosep-move-progress';
        progressEl.innerHTML = `
            <div class="progress-bar">
                <div class="progress-fill" id="autosep-move-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text" id="autosep-move-text">Moving images...</div>
            <div class="autosep-move-errors" id="autosep-move-errors" style="display: none;"></div>
            <div class="operation-controls">
                <button class="btn-cancel-operation" id="btn-cancel-autosep-move">Hide</button>
            </div>
        `;
        container.appendChild(progressEl);
    }
    
    progressEl.classList.add('visible');
    autosepMoveTracker = window.App?.createProgressTracker?.() || null;
    if (autosepMoveTracker && typeof window.App?.resetProgressTracker === 'function') {
        window.App.resetProgressTracker(autosepMoveTracker);
    }
    document.getElementById('autosep-move-fill').style.width = '0%';
    document.getElementById('autosep-move-text').textContent = `Preparing to move ${total} images in the background...`;
    renderAutosepMoveErrors([]);
    
    // The backend move runs in the background; the UI can only dismiss progress.
    const cancelBtn = document.getElementById('btn-cancel-autosep-move');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            hideAutosepMoveProgress();
        };
    }
}

function hideAutosepMoveProgress() {
    const progressEl = document.getElementById('autosep-move-progress');
    if (progressEl) {
        progressEl.classList.remove('visible');
    }
    if (autosepMoveTracker && typeof window.App?.resetProgressTracker === 'function') {
        window.App.resetProgressTracker(autosepMoveTracker);
    }
    autosepMoveTracker = null;
    autosepMoveController = null;
}

function renderAutosepMoveErrors(errors = []) {
    const errorsEl = document.getElementById('autosep-move-errors');
    if (!errorsEl) return;

    const normalizedErrors = Array.isArray(errors)
        ? errors.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];

    if (!normalizedErrors.length) {
        errorsEl.style.display = 'none';
        errorsEl.innerHTML = '';
        return;
    }

    errorsEl.style.display = 'block';
    errorsEl.innerHTML = normalizedErrors
        .map((entry) => `<div class="autosep-move-error-item">${window.escapeHtml(entry)}</div>`)
        .join('');
}

function updateAutosepMoveProgress(progress = {}, fallbackTotal = 0) {
    const fillEl = document.getElementById('autosep-move-fill');
    const textEl = document.getElementById('autosep-move-text');
    
    if (fillEl && textEl) {
        const current = Number(progress.current || 0);
        const total = Number(progress.total || fallbackTotal || 0);
        const moved = Number(progress.moved || 0);
        const errors = Number(progress.errors || 0);
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        fillEl.style.width = percent + '%';
        if (typeof window.App?.buildProgressText === 'function') {
            textEl.textContent = window.App.buildProgressText({
                progress,
                completed: current,
                total,
                tracker: autosepMoveTracker,
                defaultMessage: `Processed ${moved} moved${errors > 0 ? `, ${errors} error(s)` : ''}`,
                primaryLabel: 'Auto-Separate'
            });
        } else {
            const details = [`${moved} moved`];
            if (errors > 0) {
                details.push(`${errors} error(s)`);
            }
            textEl.textContent = `Processed ${current} of ${total} images (${details.join(', ')})`;
        }
    }

    renderAutosepMoveErrors(progress.recent_errors || []);
}

async function pollAutosepMoveProgress(expectedTotal, destination = '') {
    if (autosepMoveController?.active) return;

    const controller = { active: true, destination };
    autosepMoveController = controller;
    const destinationLabel = destination ? ` to ${destination}` : '';

    try {
        while (autosepMoveController === controller && controller.active) {
            const progress = await window.App.API.get('/api/batch-move/progress');
            updateAutosepMoveProgress(progress, expectedTotal);

            if (progress.status === 'idle') {
                hideAutosepMoveProgress();
                window.App.showToast('Batch move stopped before any progress was reported', 'error');
                break;
            }

            if (progress.status === 'done') {
                setTimeout(() => {
                    hideAutosepMoveProgress();
                    const movedCount = Number(progress.moved || 0);
                    const errorCount = Number(progress.errors || 0);

                    if (movedCount > 0 && errorCount > 0) {
                        window.App.showToast(`Moved ${movedCount} images${destinationLabel}. ${errorCount} failed.`, 'warning');
                    } else if (movedCount > 0) {
                        window.App.showToast(`Moved ${movedCount} images${destinationLabel}`, 'success');
                    } else if (errorCount > 0) {
                        window.App.showToast(progress.message || `No images were moved. ${errorCount} failed.`, 'error');
                    } else {
                        window.App.showToast(progress.message || 'No images were moved', 'error');
                    }

                    if (movedCount > 0) {
                        AutoSepState.matchCount = 0;
                        AutoSepState.previewImages = [];
                        AutoSepState.previewSignature = null;
                        document.querySelector('#autosep-preview .stat-number').textContent = '0';
                        renderAutoSepPreviewList([], 0);

                        if (window.App && window.App.loadImages) {
                            window.App.loadImages();
                        }
                    }
                }, 300);
                break;
            }

            if (progress.status === 'error') {
                hideAutosepMoveProgress();
                window.App.showToast(progress.message || 'Failed to move images', 'error');
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 250));
        }
    } finally {
        if (autosepMoveController === controller) {
            controller.active = false;
        }
    }
}

async function resumeAutosepMoveProgress() {
    try {
        const progress = await window.App.API.get('/api/batch-move/progress');
        if (progress?.status !== 'running') {
            return;
        }

        const expectedTotal = Number(progress.total || 0);
        showAutosepMoveProgress(expectedTotal);
        updateAutosepMoveProgress(progress, expectedTotal);
        pollAutosepMoveProgress(expectedTotal);
    } catch (error) {
        Logger.warn('Failed to resume auto-separate move progress:', error);
    }
}

// Enhanced execute with progress tracking
async function executeAutoSeparateWithProgress() {
    const { $, API, showToast, showConfirm } = window.App;

    const destEl = $('#autosep-destination');
    const destination = destEl ? destEl.value.trim() : '';

    if (!destination) {
        showToast('Please enter a destination folder', 'error');
        return;
    }

    const filters = getAutoSepFilters();
    const currentSignature = getAutoSepFilterSignature(filters);
    if (AutoSepState.previewSignature !== currentSignature) {
        showToast('Please preview the current filter results before moving images', 'info');
        await updateAutoSepPreview();
        return;
    }

    if (AutoSepState.matchCount === 0) {
        showToast('No images match the current filters', 'error');
        return;
    }

    const total = AutoSepState.matchCount;

    const executeMove = async () => {
            showAutosepMoveProgress(total);

            try {
                const dimensions = {
                    minWidth: filters.minWidth,
                    maxWidth: filters.maxWidth,
                    minHeight: filters.minHeight,
                    maxHeight: filters.maxHeight,
                    aspectRatio: filters.aspectRatio
                };

                const startResult = await API.batchMove(
                    filters.generators?.length > 0 ? filters.generators : null,
                    filters.tags?.length > 0 ? filters.tags : null,
                    filters.ratings?.length < 4 ? filters.ratings : null,
                    destination,
                    filters.checkpoints?.length > 0 ? filters.checkpoints : null,
                    filters.loras?.length > 0 ? filters.loras : null,
                    filters.prompts?.length > 0 ? filters.prompts : null,
                    dimensions,
                    filters.search?.trim() || null,
                    {
                        min: filters.minAesthetic,
                        max: filters.maxAesthetic,
                    }
                );

                if (startResult?.error) {
                    throw new Error(startResult.message || startResult.error);
                }
                if (startResult?.status !== 'started') {
                    throw new Error(startResult?.message || 'Batch move did not start correctly');
                }

                const expectedTotal = startResult.total || total;
                updateAutosepMoveProgress({ current: 0, total: expectedTotal, moved: 0, errors: 0 }, expectedTotal);
                await pollAutosepMoveProgress(expectedTotal, destination);

            } catch (error) {
                hideAutosepMoveProgress();
                showToast(formatUserError(error, "Failed to move images"), "error");
            }
    };

    if (AutoSepState.settings.confirmBeforeMove) {
        showConfirm(
            'Confirm Auto-Separate',
            `Move ${total} matching images to:\n${destination}\n\nReview the preview list above before continuing.`,
            executeMove
        );
        return;
    }

    await executeMove();
}

// Replace the original function
window.executeAutoSeparateWithProgress = executeAutoSeparateWithProgress;
