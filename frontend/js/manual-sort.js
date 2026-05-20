/**
 * SD Image Sorter - Manual Sort Module
 * Rhythm-game style keyboard-driven image sorting
 */

const ManualSortState = {
    active: false,
    isProcessing: false,  // Lock to prevent race conditions during rapid keypresses
    currentImage: null,
    currentTags: [],
    folders: { w: '', a: '', s: '', d: '' },
    operationMode: 'move',
    index: 0,
    total: 0,
    combo: 0,
    lastActionTime: 0,
    history: [],
    images: [],  // For gallery preview
    // Enhanced tracking
    sortedCount: 0,
    skippedCount: 0,
    undoAvailable: false,
    redoAvailable: false,
    startTime: null,
    actionTimestamps: [],  // For speed calculation
    filters: null,
    hasSavedFilterState: false,
    inheritedCurrentGalleryFilters: false,
    scopeMeta: null,
    resumeBannerSessionSnapshot: null,
};

const MANUAL_SORT_FILTER_STATE_KEY = 'manual_sort_filter_state_v1';
const MANUAL_SORT_SCOPE_META_KEY = 'manual_sort_scope_meta_v1';
const MANUAL_SORT_OPERATION_MODE_KEY = 'manual_sort_operation_mode_v1';
const MAX_MINIMAP_IMAGES = 1000;
const MANUAL_SORT_PROMPT_MATCH_MODES = new Set(['exact', 'contains']);

// Key mappings
const KEY_MAP = {
    'w': 'w', 'W': 'w', 'ArrowUp': 'w',
    'a': 'a', 'A': 'a', 'ArrowLeft': 'a',
    's': 's', 'S': 's', 'ArrowDown': 's',
    'd': 'd', 'D': 'd', 'ArrowRight': 'd',
    ' ': 'skip',
    'z': 'undo', 'Z': 'undo',
    'y': 'redo', 'Y': 'redo',
    'Escape': 'exit'
};

const DIRECTION_MAP = {
    'w': 'up',
    'a': 'left',
    's': 'down',
    'd': 'right'
};

function normalizeManualSortPromptMatchMode(value) {
    const appNormalize = window.App?.normalizePromptMatchMode;
    if (typeof appNormalize === 'function') {
        return appNormalize(value);
    }
    const text = String(value || '').trim().toLowerCase();
    return MANUAL_SORT_PROMPT_MATCH_MODES.has(text) ? text : 'exact';
}

const DEFAULT_FOLDER_LABELS = {
    w: 'Top',
    a: 'Keep',
    s: 'Delete',
    d: 'Best'
};

function manualSortText(key, enText, zhText = enText) {
    const translated = window.I18n?.t?.(key);
    if (translated && translated !== key) return translated;
    return window.I18n?.getLang?.() === 'zh-CN' ? zhText : enText;
}

function formatManualSortI18n(key, fallback, replacements = {}) {
    const raw = window.I18n?.t?.(key) || fallback;
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        raw
    );
}

function normalizeManualSortOperationMode(mode) {
    // Default to 'copy' when the stored value is unrecognized so a corrupt
    // localStorage entry can never flip a brand-new user into the
    // destructive 'move' path. Locked by Principle #11 in
    // docs/AI_PRINCIPLES.md.
    return mode === 'move' ? 'move' : 'copy';
}

function getManualSortOperationMode() {
    return normalizeManualSortOperationMode(ManualSortState.operationMode);
}

function getManualSortOperationLabel(mode = getManualSortOperationMode()) {
    return mode === 'copy'
        ? manualSortText('manual.actionModeCopy', 'Copy and keep originals', '复制并保留原图')
        : manualSortText('manual.actionModeMove', 'Move originals', '移动原图');
}

function getManualSortOperationVerb(mode = getManualSortOperationMode()) {
    return mode === 'copy'
        ? manualSortText('manual.actionVerbCopy', 'copy', '复制')
        : manualSortText('manual.actionVerbMove', 'move', '移动');
}

function setManualSortOperationMode(mode, { persist = true, updateUi = true } = {}) {
    ManualSortState.operationMode = normalizeManualSortOperationMode(mode);
    if (persist) {
        localStorage.setItem(MANUAL_SORT_OPERATION_MODE_KEY, ManualSortState.operationMode);
    }
    if (updateUi) {
        document.querySelectorAll('input[name="manual-sort-operation"]').forEach((input) => {
            input.checked = input.value === ManualSortState.operationMode;
        });
        const helper = document.getElementById('manual-sort-operation-help');
        if (helper) {
            helper.textContent = ManualSortState.operationMode === 'copy'
                ? manualSortText(
                    'manual.actionModeCopyHelp',
                    'Copies into the sort folders and keeps the originals in place. Safer when date-based library order matters.',
                    '复制到目标文件夹，同时保留原图不动。需要保住按日期整理的库时更安全。'
                )
                : manualSortText(
                    'manual.actionModeMoveHelp',
                    'Moves the original files into the sort folders.',
                    '把原文件直接移动到目标文件夹。'
                );
        }
        const summary = document.getElementById('manual-sort-execution-mode');
        if (summary) {
            summary.textContent = formatManualSortI18n('manual.executionMode', 'Action mode: {mode}', {
                mode: getManualSortOperationLabel(),
            });
        }
    }
}

function serializeManualSortFilters(filters) {
    const source = filters || {};
    const clone = window.App?.cloneFilterState;
    if (typeof clone === 'function') {
        return clone(source);
    }
    return {
        generators: [...(source.generators || ['comfyui', 'nai', 'webui', 'forge', 'unknown'])],
        ratings: [...(source.ratings || ['general', 'sensitive', 'questionable', 'explicit'])],
        tags: [...(source.tags || [])],
        checkpoints: [...(source.checkpoints || [])],
        loras: [...(source.loras || [])],
        prompts: [...(source.prompts || [])],
        promptMatchMode: normalizeManualSortPromptMatchMode(source.promptMatchMode || source.prompt_match_mode),
        artist: source.artist || null,
        search: source.search || '',
        sortBy: source.sortBy || 'newest',
        limit: source.limit || 0,
        minWidth: source.minWidth ?? null,
        maxWidth: source.maxWidth ?? null,
        minHeight: source.minHeight ?? null,
        maxHeight: source.maxHeight ?? null,
        aspectRatio: source.aspectRatio || '',
        minAesthetic: source.minAesthetic ?? null,
        maxAesthetic: source.maxAesthetic ?? null,
    };
}

function loadManualSortFilters() {
    try {
        const raw = localStorage.getItem(MANUAL_SORT_FILTER_STATE_KEY);
        if (raw) {
            ManualSortState.hasSavedFilterState = true;
            ManualSortState.filters = serializeManualSortFilters(JSON.parse(raw));
            return;
        }
    } catch (_) {
        // Ignore invalid saved state and fall back to a safe clone.
    }
    ManualSortState.hasSavedFilterState = false;
    ManualSortState.filters = serializeManualSortFilters(window.App?.AppState?.filters || null);
}

