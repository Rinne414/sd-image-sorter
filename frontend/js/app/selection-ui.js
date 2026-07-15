/**
 * app/selection-ui.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 6884-6975 (of 10,152): updateSelectionUI (selection panel/FAB state).
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function updateSelectionUI() {
    const panel = $('#selection-actions');
    const countEl = $('#selection-count');
    const scopeEl = $('#selection-scope-summary');
    const grid = $('#gallery-grid');
    const selectedCount = getSelectedGalleryCount();
    const hasSelection = selectedCount > 0;
    const selectionPanelVisible = AppState.selectionMode && AppState.currentView === 'gallery';
    const tokenRefreshPending = isFilteredSelectionTokenRefreshPending();
    const canRunBatchActions = selectionPanelVisible && hasSelection && !tokenRefreshPending;
    const buttonIds = [
        'btn-move-selected',
        'btn-copy-selected',
        'btn-export-selected',
        'btn-batch-export-tags',
        'btn-send-to-censor',
        'btn-send-selection-to-dataset-maker',
        'btn-add-selected-to-collection',
        'btn-publish-selected',
        'btn-remove-selected-gallery',
        'btn-delete-selected-files'
    ];

    syncSelectionModeButton();

    if (grid) {
        grid.classList.toggle('selection-mode', !!AppState.selectionMode);
    }

    // Aurora Phase 3: stamp pick-order numbers onto selected tiles (♥ N badge).
    if (window.GallerySelectionBadges) {
        window.GallerySelectionBadges.refresh(AppState);
    }

    // Aurora Phase 3: sticky bottom action bar visibility + stats line.
    if (window.GalleryToolbar) {
        window.GalleryToolbar.syncActionBar({
            visible: canRunBatchActions,
            selectedCount,
            tokenScoped: !!AppState.selectionToken,
        });
    }

    // In gallery selection mode, keep the browse/filter sections visible so users
    // can select images across different filters; the batch-action panel is pinned
    // to the sidebar bottom (see .filter-sidebar.selection-mode in ui-refresh.css).
    const filterSidebar = $('.filter-sidebar');
    if (filterSidebar) {
        filterSidebar.classList.toggle('selection-mode', selectionPanelVisible);
    }

    const selectAllBtn = $('#btn-select-all');
    if (selectAllBtn) {
        selectAllBtn.disabled = tokenRefreshPending
            || !selectionPanelVisible
            || (AppState.pagination.total || 0) === 0;
    }

    const invertFilteredBtn = $('#btn-invert-selection-filtered');
    if (invertFilteredBtn) {
        invertFilteredBtn.disabled = tokenRefreshPending
            || !selectionPanelVisible
            || (AppState.pagination.total || 0) === 0;
    }

    const clearSelectionBtn = $('#btn-clear-selection');
    if (clearSelectionBtn) {
        clearSelectionBtn.disabled = !selectionPanelVisible || !hasSelection;
    }

    buttonIds.forEach((id) => {
        const button = document.getElementById(id);
        if (button) {
            button.disabled = !canRunBatchActions;
        }
    });

    if (selectionPanelVisible && panel) {
        panel.style.display = 'grid';
        if (countEl) {
            countEl.textContent = hasSelection
                ? (window.I18n?.t?.('selection.count', { count: selectedCount }) || `${selectedCount} items selected`)
                : (window.I18n?.t?.('selection.emptyHint') || 'Select images, or choose all current filter matches.');
        }
        if (scopeEl) {
            scopeEl.textContent = getSelectionScopeSummaryText();
        }
        if (!hasSelection) {
            collapseSelectionMoreActions();
        }
        requestAnimationFrame(() => ensureSelectionPanelVisible(panel));
    } else if (panel) {
        panel.style.display = 'none';
        collapseSelectionMoreActions();
    }
}

