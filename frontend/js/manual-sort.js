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
    // v3.3.1: per-slot collection ids ({ key: collectionId|null }). A slot with
    // a non-null id is "collection-typed": pressing it adds the current image to
    // that collection by reference (no file move) instead of moving the file.
    collectionSlots: { w: null, a: null, s: null, d: null },
    collectionsCache: [],
    operationMode: 'copy',
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
    // v3.3.0 USR-4: optional action cooldown (opt-in, default OFF). When > 0,
    // presses within the window after the previous action completes are
    // ignored so an autoclicker can't fire a chaotic burst. lastActionCompletedAt
    // is set in the finally block of performMove/performSkip.
    actionCooldownMs: 0,
    lastActionCompletedAt: 0,
    // v3.3.2 WB-S3: active session mode. "slot" = WASD folder sort (default);
    // "bracket" = A/B king-of-the-hill culling. Set from the server's
    // result.mode so a resumed session renders the right interface.
    mode: 'slot',
};

const MANUAL_SORT_COOLDOWN_KEY = 'manual_sort_cooldown_ms_v1';
// v3.3.2 WB-S3: remembers the mode chosen in the setup screen across reloads.
const MANUAL_SORT_MODE_KEY = 'manual_sort_mode_v1';
const MANUAL_SORT_MODES = new Set(['slot', 'bracket', 'cull']);
// v3.3.2 WB-S6: remembers the A/B Showdown winner destination ('' none,
// 'fav' Favorites, or a collection id).
const MANUAL_SORT_BRACKET_WINNER_KEY = 'manual_sort_bracket_winner_v1';
// v3.3.2 FF-1: remembers the 留/汰 cull keep/reject destinations (same value
// space as the bracket winner: '' none, 'fav' Favorites, or a collection id).
const MANUAL_SORT_CULL_KEEP_KEY = 'manual_sort_cull_keep_v1';
const MANUAL_SORT_CULL_REJECT_KEY = 'manual_sort_cull_reject_v1';

const MANUAL_SORT_FILTER_STATE_KEY = 'manual_sort_filter_state_v1';
const MANUAL_SORT_SCOPE_META_KEY = 'manual_sort_scope_meta_v1';
const MANUAL_SORT_OPERATION_MODE_KEY = 'manual_sort_operation_mode_v1';
// v3.3.1: persists per-slot collection assignments ({ key: collectionId|null }).
const MANUAL_SORT_SLOT_COLLECTIONS_KEY = 'manual_sort_slot_collections_v1';
const MANUAL_SORT_SLOT_KEYS = ['w', 'a', 's', 'd'];
// Aurora Phase 3 Slice 2 — Sort enhancements.
// Focus (zen) mode preference: collapse the app chrome during a slot session.
const MANUAL_SORT_ZEN_KEY = 'manual_sort_zen_v1';
// Named full-config presets (folders + collection slots + slot layout + mode +
// action + filters). Array of { name, savedAt, mode, operationMode, filters,
// collectionSlots, folders }.
const MANUAL_SORT_PRESETS_KEY = 'manual_sort_presets_v1';
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

// ============== Workbench Mode (v3.3.2 WB-S3) ==============

// The mode selected on the setup screen for the NEXT session. Persisted so the
// choice survives reloads. ManualSortState.mode tracks the ACTIVE session's mode.
function getManualSortSelectedMode() {
    try {
        const stored = localStorage.getItem(MANUAL_SORT_MODE_KEY);
        if (stored && MANUAL_SORT_MODES.has(stored)) return stored;
    } catch (_) { /* ignore storage errors */ }
    return 'slot';
}

// The start-button label depends on the chosen mode. Shares its shape with
// ui-refresh.js (whose MutationObserver re-applies the label after rebuilding
// the button), so both must agree on the per-mode text.
function getManualSortStartLabel(mode) {
    if (mode === 'bracket') return manualSortText('manual.startShowdown', 'Start Showdown', '开始擂台');
    if (mode === 'cull') return manualSortText('manual.startCulling', 'Start Culling', '开始留汰');
    return manualSortText('manual.startSorting', 'Start Sorting', '开始排序');
}

// Reflect the chosen mode in the setup UI: highlight the button, toggle the
// slot-only vs bracket-only vs cull-only blocks, and relabel the start button.
// Never touches an active session (mode is locked once sorting starts).
function setManualSortSelectedMode(mode, { persist = true } = {}) {
    const normalized = MANUAL_SORT_MODES.has(mode) ? mode : 'slot';
    if (persist) {
        try { localStorage.setItem(MANUAL_SORT_MODE_KEY, normalized); } catch (_) { /* ignore */ }
    }

    document.querySelectorAll('.sort-mode-btn[data-sort-mode]').forEach((btn) => {
        const isActive = btn.dataset.sortMode === normalized;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
    });

    document.querySelectorAll('.sort-slot-only').forEach((el) => {
        el.style.display = normalized === 'slot' ? '' : 'none';
    });
    document.querySelectorAll('.sort-bracket-only').forEach((el) => {
        el.style.display = normalized === 'bracket' ? '' : 'none';
    });
    document.querySelectorAll('.sort-cull-only').forEach((el) => {
        el.style.display = normalized === 'cull' ? '' : 'none';
    });

    // ui-refresh.js may rebuild the start button into
    // <span>🎮</span><span class="ui-label">…</span>, stripping the original
    // id/data-i18n — so fall back to the normalized label span.
    const startBtn = document.getElementById('btn-start-sorting');
    const startLabel = document.getElementById('sort-start-label')
        || (startBtn && (startBtn.querySelector('.ui-label') || startBtn.querySelector('[data-i18n]')));
    if (startLabel) {
        startLabel.textContent = getManualSortStartLabel(normalized);
    }
}

function bindManualSortModeSwitch() {
    document.querySelectorAll('.sort-mode-btn[data-sort-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            // Locking the mode mid-session would desync the UI from the server.
            if (ManualSortState.active) return;
            setManualSortSelectedMode(btn.dataset.sortMode);
        });
    });
    // Restore the persisted choice on load.
    setManualSortSelectedMode(getManualSortSelectedMode(), { persist: false });
}

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
    const v = window.I18n?.t?.(key, replacements);
    const raw = (v && v !== key) ? v : fallback;
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        raw
    );
}

// Like formatManualSortI18n but with an explicit zh fallback, so a key that is
// not yet in the lang files still localizes correctly before token replacement.
function formatManualSortText(key, enText, zhText, replacements = {}) {
    return Object.entries(replacements).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        manualSortText(key, enText, zhText)
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

// ============== Collection Slots (v3.3.1) ==============

function loadManualSortSlotCollections() {
    const slots = { w: null, a: null, s: null, d: null };
    try {
        const raw = localStorage.getItem(MANUAL_SORT_SLOT_COLLECTIONS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            MANUAL_SORT_SLOT_KEYS.forEach((key) => {
                const value = Number(parsed[key]);
                slots[key] = Number.isInteger(value) && value > 0 ? value : null;
            });
        }
    } catch (_) {
        // Ignore corrupt saved state; fall back to all-folder slots.
    }
    ManualSortState.collectionSlots = slots;
}

function saveManualSortSlotCollections() {
    localStorage.setItem(
        MANUAL_SORT_SLOT_COLLECTIONS_KEY,
        JSON.stringify(ManualSortState.collectionSlots || {})
    );
}

function isManualSortCollectionSlot(key) {
    const id = ManualSortState.collectionSlots?.[key];
    return Number.isInteger(id) && id > 0;
}

function getManualSortCollectionName(collectionId) {
    const match = (ManualSortState.collectionsCache || []).find((c) => c.id === collectionId);
    return match ? match.name : '';
}

// Build the non-folder ({ key: collectionId }) map to send to the backend.
function getManualSortActiveCollectionSlots() {
    const out = {};
    MANUAL_SORT_SLOT_KEYS.forEach((key) => {
        out[key] = isManualSortCollectionSlot(key) ? ManualSortState.collectionSlots[key] : null;
    });
    return out;
}

function populateManualSortCollectionSelects() {
    const selects = document.querySelectorAll('.slot-collection-select');
    if (!selects.length) return;
    const placeholder = manualSortText('manual.collectChoose', 'Choose a collection…', '选择一个收藏夹…');
    const options = (ManualSortState.collectionsCache || [])
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join('');
    selects.forEach((select) => {
        const key = select.dataset.key;
        select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
        const assigned = ManualSortState.collectionSlots?.[key];
        select.value = isManualSortCollectionSlot(key) ? String(assigned) : '';
    });
}

// v3.3.2 WB-S6: A/B Showdown winner destination selector. '' = don't save,
// 'fav' = Favorites, otherwise a collection id. Persisted across reloads.
function getBracketWinnerDest() {
    try {
        const stored = localStorage.getItem(MANUAL_SORT_BRACKET_WINNER_KEY);
        if (stored != null) return stored;
    } catch (_) { /* ignore */ }
    return '';
}

function populateBracketWinnerSelect() {
    const select = document.getElementById('bracket-winner-collection');
    if (!select) return;
    const none = manualSortText('manual.bracketWinnerNone', "Don't save", '不收藏');
    const fav = manualSortText('manual.bracketWinnerFav', '♥ Favorites', '♥ 收藏');
    const options = (ManualSortState.collectionsCache || [])
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join('');
    select.innerHTML = `<option value="">${escapeHtml(none)}</option>`
        + `<option value="fav">${escapeHtml(fav)}</option>`
        + options;
    // Restore the saved choice if it still exists.
    const saved = getBracketWinnerDest();
    const valid = saved === '' || saved === 'fav'
        || (ManualSortState.collectionsCache || []).some((c) => String(c.id) === String(saved));
    select.value = valid ? saved : '';
}

// v3.3.2 FF-1: 留/汰 cull keep/reject destination selectors. Same value space
// as the bracket winner ('' = don't save, 'fav' = Favorites, else collection
// id). Keep defaults to Favorites; reject defaults to don't-save.
function getCullDest(which) {
    const key = which === 'reject' ? MANUAL_SORT_CULL_REJECT_KEY : MANUAL_SORT_CULL_KEEP_KEY;
    try {
        const stored = localStorage.getItem(key);
        if (stored != null) return stored;
    } catch (_) { /* ignore */ }
    return which === 'keep' ? 'fav' : '';
}

function populateCullDestSelect(which) {
    const select = document.getElementById(which === 'reject' ? 'cull-reject-collection' : 'cull-keep-collection');
    if (!select) return;
    const none = manualSortText('manual.bracketWinnerNone', "Don't save", '不收藏');
    const fav = manualSortText('manual.bracketWinnerFav', '♥ Favorites', '♥ 收藏');
    const options = (ManualSortState.collectionsCache || [])
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join('');
    select.innerHTML = `<option value="">${escapeHtml(none)}</option>`
        + `<option value="fav">${escapeHtml(fav)}</option>`
        + options;
    const saved = getCullDest(which);
    const valid = saved === '' || saved === 'fav'
        || (ManualSortState.collectionsCache || []).some((c) => String(c.id) === String(saved));
    select.value = valid ? saved : (which === 'keep' ? 'fav' : '');
}

function populateCullDestSelects() {
    populateCullDestSelect('keep');
    populateCullDestSelect('reject');
}

async function loadManualSortCollections() {
    try {
        const result = await window.App?.API?.listCollections?.();
        const list = Array.isArray(result?.collections) ? result.collections : [];
        ManualSortState.collectionsCache = list.map((c) => ({ id: Number(c.id), name: String(c.name || '') }));
    } catch (e) {
        ManualSortState.collectionsCache = [];
        if (window.Logger) Logger.warn('Failed to load collections for manual sort:', e);
    }
    // Drop any saved slot id that no longer exists so the UI never shows a
    // stale assignment.
    const validIds = new Set(ManualSortState.collectionsCache.map((c) => c.id));
    MANUAL_SORT_SLOT_KEYS.forEach((key) => {
        if (isManualSortCollectionSlot(key) && !validIds.has(ManualSortState.collectionSlots[key])) {
            ManualSortState.collectionSlots[key] = null;
        }
    });
    populateManualSortCollectionSelects();
    populateBracketWinnerSelect();
    populateCullDestSelects();
    MANUAL_SORT_SLOT_KEYS.forEach(refreshManualSortSlotUi);
}

// Toggle the folder-input vs collection-select for a slot based on its type.
function refreshManualSortSlotUi(key) {
    const slot = document.querySelector(`.slot-target[data-key="${key}"]`);
    if (!slot) return;
    const isCollection = isManualSortCollectionSlot(key);
    const explicitCollectionType = slot.querySelector('input[name="slot-type-' + key + '"][value="collection"]')?.checked;
    const showCollection = isCollection || Boolean(explicitCollectionType);

    const folderTarget = slot.querySelector('.slot-folder-target');
    const collectionSelect = slot.querySelector('.slot-collection-select');
    if (folderTarget) folderTarget.hidden = showCollection;
    if (collectionSelect) collectionSelect.hidden = !showCollection;

    const radios = slot.querySelectorAll(`input[name="slot-type-${key}"]`);
    radios.forEach((radio) => {
        radio.checked = showCollection ? radio.value === 'collection' : radio.value === 'folder';
    });
}

function initManualSortSlotControls() {
    document.querySelectorAll('input[name^="slot-type-"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const key = radio.dataset.key;
            if (!radio.checked || !key) return;
            if (radio.value === 'folder') {
                ManualSortState.collectionSlots[key] = null;
                saveManualSortSlotCollections();
            }
            refreshManualSortSlotUi(key);
            updateFolderNames();
        });
    });

    document.querySelectorAll('.slot-collection-select').forEach((select) => {
        select.addEventListener('change', () => {
            const key = select.dataset.key;
            const value = Number(select.value);
            ManualSortState.collectionSlots[key] = Number.isInteger(value) && value > 0 ? value : null;
            saveManualSortSlotCollections();
            refreshManualSortSlotUi(key);
            updateFolderNames();
        });
    });
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
        tagMode: source.tagMode === 'or' || source.tag_mode === 'or' ? 'or' : 'and',
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
        excludeTags: [...(source.excludeTags || [])],
        excludeGenerators: [...(source.excludeGenerators || [])],
        excludeRatings: [...(source.excludeRatings || [])],
        excludeCheckpoints: [...(source.excludeCheckpoints || [])],
        excludeLoras: [...(source.excludeLoras || [])],
        // v3.3.x gallery-scope parity (mirror App.cloneFilterState so the
        // no-App fallback can't silently drop scope fields).
        excludePrompts: [...(source.excludePrompts || [])],
        excludeColors: [...(source.excludeColors || [])],
        minUserRating: source.minUserRating ?? null,
        brightnessMin: source.brightnessMin ?? null,
        brightnessMax: source.brightnessMax ?? null,
        colorTemperature: source.colorTemperature || '',
        brightnessDistribution: source.brightnessDistribution || '',
        collectionId: source.collectionId ?? null,
        folder: source.folder ? String(source.folder).trim() : null,
        hasMetadata: typeof source.hasMetadata === 'boolean' ? source.hasMetadata : null,
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