function saveManualSortFilters() {
    ManualSortState.hasSavedFilterState = true;
    localStorage.setItem(MANUAL_SORT_FILTER_STATE_KEY, JSON.stringify(serializeManualSortFilters(ManualSortState.filters || {})));
}

function createDefaultManualSortScopeMeta() {
    return {
        lastSyncedAt: null,
        acknowledgedGallerySignature: null,
    };
}

function buildManualSortFilterContract(filters) {
    const source = serializeManualSortFilters(filters);
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

function loadManualSortScopeMeta() {
    try {
        const raw = localStorage.getItem(MANUAL_SORT_SCOPE_META_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        ManualSortState.scopeMeta = {
            ...createDefaultManualSortScopeMeta(),
            ...(parsed && typeof parsed === 'object' ? parsed : {}),
        };
    } catch (_) {
        ManualSortState.scopeMeta = createDefaultManualSortScopeMeta();
    }
}

function saveManualSortScopeMeta() {
    if (!ManualSortState.scopeMeta) {
        ManualSortState.scopeMeta = createDefaultManualSortScopeMeta();
    }
    localStorage.setItem(MANUAL_SORT_SCOPE_META_KEY, JSON.stringify(ManualSortState.scopeMeta));
}

function setManualSortFilters(nextFilters) {
    ManualSortState.filters = serializeManualSortFilters(nextFilters || {});
    saveManualSortFilters();
}

function getManualSortFilters() {
    if (!ManualSortState.filters) {
        loadManualSortFilters();
    }
    return ManualSortState.filters;
}

function getCurrentGalleryManualSortFilters() {
    const clone = window.App?.cloneFilterState;
    if (typeof clone === 'function') {
        return serializeManualSortFilters(clone(window.App?.AppState?.filters || null));
    }
    return serializeManualSortFilters({});
}

function formatManualSortScopeTime(isoString) {
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

function markManualSortScopeCustomized() {
    ManualSortState.scopeMeta = createDefaultManualSortScopeMeta();
    saveManualSortScopeMeta();
}

function markManualSortScopeSyncedFromGallery() {
    ManualSortState.scopeMeta = {
        lastSyncedAt: new Date().toISOString(),
        acknowledgedGallerySignature: null,
    };
    saveManualSortScopeMeta();
}

function getManualSortToolLabel() {
    return manualSortText('nav.manual', 'Manual Sort', '手动分类');
}

function getManualSortScopeSignature(filters) {
    const appSignature = window.App?.getAdvancedFilterContractSignature;
    if (typeof appSignature === 'function') {
        return appSignature(buildManualSortFilterContract(filters));
    }
    const contract = buildManualSortFilterContract(filters);
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
        minWidth: contract.minWidth || null,
        maxWidth: contract.maxWidth || null,
        minHeight: contract.minHeight || null,
        maxHeight: contract.maxHeight || null,
        aspectRatio: contract.aspectRatio || null,
        minAesthetic: contract.minAesthetic ?? null,
        maxAesthetic: contract.maxAesthetic ?? null,
    });
}

function getManualSortScopeStatus() {
    if (!ManualSortState.scopeMeta) {
        loadManualSortScopeMeta();
    }

    const savedFilters = getManualSortFilters();
    const galleryFilters = getCurrentGalleryManualSortFilters();
    const savedSignature = getManualSortScopeSignature(savedFilters || {});
    const gallerySignature = getManualSortScopeSignature(galleryFilters || {});
    const lastSyncedAt = ManualSortState.scopeMeta?.lastSyncedAt || null;
    const lastSyncedLabel = formatManualSortScopeTime(lastSyncedAt);
    const matchesGallery = savedSignature === gallerySignature;
    const isAcknowledged = Boolean(
        gallerySignature &&
        ManualSortState.scopeMeta?.acknowledgedGallerySignature === gallerySignature
    );

    return {
        gallerySignature,
        lastSyncedAt,
        lastSyncedLabel,
        matchesGallery,
        isAcknowledged,
    };
}

function updateManualSortExecutionScopeSummary() {
    const summaryEl = document.getElementById('manual-sort-execution-scope');
    if (!summaryEl) return;

    const status = getManualSortScopeStatus();
    const tool = getManualSortToolLabel();
    summaryEl.textContent = status.lastSyncedLabel && status.matchesGallery
        ? formatManualSortI18n('scope.sessionSynced', 'This session uses {tool} filters copied from Gallery at {time}.', {
            tool,
            time: status.lastSyncedLabel,
        })
        : formatManualSortI18n('scope.sessionSaved', 'This session uses the saved {tool} filters shown here, not the live Gallery filters.', {
            tool,
        });
}

function updateManualSortScopeStatus() {
    const card = document.getElementById('manual-sort-scope-status');
    const badge = document.getElementById('manual-sort-scope-badge');
    const meta = document.getElementById('manual-sort-scope-meta');
    const detail = document.getElementById('manual-sort-scope-detail');
    const useBtn = document.getElementById('btn-manual-sort-use-gallery-scope');
    const resyncBtn = document.getElementById('btn-manual-sort-resync-scope');
    const keepBtn = document.getElementById('btn-manual-sort-keep-scope');
    if (!card || !badge || !meta || !detail || !useBtn || !resyncBtn || !keepBtn) return;

    const tool = getManualSortToolLabel();
    const status = getManualSortScopeStatus();

    badge.textContent = formatManualSortI18n('scope.usingSaved', '{tool} will use these saved filters', { tool });
    meta.textContent = status.lastSyncedLabel
        ? formatManualSortI18n('scope.syncedAt', 'Copied from Gallery: {time}', {
            time: status.lastSyncedLabel,
        })
        : formatManualSortI18n('scope.standalone', 'These filters will not change automatically when Gallery filters change later.');

    if (status.matchesGallery && status.lastSyncedLabel) {
        detail.textContent = formatManualSortI18n('scope.aligned', 'Gallery and {tool} are currently aligned.', { tool });
    } else if (status.matchesGallery) {
        detail.textContent = formatManualSortI18n(
            'scope.alignedUnsynced',
            '{tool} currently matches the Gallery filters. Later Gallery changes will not be copied automatically.',
            { tool }
        );
    } else if (status.isAcknowledged) {
        detail.textContent = formatManualSortI18n(
            'scope.kept',
            'Using the saved {tool} filters shown here. Current Gallery filters were not copied.',
            { tool }
        );
    } else {
        detail.textContent = formatManualSortI18n(
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

function syncManualSortFiltersFromGallery(options = {}) {
    const { toastKey = 'scope.copiedToast' } = options;
    ManualSortState.inheritedCurrentGalleryFilters = true;
    setManualSortFilters(getCurrentGalleryManualSortFilters());
    markManualSortScopeSyncedFromGallery();
    updateManualSortFilterSummary();

    if (toastKey) {
        window.App?.showToast?.(
            formatManualSortI18n(toastKey, 'Copied current Gallery filters into {tool}.', {
                tool: getManualSortToolLabel(),
            }),
            'success'
        );
    }
}

function keepManualSortSavedScope() {
    const status = getManualSortScopeStatus();
    if (!status.gallerySignature) return;
    ManualSortState.scopeMeta = {
        ...(ManualSortState.scopeMeta || createDefaultManualSortScopeMeta()),
        acknowledgedGallerySignature: status.gallerySignature,
    };
    saveManualSortScopeMeta();
    updateManualSortScopeStatus();
    updateManualSortExecutionScopeSummary();
    window.App?.showToast?.(
        formatManualSortI18n('scope.keptToast', 'Kept the saved {tool} scope.', {
            tool: getManualSortToolLabel(),
        }),
        'info'
    );
}

function maybeAdoptManualSortFiltersFromGallery() {
    if (ManualSortState.hasSavedFilterState || ManualSortState.inheritedCurrentGalleryFilters) {
        return false;
    }

    syncManualSortFiltersFromGallery({ toastKey: null });
    return true;
}

function summarizeManualSortFolders(folders = {}) {
    const entries = Object.entries(folders || {}).filter(([, value]) => typeof value === 'string' && value.trim());
    if (entries.length === 0) {
        return manualSortText('manual.resumeFoldersEmpty', 'No destination folders saved yet', '还没有保存目标文件夹');
    }
    return entries
        .map(([key, value]) => `${String(key).toUpperCase()}: ${value}`)
        .join(' · ');
}

function renderManualSortResumeBanner(session, { visible = true } = {}) {
    const banner = document.querySelector('#sort-resume-banner');
    if (!banner) return;

    if (!visible) {
        ManualSortState.resumeBannerSessionSnapshot = null;
        banner.style.display = 'none';
        return;
    }

    if (!session) {
        ManualSortState.resumeBannerSessionSnapshot = null;
        banner.style.display = 'none';
        return;
    }

    banner.style.display = 'flex';
    ManualSortState.resumeBannerSessionSnapshot = {
        remaining: Number(session?.remaining || 0),
        // Resumed sessions keep whatever mode they were started with;
        // default for a brand-new session is 'copy' (Principle #11).
        operation_mode: session?.operation_mode || 'copy',
        folders: { ...(session?.folders || {}) },
    };

    const countEl = banner.querySelector('.resume-count');
    if (countEl) {
        countEl.textContent = formatManualSortI18n('manual.imagesRemaining', '{count} images remaining', {
            count: Number(session?.remaining || 0),
        });
    }

    const operationEl = banner.querySelector('.resume-operation');
    if (operationEl) {
        const modeLabel = getManualSortOperationLabel(session?.operation_mode || 'copy');
        operationEl.textContent = formatManualSortI18n(
            'manual.resumeOperationMode',
            'Saved session action mode: {mode}',
            { mode: modeLabel }
        );
    }

    const foldersEl = banner.querySelector('.resume-folders');
    if (foldersEl) {
        foldersEl.textContent = formatManualSortI18n(
            'manual.resumeFolderSummary',
            'Saved session folders: {summary}',
            { summary: summarizeManualSortFolders(session?.folders || {}) }
        );
    }
}

// ============== Initialization ==============

async function initManualSort() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);
    loadManualSortFilters();
    loadManualSortScopeMeta();
    setManualSortOperationMode(localStorage.getItem(MANUAL_SORT_OPERATION_MODE_KEY) || 'copy', {
        persist: false,
        updateUi: true,
    });
    updateManualSortFilterSummary();

    // Folder path inputs
    $$('.folder-path-input').forEach(input => {
        const savedFolder = localStorage.getItem(`sort-folder-${input.dataset.key}`);
        if(savedFolder) {
            input.value = savedFolder;
            ManualSortState.folders[input.dataset.key] = savedFolder;
        }

        input.addEventListener('change', () => {
            ManualSortState.folders[input.dataset.key] = input.value;
            localStorage.setItem(`sort-folder-${input.dataset.key}`, input.value);
        });
    });

    // Browse folder buttons
    $$('.browse-folder').forEach(btn => {
        btn.addEventListener('click', async () => {
            // Find the input in the same folder-slot as this button
            const folderSlot = btn.closest('.folder-slot');
            const input = folderSlot?.querySelector('.folder-path-input');
            if (input) {
                const key = input.dataset.key?.toUpperCase() || '';
                const currentValue = input.value || '';
                const path = await window.App.showInputModal(
                    `Folder Path for ${key}`,
                    `Enter the destination folder path.\nExample: D:\\sorted\\folder-name`,
                    currentValue
                );
                if (path !== null) {
                    input.value = path;
                    ManualSortState.folders[input.dataset.key] = path;
                    localStorage.setItem(`sort-folder-${input.dataset.key}`, path);
                }
            }
        });
    });

    document.querySelectorAll('input[name="manual-sort-operation"]').forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) {
                setManualSortOperationMode(input.value);
            }
        });
    });

    // Edit Filters button - open unified filter modal
    const filterBtn = $('#btn-manual-sort-filters');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            if (window.App && window.App.openFilterModal) {
                window.App.openFilterModal({
                    mode: 'manual-sort',
                    titleText: manualSortText('manual.filterTitle', 'Manual Sort Filters', '手动分类筛选'),
                    applyButtonText: manualSortText('manual.applyFilters', 'Apply to Manual Sort', '应用到手动分类'),
                    resetButtonText: manualSortText('manual.resetFilters', 'Reset Manual Sort Filters', '重置手动分类筛选'),
                    filterState: getManualSortFilters(),
                    onApply: (filters) => {
                        setManualSortFilters(filters);
                        markManualSortScopeCustomized();
                        updateManualSortFilterSummary();
                    },
                    onReset: (filters) => {
                        setManualSortFilters(filters);
                        markManualSortScopeCustomized();
                        updateManualSortFilterSummary();
                    },
                });
            }
        });
    }

    $('#btn-manual-sort-use-gallery-scope')?.addEventListener('click', () => {
        syncManualSortFiltersFromGallery({ toastKey: 'scope.copiedToast' });
    });
    $('#btn-manual-sort-resync-scope')?.addEventListener('click', () => {
        syncManualSortFiltersFromGallery({ toastKey: 'scope.resyncedToast' });
    });
    $('#btn-manual-sort-keep-scope')?.addEventListener('click', keepManualSortSavedScope);

    // Start sorting button
    const startBtn = $('#btn-start-sorting');
    if (startBtn) {
        startBtn.addEventListener('click', startSorting);
    }

    // Exit sorting button
    const exitBtn = $('#btn-exit-sorting');
    if (exitBtn) {
        exitBtn.addEventListener('click', exitSorting);
    }

    // Resume session button
    const resumeBtn = $('#btn-resume-sorting');
    if (resumeBtn) {
        resumeBtn.addEventListener('click', () => resumeSavedSession());
    }

    // Discard saved session button
    const discardBtn = $('#btn-discard-session');
    if (discardBtn) {
        discardBtn.addEventListener('click', () => {
            window.App.showConfirm(
                manualSortText('manual.discardSessionTitle', 'Discard Saved Session', '丢弃已保存会话'),
                manualSortText(
                    'manual.discardSessionMessage',
                    'Delete the saved manual-sort session and lose the remaining progress? This cannot be undone.',
                    '要删除已保存的手动分类会话，并丢失剩余进度吗？此操作无法撤销。'
                ),
                async () => {
                    try {
                        await window.App.API.delete('/api/sort/session');
                        renderManualSortResumeBanner(null, { visible: false });
                        window.App.showToast(
                            manualSortText('manual.discardSessionSuccess', 'Saved session discarded', '已丢弃已保存会话'),
                            'success'
                        );
                    } catch (e) {
                        if (window.Logger) Logger.warn('Failed to discard session:', e);
                        window.App.showToast(
                            formatUserError(
                                e,
                                manualSortText('manual.discardSessionFailed', 'Failed to discard saved session', '丢弃已保存会话失败')
                            ),
                            'error'
                        );
                    }
                }
            );
        });
    }

    // Keyboard listener (added when sorting starts)

    // Update filter summary display initially
    setTimeout(() => {
        if (window.App && window.App.AppState) {
            updateManualSortFilterSummary();
        }
    }, 100);

    document.addEventListener('gallery-filters-changed', () => {
        updateManualSortScopeStatus();
        updateManualSortExecutionScopeSummary();
    });
    document.addEventListener('languageChanged', () => {
        updateManualSortFilterSummary();
        setManualSortOperationMode(ManualSortState.operationMode, { persist: false, updateUi: true });
        if (ManualSortState.resumeBannerSessionSnapshot) {
            renderManualSortResumeBanner(ManualSortState.resumeBannerSessionSnapshot, { visible: true });
        }
    });

    // Check for saved session on the server
    try {
        const session = await window.App.API.get('/api/sort/current').catch(e => {
            console.warn('Operation failed:', e);
            return null;
        });
        if (session && !session.done && session.image) {
            renderManualSortResumeBanner(session, { visible: true });
        }
    } catch(e) {
        if (window.Logger) Logger.warn('Failed to check sort session:', e);
    }
}

