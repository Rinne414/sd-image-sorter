/**
 * SD Image Sorter - application boot.
 *
 * The former 14k-line god file. Everything else was decomposed VERBATIM
 * into the frontend/js/app/ module family (static script tags in
 * index.html, dependency order, one shared classic-script global lexical
 * environment — see the 2026-07 split stages 1-6). What remains here is
 * the wiring that must run last: initEventListeners (a thin composer
 * over the app/boot-listeners-* binders), the two DOMContentLoaded boot
 * blocks, and buildAppContext() + Object.seal(window.App) — the one
 * place the sealed public surface is assembled. This file must stay a real servable asset
 * (test_cache_bust GETs /static/js/app.js) and contract tests read the
 * whole family via _app_family_source().
 */

// ============== Event Listeners ==============

// Binder bodies live in app/boot-listeners-{shell,gallery}.js (the
// 923-line original broke the 800-line file cap). Registration ORDER is
// load-bearing: shell first, gallery second — the original body order.
function initEventListeners() {
    initBootListenersShell();
    initBootListenersGallery();
}

document.addEventListener('DOMContentLoaded', () => {
    initMissingFilterMarkup();
    initEventListeners();
    initInputModal();

    // Add pulse indicator to Setup button if user has never clicked it
    if (!localStorage.getItem('sd-image-sorter-setup-clicked')) {
        const setupBtn = $('#btn-open-model-manager');
        if (setupBtn) setupBtn.classList.add('setup-pulse');
    }
    initGlobalKeyboardShortcuts();
    initGalleryDropZone();
    loadTaggerModels();
    setTaggingUiState(false);
    setGalleryViewMode(AppState.viewMode);
    updateSortReverseButton();
    syncGallerySortLabels();
    switchView('gallery');
    loadStats();
    const aestheticStatusReady = refreshAestheticStatus();
    updateFilterSummary();
    syncAspectToggleWithFilters();
    updateSelectionUI();
    resumeScanProgress();
    resumeReconnectProgress();
    resumeTaggingProgress();
    // v3.3.0 FEAT-COLLECTIONS: hydrate favorite hearts once on load.
    window.Gallery?.hydrateFavorites?.();
    // v3.3.1 FEAT-COLLECTIONS: render the sidebar Collections section.
    window.CollectionsUI?.init?.();
    // v3.3.2 Library Navigation: render the sidebar Folders tree.
    window.FolderTreeUI?.init?.();
    // Smart Folders v1: render pinned filter presets with live counts.
    window.SmartFoldersUI?.init?.();
    // v3.3.2 Library Navigation: wire the library-roots management modal (Phase D).
    window.LibraryRootsUI?.init?.();
    _initBgTagProgressButtons();
    _initBgScanProgressButtons();
    _initBgReconnectProgressButtons();
    document.addEventListener('languageChanged', refreshLocalizedDynamicUi);
    document.addEventListener('languageChanged', () => setUpdateButtonState(AppState.update.status, AppState.update.checking));
    setUpdateButtonState();

    // Initialize gallery keyboard navigation for accessibility
    if (window.Gallery && typeof window.Gallery.initKeyboardNavigation === 'function') {
        window.Gallery.initKeyboardNavigation();
    }

    // Initialize Censor Edit module so addToCensorQueue is available from Gallery
    // Note: do NOT init here - initCensorEdit is called when user switches to censor view
    // to prevent mousemove/keydown listeners being attached while another view is active

    // Load More button — visible fallback for infinite scroll
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => loadMoreImages());
    }

    // Setup event listeners for buttons that previously had inline onclick
    const returnToGalleryBtn = document.getElementById('return-to-gallery-btn');
    if (returnToGalleryBtn) {
        returnToGalleryBtn.addEventListener('click', () => switchView('gallery'));
    }

    window.addEventListener('resize', () => {
        _onGalleryScroll();
        updateNavigationOverflowState();
        syncGeneratorRailOverflow();
    }, { passive: true });
    document.addEventListener('languageChanged', () => {
        updateNavigationOverflowState();
        syncGeneratorRailOverflow();
    });
    updateNavigationOverflowState();
    syncGeneratorRailOverflow();
    window.addEventListener('load', updateNavigationOverflowState, { once: true });
    window.addEventListener('load', syncGeneratorRailOverflow, { once: true });
    document.fonts?.ready?.then?.(() => {
        updateNavigationOverflowState();
        syncGeneratorRailOverflow();
    }).catch?.(() => {});
    Promise.resolve(aestheticStatusReady).finally(() => {
        document.documentElement.dataset.appReady = '1';
        window.dispatchEvent(new Event('sd-image-sorter-ready'));
    });
});

