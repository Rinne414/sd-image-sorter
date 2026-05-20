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
const AUTOSEP_SCOPE_META_KEY = 'autosep_scope_meta_v1';
const AUTOSEP_PREVIEW_FETCH_LIMIT = 200;
const AUTOSEP_OVERFLOW_PAGE_SIZE = 200;
const AUTOSEP_PROMPT_MATCH_MODES = new Set(['exact', 'contains']);

const DEFAULT_AUTOSEP_SETTINGS = {
    rememberDestination: true,
    autoPreview: false,
    confirmBeforeMove: true,
    // Default to ``copy`` so first-time users do not destructively move files
    // before they understand the workflow. Locked by Principle #11 in
    // docs/AI_PRINCIPLES.md and the corresponding ADR.
    operationMode: 'copy',
};

const AutoSepState = {
    matchCount: 0,
    previewImages: [],
    previewSignature: null,
    overflowImages: [],
    overflowSignature: null,
    overflowNextCursor: null,
    overflowHasMore: false,
    overflowLoading: false,
    settings: { ...DEFAULT_AUTOSEP_SETTINGS },
    configs: [],
    filters: null,
    hasSavedFilterState: false,
    inheritedCurrentGalleryFilters: false,
    scopeMeta: null,
};

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
            AutoSepState.hasSavedFilterState = true;
            AutoSepState.filters = serializeAutoSepFilters(JSON.parse(raw));
            return;
        }
    } catch (_) {
        // Fall back to a safe default when the saved state is invalid.
    }
    AutoSepState.hasSavedFilterState = false;
    AutoSepState.filters = getFallbackAutoSepFilters();
}

function saveAutoSepFilters() {
    AutoSepState.hasSavedFilterState = true;
    localStorage.setItem(AUTOSEP_FILTER_STATE_KEY, JSON.stringify(serializeAutoSepFilters(AutoSepState.filters || {})));
}

function createDefaultAutoSepScopeMeta() {
    return {
        lastSyncedAt: null,
        acknowledgedGallerySignature: null,
    };
}