// ============== Start Sorting ==============

async function confirmResumeSavedSessionFromStart(savedSession) {
    const body = formatManualSortI18n(
        'manual.resumeInsteadBody',
        'An unfinished Manual Sort session is saved at image {index}/{total} with {remaining} remaining. Resume it instead of starting over. To start from the first matching image, discard the saved session first.',
        {
            index: Number(savedSession.index || 0) + 1,
            total: Number(savedSession.total || 0),
            remaining: Number(savedSession.remaining || 0),
        }
    );

    return new Promise(resolve => {
        window.App.showConfirm(
            manualSortText('manual.resumeInsteadTitle', 'Resume saved Manual Sort session?', '恢复已保存的手动分类会话？'),
            body,
            async () => {
                await resumeSavedSession(savedSession);
                resolve(true);
            },
            () => {
                renderManualSortResumeBanner(savedSession, { visible: true });
                resolve(false);
            }
        );
    });
}

async function startSorting() {
    const { $, $$, API, showToast } = window.App;
    const operationMode = getManualSortOperationMode();
    const operationLabel = getManualSortOperationLabel(operationMode);

    try {
        const savedSession = await API.getCurrentSortImage();
        if (savedSession && !savedSession.done && savedSession.image) {
            await confirmResumeSavedSessionFromStart(savedSession);
            return;
        }
    } catch (error) {
        if (window.Logger) Logger.warn('Failed to check existing sort session before start:', error);
    }

    // Collect folder paths
    const folders = {};
    $$('.folder-path-input').forEach(input => {
        if (input.value.trim()) {
            folders[input.dataset.key] = input.value.trim();
        }
    });

    // Validate at least one folder
    if (Object.keys(folders).length === 0) {
        showToast(manualSortText('manual.configureFolder', 'Please configure at least one destination folder', '请至少配置一个目标文件夹'), 'error');
        return;
    }

    const replaceExisting = false;

    // Confirmation dialog before starting (files will be moved/copied)
    const scopeStatus = getManualSortScopeStatus();
    const scopeLine = scopeStatus.lastSyncedLabel && scopeStatus.matchesGallery
        ? formatManualSortI18n('scope.executeSynced', 'Using saved {tool} filters copied from Gallery at {time}', {
            tool: getManualSortToolLabel(),
            time: scopeStatus.lastSyncedLabel,
        })
        : formatManualSortI18n('scope.executeSaved', 'Using saved {tool} filters', {
            tool: getManualSortToolLabel(),
        });
    const confirmMessage = window.I18n?.getLang?.() === 'zh-CN'
        ? formatManualSortI18n(
            operationMode === 'copy' ? 'manual.startSortingConfirmCopy' : 'manual.startSortingConfirmMove',
            operationMode === 'copy'
                ? '开始排序后，图片会被复制到对应文件夹，原图保持不动。\n\n操作模式：{mode}\n{scope}\n确定开始吗？'
                : '开始排序后，图片将被移动到对应文件夹。\n\n操作模式：{mode}\n{scope}\n确定开始吗？',
            { scope: scopeLine, mode: operationLabel }
        )
        : formatManualSortI18n(
            operationMode === 'copy' ? 'manual.startSortingConfirmCopy' : 'manual.startSortingConfirmMove',
            operationMode === 'copy'
                ? 'Starting a sort session will copy images to the configured folders and keep the originals in place.\n\nAction mode: {mode}\n{scope}\nAre you sure?'
                : 'Starting a sort session will move images to the configured folders.\n\nAction mode: {mode}\n{scope}\nAre you sure?',
            { scope: scopeLine, mode: operationLabel }
        );
    const confirmed = await new Promise(resolve => {
        window.App.showConfirm(
            manualSortText('manual.startSortingTitle', 'Start Sorting', '确认开始排序'),
            confirmMessage,
            () => resolve(true),
            () => resolve(false)
        );
    });
    if (!confirmed) return;

    ManualSortState.folders = folders;
    setManualSortOperationMode(operationMode, { persist: true, updateUi: true });

    // Save destination folders for quick access later
    Object.keys(folders).forEach(key => {
        const path = folders[key];
        localStorage.setItem(`sort-folder-${key}`, path);
        if (window.App && window.App.addRecentFolder) {
            window.App.addRecentFolder(path);
        }
    });

    // Manual Sort keeps its own filter state so queue/sort work does not pollute Gallery.
    const f = buildManualSortFilterContract(getManualSortFilters());
    const generators = f.generators?.length > 0 ? f.generators : null;
    const ratings = f.ratings?.length > 0 ? f.ratings : null;
    const tags = f.tags?.length > 0 ? f.tags : null;
    const checkpoints = f.checkpoints?.length > 0 ? f.checkpoints : null;
    const loras = f.loras?.length > 0 ? f.loras : null;
    const prompts = f.prompts?.length > 0 ? f.prompts : null;
    const search = f.search?.trim() || null;
    const dimensions = {
        minWidth: f.minWidth,
        maxWidth: f.maxWidth,
        minHeight: f.minHeight,
        maxHeight: f.maxHeight,
        aspectRatio: f.aspectRatio
    };

    try {
        // Set folders on server
        await API.setSortFolders(folders);

        // Start session with unified filters including prompts and dimensions
        const result = await API.startSortSession(
            generators,
            tags,
            ratings,
            folders,
            checkpoints,
            loras,
            prompts,
            dimensions,
            search,
            {
                min: f.minAesthetic,
                max: f.maxAesthetic,
            },
            operationMode,
            f.artist,
            replaceExisting,
            f.promptMatchMode,
        );

        if (result.total_images === 0) {
            showToast(
                manualSortText('manual.noImages', 'No images match Manual Sort filters', '没有图片匹配手动分类筛选'),
                'error'
            );
            return;
        }

        // Fetch images for gallery preview with paginated requests.
        const previewImages = [];
        let previewCursor = null;

        while (previewImages.length < result.total_images && previewImages.length < MAX_MINIMAP_IMAGES) {
            const remainingPreviewSlots = Math.min(
                result.total_images - previewImages.length,
                MAX_MINIMAP_IMAGES - previewImages.length
            );
            const imagesResult = await API.getImages({
                generators: generators,
                tags: tags,
                ratings: ratings,
                checkpoints: checkpoints,
                loras: loras,
                prompts: prompts,
                promptMatchMode: f.promptMatchMode,
                artist: f.artist,
                search: search,
                minWidth: f.minWidth,
                maxWidth: f.maxWidth,
                minHeight: f.minHeight,
                maxHeight: f.maxHeight,
                aspectRatio: f.aspectRatio,
                minAesthetic: f.minAesthetic,
                maxAesthetic: f.maxAesthetic,
                limit: remainingPreviewSlots,
                cursor: previewCursor
            });

            if (!imagesResult?.images?.length) {
                break;
            }

            previewImages.push(...imagesResult.images.slice(0, remainingPreviewSlots));

            if (!imagesResult.has_more || !imagesResult.next_cursor) {
                break;
            }

            previewCursor = imagesResult.next_cursor;
        }

        ManualSortState.total = result.total_images;
        ManualSortState.index = 0;
        ManualSortState.combo = 0;
        ManualSortState.history = [];
        ManualSortState.images = previewImages;
        ManualSortState.sortedCount = 0;
        ManualSortState.skippedCount = 0;
        ManualSortState.undoAvailable = false;
        ManualSortState.redoAvailable = false;
        ManualSortState.startTime = Date.now();
        ManualSortState.actionTimestamps = [];
        ManualSortState.currentImage = null;
        ManualSortState.currentTags = [];

        // Update folder names in UI
        updateFolderNames();

        activateSortingUi();

        try {
            await loadCurrentImage();
        } catch (error) {
            rollbackSortingUi();
            throw error;
        }

        // Play start sound
        window.AudioManager?.play('start');

    } catch (error) {
        showToast(formatUserError(error, manualSortText('manual.startFailed', 'Failed to start sorting', '开始排序失败')), "error");
    }
}