function buildAppContext() {
    return {
        API,
        Prefs: AppPreferences,
        AppState,
        showToast,
        createGuideOverlay,
        copyTextToClipboard,
        showModal,
        hideModal,
        showInputModal,
        showGlobalLoading,
        hideGlobalLoading,
        createProgressTracker,
        resetProgressTracker,
        updateProgressTracker,
        buildProgressText,
        formatDurationCompact,
        formatSize,
        loadImages,
        loadStats,
        // Attach the shared tagging progress UI (modal container + floating
        // top bar) to a tagging job started by another module (e.g. Dataset
        // Maker "Tag all"). Probes /api/tag/progress and re-uses the exact
        // same poll loop as the gallery Start-Tag button.
        beginTaggingProgress: resumeTaggingProgress,
        refreshAestheticStatus,
        updateSelectionUI,
        emitSelectionStateChanged,
        getSelectedGalleryCount,
        isFilteredSelectionActiveForCurrentFilters,
        isFilteredSelectionTokenRefreshPending,
        updateFilteredSelectionExclusions,
        showConfirm,
        showRandomImage,
        showAnalytics,
        showExportModal,
        showExportTagsModal,
        moveOrCopyGalleryImages,
        updateCollapsibleFilterUI,
        openModelSelect,
        renderModelSelectList,
        confirmModelSelection,
        updateModelSelectionSummaries,
        openFilterModal,
        applyModalFilters,
        resetAllFilters,
        updateFilterSummary,
        syncGenTabsWithFilters,
        normalizePromptMatchMode,
        createDefaultFilterState,
        cloneFilterState,
        copyFilterState,
        buildSelectionFilterRequest,
        getSelectionFilterCacheKey,
        buildAdvancedFilterContract,
        getAdvancedFilterContractSignature,
        normalizeCheckpointFilterValue,
        FilterStore: AppFilterStore,
        setFilters: setAppFilters,
        updateFilters: updateAppFilters,
        createDefaultSelectionState,
        cloneSelectionState,
        SelectionStore: AppSelectionStore,
        setSelectionState,
        updateSelectionState,
        mutateSelectedIds,
        clearSelectedIds,
        setSelectionMode,
        updateSortReverseButton,
        syncGallerySortLabels,
        formatGeneratorLabel,
        loadSelectionData,
        loadSelectionDataByToken,
        resetSelectionDataCache,
        markGalleryNeedsRefresh,
        openTagsLibrary,
        switchLibraryTab,
        filterLibraryContent,
        switchView,
        openVlmSettings,
        openColorAnalysis,
        openGalleryPreview,
        applyPromptFilter,
        applyTagFiltersFromExternal,
        // Expose the canonical modal closer so cross-module callers (gallery.js
        // checkpoint/LoRA click-to-filter, FLOW-03 preview handoffs) can close
        // #image-modal. Previously these called window.App.closeModal, which was
        // undefined — a latent no-op. `closeModal` is an alias of hideModal.
        closeModal: hideModal,
        hideModal,
        showPipelineNextStep,
        hidePipelineNextStep,
        addToCensorQueue,
        sendToCensor: addToCensorQueue,
        addToDatasetMaker,
        openPromptBuildFromImage,
        openReaderFromImage,
        openSimilarFromImage,
        deleteGalleryImagesByIds,
        removeGalleryImagesByIds,
        addRecentFolder,
        getRecentFolders,
        beginAutoRefreshScanProgress,
        beginLibraryRescanScanProgress,
        updateScanDiagnosticsCard,
        copyScanDiagnostics,
        openScanLogFile,
        clampTaggerChunkToAvailableOption,
        syncSettingsPreferenceStatus,
        persistArtistDefaultsFromDom,
        $,
        $$
    };
}

// Export for other modules
window.App = buildAppContext();
Object.seal(window.App);
window.clampTaggerChunkToAvailableOption = clampTaggerChunkToAvailableOption;


// ============== Empty State CTA Handlers ==============

// Connect empty state scan button
document.addEventListener('DOMContentLoaded', () => {
    const emptyStateScanBtn = document.getElementById('empty-state-scan-btn');
    if (emptyStateScanBtn) {
        emptyStateScanBtn.addEventListener('click', () => {
            showModal('scan-modal');
        });
    }
});
