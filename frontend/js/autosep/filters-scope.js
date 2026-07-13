/**
 * autosep/filters-scope.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 146-354 + 1468: filter load/save/get/set, scope-meta persistence,
 * getCurrentGalleryAutoSepFilters, the scope time/status/summary renderers,
 * syncAutoSepFiltersFromGallery / keepAutoSepSavedScope, and the ONE-SHOT
 * maybeAdoptAutoSepFiltersFromGallery with its window publish (each publish
 * stays in the file that declares its function). Classic script: loads
 * after autosep/state-constants.js (base).
 */
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
    const useBtn = document.getElementById('btn-autosep-use-gallery-scope');
    const resyncBtn = document.getElementById('btn-autosep-resync-scope');
    const keepBtn = document.getElementById('btn-autosep-keep-scope');
    if (!card || !useBtn || !resyncBtn || !keepBtn) return;

    const status = getAutoSepScopeStatus();

    useBtn.hidden = Boolean(status.lastSyncedAt);
    resyncBtn.hidden = !Boolean(status.lastSyncedAt) || status.matchesGallery;
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

window.maybeAdoptAutoSepFiltersFromGallery = maybeAdoptAutoSepFiltersFromGallery;