function updateFolderNames() {
    const { $ } = window.App;

    Object.keys(DEFAULT_FOLDER_LABELS).forEach((key) => {
        const path = ManualSortState.folders[key];
        const nameEl = $(`#folder-name-${key}`);
        if (!nameEl) return;

        if (path) {
            const parts = path.split(/[/\\]/);
            nameEl.textContent = parts[parts.length - 1] || path;
        } else {
            nameEl.textContent = DEFAULT_FOLDER_LABELS[key] || key.toUpperCase();
        }
    });
}

function restoreFolderInputs() {
    document.querySelectorAll('.folder-path-input').forEach(input => {
        const key = input.dataset.key;
        input.value = key ? (ManualSortState.folders[key] || '') : '';
    });
    updateFolderNames();
}

function syncPreviewImages(imageIds = [], currentImage = null) {
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
        ManualSortState.images = [];
        return;
    }

    const existingById = new Map((ManualSortState.images || []).map(image => [image.id, image]));
    ManualSortState.images = imageIds.map(id => existingById.get(id) || { id });

    if (currentImage?.id) {
        const currentIndex = imageIds.indexOf(currentImage.id);
        if (currentIndex >= 0) {
            ManualSortState.images[currentIndex] = currentImage;
        }
    }
}

function updateHistoryControlState(state = {}) {
    if (typeof state.undo_available === 'boolean') {
        ManualSortState.undoAvailable = state.undo_available;
    }
    if (typeof state.redo_available === 'boolean') {
        ManualSortState.redoAvailable = state.redo_available;
    }

    document.querySelectorAll('[data-action="undo"]').forEach(btn => {
        const disabled = !ManualSortState.active || !ManualSortState.undoAvailable;
        btn.disabled = disabled;
        btn.setAttribute('aria-disabled', String(disabled));
    });

    document.querySelectorAll('[data-action="redo"]').forEach(btn => {
        const disabled = !ManualSortState.active || !ManualSortState.redoAvailable;
        btn.disabled = disabled;
        btn.setAttribute('aria-disabled', String(disabled));
    });
}