function loadAutoSepScopeMeta() {
    try {
        const raw = localStorage.getItem(AUTOSEP_SCOPE_META_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        AutoSepState.scopeMeta = {
            ...createDefaultAutoSepScopeMeta(),
            ...(parsed && typeof parsed === 'object' ? parsed : {}),
        };
    } catch (_) {
        AutoSepState.scopeMeta = createDefaultAutoSepScopeMeta();
    }
}

function saveAutoSepScopeMeta() {
    if (!AutoSepState.scopeMeta) {
        AutoSepState.scopeMeta = createDefaultAutoSepScopeMeta();
    }
    localStorage.setItem(AUTOSEP_SCOPE_META_KEY, JSON.stringify(AutoSepState.scopeMeta));
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

function getCurrentGalleryAutoSepFilters() {
    const clone = window.App?.cloneFilterState;
    if (typeof clone === 'function') {
        return serializeAutoSepFilters(clone(window.App?.AppState?.filters || null));
    }
    return serializeAutoSepFilters({});
}

function formatAutoSepScopeTime(isoString) {
    if (!isoString) return '';
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) return '';
    const locale = window.I18n?.getLang?.() === 'zh-CN' ? 'zh-CN' : 'en-US';
    return parsed.toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function markAutoSepScopeCustomized() {
    AutoSepState.scopeMeta = createDefaultAutoSepScopeMeta();
    saveAutoSepScopeMeta();
}

function markAutoSepScopeSyncedFromGallery() {
    AutoSepState.scopeMeta = {
        lastSyncedAt: new Date().toISOString(),
        acknowledgedGallerySignature: null,
    };
    saveAutoSepScopeMeta();
}

function getAutoSepToolLabel() {
    return tKey('nav.autosep', 'Auto-Separate', '自动分类');
}

function getAutoSepScopeStatus() {
    if (!AutoSepState.scopeMeta) {
        loadAutoSepScopeMeta();
    }

    const savedFilters = getAutoSepFilters();
    const galleryFilters = getCurrentGalleryAutoSepFilters();
    const savedSignature = getAutoSepFilterSignature(savedFilters || {});
    const gallerySignature = getAutoSepFilterSignature(galleryFilters || {});
    const lastSyncedAt = AutoSepState.scopeMeta?.lastSyncedAt || null;
    const lastSyncedLabel = formatAutoSepScopeTime(lastSyncedAt);
    const matchesGallery = savedSignature === gallerySignature;
    const isAcknowledged = Boolean(
        gallerySignature &&
        AutoSepState.scopeMeta?.acknowledgedGallerySignature === gallerySignature
    );

    return {
        gallerySignature,
        lastSyncedAt,
        lastSyncedLabel,
        matchesGallery,
        isAcknowledged,
    };
}

function updateAutoSepPreviewScopeSummary() {
    const summaryEl = document.getElementById('autosep-preview-scope-summary');
    if (!summaryEl) return;

    const status = getAutoSepScopeStatus();
    const tool = getAutoSepToolLabel();
    summaryEl.textContent = status.lastSyncedLabel && status.matchesGallery
        ? _formatAutoSepI18n('scope.previewSynced', 'Preview uses {tool} filters copied from Gallery at {time}.', {
            tool,
            time: status.lastSyncedLabel,
        })
        : _formatAutoSepI18n('scope.previewSaved', 'Preview uses the saved {tool} filters shown here, not the live Gallery filters.', {
            tool,
        });
}

function updateAutoSepScopeStatus() {
    const card = document.getElementById('autosep-scope-status');
    const badge = document.getElementById('autosep-scope-badge');
    const meta = document.getElementById('autosep-scope-meta');
    const detail = document.getElementById('autosep-scope-detail');
    const useBtn = document.getElementById('btn-autosep-use-gallery-scope');
    const resyncBtn = document.getElementById('btn-autosep-resync-scope');
    const keepBtn = document.getElementById('btn-autosep-keep-scope');
    if (!card || !badge || !meta || !detail || !useBtn || !resyncBtn || !keepBtn) return;

    const tool = getAutoSepToolLabel();
    const status = getAutoSepScopeStatus();

    badge.textContent = _formatAutoSepI18n('scope.usingSaved', '{tool} will use these saved filters', { tool });
    meta.textContent = status.lastSyncedLabel
        ? _formatAutoSepI18n('scope.syncedAt', 'Copied from Gallery: {time}', {
            time: status.lastSyncedLabel,
        })
        : _formatAutoSepI18n('scope.standalone', 'These filters will not change automatically when Gallery filters change later.');

    if (status.matchesGallery && status.lastSyncedLabel) {
        detail.textContent = _formatAutoSepI18n('scope.aligned', 'Gallery and {tool} are currently aligned.', { tool });
    } else if (status.matchesGallery) {
        detail.textContent = _formatAutoSepI18n(
            'scope.alignedUnsynced',
            '{tool} currently matches the Gallery filters. Later Gallery changes will not be copied automatically.',
            { tool }
        );
    } else if (status.isAcknowledged) {
        detail.textContent = _formatAutoSepI18n(
            'scope.kept',
            'Using the saved {tool} filters shown here. Current Gallery filters were not copied.',
            { tool }
        );
    } else {
        detail.textContent = _formatAutoSepI18n(
            'scope.mismatch',
            'Gallery filters changed. {tool} will still use the saved filters shown here.',
            { tool }
        );
    }

    card.classList.toggle('is-synced', status.matchesGallery);
    card.classList.toggle('is-warning', !status.matchesGallery && !status.isAcknowledged);

    useBtn.hidden = Boolean(status.lastSyncedAt);
    resyncBtn.hidden = !Boolean(status.lastSyncedAt);
    keepBtn.hidden = status.matchesGallery || status.isAcknowledged;
}

function syncAutoSepFiltersFromGallery(options = {}) {
    const { toastKey = 'scope.copiedToast' } = options;
    const galleryFilters = getCurrentGalleryAutoSepFilters();
    AutoSepState.inheritedCurrentGalleryFilters = true;
    setAutoSepFilters(galleryFilters);
    markAutoSepScopeSyncedFromGallery();
    updateAutoSepSummary();
    invalidateAutoSepPreview();
    renderAutoSepConfigControls();

    if (toastKey) {
        window.App?.showToast?.(
            _formatAutoSepI18n(toastKey, 'Copied current Gallery filters into {tool}.', {
                tool: getAutoSepToolLabel(),
            }),
            'success'
        );
    }
}

function keepAutoSepSavedScope() {
    const status = getAutoSepScopeStatus();
    if (!status.gallerySignature) return;
    AutoSepState.scopeMeta = {
        ...(AutoSepState.scopeMeta || createDefaultAutoSepScopeMeta()),
        acknowledgedGallerySignature: status.gallerySignature,
    };
    saveAutoSepScopeMeta();
    updateAutoSepScopeStatus();
    updateAutoSepPreviewScopeSummary();
    window.App?.showToast?.(
        _formatAutoSepI18n('scope.keptToast', 'Kept the saved {tool} scope.', {
            tool: getAutoSepToolLabel(),
        }),
        'info'
    );
}

function maybeAdoptAutoSepFiltersFromGallery() {
    if (AutoSepState.hasSavedFilterState || AutoSepState.inheritedCurrentGalleryFilters) {
        return false;
    }

    syncAutoSepFiltersFromGallery({ toastKey: null });
    return true;
}

// ============== Initialization ==============

function initAutoSeparate() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);
    loadAutoSepFilters();
    loadAutoSepScopeMeta();
    loadAutoSepSettings();
    applyAutoSepSettingsToUi();
    updateAutoSepSettingsSummary();
    loadAutoSepConfigs();
    renderAutoSepConfigControls();
    updateAutoSepSummary();
    updateAutoSepPreviewScopeSummary();

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
                        markAutoSepScopeCustomized();
                        updateAutoSepSummary();
                        invalidateAutoSepPreview();
                        renderAutoSepConfigControls();
                    },
                    onReset: (filters) => {
                        setAutoSepFilters(filters);
                        markAutoSepScopeCustomized();
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

    $('#btn-autosep-use-gallery-scope')?.addEventListener('click', () => {
        syncAutoSepFiltersFromGallery({ toastKey: 'scope.copiedToast' });
    });
    $('#btn-autosep-resync-scope')?.addEventListener('click', () => {
        syncAutoSepFiltersFromGallery({ toastKey: 'scope.resyncedToast' });
    });
    $('#btn-autosep-keep-scope')?.addEventListener('click', keepAutoSepSavedScope);

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
    $('#btn-close-autosep-overflow')?.addEventListener('click', () => window.App?.hideModal?.('autosep-overflow-modal'));
    $('#autosep-overflow-modal .modal-backdrop')?.addEventListener('click', () => window.App?.hideModal?.('autosep-overflow-modal'));
    $('#btn-save-autosep-settings')?.addEventListener('click', saveAutoSepSettingsFromUi);
    $('#btn-reset-autosep-settings')?.addEventListener('click', resetAutoSepSettings);
    document.querySelectorAll('input[data-autosep-operation-mode]').forEach((input) => {
        const handleOperationModeInput = () => {
            if (!input.checked) return;
            setAutoSepOperationMode(input.value, { persist: true });
        };
        input.addEventListener('input', handleOperationModeInput);
        input.addEventListener('change', handleOperationModeInput);
    });
    document.querySelectorAll('input[data-autosep-setting]').forEach((input) => {
        input.addEventListener('change', () => {
            setAutoSepBooleanSetting(input.dataset.autosepSetting, input.checked, { persist: true });
        });
    });
    $('#btn-autosep-new-config')?.addEventListener('click', createAutoSepConfig);
    $('#btn-autosep-save-config')?.addEventListener('click', saveCurrentAutoSepConfig);
    $('#btn-autosep-load-config')?.addEventListener('click', loadSelectedAutoSepConfig);
    $('#btn-autosep-rename-config')?.addEventListener('click', renameSelectedAutoSepConfig);
    $('#btn-autosep-delete-config')?.addEventListener('click', deleteSelectedAutoSepConfig);
    $('#autosep-config-select')?.addEventListener('change', renderAutoSepConfigControls);
    document.addEventListener('gallery-filters-changed', () => {
        updateAutoSepScopeStatus();
        updateAutoSepPreviewScopeSummary();
    });
    document.addEventListener('languageChanged', () => {
        updateAutoSepSummary();
        updateAutoSepSettingsSummary();
        renderAutoSepConfigControls();
        updateAutoSepPreviewScopeSummary();
        updateAutoSepActionUi();
    });

    updateAutoSepActionUi();
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
        promptMatchMode: normalizeAutoSepPromptMatchMode(source.promptMatchMode || source.prompt_match_mode),
        artist: source.artist || null,
        search: source.search || '',
        minWidth: source.minWidth ?? null,
        maxWidth: source.maxWidth ?? null,
        minHeight: source.minHeight ?? null,
        maxHeight: source.maxHeight ?? null,
        aspectRatio: source.aspectRatio || '',
        minAesthetic: source.minAesthetic ?? null,
        maxAesthetic: source.maxAesthetic ?? null,
    };
}