// v3.3.x gallery-scope parity: bundle the scope fields (collection/folder/
// star-rating/exclude-prompts/colors/brightness) that the legacy positional
// startSortSession args never carried, so the WASD/bracket/cull session set
// equals what the gallery showed. Shared by all three start paths.
function buildManualSortScopeFilters(contract) {
    return {
        excludePrompts: contract.excludePrompts?.length > 0 ? contract.excludePrompts : null,
        excludeColors: contract.excludeColors?.length > 0 ? contract.excludeColors : null,
        minUserRating: contract.minUserRating || null,
        brightnessMin: contract.brightnessMin ?? null,
        brightnessMax: contract.brightnessMax ?? null,
        colorTemperature: contract.colorTemperature || null,
        brightnessDistribution: contract.brightnessDistribution || null,
        collectionId: contract.collectionId || null,
        folder: contract.folder || null,
        hasMetadata: typeof contract.hasMetadata === 'boolean' ? contract.hasMetadata : null,
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
    return manualSortText('nav.manual', 'Manual Sort', '手动排序');
}

// ============== Sort enhancements (Aurora Phase 3 Slice 2) ==============
//
// Three additive setup-screen conveniences: a live scoped image count above the
// Start button, a focus (zen) mode toggle on the sorting stage, and named
// full-config presets. All are localStorage-backed and never touch the server
// session shape.

// --- Live scoped image count ---------------------------------------------
// Only fetch when the manual-sort setup is actually on screen; the summary hook
// fires on init/languageChange even while the view is hidden.
function isManualSortSetupVisible() {
    const sortingView = document.getElementById('view-sorting');
    if (sortingView && !sortingView.classList.contains('active')) return false;
    const manualView = document.getElementById('view-manual');
    if (!manualView || manualView.style.display === 'none') return false;
    const setup = document.getElementById('sort-setup');
    if (!setup || setup.style.display === 'none') return false;
    return !ManualSortState.active;
}

let _manualSortScopeCountAbort = null;
let _manualSortScopeCountSeq = 0;

// Count how many images the current Manual Sort filters would pull in and show
// it above the Start button. Reuses the Gallery count endpoint + shared
// buildFilterQueryParams so the number matches what a session would enqueue.
// Best-effort: on any failure the row shows an unavailable note rather than a
// stale/false count. The `≈` framing keeps it honest (filters + moves race).
async function refreshManualSortScopeCount() {
    const wrap = document.getElementById('sort-scope-count');
    const text = document.getElementById('sort-scope-count-text');
    if (!wrap || !text) return;

    // Don't spend a request while the setup is off-screen.
    if (!isManualSortSetupVisible()) {
        wrap.hidden = true;
        return;
    }

    const API = window.App?.API;
    if (!API || typeof API.buildFilterQueryParams !== 'function') {
        wrap.hidden = true;
        return;
    }

    let params;
    try {
        params = API.buildFilterQueryParams(buildManualSortFilterContract(getManualSortFilters()));
    } catch (_) {
        wrap.hidden = true;
        return;
    }

    // Reflect a counting state immediately so a slow fetch never looks frozen.
    wrap.hidden = false;
    wrap.classList.add('is-counting');
    wrap.classList.remove('is-failed');
    text.textContent = manualSortText('manual.scopeCountCounting', 'Counting images…', '正在统计图片…');

    const seq = ++_manualSortScopeCountSeq;
    try {
        if (_manualSortScopeCountAbort) _manualSortScopeCountAbort.abort();
        _manualSortScopeCountAbort = new AbortController();
        const resp = await fetch(`/api/images/count?${params}`, { signal: _manualSortScopeCountAbort.signal });
        if (seq !== _manualSortScopeCountSeq) return; // a newer refresh superseded us
        if (!resp.ok) throw new Error(`count ${resp.status}`);
        const data = await resp.json();
        const total = Number(data?.total);
        wrap.classList.remove('is-counting');
        if (Number.isFinite(total) && total >= 0) {
            text.textContent = formatManualSortI18n('manual.scopeCount', '≈{count} images in scope', {
                count: total.toLocaleString(),
            });
        } else {
            // total < 0 is the count-skipped sentinel for very large libraries;
            // hide rather than print a nonsense number.
            wrap.hidden = true;
        }
    } catch (e) {
        if (e?.name === 'AbortError' || seq !== _manualSortScopeCountSeq) return;
        wrap.classList.remove('is-counting');
        wrap.classList.add('is-failed');
        text.textContent = manualSortText('manual.scopeCountFailed', 'Count unavailable', '无法统计数量');
    }
}

// --- Focus (zen) mode -----------------------------------------------------
function getManualSortZenPref() {
    try { return localStorage.getItem(MANUAL_SORT_ZEN_KEY) === '1'; } catch (_) { return false; }
}

// Collapse the app chrome for a distraction-free WASD stage. A single
// html.sort-zen class does the work in CSS (--nav-height:0 + hidden top bar);
// the preference persists so the next session remembers it.
function applyManualSortZen(on, { persist = true } = {}) {
    const enabled = !!on;
    document.documentElement.classList.toggle('sort-zen', enabled);
    if (persist) {
        try { localStorage.setItem(MANUAL_SORT_ZEN_KEY, enabled ? '1' : '0'); } catch (_) { /* ignore */ }
    }
    const btn = document.getElementById('btn-sort-zen');
    if (btn) {
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        btn.classList.toggle('is-active', enabled);
        btn.title = enabled
            ? manualSortText('manual.zenExit', 'Exit focus mode', '退出专注模式')
            : manualSortText('manual.zenEnter', 'Focus mode', '专注模式');
    }
}

// Visual-only strip used when leaving the stage — never clears the saved
// preference, so re-entering a session restores the chosen focus state.
function clearManualSortZen() {
    document.documentElement.classList.remove('sort-zen');
}

// Repaint the on-stage mute button from the live AudioManager state. Module-level
// so it can re-sync on stage entry — the global Settings sound toggle mutates
// AudioManager without notifying this button, which would otherwise show a stale
// icon/aria-pressed until its own next click.
function syncSortMuteButton() {
    const muteBtn = document.getElementById('btn-sort-mute');
    const muteIcon = document.getElementById('sort-mute-icon');
    if (!muteBtn) return;
    const on = window.AudioManager ? window.AudioManager.enabled !== false : true;
    if (muteIcon) muteIcon.textContent = on ? '🔊' : '🔇';
    muteBtn.setAttribute('aria-pressed', on ? 'false' : 'true');
    muteBtn.title = on
        ? manualSortText('manual.muteSounds', 'Mute sort sounds', '静音排序音效')
        : manualSortText('manual.unmuteSounds', 'Unmute sort sounds', '取消静音');
}

// --- Named full-config presets -------------------------------------------
function getManualSortPresets() {
    try {
        const parsed = JSON.parse(localStorage.getItem(MANUAL_SORT_PRESETS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.name === 'string') : [];
    } catch (_) {
        return [];
    }
}

function saveManualSortPresets(list) {
    try { localStorage.setItem(MANUAL_SORT_PRESETS_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
}

// Snapshot everything the setup screen holds. Folder paths read straight from
// the DOM inputs (the source of truth for folder-typed slots); slots/filters/
// mode/action come from state.
function captureManualSortPreset(name) {
    const folders = {};
    document.querySelectorAll('.folder-path-input').forEach((input) => {
        const key = input.dataset.key;
        const value = (input.value || '').trim();
        if (key && value) folders[key] = value;
    });
    return {
        name,
        mode: getManualSortSelectedMode(),
        operationMode: getManualSortOperationMode(),
        filters: serializeManualSortFilters(getManualSortFilters()),
        collectionSlots: { ...(ManualSortState.collectionSlots || {}) },
        folders,
    };
}

// Restore a captured preset into the live setup and repaint every derived UI.
function applyManualSortPreset(preset) {
    if (!preset) return;

    setManualSortFilters(preset.filters || {});
    markManualSortScopeCustomized();

    // Collection slots — drop ids that no longer exist so the UI can't show a
    // ghost assignment.
    const validIds = new Set((ManualSortState.collectionsCache || []).map((c) => c.id));
    const slots = {};
    MANUAL_SORT_SLOT_KEYS.forEach((key) => {
        const id = preset.collectionSlots?.[key];
        slots[key] = Number.isInteger(id) && id > 0 && validIds.has(id) ? id : null;
    });
    ManualSortState.collectionSlots = slots;
    saveManualSortSlotCollections();

    // Folder inputs + persisted per-slot folder paths.
    document.querySelectorAll('.folder-path-input').forEach((input) => {
        const key = input.dataset.key;
        const value = preset.folders?.[key] || '';
        input.value = value;
        ManualSortState.folders[key] = value;
        try { localStorage.setItem(`sort-folder-${key}`, value); } catch (_) { /* ignore */ }
    });

    setManualSortSelectedMode(preset.mode || 'slot');
    setManualSortOperationMode(preset.operationMode || 'copy', { persist: true, updateUi: true });

    // Reset each slot's folder/collection radio to match the preset BEFORE
    // refreshing the slot UI. refreshManualSortSlotUi reads the LIVE radio state
    // (explicitCollectionType), so a slot still checked "collection" from a
    // previous preset would otherwise hide the restored folder path behind an
    // empty collection dropdown.
    MANUAL_SORT_SLOT_KEYS.forEach((key) => {
        const isCollection = Number.isInteger(slots[key]) && slots[key] > 0;
        document.querySelectorAll(`input[name="slot-type-${key}"]`).forEach((radio) => {
            radio.checked = isCollection ? radio.value === 'collection' : radio.value === 'folder';
        });
    });

    populateManualSortCollectionSelects();
    MANUAL_SORT_SLOT_KEYS.forEach(refreshManualSortSlotUi);
    if (typeof updateFolderNames === 'function') updateFolderNames();
    updateManualSortFilterSummary();
}

// Rebuild the preset <select> with DOM methods (the security hook blocks
// innerHTML). Keeps the current selection if it still exists.
function populateManualSortPresetSelect() {
    const select = document.getElementById('sort-preset-select');
    if (!select) return;
    const presets = getManualSortPresets();
    const prev = select.value;
    while (select.firstChild) select.removeChild(select.firstChild);

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = presets.length
        ? manualSortText('manual.presetChoose', 'Choose a preset…', '选择预设…')
        : manualSortText('manual.presetNone', 'No saved presets', '暂无预设');
    select.appendChild(placeholder);

    presets.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        select.appendChild(opt);
    });

    if (prev && presets.some((p) => p.name === prev)) select.value = prev;
    const del = document.getElementById('btn-sort-preset-delete');
    if (del) del.disabled = presets.length === 0;
}

async function handleManualSortPresetSave() {
    const raw = await window.App.showInputModal(
        manualSortText('manual.presetSaveTitle', 'Save Sort Preset', '保存排序预设'),
        manualSortText(
            'manual.presetSavePrompt',
            'Name this preset. It stores the folders/collections, slot layout, mode, action, and filters currently set here.',
            '给这套预设取个名字。它会记住当前的文件夹/收藏夹、槽位布局、模式、动作和筛选。'
        ),
        ''
    );
    if (raw == null) return; // cancelled
    const name = raw.trim();
    if (!name) {
        window.App.showToast(manualSortText('manual.presetNameRequired', 'Enter a preset name', '请输入预设名称'), 'error');
        return;
    }

    const presets = getManualSortPresets();
    const existingIdx = presets.findIndex((p) => p.name === name);
    if (existingIdx >= 0) {
        const ok = await new Promise((resolve) => {
            window.App.showConfirm(
                manualSortText('manual.presetOverwriteTitle', 'Replace Preset', '覆盖预设'),
                formatManualSortI18n('manual.presetOverwrite', 'A preset named "{name}" already exists. Replace it?', { name }),
                () => resolve(true),
                () => resolve(false)
            );
        });
        if (!ok) return;
        presets[existingIdx] = captureManualSortPreset(name);
    } else {
        presets.push(captureManualSortPreset(name));
    }
    saveManualSortPresets(presets);
    populateManualSortPresetSelect();
    const select = document.getElementById('sort-preset-select');
    if (select) select.value = name;
    window.App.showToast(formatManualSortI18n('manual.presetSaved', 'Preset "{name}" saved', { name }), 'success');
}

function handleManualSortPresetLoad() {
    const name = document.getElementById('sort-preset-select')?.value || '';
    if (!name) {
        window.App.showToast(manualSortText('manual.presetPickFirst', 'Choose a preset to load first', '请先选择要载入的预设'), 'info');
        return;
    }
    const preset = getManualSortPresets().find((p) => p.name === name);
    if (!preset) return;
    applyManualSortPreset(preset);
    window.App.showToast(formatManualSortI18n('manual.presetLoaded', 'Preset "{name}" loaded', { name }), 'success');
}

async function handleManualSortPresetDelete() {
    const name = document.getElementById('sort-preset-select')?.value || '';
    if (!name) {
        window.App.showToast(manualSortText('manual.presetPickFirst', 'Choose a preset to load first', '请先选择要载入的预设'), 'info');
        return;
    }
    const ok = await new Promise((resolve) => {
        window.App.showConfirm(
            manualSortText('manual.presetDeleteTitle', 'Delete Preset', '删除预设'),
            formatManualSortI18n('manual.presetDeleteConfirm', 'Delete the preset "{name}"? This cannot be undone.', { name }),
            () => resolve(true),
            () => resolve(false)
        );
    });
    if (!ok) return;
    saveManualSortPresets(getManualSortPresets().filter((p) => p.name !== name));
    populateManualSortPresetSelect();
    window.App.showToast(formatManualSortI18n('manual.presetDeleted', 'Preset "{name}" deleted', { name }), 'success');
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
        tagMode: contract.tagMode || 'and',
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
        excludeTags: contract.excludeTags || [],
        excludeGenerators: contract.excludeGenerators || [],
        excludeRatings: contract.excludeRatings || [],
        excludeCheckpoints: contract.excludeCheckpoints || [],
        excludeLoras: contract.excludeLoras || [],
        // v3.3.x scope fields — keep the fallback signature honest about
        // collection/folder/rating/exclude differences vs the gallery.
        excludePrompts: contract.excludePrompts || [],
        excludeColors: contract.excludeColors || [],
        minUserRating: contract.minUserRating ?? null,
        brightnessMin: contract.brightnessMin ?? null,
        brightnessMax: contract.brightnessMax ?? null,
        colorTemperature: contract.colorTemperature || '',
        brightnessDistribution: contract.brightnessDistribution || '',
        collectionId: contract.collectionId ?? null,
        folder: contract.folder || null,
        hasMetadata: contract.hasMetadata ?? null,
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
    const mode = MANUAL_SORT_MODES.has(session?.mode) ? session.mode : 'slot';
    const remaining = Number(session?.remaining || 0);
    ManualSortState.resumeBannerSessionSnapshot = {
        mode,
        remaining,
        // Resumed sessions keep whatever mode they were started with;
        // default for a brand-new session is 'copy' (Principle #11).
        operation_mode: session?.operation_mode || 'copy',
        folders: { ...(session?.folders || {}) },
    };

    const countEl = banner.querySelector('.resume-count');
    if (countEl) {
        if (mode === 'bracket') {
            countEl.textContent = formatManualSortText('manual.resumeBracketRemaining', '{count} comparisons left', '还剩 {count} 场对决', { count: remaining });
        } else if (mode === 'cull') {
            countEl.textContent = formatManualSortText('manual.resumeCullRemaining', '{count} images left to judge', '还有 {count} 张待筛选', { count: remaining });
        } else {
            countEl.textContent = formatManualSortI18n('manual.imagesRemaining', '{count} images remaining', { count: remaining });
        }
    }

    // Action mode + destination folders only apply to the slot (WASD) flow.
    // Bracket and cull are folder-free and non-destructive, so hide those lines
    // instead of showing meaningless "folders: none" / copy-mode text.
    const slotOnly = mode === 'slot';
    const operationEl = banner.querySelector('.resume-operation');
    if (operationEl) {
        operationEl.style.display = slotOnly ? '' : 'none';
        if (slotOnly) {
            const modeLabel = getManualSortOperationLabel(session?.operation_mode || 'copy');
            operationEl.textContent = formatManualSortI18n(
                'manual.resumeOperationMode',
                'Saved session action mode: {mode}',
                { mode: modeLabel }
            );
        }
    }

    const foldersEl = banner.querySelector('.resume-folders');
    if (foldersEl) {
        foldersEl.style.display = slotOnly ? '' : 'none';
        if (slotOnly) {
            foldersEl.textContent = formatManualSortI18n(
                'manual.resumeFolderSummary',
                'Saved session folders: {summary}',
                { summary: summarizeManualSortFolders(session?.folders || {}) }
            );
        }
    }
}

// ============== Initialization ==============

// v3.3.0 USR-4: wire the opt-in action-cooldown controls and restore the
// persisted value. Default is OFF (0 ms) so existing users see no change.
function initManualSortCooldownControls($) {
    const toggle = $('#manual-sort-cooldown-toggle');
    const slider = $('#manual-sort-cooldown-ms');
    const valueLabel = $('#manual-sort-cooldown-value');
    const row = $('#manual-sort-cooldown-row');
    if (!toggle || !slider) return;

    const savedMs = Number(localStorage.getItem(MANUAL_SORT_COOLDOWN_KEY) || 0) || 0;
    const enabled = savedMs > 0;
    toggle.checked = enabled;
    if (enabled) slider.value = String(savedMs);
    if (row) row.style.display = enabled ? 'flex' : 'none';
    ManualSortState.actionCooldownMs = enabled ? Number(slider.value) || 0 : 0;
    if (valueLabel) valueLabel.textContent = `${slider.value} ms`;

    const persist = () => {
        const ms = toggle.checked ? (Number(slider.value) || 0) : 0;
        ManualSortState.actionCooldownMs = ms;
        localStorage.setItem(MANUAL_SORT_COOLDOWN_KEY, String(ms));
    };

    toggle.addEventListener('change', () => {
        if (row) row.style.display = toggle.checked ? 'flex' : 'none';
        persist();
    });
    slider.addEventListener('input', () => {
        if (valueLabel) valueLabel.textContent = `${slider.value} ms`;
        if (toggle.checked) persist();
    });
}

async function initManualSort() {
    // Use direct selectors to avoid timing issues with window.App
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);
    loadManualSortFilters();
    loadManualSortScopeMeta();
    loadManualSortSlotCollections();
    setManualSortOperationMode(localStorage.getItem(MANUAL_SORT_OPERATION_MODE_KEY) || 'copy', {
        persist: false,
        updateUi: true,
    });
    updateManualSortFilterSummary();
    initManualSortCooldownControls($);
    initManualSortSlotControls();
    // Populate the collection <select>s from the API (best-effort; folder slots
    // keep working even if this fails).
    loadManualSortCollections();

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
                    titleText: manualSortText('manual.filterTitle', 'Manual Sort Filters', '手动排序筛选'),
                    applyButtonText: manualSortText('manual.applyFilters', 'Apply to Manual Sort', '应用到手动排序'),
                    resetButtonText: manualSortText('manual.resetFilters', 'Reset Manual Sort Filters', '重置手动排序筛选'),
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

    // v3.3.2 WB-S3: Workbench mode switch + A/B Showdown (bracket) controls.
    bindManualSortModeSwitch();
    // Fighter-image clicks pick — unless sync-zoom is on, where a click should
    // inspect (the dedicated 选 A/选 B buttons + keyboard still pick).
    const championFighter = $('#bracket-champion');
    const challengerFighter = $('#bracket-challenger');
    championFighter?.addEventListener('click', () => { if (!ManualSortState.bracketZoom) performBracketAction('champion'); });
    challengerFighter?.addEventListener('click', () => { if (!ManualSortState.bracketZoom) performBracketAction('challenger'); });
    $('#bracket-btn-champion')?.addEventListener('click', () => performBracketAction('champion'));
    $('#bracket-btn-challenger')?.addEventListener('click', () => performBracketAction('challenger'));
    $('#bracket-btn-skip')?.addEventListener('click', () => performBracketAction('skip'));
    $('#bracket-btn-undo')?.addEventListener('click', () => performBracketAction('undo'));
    $('#bracket-btn-redo')?.addEventListener('click', () => performBracketAction('redo'));
    $('#bracket-btn-exit')?.addEventListener('click', exitSorting);

    // v3.3.2 WB-S6: remember the showdown winner destination.
    $('#bracket-winner-collection')?.addEventListener('change', (e) => {
        try { localStorage.setItem(MANUAL_SORT_BRACKET_WINNER_KEY, e.target.value || ''); } catch (_) { /* ignore */ }
    });

    // v3.3.2 WB-S5: synchronized pixel-peep zoom.
    $('#bracket-btn-zoom')?.addEventListener('click', () => setBracketZoomActive(!ManualSortState.bracketZoom));
    [championFighter, challengerFighter].forEach((fighter) => {
        if (!fighter) return;
        fighter.addEventListener('mousemove', handleBracketZoomMove);
        fighter.addEventListener('mouseleave', () => { if (ManualSortState.bracketZoom) applyBracketZoom(null, null); });
    });

    // v3.3.2 FF-1: 留/汰 Keep-Reject cull controls.
    $('#cull-btn-keep')?.addEventListener('click', () => performCullAction('keep'));
    $('#cull-btn-reject')?.addEventListener('click', () => performCullAction('reject'));
    $('#cull-btn-skip')?.addEventListener('click', () => performCullAction('skip'));
    $('#cull-btn-undo')?.addEventListener('click', () => performCullAction('undo'));
    $('#cull-btn-redo')?.addEventListener('click', () => performCullAction('redo'));
    $('#cull-btn-exit')?.addEventListener('click', exitSorting);
    $('#cull-keep-collection')?.addEventListener('change', (e) => {
        try { localStorage.setItem(MANUAL_SORT_CULL_KEEP_KEY, e.target.value || ''); } catch (_) { /* ignore */ }
    });
    $('#cull-reject-collection')?.addEventListener('change', (e) => {
        try { localStorage.setItem(MANUAL_SORT_CULL_REJECT_KEY, e.target.value || ''); } catch (_) { /* ignore */ }
    });

    // Exit sorting button
    const exitBtn = $('#btn-exit-sorting');
    if (exitBtn) {
        exitBtn.addEventListener('click', exitSorting);
    }

    // On-stage sound mute toggle — silences the sort SFX without leaving the
    // stage. Wires to the same AudioManager singleton + sort-audio-enabled key
    // as the global Settings toggle. syncSortMuteButton() is module-level so
    // activateSortingUi can re-sync it on stage entry (the global Settings
    // toggle mutates AudioManager without notifying this button).
    const muteBtn = $('#btn-sort-mute');
    if (muteBtn) {
        syncSortMuteButton();
        muteBtn.addEventListener('click', () => {
            if (window.AudioManager?.toggle) window.AudioManager.toggle();
            syncSortMuteButton();
        });
    }

    // Focus (zen) mode toggle — hides the top nav bar for the WASD stage.
    const zenBtn = $('#btn-sort-zen');
    if (zenBtn) {
        // Reflect the persisted preference on the button without touching the
        // class yet (the class only applies once a session is active).
        applyManualSortZen(getManualSortZenPref(), { persist: false });
        clearManualSortZen();
        zenBtn.addEventListener('click', () => {
            applyManualSortZen(!document.documentElement.classList.contains('sort-zen'));
        });
    }

    // Named full-config preset bar (save / load / delete).
    populateManualSortPresetSelect();
    $('#btn-sort-preset-save')?.addEventListener('click', handleManualSortPresetSave);
    $('#btn-sort-preset-load')?.addEventListener('click', handleManualSortPresetLoad);
    $('#btn-sort-preset-delete')?.addEventListener('click', handleManualSortPresetDelete);
    // Double-clicking a name in the list is a fast load.
    $('#sort-preset-select')?.addEventListener('dblclick', handleManualSortPresetLoad);

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
                    '要删除已保存的手动排序会话，并丢失剩余进度吗？此操作无法撤销。'
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
        if (session && !session.done && (session.image || session.champion)) {
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
            index: Number(savedSession.index ?? savedSession.challenger_index ?? 0) + 1,
            total: Number(savedSession.total || 0),
            remaining: Number(savedSession.remaining || 0),
        }
    );

    return new Promise(resolve => {
        window.App.showConfirm(
            manualSortText('manual.resumeInsteadTitle', 'Resume saved Manual Sort session?', '恢复已保存的手动排序会话？'),
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
    // v3.3.2 WB-S3: A/B Showdown uses a separate, folder-free start path so the
    // slot (WASD) flow below stays exactly as it was.
    if (getManualSortSelectedMode() === 'bracket') {
        return startBracketSorting();
    }
    // v3.3.2 FF-1: 留/汰 cull is also folder-free and non-destructive.
    if (getManualSortSelectedMode() === 'cull') {
        return startCullSorting();
    }

    const { $, $$, API, showToast } = window.App;
    const operationMode = getManualSortOperationMode();
    const operationLabel = getManualSortOperationLabel(operationMode);

    try {
        const savedSession = await API.getCurrentSortImage();
        if (savedSession && !savedSession.done && (savedSession.image || savedSession.champion)) {
            await confirmResumeSavedSessionFromStart(savedSession);
            return;
        }
    } catch (error) {
        if (window.Logger) Logger.warn('Failed to check existing sort session before start:', error);
    }

    // Collect folder paths (folder-typed slots only).
    const folders = {};
    $$('.folder-path-input').forEach(input => {
        const key = input.dataset.key;
        if (input.value.trim() && !isManualSortCollectionSlot(key)) {
            folders[key] = input.value.trim();
        }
    });

    // v3.3.1: collection-typed slots ({ key: collectionId }).
    const collectionSlots = getManualSortActiveCollectionSlots();
    const hasCollectionSlot = MANUAL_SORT_SLOT_KEYS.some((key) => isManualSortCollectionSlot(key));

    // Validate at least one destination (folder OR collection).
    if (Object.keys(folders).length === 0 && !hasCollectionSlot) {
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
        // Set folders + collection slots on server
        await API.setSortFolders(folders, collectionSlots);

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
            f.tagMode,
            {
                tags: f.excludeTags?.length > 0 ? f.excludeTags : null,
                generators: f.excludeGenerators?.length > 0 ? f.excludeGenerators : null,
                ratings: f.excludeRatings?.length > 0 ? f.excludeRatings : null,
                checkpoints: f.excludeCheckpoints?.length > 0 ? f.excludeCheckpoints : null,
                loras: f.excludeLoras?.length > 0 ? f.excludeLoras : null,
            },
            collectionSlots,
            'slot',
            buildManualSortScopeFilters(f),
        );

        if (result.total_images === 0) {
            showToast(
                manualSortText('manual.noImages', 'No images match Manual Sort filters', '没有图片匹配手动排序筛选'),
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
                tagMode: f.tagMode,
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
                excludeTags: f.excludeTags?.length > 0 ? f.excludeTags : null,
                excludeGenerators: f.excludeGenerators?.length > 0 ? f.excludeGenerators : null,
                excludeRatings: f.excludeRatings?.length > 0 ? f.excludeRatings : null,
                excludeCheckpoints: f.excludeCheckpoints?.length > 0 ? f.excludeCheckpoints : null,
                excludeLoras: f.excludeLoras?.length > 0 ? f.excludeLoras : null,
                // v3.3.x gallery-scope parity: the minimap preview must show
                // the same set the session will actually iterate.
                ...buildManualSortScopeFilters(f),
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
        const nameEl = $(`#folder-name-${key}`);
        if (!nameEl) return;

        // v3.3.1: collection-typed slots show the collection name + a hint that
        // the action adds by reference (the file is not moved).
        if (isManualSortCollectionSlot(key)) {
            const name = getManualSortCollectionName(ManualSortState.collectionSlots[key]);
            const label = name || manualSortText('manual.collectSlotFallback', 'Collection', '收藏夹');
            nameEl.textContent = `★ ${label}`;
            nameEl.title = formatManualSortI18n(
                'manual.collectHint',
                'Adds to “{name}” by reference — the file is not moved.',
                { name: label }
            );
            return;
        }

        nameEl.title = '';
        const path = ManualSortState.folders[key];
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

// v3.3.2 WB-S3: hide both the slot and bracket interfaces (used by
// finish/exit/rollback so neither lingers when returning to setup).
function hideSortInterfaces() {
    const { $ } = window.App;
    const slot = $('#sort-interface');
    if (slot) slot.style.display = 'none';
    const bracket = $('#sort-bracket-interface');
    if (bracket) bracket.style.display = 'none';
    const cull = $('#sort-cull-interface');
    if (cull) cull.style.display = 'none';
    // Leaving any stage always restores the app chrome (focus mode is a
    // stage-only affordance; the saved preference survives for next time).
    clearManualSortZen();
}

function activateSortingUi(mode = 'slot') {
    const { $ } = window.App;
    ManualSortState.active = true;
    ManualSortState.mode = MANUAL_SORT_MODES.has(mode) ? mode : 'slot';
    document.removeEventListener('keydown', handleSortKeypress);
    document.addEventListener('keydown', handleSortKeypress);
    $('#sort-setup').style.display = 'none';
    hideSortInterfaces();
    if (ManualSortState.mode === 'bracket') {
        $('#sort-bracket-interface').style.display = 'flex';
    } else if (ManualSortState.mode === 'cull') {
        $('#sort-cull-interface').style.display = 'flex';
    } else {
        $('#sort-interface').style.display = 'flex';
        // Restore the chosen focus state for the WASD stage (the toggle lives
        // in this HUD). hideSortInterfaces() above already cleared it.
        applyManualSortZen(getManualSortZenPref(), { persist: false });
    }
    // Re-sync the HUD mute button — the global Settings toggle may have changed
    // AudioManager since this button was last painted.
    syncSortMuteButton();
    updateHistoryControlState();
}

function rollbackSortingUi() {
    const { $ } = window.App;
    ManualSortState.active = false;
    document.removeEventListener('keydown', handleSortKeypress);
    hideSortInterfaces();
    $('#sort-setup').style.display = 'block';
    updateHistoryControlState({ undo_available: false, redo_available: false });
}

function applyCurrentSortPayload(result, options = {}) {
    // v3.3.2 WB-S3: bracket sessions render the A/B interface instead of the
    // single-image slot view. Keeps the slot path below byte-identical.
    if (result?.mode === 'bracket') {
        return applyBracketPayload(result, options);
    }
    if (result?.mode === 'cull') {
        return applyCullPayload(result, options);
    }

    const { $, API } = window.App;
    const { cacheBust = false } = options;

    if (result?.operation_mode) {
        setManualSortOperationMode(result.operation_mode, { persist: true, updateUi: true });
    }

    if (result?.folders && typeof result.folders === 'object') {
        ManualSortState.folders = { ...ManualSortState.folders, ...result.folders };
        restoreFolderInputs();
    }

    // v3.3.1: adopt the session's per-slot collection assignments so a resumed
    // session keeps its collection-typed slots (and the legend/labels match).
    if (result?.collection_slots && typeof result.collection_slots === 'object') {
        MANUAL_SORT_SLOT_KEYS.forEach((key) => {
            const value = Number(result.collection_slots[key]);
            ManualSortState.collectionSlots[key] = Number.isInteger(value) && value > 0 ? value : null;
        });
        saveManualSortSlotCollections();
        populateManualSortCollectionSelects();
        MANUAL_SORT_SLOT_KEYS.forEach(refreshManualSortSlotUi);
        updateFolderNames();
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

// ============== A/B Showdown (bracket) — v3.3.2 WB-S3 ==============

// Folder-free start path for A/B Showdown. Mirrors startSorting's filter
// building but skips destination folders (bracket is non-destructive culling)
// and the move/copy confirmation.
async function startBracketSorting() {
    const { $, API, showToast } = window.App;

    // Resume any unfinished session in its own mode rather than clobbering it.
    try {
        const existing = await API.getCurrentSortImage();
        const hasActive = existing && !existing.done && (existing.image || existing.champion);
        if (hasActive) {
            if (existing.mode === 'bracket') {
                ManualSortState.startTime = Date.now();
                ManualSortState.history = [];
                ManualSortState.actionTimestamps = [];
                activateSortingUi('bracket');
                applyCurrentSortPayload(existing);
                showToast(manualSortText('manual.bracketResumed', 'Resumed your A/B Showdown.', '已恢复 A/B 擂台。'), 'info');
            } else {
                await resumeSavedSession(existing);
            }
            return;
        }
    } catch (error) {
        if (window.Logger) Logger.warn('Failed to check existing session before bracket start:', error);
    }

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
        aspectRatio: f.aspectRatio,
    };

    try {
        const result = await API.startSortSession(
            generators,
            tags,
            ratings,
            {}, // no destination folders for bracket
            checkpoints,
            loras,
            prompts,
            dimensions,
            search,
            { min: f.minAesthetic, max: f.maxAesthetic },
            'copy', // operation mode is irrelevant; bracket does not move files
            f.artist,
            false,
            f.promptMatchMode,
            f.tagMode,
            {
                tags: f.excludeTags?.length > 0 ? f.excludeTags : null,
                generators: f.excludeGenerators?.length > 0 ? f.excludeGenerators : null,
                ratings: f.excludeRatings?.length > 0 ? f.excludeRatings : null,
                checkpoints: f.excludeCheckpoints?.length > 0 ? f.excludeCheckpoints : null,
                loras: f.excludeLoras?.length > 0 ? f.excludeLoras : null,
            },
            null, // collection slots
            'bracket',
            buildManualSortScopeFilters(f),
        );

        const totalImages = Number(result?.total_images ?? 0);
        if (totalImages === 0) {
            showToast(manualSortText('manual.noImages', 'No images match Manual Sort filters', '没有图片匹配手动排序筛选'), 'error');
            return;
        }
        if (totalImages < 2) {
            showToast(manualSortText('manual.bracketNeedTwo', 'A/B Showdown needs at least 2 images to compare.', 'A/B 擂台至少需要 2 张图片才能比较。'), 'error');
            return;
        }

        // Fresh session bookkeeping.
        ManualSortState.startTime = Date.now();
        ManualSortState.history = [];
        ManualSortState.images = [];
        ManualSortState.currentImage = null;
        ManualSortState.currentTags = [];
        ManualSortState.actionTimestamps = [];
        ManualSortState.sortedCount = 0;
        ManualSortState.skippedCount = 0;
        ManualSortState.combo = 0;
        ManualSortState.bracketStreak = 1;
        ManualSortState.bracketLastChampIndex = 0;

        activateSortingUi('bracket');
        setBracketZoomActive(false);
        await loadCurrentImage();
    } catch (error) {
        rollbackSortingUi();
        Logger.error('Failed to start A/B Showdown:', error);
        showToast(formatUserError(error, manualSortText('manual.bracketStartFailed', 'Failed to start A/B Showdown', '开始 A/B 擂台失败')), 'error');
    }
}

function bracketImageName(image) {
    if (!image) return '';
    if (image.filename) return image.filename;
    if (image.path) return String(image.path).split(/[\\/]/).pop();
    return image.id ? `#${image.id}` : '';
}

function renderBracketFighterName(selector, image) {
    const { $ } = window.App;
    const el = $(selector);
    if (!el) return;
    el.textContent = bracketImageName(image);
}

// v3.3.2 WB-S4: per-fighter generation-param chips — the SD judging context
// Eagle/Billfish can't show. Reuses Gallery's synchronous metadata parser so
// sampler/cfg/steps/seed come from the same source as the detail view.
function bracketMetaChipsHtml(image) {
    if (!image) return '';
    let gp = {};
    try {
        const parsed = window.Gallery && typeof window.Gallery._extractParsedData === 'function'
            ? window.Gallery._extractParsedData(image)
            : null;
        gp = (parsed && parsed.generation_params) || {};
    } catch (_) { gp = {}; }

    const chips = [];
    const chip = (text) => { if (text != null && String(text).trim() !== '') chips.push(`<span class="bchip">${escapeHtml(String(text))}</span>`); };
    const labeled = (label, val) => { if (val != null && String(val).trim() !== '') chips.push(`<span class="bchip"><b>${escapeHtml(label)}</b> ${escapeHtml(String(val))}</span>`); };

    if (gp.sampler) chip(gp.sampler);
    labeled('CFG', gp.cfg_scale);
    labeled('Steps', gp.steps);
    labeled('Seed', gp.seed);
    if (image.checkpoint) {
        const ckpt = String(image.checkpoint).split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth)$/i, '');
        chip(ckpt);
    }
    if (image.width && image.height) chip(`${image.width}×${image.height}`);
    if (image.aesthetic_score != null && image.aesthetic_score !== '') {
        const score = Number(image.aesthetic_score);
        if (Number.isFinite(score)) labeled('★', score.toFixed(1));
    }
    return chips.join('');
}

function renderBracketMeta(selector, image) {
    const { $ } = window.App;
    const el = $(selector);
    if (!el) return;
    el.innerHTML = bracketMetaChipsHtml(image);
}

// Normalize a sampler/scheduler label so the SAME choice from different
// generators isn't reported as a difference: A1111 "DPM++ 2M" vs ComfyUI
// "dpmpp_2m" vs NAI "k_euler_ancestral". Display still uses the raw value;
// only the same/diff decision is normalized. (Some A1111 versions fold the
// scheduler into the sampler name, so cross-generator matching is best-effort.)
function normalizeSamplerForCompare(value) {
    if (value == null) return null;
    let s = String(value).toLowerCase().trim();
    if (!s) return null;
    s = s.replace(/\+\+/g, 'pp');        // dpm++ -> dpmpp
    s = s.replace(/ancestral/g, 'a');    // "euler ancestral" -> "euler a"
    s = s.replace(/[\s_]+/g, '');         // collapse spaces / underscores
    s = s.replace(/^k(?=euler|dpmpp|dpm|heun|lms)/, ''); // NAI "k_euler" -> "euler"
    return s || null;
}

// v3.3.2 WB-S5: comparable generation params for the metadata-diff strip.
// Ordered so the strip reads the way 炼丹 users scan params.
function bracketComparableParams(image) {
    let gp = {};
    try {
        const parsed = window.Gallery && typeof window.Gallery._extractParsedData === 'function'
            ? window.Gallery._extractParsedData(image)
            : null;
        gp = (parsed && parsed.generation_params) || {};
    } catch (_) { gp = {}; }

    const ckpt = image && image.checkpoint
        ? String(image.checkpoint).split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
        : null;
    const norm = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

    // Scheduler is stored under a different key per generator: ComfyUI
    // "scheduler", A1111/WebUI "schedule_type", NovelAI "noise_schedule".
    const sched = norm(gp.scheduler != null ? gp.scheduler
        : (gp.schedule_type != null ? gp.schedule_type : gp.noise_schedule));
    const sampler = norm(gp.sampler);
    // genParam flags the true SD generation params (vs structural model/size) so
    // the strip can tell "params match" apart from "no SD metadata at all".
    return [
        { key: 'Sampler', value: sampler, cmp: normalizeSamplerForCompare(sampler), genParam: true },
        { key: 'CFG', value: norm(gp.cfg_scale), genParam: true },
        { key: 'Steps', value: norm(gp.steps), genParam: true },
        { key: 'Seed', value: norm(gp.seed), genParam: true },
        { key: 'Scheduler', value: sched, cmp: normalizeSamplerForCompare(sched), genParam: true },
        { key: 'Clip skip', value: norm(gp.clip_skip), genParam: true },
        { key: 'Denoise', value: norm(gp.denoising_strength != null ? gp.denoising_strength : gp.denoise), genParam: true },
        { key: 'Model', value: norm(ckpt), genParam: false },
        { key: 'Size', value: (image && image.width && image.height) ? `${image.width}×${image.height}` : null, genParam: false },
    ];
}

// Render the only-show-differences strip between champion (A) and challenger (B).
function renderBracketDiff(champImage, challImage) {
    const { $ } = window.App;
    const strip = $('#bracket-diff');
    if (!strip) return;

    if (!champImage || !challImage) {
        strip.hidden = true;
        strip.innerHTML = '';
        return;
    }

    const a = bracketComparableParams(champImage);
    const b = bracketComparableParams(challImage);
    const bByKey = {};
    b.forEach((p) => { bByKey[p.key] = p; });

    const diffs = [];
    const sames = [];
    let comparableGenParams = 0; // SD generation params present on either side
    a.forEach((p) => {
        const bp = bByKey[p.key] || {};
        const av = p.value;
        const bv = bp.value;
        if (av == null && bv == null) return;        // neither side has this field
        if (p.genParam) comparableGenParams += 1;
        const ac = p.cmp != null ? p.cmp : av;       // normalized compare key (sampler/scheduler)
        const bc = bp.cmp != null ? bp.cmp : bv;
        if (ac === bc) { sames.push(p.key); return; }
        diffs.push({ key: p.key, a: av == null ? '—' : av, b: bv == null ? '—' : bv });
    });

    const parts = [`<span class="bd-label">${escapeHtml(manualSortText('manual.bracketDiffLabel', 'Differences only', '只显示差异'))}</span>`];
    if (diffs.length > 0) {
        diffs.forEach((d) => {
            parts.push(
                `<span class="bd-chip"><b>${escapeHtml(d.key)}</b>`
                + `<span class="bd-a">${escapeHtml(d.a)}</span>`
                + `<span class="bd-arrow">→</span>`
                + `<span class="bd-b">${escapeHtml(d.b)}</span></span>`
            );
        });
    } else if (comparableGenParams === 0) {
        // Neither image carries SD generation metadata (e.g. un-parsed images);
        // claiming "same params" would be misleading, so be honest instead.
        parts.push(`<span class="bd-none">${escapeHtml(manualSortText('manual.bracketDiffNoMeta', 'No SD generation metadata to compare', '没有可对比的 SD 生成参数'))}</span>`);
    } else {
        parts.push(`<span class="bd-none">${escapeHtml(manualSortText('manual.bracketDiffNone', 'Same generation params', '生成参数相同'))}</span>`);
    }
    if (sames.length > 0) {
        parts.push(
            `<span class="bd-same">${escapeHtml(formatManualSortText('manual.bracketDiffSame', 'same: {keys}', '相同: {keys}', { keys: sames.join(' · ') }))}</span>`
        );
    }

    strip.innerHTML = parts.join('');
    strip.hidden = false;
}

// v3.3.2 WB-S5: synchronized pixel-peep zoom. Moving over either fighter zooms
// BOTH images to the same PICTURE point (corrected for object-fit letterboxing)
// so fine detail compares 1:1 even when the two images differ in aspect ratio.
const BRACKET_ZOOM_SCALE = 2.6;

// The rendered (letterboxed) rect of an object-fit:contain image inside a box
// of bw×bh — used to map between cursor/box space and picture space.
function containedImageRect(naturalW, naturalH, bw, bh) {
    if (!naturalW || !naturalH || !bw || !bh) return null;
    const scale = Math.min(bw / naturalW, bh / naturalH);
    const w = naturalW * scale;
    const h = naturalH * scale;
    return { left: (bw - w) / 2, top: (bh - h) / 2, width: w, height: h };
}

function setBracketZoomActive(active) {
    const { $ } = window.App;
    ManualSortState.bracketZoom = !!active;
    const btn = $('#bracket-btn-zoom');
    if (btn) btn.setAttribute('aria-pressed', String(!!active));
    const duel = document.querySelector('.bracket-duel');
    if (duel) duel.classList.toggle('zooming', !!active);
    if (!active) applyBracketZoom(null, null);
}

// normX/normY are PICTURE-space coordinates in [0,1] (where in the actual image
// content the cursor points). Each fighter maps that picture point back to its
// OWN box-relative transform-origin, correcting for object-fit:contain
// letterboxing, so both images zoom to the same picture coordinate.
function applyBracketZoom(normX, normY) {
    const { $ } = window.App;
    const imgs = [$('#bracket-champion-image'), $('#bracket-challenger-image')];
    imgs.forEach((img) => {
        if (!img) return;
        if (normX == null || normY == null) {
            img.style.transform = '';
            img.style.transformOrigin = '';
            return;
        }
        const rect = img.getBoundingClientRect();
        const r = containedImageRect(img.naturalWidth, img.naturalHeight, rect.width, rect.height);
        let oxPct = normX * 100;
        let oyPct = normY * 100;
        if (r && rect.width && rect.height) {
            oxPct = ((r.left + normX * r.width) / rect.width) * 100;
            oyPct = ((r.top + normY * r.height) / rect.height) * 100;
        }
        img.style.transformOrigin = `${oxPct.toFixed(2)}% ${oyPct.toFixed(2)}%`;
        img.style.transform = `scale(${BRACKET_ZOOM_SCALE})`;
    });
}

function handleBracketZoomMove(e) {
    if (!ManualSortState.bracketZoom) return;
    const fighter = e.currentTarget;
    const img = fighter.tagName === 'IMG' ? fighter : fighter.querySelector('img');
    const rect = (img || fighter).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Cursor position within the image element box.
    const bx = e.clientX - rect.left;
    const by = e.clientY - rect.top;
    // Convert to picture-space via the hovered image's letterboxed rect, so the
    // focal point is "where in the picture" rather than "where in the box".
    const r = img ? containedImageRect(img.naturalWidth, img.naturalHeight, rect.width, rect.height) : null;
    let normX;
    let normY;
    if (r && r.width && r.height) {
        normX = Math.min(1, Math.max(0, (bx - r.left) / r.width));
        normY = Math.min(1, Math.max(0, (by - r.top) / r.height));
    } else {
        normX = Math.min(1, Math.max(0, bx / rect.width));
        normY = Math.min(1, Math.max(0, by / rect.height));
    }
    applyBracketZoom(normX, normY);
}

// v3.3.2 WB-S4: brief highlight on the chosen fighter for tactile feedback.
function flashBracketPick(action) {
    const { $ } = window.App;
    const id = action === 'champion' ? '#bracket-champion'
        : action === 'challenger' ? '#bracket-challenger'
        : null;
    if (!id) return;
    const el = $(id);
    if (!el) return;
    el.classList.remove('is-picked');
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add('is-picked');
    setTimeout(() => el.classList.remove('is-picked'), 240);
}

function updateBracketProgress(result) {
    const { $ } = window.App;
    const total = Number(result?.total ?? ManualSortState.total ?? 0);
    const comparisonsTotal = Number(result?.comparisons_total ?? Math.max(0, total - 1));
    const challengerIndex = Number(result?.challenger_index ?? result?.index ?? 0);
    const decided = Math.max(0, Math.min(challengerIndex - 1, comparisonsTotal));
    const pct = comparisonsTotal > 0 ? (decided / comparisonsTotal) * 100 : 0;

    const fill = $('#bracket-progress-fill');
    if (fill) fill.style.width = `${pct}%`;
    const text = $('#bracket-progress-text');
    if (text) text.textContent = `${decided} / ${comparisonsTotal}`;

    // v3.3.2 WB-S4: champion win-streak (only once the champ has held ≥2 rounds).
    const streakEl = $('#bracket-streak');
    if (streakEl) {
        const streak = Number(ManualSortState.bracketStreak || 0);
        streakEl.textContent = streak >= 2
            ? formatManualSortI18n('manual.bracketStreak', '👑 Streak ×{n}', { n: streak })
            : '';
    }
}

// Renders the current champion/challenger pair. Returns false when the bracket
// is finished (so callers mirror applyCurrentSortPayload's contract).
function applyBracketPayload(result, options = {}) {
    const { $, API } = window.App;
    ManualSortState.mode = 'bracket';

    updateHistoryControlState(result || {});

    if (result?.done) {
        finishBracketSorting(result);
        return false;
    }

    const champion = result?.champion?.image || null;
    const challenger = result?.challenger?.image || null;
    ManualSortState.currentImage = challenger;
    ManualSortState.index = Number(result?.challenger_index ?? result?.index ?? 0);
    ManualSortState.total = Number(result?.total ?? 0);

    // v3.3.2 WB-S4: champion win-streak. Same champion index across loads means
    // the champ held the crown another round.
    const champIdx = Number(result?.champion_index ?? 0);
    if (ManualSortState.bracketLastChampIndex === champIdx) {
        ManualSortState.bracketStreak = (ManualSortState.bracketStreak || 1) + 1;
    } else {
        ManualSortState.bracketStreak = 1;
    }
    ManualSortState.bracketLastChampIndex = champIdx;

    const cacheSuffix = options.cacheBust ? `?t=${Date.now()}` : '';
    const champImg = $('#bracket-champion-image');
    if (champImg) champImg.src = champion?.id ? API.getImageUrl(champion.id) + cacheSuffix : '';
    const challImg = $('#bracket-challenger-image');
    if (challImg) challImg.src = challenger?.id ? API.getImageUrl(challenger.id) + cacheSuffix : '';

    renderBracketFighterName('#bracket-champion-name', champion);
    renderBracketFighterName('#bracket-challenger-name', challenger);
    renderBracketMeta('#bracket-champion-meta', champion);
    renderBracketMeta('#bracket-challenger-meta', challenger);
    renderBracketDiff(champion, challenger);
    // Each new pair starts un-zoomed; a mouse move re-applies if zoom is on.
    applyBracketZoom(null, null);
    updateBracketProgress(result);

    const undoBtn = $('#bracket-btn-undo');
    if (undoBtn) undoBtn.disabled = !result?.undo_available;
    const redoBtn = $('#bracket-btn-redo');
    if (redoBtn) redoBtn.disabled = !result?.redo_available;

    return true;
}

async function performBracketAction(action, fast = false) {
    const { API, showToast } = window.App;
    if (!ManualSortState.active || ManualSortState.mode !== 'bracket') return;

    const isHistory = action === 'undo' || action === 'redo';
    if (!isHistory) {
        if (ManualSortState.isProcessing) { flashManualSortBusy(); return; }
        if (isManualSortInCooldown()) { flashManualSortBusy(); return; }
    }
    ManualSortState.isProcessing = true;

    try {
        // v3.3.2 WB-S4: directional pick sfx (left/right pitch) + brief highlight.
        if (action === 'skip') {
            window.AudioManager?.play('skip');
        } else if (isHistory) {
            window.AudioManager?.play('undo');
        } else {
            window.AudioManager?.play('move', action === 'champion' ? 'a' : 'd');
        }
        flashBracketPick(action);

        const result = await API.sortAction(action);
        if (result?.error) {
            updateHistoryControlState(result);
            showToast(result.error, 'error');
            return;
        }

        if (!isHistory) {
            ManualSortState.actionTimestamps.push(Date.now());
            const cutoff = Date.now() - 30000;
            ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);
        }

        // A bracket action returns only status flags/indices, never the next
        // pair — reload fresh so the new champion/challenger render.
        await loadCurrentImage();
    } catch (error) {
        Logger.error('Bracket action failed:', error);
        showToast(manualSortText('manual.bracketActionFailed', 'Action failed', '操作失败'), 'error');
    } finally {
        ManualSortState.isProcessing = false;
        ManualSortState.lastActionCompletedAt = Date.now();
    }
}

// v3.3.2 WB-S6: route the showdown winner to its chosen destination by
// reference (non-destructive). Returns a display label for the toast, or null
// when nothing was saved. '' = don't save, 'fav' = Favorites, else collection id.
async function collectBracketWinner(winnerImage) {
    const { API, showToast } = window.App;
    const winnerId = winnerImage && winnerImage.id;
    if (!winnerId) return null;
    const dest = getBracketWinnerDest();
    if (!dest) return null;

    try {
        if (dest === 'fav') {
            await API.setFavorite(winnerId, true);
            return manualSortText('manual.bracketWinnerFav', '♥ Favorites', '♥ 收藏');
        }
        const collectionId = Number(dest);
        if (!Number.isInteger(collectionId) || collectionId <= 0) return null;
        await API.setCollectionMembership(collectionId, winnerId, true);
        const match = (ManualSortState.collectionsCache || []).find((c) => c.id === collectionId);
        return match ? match.name : `#${collectionId}`;
    } catch (error) {
        Logger.error('Failed to save showdown winner:', error);
        showToast(manualSortText('manual.bracketWinnerFailed', 'Failed to save the winner', '保存冠军失败'), 'error');
        return null;
    }
}

async function finishBracketSorting(result) {
    const { $, showToast } = window.App;

    ManualSortState.active = false;
    ManualSortState.undoAvailable = false;
    ManualSortState.redoAvailable = false;
    document.removeEventListener('keydown', handleSortKeypress);
    updateHistoryControlState({ undo_available: false, redo_available: false });

    window.AudioManager?.play('finish');
    setBracketZoomActive(false);

    const winner = result?.winner?.image || result?.champion?.image || null;
    const winnerName = bracketImageName(winner);

    hideSortInterfaces();
    $('#sort-setup').style.display = 'block';

    const destLabel = await collectBracketWinner(winner);

    if (winnerName && destLabel) {
        showToast(
            formatManualSortI18n('manual.bracketWinnerSaved', 'Winner {name} → {dest}', { name: winnerName, dest: destLabel }),
            'success'
        );
    } else if (winnerName) {
        showToast(
            formatManualSortI18n('manual.bracketWinner', 'Showdown complete — winner: {name}', { name: winnerName }),
            'success'
        );
    } else {
        showToast(manualSortText('manual.bracketComplete', 'Showdown complete.', '擂台结束。'), 'success');
    }

    window.App.API.delete('/api/sort/session').catch(e => {
        if (window.Logger) Logger.warn('Failed to clean up bracket session:', e);
    });

    if (window.App && window.App.loadImages) {
        window.App.loadImages();
    }
}

function handleBracketKeypress(e) {
    const key = e.key;
    let action = null;
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') action = 'champion';
    else if (key === 'ArrowRight' || key === 'd' || key === 'D') action = 'challenger';
    else if (key === ' ' || key === 'ArrowUp' || key === 'w' || key === 'W') action = 'skip';
    else if (key === 'z' || key === 'Z') action = 'undo';
    else if (key === 'y' || key === 'Y') action = 'redo';
    else if (key === 'Escape') { e.preventDefault(); exitSorting(); return; }

    if (!action) return;
    e.preventDefault();
    performBracketAction(action, Boolean(e.repeat));
}

// ============== 留/汰 Keep-Reject cull — v3.3.2 FF-1 ==============

// Folder-free, non-destructive start path (mirrors startBracketSorting). One
// image at a time; keep/reject decisions are tracked client-side and routed to
// the chosen collections at finish.
async function startCullSorting() {
    const { API, showToast } = window.App;

    try {
        const existing = await API.getCurrentSortImage();
        const hasActive = existing && !existing.done && (existing.image || existing.champion);
        if (hasActive) {
            if (existing.mode === 'cull') {
                ManualSortState.startTime = Date.now();
                ManualSortState.history = [];
                ManualSortState.actionTimestamps = [];
                ManualSortState.cullDecisions = new Map();
                activateSortingUi('cull');
                applyCurrentSortPayload(existing);
                showToast(manualSortText('manual.cullResumed', 'Resumed your Keep/Reject session.', '已恢复留/汰整理。'), 'info');
            } else {
                await resumeSavedSession(existing);
            }
            return;
        }
    } catch (error) {
        if (window.Logger) Logger.warn('Failed to check existing session before cull start:', error);
    }

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
        aspectRatio: f.aspectRatio,
    };

    try {
        const result = await API.startSortSession(
            generators, tags, ratings,
            {}, // no destination folders for cull
            checkpoints, loras, prompts, dimensions, search,
            { min: f.minAesthetic, max: f.maxAesthetic },
            'copy', // operation mode irrelevant; cull does not move files
            f.artist, false, f.promptMatchMode, f.tagMode,
            {
                tags: f.excludeTags?.length > 0 ? f.excludeTags : null,
                generators: f.excludeGenerators?.length > 0 ? f.excludeGenerators : null,
                ratings: f.excludeRatings?.length > 0 ? f.excludeRatings : null,
                checkpoints: f.excludeCheckpoints?.length > 0 ? f.excludeCheckpoints : null,
                loras: f.excludeLoras?.length > 0 ? f.excludeLoras : null,
            },
            null, // collection slots
            'cull',
            buildManualSortScopeFilters(f),
        );

        const totalImages = Number(result?.total_images ?? 0);
        if (totalImages === 0) {
            showToast(manualSortText('manual.noImages', 'No images match Manual Sort filters', '没有图片匹配手动排序筛选'), 'error');
            return;
        }

        ManualSortState.startTime = Date.now();
        ManualSortState.history = [];
        ManualSortState.images = [];
        ManualSortState.currentImage = null;
        ManualSortState.currentTags = [];
        ManualSortState.actionTimestamps = [];
        ManualSortState.sortedCount = 0;
        ManualSortState.skippedCount = 0;
        ManualSortState.combo = 0;
        ManualSortState.cullDecisions = new Map();

        activateSortingUi('cull');
        await loadCurrentImage();
    } catch (error) {
        rollbackSortingUi();
        Logger.error('Failed to start Keep/Reject cull:', error);
        showToast(formatUserError(error, manualSortText('manual.cullStartFailed', 'Failed to start Keep/Reject', '开始留/汰失败')), 'error');
    }
}

// Render the single judged image. Returns false when the session finished (so
// callers mirror applyCurrentSortPayload's contract).
function applyCullPayload(result, options = {}) {
    const { $, API } = window.App;
    ManualSortState.mode = 'cull';

    updateHistoryControlState(result || {});

    // v3.3.2 fix: rebuild the decision map from the server payload (history is
    // the source of truth) so a resumed session re-routes keep/reject choices
    // made before a reload — not just those made in the current page load.
    if (result && result.decisions && typeof result.decisions === 'object') {
        const rebuilt = new Map();
        for (const [id, decision] of Object.entries(result.decisions)) {
            const n = Number(id);
            if (Number.isInteger(n) && n > 0 && (decision === 'keep' || decision === 'reject')) {
                rebuilt.set(n, decision);
            }
        }
        ManualSortState.cullDecisions = rebuilt;
    }

    if (result?.done) {
        finishCullSorting(result);
        return false;
    }

    const image = result?.image?.image || null;
    ManualSortState.currentImage = image;
    ManualSortState.currentTags = result?.image?.tags || [];
    ManualSortState.index = Number(result?.index ?? 0);
    ManualSortState.total = Number(result?.total ?? 0);

    const cacheSuffix = options.cacheBust ? `?t=${Date.now()}` : '';
    const img = $('#cull-image');
    if (img) img.src = image?.id ? API.getImageUrl(image.id) + cacheSuffix : '';

    renderBracketFighterName('#cull-name', image);
    renderBracketMeta('#cull-meta', image);
    updateCullProgress(result);

    const undoBtn = $('#cull-btn-undo');
    if (undoBtn) undoBtn.disabled = !result?.undo_available;
    const redoBtn = $('#cull-btn-redo');
    if (redoBtn) redoBtn.disabled = !result?.redo_available;

    return true;
}

function updateCullProgress(result) {
    const { $ } = window.App;
    const total = Number(result?.total ?? ManualSortState.total ?? 0);
    const index = Number(result?.index ?? ManualSortState.index ?? 0);
    const kept = Number(result?.kept ?? 0);
    const rejected = Number(result?.rejected ?? 0);

    const fill = $('#cull-progress-fill');
    if (fill) fill.style.width = total ? `${Math.min(100, (index / total) * 100)}%` : '0%';
    const text = $('#cull-progress-text');
    if (text) text.textContent = `${Math.min(index + 1, total)} / ${total}`;
    const keepTally = $('#cull-tally-keep');
    if (keepTally) keepTally.textContent = `♥ ${kept}`;
    const rejTally = $('#cull-tally-reject');
    if (rejTally) rejTally.textContent = `✕ ${rejected}`;
}

// Brief keep/reject/skip stamp animation on the card.
function flashCullStamp(action) {
    const { $ } = window.App;
    const card = $('#cull-card');
    if (!card) return;
    card.classList.remove('cull-flash-keep', 'cull-flash-reject', 'cull-flash-skip');
    const cls = action === 'keep' ? 'cull-flash-keep'
        : action === 'reject' ? 'cull-flash-reject'
        : action === 'skip' ? 'cull-flash-skip' : null;
    if (!cls) return;
    void card.offsetWidth; // reflow so the animation restarts each time
    card.classList.add(cls);
    setTimeout(() => card.classList.remove(cls), 360);
}

// Maintain the client-side decision map from the server's action response so
// finish can route kept→keep dest / rejected→reject dest. Forward keep/reject
// set the decision; skip clears it; undo reverts the affected image; redo
// re-applies the entry's decision. (image_id + decision come back per action.)
function applyCullDecisionFromResult(action, result) {
    if (!ManualSortState.cullDecisions) ManualSortState.cullDecisions = new Map();
    const map = ManualSortState.cullDecisions;
    const id = Number(result?.image_id);
    if (!Number.isInteger(id) || id <= 0) return;
    if (action === 'keep' || action === 'reject') {
        map.set(id, action);
    } else if (action === 'skip' || action === 'undo') {
        map.delete(id);
    } else if (action === 'redo') {
        const decision = result?.decision;
        if (decision === 'keep' || decision === 'reject') map.set(id, decision);
        else map.delete(id);
    }
}

async function performCullAction(action, fast = false) {
    const { API, showToast } = window.App;
    if (!ManualSortState.active || ManualSortState.mode !== 'cull') return;

    const isHistory = action === 'undo' || action === 'redo';
    if (!isHistory) {
        if (ManualSortState.isProcessing) { flashManualSortBusy(); return; }
        if (isManualSortInCooldown()) { flashManualSortBusy(); return; }
    }
    ManualSortState.isProcessing = true;

    try {
        if (action === 'keep') window.AudioManager?.play('move', 'd');
        else if (action === 'reject') window.AudioManager?.play('move', 'a');
        else if (action === 'skip') window.AudioManager?.play('skip');
        else window.AudioManager?.play('undo');
        flashCullStamp(action);

        const result = await API.sortAction(action);
        if (result?.error) {
            updateHistoryControlState(result);
            showToast(result.error, 'error');
            return;
        }

        applyCullDecisionFromResult(action, result);

        if (!isHistory) {
            ManualSortState.actionTimestamps.push(Date.now());
            const cutoff = Date.now() - 30000;
            ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);
        }

        // A cull action returns only status flags — reload fresh so the next
        // image (and tally) render.
        await loadCurrentImage();
    } catch (error) {
        Logger.error('Cull action failed:', error);
        showToast(manualSortText('manual.cullActionFailed', 'Action failed', '操作失败'), 'error');
    } finally {
        ManualSortState.isProcessing = false;
        ManualSortState.lastActionCompletedAt = Date.now();
    }
}

// Route the tracked decisions to their destinations by reference (non-destructive).
async function collectCullDecisions() {
    const { API } = window.App;
    const map = ManualSortState.cullDecisions || new Map();
    const keepDest = getCullDest('keep');
    const rejectDest = getCullDest('reject');

    let attempted = 0;
    let failed = 0;

    // Returns false only when a real write throws, so finishCullSorting can
    // report honestly instead of always showing a green success toast even
    // when every keep/reject failed (e.g. the destination collection was
    // deleted mid-session). A falsy/invalid dest is "nothing to write", not a
    // failure.
    const route = async (id, dest) => {
        if (!dest) return true;
        const cid = dest === 'fav' ? null : Number(dest);
        if (dest !== 'fav' && (!Number.isInteger(cid) || cid <= 0)) return true;
        attempted += 1;
        try {
            if (dest === 'fav') await API.setFavorite(id, true);
            else await API.setCollectionMembership(cid, id, true);
            return true;
        } catch (e) {
            failed += 1;
            if (window.Logger) Logger.error('Failed to route cull decision:', e);
            return false;
        }
    };

    for (const [id, decision] of map.entries()) {
        if (decision === 'keep') await route(id, keepDest);
        else if (decision === 'reject') await route(id, rejectDest);
    }
    return { attempted, failed };
}

async function finishCullSorting(result) {
    const { $, showToast } = window.App;

    ManualSortState.active = false;
    ManualSortState.undoAvailable = false;
    ManualSortState.redoAvailable = false;
    document.removeEventListener('keydown', handleSortKeypress);
    updateHistoryControlState({ undo_available: false, redo_available: false });

    window.AudioManager?.play('finish');

    hideSortInterfaces();
    $('#sort-setup').style.display = 'block';

    const map = ManualSortState.cullDecisions || new Map();
    let keptCount = 0;
    let rejectedCount = 0;
    for (const decision of map.values()) {
        if (decision === 'keep') keptCount += 1;
        else if (decision === 'reject') rejectedCount += 1;
    }

    const routeStats = await collectCullDecisions();

    if (routeStats.failed > 0) {
        showToast(
            formatManualSortText(
                'manual.cullCompletePartial',
                'Cull done — kept {kept}, rejected {rejected}, but {failed} could not be saved to your collections/favorites.',
                '整理完成 — 保留 {kept}、剔除 {rejected}，但有 {failed} 张未能写入收藏夹/收藏。',
                { kept: keptCount, rejected: rejectedCount, failed: routeStats.failed }
            ),
            'warning'
        );
    } else {
        showToast(
            formatManualSortI18n(
                'manual.cullComplete',
                'Cull complete — kept {kept}, rejected {rejected}.',
                { kept: keptCount, rejected: rejectedCount }
            ),
            'success'
        );
    }

    window.App.API.delete('/api/sort/session').catch(e => {
        if (window.Logger) Logger.warn('Failed to clean up cull session:', e);
    });

    ManualSortState.cullDecisions = new Map();

    if (window.App && window.App.loadImages) {
        window.App.loadImages();
    }
}

function handleCullKeypress(e) {
    const key = e.key;
    let action = null;
    if (key === 'ArrowRight' || key === 'd' || key === 'D' || key === 'k' || key === 'K') action = 'keep';
    else if (key === 'ArrowLeft' || key === 'a' || key === 'A' || key === 'x' || key === 'X') action = 'reject';
    else if (key === ' ' || key === 'ArrowUp' || key === 'w' || key === 'W' || key === 'ArrowDown' || key === 's' || key === 'S') action = 'skip';
    else if (key === 'z' || key === 'Z') action = 'undo';
    else if (key === 'y' || key === 'Y') action = 'redo';
    else if (key === 'Escape') { e.preventDefault(); exitSorting(); return; }

    if (!action) return;
    e.preventDefault();
    performCullAction(action, Boolean(e.repeat));
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

        if (!session || session.done || !(session.image || session.champion)) {
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
        const resumeMode = MANUAL_SORT_MODES.has(session.mode) ? session.mode : 'slot';
        // Cull decisions are rebuilt from the server payload in applyCullPayload
        // (server history is the source of truth), so keep/reject choices made
        // before the reload are still routed at finish. Reset the bracket streak
        // so a resumed showdown counts the champion's run from this load.
        ManualSortState.cullDecisions = new Map();
        ManualSortState.bracketStreak = 1;
        ManualSortState.bracketLastChampIndex = null;
        activateSortingUi(resumeMode);
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

    // Throughput: images per minute over a rolling 10-second window (张/分).
    const speedEl = $('#sort-speed');
    if (speedEl) {
        const now = Date.now();
        const recentActions = ManualSortState.actionTimestamps.filter(t => now - t < 10000);
        const perMinute = recentActions.length > 1
            ? Math.round((recentActions.length / ((now - recentActions[0]) / 1000)) * 60)
            : 0;
        speedEl.textContent = formatManualSortI18n('manual.imagesPerMinute', '{speed}/min', { speed: perMinute });
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

    const isBracket = ManualSortState.mode === 'bracket';
    const isCull = ManualSortState.mode === 'cull';

    // Handle Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo) explicitly
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            if (isBracket) {
                performBracketAction(e.shiftKey ? 'redo' : 'undo');
            } else if (isCull) {
                performCullAction(e.shiftKey ? 'redo' : 'undo');
            } else if (e.shiftKey) {
                redoLastAction();
            } else {
                undoLastAction();
            }
            return;
        }
        if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            if (isBracket) performBracketAction('redo');
            else if (isCull) performCullAction('redo');
            else redoLastAction();
            return;
        }
        return; // Ignore other Ctrl+key combos
    }

    // v3.3.2 WB-S3: A/B Showdown has its own key map (←/→ pick, ↑ skip).
    if (isBracket) {
        handleBracketKeypress(e);
        return;
    }
    // v3.3.2 FF-1: 留/汰 cull has its own key map (←reject / →keep / ↑skip).
    if (isCull) {
        handleCullKeypress(e);
        return;
    }

    const action = KEY_MAP[e.key];
    if (!action) return;

    e.preventDefault();

    // v3.2.1 task #36: when the OS auto-repeat fires (key held down) we skip
    // the 300 ms fly-away animation so long-press feels Ctrl+Z fast instead of
    // gated by animation duration.
    const fast = Boolean(e.repeat);

    if (action === 'undo') {
        undoLastAction();
    } else if (action === 'redo') {
        redoLastAction();
    } else if (action === 'skip') {
        performSkip(fast);
    } else if (action === 'exit') {
        exitSorting();
    } else {
        performMove(action, fast);
    }
}

// v3.3.0 USR-4: cooldown + visible busy feedback for manual sort.
function isManualSortInCooldown() {
    const cd = Number(ManualSortState.actionCooldownMs) || 0;
    if (cd <= 0) return false;
    return (Date.now() - (ManualSortState.lastActionCompletedAt || 0)) < cd;
}

// A dropped press (busy or in cooldown) is otherwise invisible. Flash the
// current image wrapper briefly so the user can tell the press was ignored.
function flashManualSortBusy() {
    const wrapper = window.App?.$?.('.current-image-wrapper');
    if (!wrapper) return;
    wrapper.classList.remove('sort-busy-flash');
    // Force reflow so re-adding the class restarts the animation.
    void wrapper.offsetWidth;
    wrapper.classList.add('sort-busy-flash');
    setTimeout(() => wrapper.classList.remove('sort-busy-flash'), 220);
}

async function performMove(folderKey, fast = false) {
    const { $, API, showToast } = window.App;
    // v3.3.1: a collection-typed slot adds the image to a collection by
    // reference ("collect") instead of moving the file.
    const isCollect = isManualSortCollectionSlot(folderKey);
    const operationVerb = isCollect
        ? manualSortText('manual.actionVerbCollect', 'add', '收藏')
        : getManualSortOperationVerb();

    // Prevent race condition from rapid keypresses
    if (ManualSortState.isProcessing) {
        flashManualSortBusy();
        return;
    }
    // v3.3.0 USR-4: optional cooldown (opt-in). Ignore presses fired within
    // the window after the previous action completed.
    if (isManualSortInCooldown()) {
        flashManualSortBusy();
        return;
    }
    ManualSortState.isProcessing = true;

    try {
        // Check the slot is configured (folder path OR collection assignment).
        if (!isCollect && !ManualSortState.folders[folderKey]) {
            showToast(formatManualSortI18n('manual.folderNotConfigured', 'Folder {key} is not configured', {
                key: folderKey.toUpperCase(),
            }), 'error');
            return;
        }

        // Animate folder highlight
        const folderEl = $(`.sort-folder[data-key="${folderKey}"]`);
        folderEl?.classList.add('active');
        setTimeout(() => folderEl?.classList.remove('active'), fast ? 120 : 300);

        // Animate image flying away (skipped on key auto-repeat)
        const direction = DIRECTION_MAP[folderKey];
        const imgWrapper = $('.current-image-wrapper');
        if (!fast) {
            imgWrapper.classList.add(`fly-${direction}`);
        }

        // Play sound
        window.AudioManager?.play('move', folderKey);

        // Wait for animation. On long-press auto-repeat we skip the wait so
        // each action only blocks on the API roundtrip.
        if (!fast) {
            await sleep(300);
        }

        // Send action to server: 'collect' (by reference) or 'move' (file op).
        const result = await API.sortAction(isCollect ? 'collect' : 'move', folderKey);

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

        // Update combo/stats only after a successful action.
        updateCombo();
        ManualSortState.actionTimestamps.push(Date.now());
        const cutoff = Date.now() - 30000;
        ManualSortState.actionTimestamps = ManualSortState.actionTimestamps.filter(t => t > cutoff);

        if (isCollect) {
            const name = getManualSortCollectionName(ManualSortState.collectionSlots[folderKey]) || folderKey.toUpperCase();
            showToast(
                formatManualSortI18n('manual.collectedToast', 'Added to “{name}” (original kept in place)', { name }),
                'success'
            );
        }

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
        ManualSortState.lastActionCompletedAt = Date.now();
    }
}

async function performSkip(fast = false) {
    const { $, API, showToast } = window.App;

    // Prevent race condition from rapid keypresses
    if (ManualSortState.isProcessing) {
        flashManualSortBusy();
        return;
    }
    // v3.3.0 USR-4: optional cooldown (opt-in).
    if (isManualSortInCooldown()) {
        flashManualSortBusy();
        return;
    }
    ManualSortState.isProcessing = true;

    try {
        // Animate skip (skipped on key auto-repeat)
        const imgWrapper = $('.current-image-wrapper');
        if (!fast) {
            imgWrapper.classList.add('skip');
        }

        // Play skip sound
        window.AudioManager?.play('skip');

        // Reset combo
        ManualSortState.combo = 0;
        updateComboDisplay();

        if (!fast) {
            await sleep(300);
        }

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
        ManualSortState.lastActionCompletedAt = Date.now();
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

    // FLOW-07: persistent next-step CTA after finishing a manual sort, so the
    // session no longer dead-ends (the summary toast above still reports the
    // stats). Reuses window.App.showPipelineNextStep.
    window.App?.showPipelineNextStep?.({
        icon: '🗂️',
        title: formatManualSortI18n('flow.sortDoneTitle', 'Sorting done — what next?'),
        actions: [
            { icon: '🔳', label: formatManualSortI18n('nav.censor', 'Censor Edit'), action: 'view:censor' },
            { icon: '📦', label: formatManualSortI18n('nav.dataset', 'Dataset'), action: 'view:dataset' },
            { icon: '🖼️', label: formatManualSortI18n('nav.gallery', 'Gallery'), action: 'view:gallery' },
        ],
    });

    // Return to setup
    hideSortInterfaces();
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

    hideSortInterfaces();
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

    // Strip each span's data-i18n default when writing the real (already
    // localized) scope value, so a later I18n.applyToDOM on languageChanged
    // cannot reset it to "All"/"None" and misreport the sort scope. Matches the
    // gallery sidebar / auto-separate summary writers.
    const setSummary = (id, value) => {
        const el = $(id);
        if (!el) return;
        el.removeAttribute('data-i18n');
        el.textContent = value;
    };

    setSummary('#manual-sort-summary-generators', summary.generators);
    setSummary('#manual-sort-summary-tags', summary.tags);
    setSummary('#manual-sort-summary-ratings', summary.ratings);
    setSummary('#manual-sort-summary-checkpoints', summary.checkpoints);
    setSummary('#manual-sort-summary-loras', summary.loras);
    setSummary('#manual-sort-summary-prompts', summary.prompts);
    setSummary('#manual-sort-summary-search', summary.search);
    setSummary('#manual-sort-summary-dimensions', summary.dimensions);

    updateManualSortScopeStatus();
    updateManualSortExecutionScopeSummary();
    // Keep the scoped image count in step with the filters (no-op when the
    // setup is off-screen — the fetch guards on visibility).
    refreshManualSortScopeCount();
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
// Exposed so the sorting sub-tab switch (inline in index.html) can refresh the
// live scoped count the moment the Manual Sort setup becomes visible.
window.refreshManualSortScopeCount = refreshManualSortScopeCount;

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