function activateSortingUi() {
    const { $ } = window.App;
    ManualSortState.active = true;
    document.removeEventListener('keydown', handleSortKeypress);
    document.addEventListener('keydown', handleSortKeypress);
    $('#sort-setup').style.display = 'none';
    $('#sort-interface').style.display = 'flex';
    updateHistoryControlState();
}

function rollbackSortingUi() {
    const { $ } = window.App;
    ManualSortState.active = false;
    document.removeEventListener('keydown', handleSortKeypress);
    $('#sort-interface').style.display = 'none';
    $('#sort-setup').style.display = 'block';
    updateHistoryControlState({ undo_available: false, redo_available: false });
}

function applyCurrentSortPayload(result, options = {}) {
    const { $, API } = window.App;
    const { cacheBust = false } = options;

    if (result?.operation_mode) {
        setManualSortOperationMode(result.operation_mode, { persist: true, updateUi: true });
    }

    if (result?.folders && typeof result.folders === 'object') {
        ManualSortState.folders = { ...ManualSortState.folders, ...result.folders };
        restoreFolderInputs();
    }

    if (Array.isArray(result?.image_ids)) {
        syncPreviewImages(result.image_ids, result.image || null);
    }

    if (Number.isFinite(result?.sorted_count)) {
        ManualSortState.sortedCount = result.sorted_count;
    }
    if (Number.isFinite(result?.skipped_count)) {
        ManualSortState.skippedCount = result.skipped_count;
    }

    updateHistoryControlState(result || {});

    if (result?.done) {
        finishSorting();
        return false;
    }

    ManualSortState.currentImage = result.image;
    ManualSortState.currentTags = result.tags || [];
    ManualSortState.index = result.index;
    ManualSortState.total = result.total;

    if (ManualSortState.currentImage?.id && ManualSortState.images?.length > ManualSortState.index) {
        ManualSortState.images[ManualSortState.index] = ManualSortState.currentImage;
    }

    const imgWrapper = $('.current-image-wrapper');
    imgWrapper.classList.remove('fly-up', 'fly-down', 'fly-left', 'fly-right', 'skip');
    imgWrapper.classList.add('slide-in');

    const img = $('#current-image');
    const cacheSuffix = cacheBust ? `?t=${Date.now()}` : '';
    img.src = ManualSortState.currentImage?.id ? API.getImageUrl(ManualSortState.currentImage.id) + cacheSuffix : '';

    const tagsEl = $('#current-image-tags');
    const topTags = ManualSortState.currentTags.slice(0, 5);
    tagsEl.innerHTML = topTags
        .map(t => `<span class="image-tag">${escapeHtml(t.tag)}</span>`)
        .join('');

    updateProgress();

    setTimeout(() => {
        imgWrapper.classList.remove('slide-in');
    }, 300);

    return true;
}