function buildAutoSepFilterContract(filters) {
    const source = serializeAutoSepFilters(filters);
    const normalizeCheckpoint = window.App?.normalizeCheckpointFilterValue;
    const checkpoints = Array.isArray(source.checkpoints) ? source.checkpoints : [];
    return {
        ...source,
        checkpoints: checkpoints
            .map((value) => typeof normalizeCheckpoint === 'function' ? normalizeCheckpoint(value) : String(value || '').trim())
            .filter(Boolean),
        artist: source.artist ? String(source.artist).trim() : null,
        search: source.search || '',
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
            : tKey('autosep.noConfigsYet', 'No saved configs yet. Save your current setup and reuse it later.', '还没有保存配置。先把当前规则存成一个方案，之后就能直接复用。');
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

    updateAutoSepScopeStatus();
    updateAutoSepPreviewScopeSummary();
}

function getAutoSepFilterSignature(filters) {
    const appSignature = window.App?.getAdvancedFilterContractSignature;
    if (typeof appSignature === 'function') {
        return appSignature(buildAutoSepFilterContract(filters));
    }
    const contract = buildAutoSepFilterContract(filters);
    return JSON.stringify({
        generators: contract.generators || [],
        tags: contract.tags || [],
        ratings: contract.ratings || [],
        checkpoints: contract.checkpoints || [],
        loras: contract.loras || [],
        prompts: contract.prompts || [],
        promptMatchMode: contract.promptMatchMode || 'exact',
        artist: contract.artist || null,
        search: contract.search || '',
        minWidth: contract.minWidth ?? null,
        maxWidth: contract.maxWidth ?? null,
        minHeight: contract.minHeight ?? null,
        maxHeight: contract.maxHeight ?? null,
        aspectRatio: contract.aspectRatio || null,
        minAesthetic: contract.minAesthetic ?? null,
        maxAesthetic: contract.maxAesthetic ?? null,
    });
}

function _formatAutoSepI18n(key, fallback, replacements = {}) {
    const raw = window.I18n?.t?.(key) || fallback;
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        raw,
    );
}

