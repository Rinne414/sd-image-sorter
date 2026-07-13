/**
 * autosep/init.js — autosep.js decomposition.
 * Extracted VERBATIM (byte-identical) from frontend/js/autosep.js, pre-split
 * lines 355-489 + 1459-1464: initAutoSeparate (all DOM wiring; the
 * operation-radio handler literal is pinned by test_frontend_contract's
 * critical-action-settings test) plus the DOMContentLoaded →
 * initAutoSeparate boot, colocated with the function it invokes. Classic
 * script: the listener is registered at parse time and fires after every
 * family file has executed, so all cross-file callees are defined.
 */
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

// ============== Initialize ==============

document.addEventListener('DOMContentLoaded', () => {
    initAutoSeparate();
});