async function resumeSavedSession(prefetchedSession = null) {
    const { $, API, showToast } = window.App;
    const previousResumeSnapshot = ManualSortState.resumeBannerSessionSnapshot
        ? {
            remaining: ManualSortState.resumeBannerSessionSnapshot.remaining,
            operation_mode: ManualSortState.resumeBannerSessionSnapshot.operation_mode,
            folders: { ...(ManualSortState.resumeBannerSessionSnapshot.folders || {}) },
        }
        : null;

    try {
        const session = prefetchedSession || await API.getCurrentSortImage();

        if (!session || session.done || !session.image) {
            renderManualSortResumeBanner(null, { visible: false });
            showToast(manualSortText('manual.noSavedSession', 'No saved sorting session to resume', '没有可恢复的已保存排序会话'), 'info');
            return;
        }

        ManualSortState.folders = session.folders || {};
        ManualSortState.startTime = Date.now();
        ManualSortState.combo = 0;
        ManualSortState.lastActionTime = 0;
        ManualSortState.history = [];
        ManualSortState.images = [];
        ManualSortState.currentImage = null;
        ManualSortState.currentTags = [];
        ManualSortState.actionTimestamps = [];
        ManualSortState.sortedCount = 0;
        ManualSortState.skippedCount = 0;
        ManualSortState.undoAvailable = false;
        ManualSortState.redoAvailable = false;
        setManualSortOperationMode(session.operation_mode || ManualSortState.operationMode, { persist: true, updateUi: true });

        if (!Object.keys(ManualSortState.folders).length) {
            const folderResult = await API.get('/api/sort/folders');
            ManualSortState.folders = folderResult?.folders || {};
        }

        restoreFolderInputs();
        activateSortingUi();
        applyCurrentSortPayload(session);

        renderManualSortResumeBanner(null, { visible: false });
    } catch (error) {
        rollbackSortingUi();
        renderManualSortResumeBanner(previousResumeSnapshot, { visible: Boolean(previousResumeSnapshot) });
        Logger.error('Failed to resume saved session:', error);
        showToast(formatUserError(error, manualSortText('manual.resumeFailed', 'Failed to resume saved session', '恢复已保存会话失败')), 'error');
    }
}

// ============== Load Current Image ==============

async function loadCurrentImage(prefetchedResult = null) {
    const { API } = window.App;

    try {
        const result = prefetchedResult || await API.getCurrentSortImage();
        applyCurrentSortPayload(result, { cacheBust: !!prefetchedResult });
    } catch (error) {
        Logger.error('Failed to load current image:', error);
        throw error;
    }
}

function updateProgress() {
    const { $ } = window.App;
    const percent = ManualSortState.total > 0
        ? (ManualSortState.index / ManualSortState.total) * 100
        : 0;

    $('#sort-progress-fill').style.width = percent + '%';
    $('#sort-progress-text').textContent = `${ManualSortState.index} / ${ManualSortState.total}`;

    // Enhanced progress stats
    const percentEl = $('#sort-percent');
    if (percentEl) percentEl.textContent = Math.round(percent) + '%';

    const sortedEl = $('#sort-sorted-count');
    if (sortedEl) sortedEl.textContent = ManualSortState.sortedCount;

    const skippedEl = $('#sort-skipped-count');
    if (skippedEl) skippedEl.textContent = ManualSortState.skippedCount;

    const remainingEl = $('#sort-remaining-count');
    if (remainingEl) remainingEl.textContent = Math.max(0, ManualSortState.total - ManualSortState.index);

    // Speed calculation (actions per second, rolling 10-second window)
    const speedEl = $('#sort-speed');
    if (speedEl) {
        const now = Date.now();
        const recentActions = ManualSortState.actionTimestamps.filter(t => now - t < 10000);
        const speed = recentActions.length > 1
            ? (recentActions.length / ((now - recentActions[0]) / 1000)).toFixed(1)
            : '0.0';
        speedEl.textContent = formatManualSortI18n('manual.actionsPerSecond', '{speed}/s', { speed });
    }

    // Segmented progress bar
    const sortedFill = $('#sort-progress-sorted');
    const skippedFill = $('#sort-progress-skipped');
    if (sortedFill && skippedFill && ManualSortState.total > 0) {
        const sortedPct = (ManualSortState.sortedCount / ManualSortState.total) * 100;
        const skippedPct = (ManualSortState.skippedCount / ManualSortState.total) * 100;
        sortedFill.style.width = sortedPct + '%';
        skippedFill.style.width = skippedPct + '%';
    }

    // Minimap position
    const minimapPos = $('#minimap-position');
    if (minimapPos) minimapPos.textContent = `${ManualSortState.index + 1}/${ManualSortState.total}`;

    // Also update gallery preview
    updateGalleryPreview();
}

function updateGalleryPreview() {
    const { $, API } = window.App;
    const container = $('#preview-scroll');
    if (!container) return;

    // Get surrounding images (5 before, current, 10 after)
    const startIdx = Math.max(0, ManualSortState.index - 5);
    const endIdx = Math.min(ManualSortState.images?.length || 0, ManualSortState.index + 11);

    if (!ManualSortState.images || ManualSortState.images.length === 0) {
        container.innerHTML = `<span style="color: var(--text-muted); font-size: 12px;">${manualSortText('manual.noImagesLoaded', 'No images loaded', '还没有载入图片')}</span>`;
        return;
    }

    const thumbsHTML = [];
    for (let i = startIdx; i < endIdx; i++) {
        const img = ManualSortState.images[i];
        if (!img) continue;

        let className = 'preview-thumb';
        if (i === ManualSortState.index) {
            className += ' current';
        } else if (i < ManualSortState.index) {
            className += ' processed';
        }

        thumbsHTML.push(`
            <div class="${className}" data-index="${i}" title="${escapeHtml(formatManualSortI18n('manual.previewImageTitle', 'Image {index}', { index: i + 1 }))}">
                <img src="${API?.getThumbnailUrl?.(img.id) ?? `/api/image-thumbnail/${img.id}?size=256`}" alt="" loading="lazy">
            </div>
        `);
    }

    container.innerHTML = thumbsHTML.join('');

    // Scroll to keep current image centered
    const currentThumb = container.querySelector('.current');
    if (currentThumb) {
        currentThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
}

// ============== Handle Keypress ==============

function handleSortKeypress(e) {
    if (!ManualSortState.active) return;

    // Handle Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) explicitly
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            if (e.shiftKey) {
                redoLastAction();
            } else {
                undoLastAction();
            }
            return;
        }
        if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            redoLastAction();
            return;
        }
        return; // Ignore other Ctrl+key combos
    }

    const action = KEY_MAP[e.key];
    if (!action) return;

    e.preventDefault();

    if (action === 'undo') {
        undoLastAction();
    } else if (action === 'redo') {
        redoLastAction();
    } else if (action === 'skip') {
        performSkip();
    } else if (action === 'exit') {
        exitSorting();
    } else {
        performMove(action);
    }
}