function _computeAutoSepPreviewCap(container) {
    // Two rows worth of thumbnails: matches what the user can see without
    // scrolling and keeps the preview panel compact no matter how large the
    // match count grows. Column count is derived from the container width
    // because the grid uses auto-fill minmax(128px, 1fr).
    if (!container) return 8;
    const style = window.getComputedStyle(container);
    const gap = parseFloat(style.columnGap || style.gap || '12') || 12;
    const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const minColumn = 128;
    const width = Math.max(0, (container.clientWidth || 0) - paddingX);
    if (width <= 0) return 8;
    const cols = Math.max(1, Math.floor((width + gap) / (minColumn + gap)));
    return cols * 2;
}

function _buildAutoSepPreviewItem(image) {
    const { API, openGalleryPreview } = window.App;
    const button = document.createElement('button');
    button.className = 'autosep-preview-item';
    button.type = 'button';
    button.dataset.imageId = String(image.id);
    button.title = `Open ${image.filename}`;

    const img = document.createElement('img');
    img.className = 'autosep-preview-thumb';
    img.src = API.getThumbnailUrl(image.id, 256);
    img.alt = image.filename;
    img.loading = 'lazy';

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
    return button;
}

function _renderAutoSepOverflowModal(images) {
    const list = document.getElementById('autosep-overflow-list');
    const description = document.getElementById('autosep-overflow-description');
    if (!list) return;

    list.innerHTML = '';
    images.forEach((image) => list.appendChild(_buildAutoSepPreviewItem(image)));

    if (AutoSepState.overflowHasMore) {
        const remaining = Math.max(0, AutoSepState.matchCount - AutoSepState.overflowImages.length);
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.type = 'button';
        loadMoreBtn.id = 'autosep-overflow-load-more';
        loadMoreBtn.className = 'btn btn-secondary';
        loadMoreBtn.textContent = _formatAutoSepI18n('autosep.overflowLoadMore', 'Load {count} more', {
            count: Math.min(AUTOSEP_OVERFLOW_PAGE_SIZE, remaining || AUTOSEP_OVERFLOW_PAGE_SIZE),
        });
        loadMoreBtn.disabled = AutoSepState.overflowLoading;
        loadMoreBtn.addEventListener('click', loadMoreAutoSepOverflow);
        list.appendChild(loadMoreBtn);
    }

    if (description) {
        description.textContent = _formatAutoSepI18n(
            'autosep.overflowDescriptionPaged',
            'Showing {shown} of {total} matching images. Load more only if you need the full list.',
            {
                shown: AutoSepState.overflowImages.length,
                total: AutoSepState.matchCount,
            },
        );
    }
}

function _buildAutoSepImageQuery(filters, cursor = null, limit = 500) {
    const contract = buildAutoSepFilterContract(filters);
    return {
        generators: contract.generators?.length > 0 ? contract.generators : null,
        tags: contract.tags?.length > 0 ? contract.tags : null,
        ratings: contract.ratings?.length < 4 ? contract.ratings : null,
        checkpoints: contract.checkpoints?.length > 0 ? contract.checkpoints : null,
        loras: contract.loras?.length > 0 ? contract.loras : null,
        prompts: contract.prompts?.length > 0 ? contract.prompts : null,
        promptMatchMode: contract.promptMatchMode || 'exact',
        artist: contract.artist || null,
        search: contract.search?.trim() || null,
        minWidth: contract.minWidth,
        maxWidth: contract.maxWidth,
        minHeight: contract.minHeight,
        maxHeight: contract.maxHeight,
        aspectRatio: contract.aspectRatio,
        minAesthetic: contract.minAesthetic,
        maxAesthetic: contract.maxAesthetic,
        limit,
        cursor,
    };
}

function _resetAutoSepOverflowState(signature = null) {
    AutoSepState.overflowImages = [];
    AutoSepState.overflowSignature = signature;
    AutoSepState.overflowNextCursor = null;
    AutoSepState.overflowHasMore = false;
    AutoSepState.overflowLoading = false;
}

