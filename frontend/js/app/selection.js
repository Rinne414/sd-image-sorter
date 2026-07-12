/**
 * app/selection.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 1017-1367 (of 10,152): selection mode/scope system + gallery preview/prompt-filter.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function syncSelectionModeButton() {
    const toggleBtn = $('#btn-toggle-select');
    if (!toggleBtn) return;

    const iconEl = toggleBtn.querySelector('span:first-child');
    const labelEl = toggleBtn.querySelector('span:last-child');
    const isSelecting = Boolean(AppState.selectionMode);
    const _d = window.I18n?.t?.('selection.doneSelecting');
    const doneLabel = (_d && _d !== 'selection.doneSelecting') ? _d : 'Done Selecting';
    const _s = window.I18n?.t?.('gallery.selectImages');
    const idleLabel = (_s && _s !== 'gallery.selectImages') ? _s : 'Select Images';

    toggleBtn.classList.toggle('active', isSelecting);
    toggleBtn.classList.toggle('selection-active', isSelecting);
    toggleBtn.setAttribute('aria-pressed', String(isSelecting));
    toggleBtn.setAttribute('data-state', isSelecting ? 'selecting' : 'idle');
    toggleBtn.setAttribute(
        'aria-label',
        isSelecting ? 'Exit image selection mode' : 'Enable image selection mode'
    );

    if (iconEl) {
        iconEl.textContent = isSelecting ? '✦' : '✔';
    }

    if (labelEl) {
        labelEl.textContent = isSelecting ? doneLabel : idleLabel;
    }
}

function emitSelectionStateChanged() {
    const selectedCount = getSelectedGalleryCount();
    const detail = {
        selectionMode: Boolean(AppState.selectionMode),
        selectedCount,
        selectionScope: AppState.selectionScope || 'visible',
    };
    window.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
    document.dispatchEvent(new CustomEvent('selection-state-changed', { detail }));
}

function getSelectionScopeSummaryText(scope = AppState.selectionScope || 'visible') {
    if (scope === 'loaded') {
        return appT('selection.scopeLoaded', 'Selected from loaded gallery items');
    }
    if (scope === 'filtered') {
        return AppState.selectionToken
            ? appT('selection.scopeFiltered', 'Selected all current filter matches')
            : appT('selection.scopeFilteredExplicit', 'Selected current filter matches');
    }
    return appT('selection.scopeVisible', 'Selected manually from Gallery');
}

function collapseSelectionMoreActions() {
    // Selection actions are now always visible in sections; kept as a no-op for older callers.
}

function normalizeSelectionImageIds(rawIds) {
    return Array.isArray(rawIds)
        ? rawIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
        : [];
}

function confirmLargeFilteredSelection(total) {
    const normalizedTotal = Number(total || 0);
    if (normalizedTotal <= FILTERED_SELECTION_CONFIRM_THRESHOLD) {
        return true;
    }

    const confirmMessage = appT(
        'selection.largeFilteredConfirm',
        'This will select {count} filtered images using a compact selection token. Continue?',
        { count: normalizedTotal }
    );
    return window.confirm(confirmMessage);
}

function shouldFallbackToSelectionIds(error) {
    return [404, 405, 501].includes(Number(error?.apiStatus));
}

async function resolveFilteredSelectionIdsViaChunks(filterPayload, options = {}) {
    const tokenPayload = await API.createSelectionToken(filterPayload, FILTERED_SELECTION_CHUNK_SIZE, options);
    const selectionToken = tokenPayload?.selection_token;
    if (!selectionToken) {
        throw new Error('Selection token response was missing a token');
    }

    const totalEstimate = Number(tokenPayload?.total_estimate || 0);
    if (!confirmLargeFilteredSelection(totalEstimate)) {
        return { cancelled: true, imageIds: [] };
    }

    return {
        cancelled: false,
        imageIds: [],
        selectionToken,
        total: totalEstimate,
        exactTotal: tokenPayload?.exact_total !== false,
    };
}

async function resolveFilteredSelectionIdsViaLegacyEndpoint(filterPayload) {
    const result = await API.getSelectionIds(filterPayload);
    const imageIds = normalizeSelectionImageIds(result?.image_ids);
    const total = Number(result?.total || imageIds.length || 0);
    if (!confirmLargeFilteredSelection(total)) {
        return { cancelled: true, imageIds: [] };
    }
    return { cancelled: false, imageIds, selectionToken: null, total };
}

async function resolveFilteredSelectionIds(filterPayload, options = {}) {
    try {
        return await resolveFilteredSelectionIdsViaChunks(filterPayload, options);
    } catch (error) {
        if (!shouldFallbackToSelectionIds(error)) {
            throw error;
        }
        return resolveFilteredSelectionIdsViaLegacyEndpoint(filterPayload);
    }
}

async function selectAllFilteredResults() {
    const selectFilteredBtn = $('#btn-select-all');
    if (selectFilteredBtn) {
        selectFilteredBtn.disabled = true;
    }

    try {
        const filterPayload = buildSelectionFilterRequest();
        const filterKey = JSON.stringify(filterPayload);
        const result = await resolveFilteredSelectionIds(filterPayload);
        if (result.cancelled) {
            updateSelectionUI();
            return;
        }

        if (getSelectionFilterCacheKey(AppState.filters) !== filterKey) {
            updateSelectionUI();
            return;
        }

        updateSelectionState((selection) => {
            selection.selectedIds = result.selectionToken ? new Set() : new Set(result.imageIds);
            selection.scope = 'filtered';
            selection.filterKey = filterKey;
            selection.selectionToken = result.selectionToken || null;
            selection.selectionTotal = Number(result.total || result.imageIds?.length || 0);
        });

        if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
            Gallery.syncSelectionState();
        }
        updateSelectionUI();
        emitSelectionStateChanged();
    } catch (error) {
        showToast(
            formatUserError(error, appT('selection.selectFilteredFailed', 'Failed to select all current filter matches')),
            'error'
        );
        updateSelectionUI();
    }
}

async function invertAllFilteredResults() {
    const invertFilteredBtn = $('#btn-invert-selection-filtered');
    if (invertFilteredBtn) {
        invertFilteredBtn.disabled = true;
    }

    try {
        const filterPayload = buildSelectionFilterRequest();
        const filterKey = JSON.stringify(filterPayload);
        const excludedImageIds = getSelectedGalleryIds();
        const result = await resolveFilteredSelectionIds(filterPayload, { excludedImageIds });
        if (result.cancelled) {
            updateSelectionUI();
            return;
        }

        if (getSelectionFilterCacheKey(AppState.filters) !== filterKey) {
            updateSelectionUI();
            return;
        }

        const currentSelected = new Set(AppState.selectedIds || []);
        const activeSelectionToken = getActiveSelectionTokenForActions();

        updateSelectionState((selection) => {
            if (activeSelectionToken) {
                if (currentSelected.size === 0) {
                    selection.selectedIds = new Set();
                    selection.scope = 'visible';
                    selection.filterKey = null;
                    selection.selectionToken = null;
                    selection.selectionTotal = 0;
                    return;
                }

                selection.selectedIds = new Set(currentSelected);
                selection.scope = 'filtered';
                selection.filterKey = filterKey;
                selection.selectionToken = null;
                selection.selectionTotal = currentSelected.size;
                return;
            }

            if (result.selectionToken) {
                selection.selectedIds = currentSelected;
                selection.scope = 'filtered';
                selection.filterKey = filterKey;
                selection.selectionToken = result.selectionToken;
                selection.selectionTotal = Number(result.total || 0);
                return;
            }

            const nextSelected = new Set(
                result.imageIds.filter((imageId) => !currentSelected.has(imageId))
            );
            selection.selectedIds = nextSelected;
            selection.scope = 'filtered';
            selection.filterKey = filterKey;
            selection.selectionToken = null;
            selection.selectionTotal = nextSelected.size;
        });

        if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
            Gallery.syncSelectionState();
        }
        resetSelectionDataCache();
        updateSelectionUI();
        emitSelectionStateChanged();
    } catch (error) {
        showToast(
            formatUserError(error, appT('selection.invertFilteredFailed', 'Failed to invert current filter matches')),
            'error'
        );
        updateSelectionUI();
    }
}

function ensureSelectionPanelVisible(panel) {
    const sidebar = document.querySelector('.filter-sidebar');
    if (!panel || !sidebar) return;

    const panelRect = panel.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const padding = 10;
    const viewportBottom = window.innerHeight || document.documentElement.clientHeight || sidebarRect.bottom;
    const visibleBottom = Math.min(sidebarRect.bottom, viewportBottom);
    const visibleTop = Math.max(sidebarRect.top, 0);

    if (panelRect.bottom > visibleBottom - padding) {
        sidebar.scrollTop += panelRect.bottom - visibleBottom + padding;
    } else if (panelRect.top < visibleTop + padding) {
        sidebar.scrollTop -= visibleTop + padding - panelRect.top;
    }
}

function setSelectionMode(enabled, options = {}) {
    const { clearSelectionWhenDisabled = true } = options;
    const nextMode = Boolean(enabled);
    updateSelectionState((selection) => {
        selection.selectionMode = nextMode;
        if (!nextMode && clearSelectionWhenDisabled) {
            selection.selectedIds = new Set();
            selection.scope = 'visible';
            selection.filterKey = null;
            selection.selectionToken = null;
            selection.selectionTotal = 0;
        }
    });

    if (!nextMode) {
        collapseSelectionMoreActions();
    }

    if (!nextMode && clearSelectionWhenDisabled && window.Gallery) {
        window.Gallery.lastSelectedIndex = null;
    }

    updateSelectionUI();
    emitSelectionStateChanged();

    if (window.Gallery && typeof Gallery.syncSelectionState === 'function') {
        Gallery.syncSelectionState();
    }
}

function openGalleryPreview(imageId) {
    switchView('gallery');
    requestAnimationFrame(() => {
        if (window.Gallery && typeof window.Gallery.openPreview === 'function') {
            window.Gallery.openPreview(imageId);
        }
    });
}

function applyPromptFilter(prompt) {
    const value = String(prompt ?? '').trim();
    if (!value) return false;

    updateAppFilters((filters) => {
        filters.prompts = [value];
    });

    if (typeof renderModalActivePrompts === 'function') {
        renderModalActivePrompts();
    }
    updateFilterSummary();
    if (typeof window.updateAutoSepSummary === 'function') window.updateAutoSepSummary();
    if (typeof window.invalidateAutoSepPreview === 'function') window.invalidateAutoSepPreview();
    if (typeof window.updateManualSortFilterSummary === 'function') window.updateManualSortFilterSummary();
    syncGenTabsWithFilters();
    switchView('gallery');
    loadImages();
    return true;
}

function resetViewScrollPosition() {
    const mainContent = document.getElementById('main-content');
    document.documentElement.style.overflowAnchor = 'none';
    document.body.style.overflowAnchor = 'none';
    if (mainContent) {
        mainContent.style.overflowAnchor = 'none';
        mainContent.scrollTop = 0;
    }
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    try {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    } catch (_error) {
        window.scrollTo(0, 0);
    }
}

function scheduleViewScrollReset() {
    resetViewScrollPosition();
    requestAnimationFrame(() => {
        resetViewScrollPosition();
        requestAnimationFrame(resetViewScrollPosition);
    });
    setTimeout(resetViewScrollPosition, 50);
    setTimeout(resetViewScrollPosition, 160);
    setTimeout(resetViewScrollPosition, 320);
    setTimeout(resetViewScrollPosition, 700);
}