async function performMove(folderKey) {
    const { $, API, showToast } = window.App;
    const operationVerb = getManualSortOperationVerb();

    // Prevent race condition from rapid keypresses
    if (ManualSortState.isProcessing) return;
    ManualSortState.isProcessing = true;

    try {
        // Check if folder is configured
        if (!ManualSortState.folders[folderKey]) {
            showToast(formatManualSortI18n('manual.folderNotConfigured', 'Folder {key} is not configured', {
                key: folderKey.toUpperCase(),
            }), 'error');
            return;
        }

        // Animate folder highlight
        const folderEl = $(`.sort-folder[data-key="${folderKey}"]`);
        folderEl?.classList.add('active');
        setTimeout(() => folderEl?.classList.remove('active'), 300);

        // Animate image flying away
        const direction = DIRECTION_MAP[folderKey];
        const imgWrapper = $('.current-image-wrapper');
        imgWrapper.classList.add(`fly-${direction}`);

        // Play sound
        window.AudioManager?.play('move', folderKey);

        // Wait for animation
        await sleep(300);

        // Send action to server
        const result = await API.sortAction('move', folderKey);

        if (result.error) {
            updateHistoryControlState(result);
            showToast(
                formatManualSortI18n('manual.operationFailedWithReason', 'Failed to {operation} image: {reason}', {
                    operation: operationVerb,
                    reason: result.error,
                }),
                'error'
            );
            return;
        }

        // Update combo/stats only after successful move
        updateCombo();
        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);
        await loadCurrentImage(result);

    } catch (error) {
        Logger.error(`Failed to ${operationVerb} image:`, error);
        showToast(
            formatManualSortI18n('manual.operationFailed', 'Failed to {operation} image', {
                operation: operationVerb,
            }),
            'error'
        );
    } finally {
        ManualSortState.isProcessing = false;
    }
}

async function performSkip() {
    const { $, API, showToast } = window.App;

    // Prevent race condition from rapid keypresses
    if (ManualSortState.isProcessing) return;
    ManualSortState.isProcessing = true;

    try {
        // Animate skip
        const imgWrapper = $('.current-image-wrapper');
        imgWrapper.classList.add('skip');

        // Play skip sound
        window.AudioManager?.play('skip');

        // Reset combo
        ManualSortState.combo = 0;
        updateComboDisplay();

        await sleep(300);

        const result = await API.sortAction('skip');
        if (result.error) {
            updateHistoryControlState(result);
            showToast(
                formatManualSortI18n('manual.skipFailedWithReason', 'Failed to skip image: {reason}', {
                    reason: result.error,
                }),
                'error'
            );
            return;
        }

        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);

        await loadCurrentImage(result);

    } catch (error) {
        Logger.error('Failed to skip:', error);
        showToast(manualSortText('manual.skipFailed', 'Failed to skip image', '跳过图片失败'), 'error');
    } finally {
        ManualSortState.isProcessing = false;
    }
}

async function undoLastAction() {
    const { $, API, showToast } = window.App;

    // Play undo sound
    window.AudioManager?.play('undo');

    // Reset combo
    ManualSortState.combo = 0;
    updateComboDisplay();

    try {
        const result = await API.sortAction('undo');

        // Check if there was nothing to undo
        if (result.status === 'no_history') {
            updateHistoryControlState(result);
            showToast(manualSortText('manual.undoEmpty', 'Nothing to undo', '没有可撤销的操作'), 'info');
            return;
        }

        await loadCurrentImage(result);
        showToast(manualSortText('manual.undoSuccess', 'Undid last action', '已撤销上一步'), 'info');
    } catch (error) {
        Logger.error('Failed to undo:', error);
        showToast(manualSortText('manual.undoFailed', 'Failed to undo', '撤销失败'), 'error');
    }
}

// ============== Combo System ==============

const COMBO_WINDOW_MS = 2000;
const COMBO_SOUND_MILESTONE = 5;

function updateCombo() {
    const now = Date.now();
    const timeSinceLast = now - ManualSortState.lastActionTime;

    if (timeSinceLast < COMBO_WINDOW_MS) {
        ManualSortState.combo++;
    } else {
        ManualSortState.combo = 1;
    }

    ManualSortState.lastActionTime = now;
    updateComboDisplay();

    // Play combo sound at milestones
    if (ManualSortState.combo % COMBO_SOUND_MILESTONE === 0 && ManualSortState.combo > 0) {
        window.AudioManager?.play('combo');
    }
}

function updateComboDisplay() {
    const { $ } = window.App;
    const comboEl = $('#combo-display');
    if (!comboEl) return;

    const comboNum = comboEl.querySelector('.combo-number');
    if (!comboNum) return;

    if (ManualSortState.combo >= 3) {
        comboEl.classList.add('visible');
        comboNum.textContent = ManualSortState.combo;

        // Pulse animation
        comboNum.style.transform = 'scale(1.2)';
        setTimeout(() => {
            comboNum.style.transform = 'scale(1)';
        }, 100);
    } else {
        comboEl.classList.remove('visible');
    }
}

// ============== Finish/Exit ==============

function finishSorting() {
    const { $, showToast } = window.App;

    ManualSortState.active = false;
    ManualSortState.history = [];
    ManualSortState.undoAvailable = false;
    ManualSortState.redoAvailable = false;
    document.removeEventListener('keydown', handleSortKeypress);
    updateHistoryControlState({ undo_available: false, redo_available: false });

    // Play finish sound
    window.AudioManager?.play('finish');

    // Calculate session stats
    const elapsed = ManualSortState.startTime
        ? Math.round((Date.now() - ManualSortState.startTime) / 1000)
        : 0;
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    showToast(
        formatManualSortI18n('manual.finishSummary', 'Sorting complete. {sorted} sorted, {skipped} skipped in {time}.', {
            sorted: ManualSortState.sortedCount,
            skipped: ManualSortState.skippedCount,
            time: timeStr,
        }),
        'success'
    );

    // Return to setup
    $('#sort-interface').style.display = 'none';
    $('#sort-setup').style.display = 'block';

    window.App.API.delete('/api/sort/session').catch(e => {
        if (window.Logger) Logger.warn('Failed to clean up sort session:', e);
    });

    // Refresh gallery
    if (window.App && window.App.loadImages) {
        window.App.loadImages();
    }
}