async function loadMoreAutoSepOverflow() {
    if (AutoSepState.overflowLoading) return;

    const filters = getAutoSepFilters();
    const signature = getAutoSepFilterSignature(filters);
    if (AutoSepState.overflowSignature !== signature) {
        _resetAutoSepOverflowState(signature);
    }

    AutoSepState.overflowLoading = true;
    const list = document.getElementById('autosep-overflow-list');
    if (list && !AutoSepState.overflowImages.length) {
        list.innerHTML = `<div class="autosep-preview-empty">${escapeHtml(_formatAutoSepI18n('autosep.overflowLoading', 'Loading matching images...'))}</div>`;
    }

    try {
        const result = await window.App.API.getImages(
            _buildAutoSepImageQuery(filters, AutoSepState.overflowNextCursor, AUTOSEP_OVERFLOW_PAGE_SIZE)
        );
        const rows = Array.isArray(result?.images) ? result.images : [];
        AutoSepState.overflowImages.push(...rows);
        AutoSepState.matchCount = Number.isFinite(result?.total) && result.total >= 0
            ? result.total
            : Math.max(AutoSepState.matchCount, AutoSepState.overflowImages.length);
        AutoSepState.overflowNextCursor = result?.next_cursor || null;
        AutoSepState.overflowHasMore = Boolean(result?.has_more && AutoSepState.overflowNextCursor);
        AutoSepState.overflowLoading = false;
        _renderAutoSepOverflowModal(AutoSepState.overflowImages);
    } catch (error) {
        Logger.error('Failed to load Auto-Separate overflow preview:', error);
        if (list) {
            list.innerHTML = `<div class="autosep-preview-empty">${escapeHtml(_formatAutoSepI18n('autosep.overflowLoadFailed', 'Failed to load more matching images.'))}</div>`;
        }
    } finally {
        AutoSepState.overflowLoading = false;
    }
}

async function openAutoSepOverflowModal() {
    const { showModal } = window.App;
    const filters = getAutoSepFilters();
    const signature = getAutoSepFilterSignature(filters);
    _resetAutoSepOverflowState(signature);
    if (typeof showModal === 'function') showModal('autosep-overflow-modal');
    await loadMoreAutoSepOverflow();
}

