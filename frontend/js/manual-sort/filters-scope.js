/**
 * manual-sort/filters-scope.js — manual-sort.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/manual-sort.js,
 * pre-split lines 458-629 + 949-1119 + 3533-3569: filter serialization and
 * persistence, the filter contract + the shared gallery-scope bundle builder
 * (used by every start path AND the minimap preview — the release contract
 * counts its call sites across the family, do not DRY), scope
 * meta/signature/status/summaries, sync-from-gallery / keep-saved, and the
 * filter-summary writer (strips data-i18n so languageChanged cannot reset the
 * localized scope). Classic script: loads after manual-sort/state-constants.js.
 */
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