function exitSorting() {
    const { $, showToast } = window.App;

    ManualSortState.active = false;
    ManualSortState.undoAvailable = false;
    ManualSortState.redoAvailable = false;
    document.removeEventListener('keydown', handleSortKeypress);
    updateHistoryControlState({ undo_available: false, redo_available: false });

    $('#sort-interface').style.display = 'none';
    $('#sort-setup').style.display = 'block';

    const remaining = Math.max(0, ManualSortState.total - ManualSortState.index);
    if (remaining > 0) {
        renderManualSortResumeBanner(
            {
                remaining,
                operation_mode: getManualSortOperationMode(),
                folders: ManualSortState.folders || {},
            },
            { visible: true }
        );
    }

    showToast(manualSortText('manual.sortingPaused', 'Sorting paused. You can resume later.', '排序已暂停，稍后可以继续。'), 'info');

    // Refresh gallery to show updated image locations
    if (window.App && window.App.loadImages) {
        window.App.loadImages();
    }
}

// ============== Filter Summary ==============

function updateManualSortFilterSummary() {
    const { $ } = window.App;
    const filters = getManualSortFilters();
    if (!filters) return;

    // Use shared filter summary formatter
    const summary = window.formatFilterSummary(filters);

    // Generators
    const genEl = $('#manual-sort-summary-generators');
    if (genEl) genEl.textContent = summary.generators;

    // Tags
    const tagEl = $('#manual-sort-summary-tags');
    if (tagEl) tagEl.textContent = summary.tags;

    // Ratings
    const ratingEl = $('#manual-sort-summary-ratings');
    if (ratingEl) ratingEl.textContent = summary.ratings;

    // Checkpoints
    const cpEl = $('#manual-sort-summary-checkpoints');
    if (cpEl) cpEl.textContent = summary.checkpoints;

    // Loras
    const loraEl = $('#manual-sort-summary-loras');
    if (loraEl) loraEl.textContent = summary.loras;

    // Prompts
    const promptEl = $('#manual-sort-summary-prompts');
    if (promptEl) promptEl.textContent = summary.prompts;

    // Search
    const searchEl = $('#manual-sort-summary-search');
    if (searchEl) searchEl.textContent = summary.search;

    // Dimensions
    const dimEl = $('#manual-sort-summary-dimensions');
    if (dimEl) dimEl.textContent = summary.dimensions;

    updateManualSortScopeStatus();
    updateManualSortExecutionScopeSummary();
}

// ============== Utilities ==============

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    initManualSort();
});

// Export for use by app.js and filter modal
window.ManualSortState = ManualSortState;
window.updateManualSortFilterSummary = updateManualSortFilterSummary;
window.maybeAdoptManualSortFiltersFromGallery = maybeAdoptManualSortFiltersFromGallery;

// ============== Touch Controls for Mobile ==============

// Touch control button mapping
const TOUCH_BUTTONS = [
    { key: 'w', label: 'W', icon: '↑', action: 'move', folderKey: 'w' },
    { key: 'a', label: 'A', icon: '←', action: 'move', folderKey: 'a' },
    { key: 's', label: 'S', icon: '↓', action: 'move', folderKey: 's' },
    { key: 'd', label: 'D', icon: '→', action: 'move', folderKey: 'd' }
];

function createTouchControls() {
    const container = document.querySelector('.sort-interface');
    if (!container) return;
    
    // Check if already created
    if (document.getElementById('touch-sort-controls')) return;
    
    const touchControls = document.createElement('div');
    touchControls.id = 'touch-sort-controls';
    touchControls.className = 'touch-sort-controls';
    
    touchControls.innerHTML = `
        <button class="touch-sort-btn" data-key="w" aria-label="Move to W folder">
            <span class="key-label">W</span>
            <span>↑</span>
        </button>
        <button class="touch-sort-btn" data-key="a" aria-label="Move to A folder">
            <span class="key-label">A</span>
            <span>←</span>
        </button>
        <button class="touch-sort-btn btn-undo" data-action="undo" aria-label="Undo last action">
            <span class="key-label">Z</span>
            <span>Undo</span>
        </button>
        <button class="touch-sort-btn btn-redo" data-action="redo" aria-label="Redo last undone action">
            <span class="key-label">Y</span>
            <span>Redo</span>
        </button>
        <button class="touch-sort-btn" data-key="s" aria-label="Move to S folder">
            <span class="key-label">S</span>
            <span>↓</span>
        </button>
        <button class="touch-sort-btn" data-key="d" aria-label="Move to D folder">
            <span class="key-label">D</span>
            <span>→</span>
        </button>
        <button class="touch-sort-btn btn-skip" data-action="skip" aria-label="Skip current image">
            <span class="key-label">Space</span>
            <span>Skip</span>
        </button>
        <button class="touch-sort-btn btn-undo" data-action="exit" aria-label="Exit sorting">
            <span class="key-label">Esc</span>
            <span>Exit</span>
        </button>
    `;
    
    container.appendChild(touchControls);
    
    // Add event listeners
    touchControls.querySelectorAll('.touch-sort-btn').forEach(btn => {
        btn.addEventListener('click', handleTouchControl);
    });

    updateHistoryControlState();
}

function handleTouchControl(e) {
    if (!ManualSortState.active) return;
    
    const btn = e.currentTarget;
    const key = btn.dataset.key;
    const action = btn.dataset.action;
    
    if (key) {
        performMove(key);
    } else if (action) {
        switch (action) {
            case 'undo':
                undoLastAction();
                break;
            case 'redo':
                redoLastAction();
                break;
            case 'skip':
                performSkip();
                break;
            case 'exit':
                exitSorting();
                break;
        }
    }
}

// Redo functionality
async function redoLastAction() {
    const { API, showToast } = window.App;

    try {
        const result = await API.sortAction('redo');

        if (result.status === 'no_redo') {
            updateHistoryControlState(result);
            showToast(manualSortText('manual.redoEmpty', 'Nothing to redo', '没有可重做的操作'), 'info');
            return;
        }

        if (result.error) {
            updateHistoryControlState(result);
            showToast(result.error, 'error');
            return;
        }

        window.AudioManager?.play('move');
        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);

        await loadCurrentImage(result);

        if (result.redone_action === 'move' && result.folder_key) {
            showToast(
                formatManualSortI18n(
                    getManualSortOperationMode() === 'copy' ? 'manual.redoCopy' : 'manual.redoMove',
                    getManualSortOperationMode() === 'copy' ? 'Redid copy to {key}' : 'Redid move to {key}',
                    {
                    key: result.folder_key.toUpperCase(),
                    }
                ),
                'info'
            );
        } else {
            showToast(manualSortText('manual.redoSkip', 'Redid skip', '已重做跳过'), 'info');
        }
    } catch (error) {
        Logger.error('Failed to redo:', error);
        showToast(manualSortText('manual.redoFailed', 'Failed to redo', '重做失败'), 'error');
    }
}

// Export touch control functions
window.createTouchControls = createTouchControls;
window.redoLastAction = redoLastAction;