function renderAutoSepPreviewList(images = [], totalCount = 0) {
    const { $ } = window.App;
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

    const cap = _computeAutoSepPreviewCap(container);
    // Reserve the last visible slot for the +N button when the match set is
    // bigger than the cap — this keeps the visible row count consistent with
    // the 2-row budget computed above, instead of spilling into row 3.
    const willOverflow = totalCount > cap;
    const visibleCount = willOverflow ? Math.max(0, Math.min(images.length, cap - 1)) : images.length;
    const visibleImages = images.slice(0, visibleCount);

    visibleImages.forEach((image) => container.appendChild(_buildAutoSepPreviewItem(image)));

    const remaining = Math.max(totalCount - visibleCount, 0);
    if (willOverflow && remaining > 0) {
        const more = document.createElement('button');
        more.type = 'button';
        more.id = 'autosep-preview-more';
        more.className = 'autosep-preview-more autosep-preview-more-btn';
        more.textContent = _formatAutoSepI18n('autosep.previewMore', '+{count} more', { count: remaining });
        more.setAttribute(
            'aria-label',
            _formatAutoSepI18n('autosep.previewMoreAria', 'Show the remaining {count} matching images', { count: remaining }),
        );
        more.addEventListener('click', openAutoSepOverflowModal);
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
        Boolean(filters.artist?.trim?.()) ||
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
        const previewImages = [];
        let cursor = null;
        let hasMore = true;
        let totalCount = 0;

        while (hasMore && previewImages.length < AUTOSEP_PREVIEW_FETCH_LIMIT) {
            const remaining = AUTOSEP_PREVIEW_FETCH_LIMIT - previewImages.length;
            const result = await API.getImages(
                _buildAutoSepImageQuery(filters, cursor, Math.min(AUTOSEP_OVERFLOW_PAGE_SIZE, remaining))
            );

            const rows = Array.isArray(result?.images) ? result.images : [];
            previewImages.push(...rows.slice(0, remaining));
            if (Number.isFinite(result?.total) && result.total >= 0) {
                totalCount = result.total;
            } else {
                totalCount = Math.max(totalCount, previewImages.length + (result?.has_more ? 1 : 0));
            }
            cursor = result?.next_cursor || null;
            hasMore = Boolean(result?.has_more && cursor);
            if (requestId !== _previewRequestId) return;
        }

        if (requestId !== _previewRequestId) return; // Stale request, discard
        AutoSepState.matchCount = Math.max(totalCount, previewImages.length);
        AutoSepState.previewImages = previewImages;
        AutoSepState.previewSignature = currentSignature;
        _resetAutoSepOverflowState(currentSignature);
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
    _resetAutoSepOverflowState(null);
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
window.maybeAdoptAutoSepFiltersFromGallery = maybeAdoptAutoSepFiltersFromGallery;
window.updateAutoSepActionUi = updateAutoSepActionUi;


// ============== Enhanced Execute with Progress ==============

// State for move operation
let autosepMoveController = null;
let autosepMoveTracker = null;

function showAutosepMoveProgress(total) {
    const container = document.querySelector('.preview-section');
    if (!container) return;
    const operationMode = getAutoSepOperationMode();

    const cancelLabel = tKey('autosep.cancel', 'Cancel', '取消');
    const hideLabel = tKey('autosep.hide', 'Hide', '隐藏');

    // Check if progress element already exists
    let progressEl = document.getElementById('autosep-move-progress');
    if (!progressEl) {
        progressEl = document.createElement('div');
        progressEl.id = 'autosep-move-progress';
        progressEl.className = 'autosep-move-progress';
        // Two-button layout: Cancel actually stops the backend worker via
        // /api/batch-move/cancel; Hide only dismisses this UI block. The
        // previous single-button layout was labelled "Hide" but had id
        // `btn-cancel-autosep-move`, which misled users into thinking
        // dismissing the panel cancelled the underlying batch.
        progressEl.innerHTML = `
            <div class="progress-bar">
                <div class="progress-fill" id="autosep-move-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text" id="autosep-move-text">Moving images...</div>
            <div class="autosep-move-errors" id="autosep-move-errors" style="display: none;"></div>
            <div class="operation-controls">
                <button class="btn-cancel-operation" id="btn-cancel-autosep-move">${window.escapeHtml(cancelLabel)}</button>
                <button class="btn-cancel-operation" id="btn-hide-autosep-move">${window.escapeHtml(hideLabel)}</button>
            </div>
        `;
        container.appendChild(progressEl);
    } else {
        // Re-localize labels in case language changed since last time.
        const existingCancelBtn = document.getElementById('btn-cancel-autosep-move');
        const existingHideBtn = document.getElementById('btn-hide-autosep-move');
        if (existingCancelBtn) existingCancelBtn.textContent = cancelLabel;
        if (existingHideBtn) existingHideBtn.textContent = hideLabel;
    }

    progressEl.classList.add('visible');
    autosepMoveTracker = window.App?.createProgressTracker?.() || null;
    if (autosepMoveTracker && typeof window.App?.resetProgressTracker === 'function') {
        window.App.resetProgressTracker(autosepMoveTracker);
    }
    document.getElementById('autosep-move-fill').style.width = '0%';
    document.getElementById('autosep-move-text').textContent = operationMode === 'copy'
        ? tKey('autosep.preparingCopy', `Preparing to copy ${total} images in the background...`, `准备在后台复制 ${total} 张图片...`)
        : tKey('autosep.preparingMove', `Preparing to move ${total} images in the background...`, `准备在后台移动 ${total} 张图片...`);
    renderAutosepMoveErrors([]);

    const cancelBtn = document.getElementById('btn-cancel-autosep-move');
    if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = cancelLabel;
        cancelBtn.onclick = async () => {
            cancelBtn.disabled = true;
            cancelBtn.textContent = tKey('autosep.cancelling', 'Cancelling...', '正在取消…');
            try {
                await window.App.API.post('/api/batch-move/cancel', {});
            } catch (error) {
                cancelBtn.disabled = false;
                cancelBtn.textContent = cancelLabel;
                window.App.showToast(
                    tKey('autosep.cancelFailed', 'Failed to request cancellation', '取消请求失败'),
                    'error'
                );
            }
        };
    }
    const hideBtn = document.getElementById('btn-hide-autosep-move');
    if (hideBtn) {
        hideBtn.onclick = () => {
            // Hide only dismisses the panel. The backend worker keeps
            // running; resumeAutosepMoveProgress() will re-attach if the
            // user navigates back while the worker is still active.
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
        const operationMode = normalizeAutoSepOperationMode(progress.operation || getAutoSepOperationMode());
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        fillEl.style.width = percent + '%';
        if (typeof window.App?.buildProgressText === 'function') {
            const movedLabel = getAutoSepCompletedLabel(operationMode, moved);
            const errorLabel = errors > 0
                ? _formatAutoSepI18n('autosep.progressErrors', '{count} failed', { count: errors })
                : '';
            textEl.textContent = window.App.buildProgressText({
                progress,
                completed: current,
                total,
                tracker: autosepMoveTracker,
                defaultMessage: errorLabel ? `${movedLabel} • ${errorLabel}` : movedLabel,
                primaryLabel: tKey('autosep.title', 'Auto-Separate', '自动分类')
            });
        } else {
            const details = [getAutoSepCompletedLabel(operationMode, moved)];
            if (errors > 0) {
                details.push(_formatAutoSepI18n('autosep.progressErrors', '{count} failed', { count: errors }));
            }
            textEl.textContent = _formatAutoSepI18n(
                'autosep.progressSummary',
                'Processed {current}/{total} images ({details})',
                {
                    current,
                    total,
                    details: details.join(' • '),
                }
            );
        }
    }

    renderAutosepMoveErrors(progress.recent_errors || []);
}

async function pollAutosepMoveProgress(expectedTotal, destination = '') {
    if (autosepMoveController?.active) return;

    const controller = { active: true, destination };
    autosepMoveController = controller;
    const destinationLabel = destination
        ? _formatAutoSepI18n('autosep.destinationSuffix', ' to {path}', { path: destination })
        : '';

    try {
        while (autosepMoveController === controller && controller.active) {
            const progress = await window.App.API.get('/api/batch-move/progress');
            updateAutosepMoveProgress(progress, expectedTotal);

            if (progress.status === 'idle') {
                hideAutosepMoveProgress();
                window.App.showToast(
                    _formatAutoSepI18n(
                        'autosep.moveStoppedNoProgress',
                        'Batch move stopped before any progress was reported'
                    ),
                    'error'
                );
                break;
            }

            if (progress.status === 'done') {
                setTimeout(() => {
                    hideAutosepMoveProgress();
                    const movedCount = Number(progress.moved || 0);
                    const errorCount = Number(progress.errors || 0);
                    const operationMode = normalizeAutoSepOperationMode(progress.operation || getAutoSepOperationMode());

                    if (movedCount > 0 && errorCount > 0) {
                        window.App.showToast(
                            _formatAutoSepI18n(
                                operationMode === 'copy' ? 'autosep.copyPartial' : 'autosep.movePartial',
                                operationMode === 'copy' ? 'Copied {count} images{destination}. {errors} failed.' : 'Moved {count} images{destination}. {errors} failed.',
                                {
                                count: movedCount,
                                destination: destinationLabel,
                                errors: errorCount,
                                }
                            ),
                            'warning'
                        );
                    } else if (movedCount > 0) {
                        window.App.showToast(
                            _formatAutoSepI18n(
                                operationMode === 'copy' ? 'autosep.copySuccess' : 'autosep.moveSuccess',
                                operationMode === 'copy' ? 'Copied {count} images{destination}' : 'Moved {count} images{destination}',
                                {
                                count: movedCount,
                                destination: destinationLabel,
                                }
                            ),
                            'success'
                        );
                    } else if (errorCount > 0) {
                        window.App.showToast(
                            progress.message || _formatAutoSepI18n(
                                operationMode === 'copy' ? 'autosep.copyNoneFailed' : 'autosep.moveNoneFailed',
                                operationMode === 'copy' ? 'No images were copied. {errors} failed.' : 'No images were moved. {errors} failed.',
                                {
                                errors: errorCount,
                                }
                            ),
                            'error'
                        );
                    } else {
                        window.App.showToast(
                            progress.message || _formatAutoSepI18n(
                                operationMode === 'copy' ? 'autosep.copyNone' : 'autosep.moveNone',
                                operationMode === 'copy' ? 'No images were copied' : 'No images were moved'
                            ),
                            'error'
                        );
                    }

                    if (movedCount > 0) {
                        AutoSepState.matchCount = 0;
                        AutoSepState.previewImages = [];
                        AutoSepState.previewSignature = null;
                        _resetAutoSepOverflowState(null);
                        document.querySelector('#autosep-preview .stat-number').textContent = '0';
                        renderAutoSepPreviewList([], 0);

                        if (window.App && window.App.loadImages) {
                            window.App.loadImages();
                        }
                    }
                }, 300);
                break;
            }

            if (progress.status === 'cancelled') {
                hideAutosepMoveProgress();
                const movedCount = Number(progress.moved || 0);
                const errorCount = Number(progress.errors || 0);
                const operationMode = normalizeAutoSepOperationMode(progress.operation || getAutoSepOperationMode());
                window.App.showToast(
                    progress.message || _formatAutoSepI18n(
                        operationMode === 'copy' ? 'autosep.copyCancelled' : 'autosep.moveCancelled',
                        operationMode === 'copy'
                            ? 'Copy cancelled. {count} images copied so far.'
                            : 'Move cancelled. {count} images moved so far.',
                        { count: movedCount }
                    ),
                    errorCount > 0 ? 'warning' : 'info'
                );
                // Refresh the gallery so the partially-moved files reflect
                // their new on-disk locations. Skip the refresh when nothing
                // was committed — there's nothing to update.
                if (movedCount > 0 && window.App && window.App.loadImages) {
                    window.App.loadImages();
                }
                break;
            }

            if (progress.status === 'error') {
                hideAutosepMoveProgress();
                const operationMode = normalizeAutoSepOperationMode(progress.operation || getAutoSepOperationMode());
                window.App.showToast(
                    progress.message || _formatAutoSepI18n(
                        operationMode === 'copy' ? 'autosep.copyFailed' : 'autosep.moveFailed',
                        operationMode === 'copy' ? 'Failed to copy images' : 'Failed to move images'
                    ),
                    'error'
                );
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
    const operationMode = getAutoSepOperationMode();
    const operationLabel = getAutoSepOperationLabel(operationMode);

    if (!destination) {
        showToast(tKey('autosep.noDestination', 'Please enter a destination folder', '请指定目标文件夹'), 'error');
        return;
    }

    const filters = getAutoSepFilters();
    const currentSignature = getAutoSepFilterSignature(filters);
    if (AutoSepState.previewSignature !== currentSignature) {
        showToast(
            _formatAutoSepI18n(
                operationMode === 'copy' ? 'autosep.previewBeforeCopy' : 'autosep.previewBeforeMove',
                operationMode === 'copy'
                    ? 'Please preview the current filter results before copying images'
                    : 'Please preview the current filter results before moving images'
            ),
            'info'
        );
        await updateAutoSepPreview();
        return;
    }

    if (AutoSepState.matchCount === 0) {
        showToast(
            tKey('autosep.noMatchingImages', 'No images match Auto-Separate filters', '没有图片匹配自动分类筛选'),
            'error'
        );
        return;
    }

    const total = AutoSepState.matchCount;
    const scopeStatus = getAutoSepScopeStatus();
    const scopeLine = scopeStatus.lastSyncedLabel && scopeStatus.matchesGallery
        ? _formatAutoSepI18n('scope.executeSynced', 'Using saved {tool} filters copied from Gallery at {time}', {
            tool: getAutoSepToolLabel(),
            time: scopeStatus.lastSyncedLabel,
        })
        : _formatAutoSepI18n('scope.executeSaved', 'Using saved {tool} filters', {
            tool: getAutoSepToolLabel(),
        });

    const executeMove = async () => {
            showAutosepMoveProgress(total);

            try {
                const contract = buildAutoSepFilterContract(filters);
                const dimensions = {
                    minWidth: contract.minWidth,
                    maxWidth: contract.maxWidth,
                    minHeight: contract.minHeight,
                    maxHeight: contract.maxHeight,
                    aspectRatio: contract.aspectRatio
                };

                const startResult = await API.batchMove(
                    contract.generators?.length > 0 ? contract.generators : null,
                    contract.tags?.length > 0 ? contract.tags : null,
                    contract.ratings?.length < 4 ? contract.ratings : null,
                    destination,
                    contract.checkpoints?.length > 0 ? contract.checkpoints : null,
                    contract.loras?.length > 0 ? contract.loras : null,
                    contract.prompts?.length > 0 ? contract.prompts : null,
                    dimensions,
                    contract.search?.trim() || null,
                    {
                        min: contract.minAesthetic,
                        max: contract.maxAesthetic,
                    },
                    operationMode,
                    contract.artist,
                    contract.promptMatchMode,
                );

                if (startResult?.error) {
                    throw new Error(startResult.message || startResult.error);
                }
                if (startResult?.status !== 'started') {
                    throw new Error(
                        startResult?.message || _formatAutoSepI18n(
                            operationMode === 'copy' ? 'autosep.copyFailed' : 'autosep.moveFailed',
                            operationMode === 'copy' ? 'Failed to copy images' : 'Failed to move images'
                        )
                    );
                }

                const expectedTotal = startResult.total || total;
                updateAutosepMoveProgress({ current: 0, total: expectedTotal, moved: 0, errors: 0 }, expectedTotal);
                await pollAutosepMoveProgress(expectedTotal, destination);

            } catch (error) {
                hideAutosepMoveProgress();
                showToast(
                    formatUserError(
                        error,
                        _formatAutoSepI18n(
                            operationMode === 'copy' ? 'autosep.copyFailed' : 'autosep.moveFailed',
                            operationMode === 'copy' ? 'Failed to copy images' : 'Failed to move images'
                        )
                    ),
                    "error"
                );
            }
    };

    if (AutoSepState.settings.confirmBeforeMove) {
        showConfirm(
            tKey('autosep.confirmExecuteTitle', 'Confirm Auto-Separate', '确认自动分类'),
            window.I18n?.getLang?.() === 'zh-CN'
                ? `要把 ${total} 张匹配图片${operationMode === 'copy' ? '复制到' : '移动到'}：\n${destination}\n\n操作模式：${operationLabel}\n${scopeLine}\n继续前先确认上方预览列表。`
                : `${operationMode === 'copy' ? 'Copy' : 'Move'} ${total} matching images to:\n${destination}\n\nAction mode: ${operationLabel}\n${scopeLine}\nReview the preview list above before continuing.`,
            executeMove
        );
        return;
    }

    await executeMove();
}

// Replace the original function
window.executeAutoSeparateWithProgress = executeAutoSeparateWithProgress;
