/**
 * Censor Editor - init + event wiring (split VERBATIM from censor-edit.js; god-file decomposition).
 * initCensorEdit entry, censor-owned modal open/close helpers, bindEvents master wiring incl. window.CensorEdit.addToQueue bridge.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
function initCensorEdit() {
    const { $, $$ } = window.App || { $: (s) => document.querySelector(s), $$: (s) => document.querySelectorAll(s) };

    // Re-attach resize listener if it was cleaned up
    if (!boundHandlers.resize) {
        boundHandlers.resize = _handleCensorResize;
        window.addEventListener('resize', _handleCensorResize);
    }

    // Warn before reload/close when the queue holds unsaved censoring work — the
    // in-memory queue and edits are not persisted, so an accidental F5 silently
    // discarded them. Mirrors the dataset-maker beforeunload guard (Chrome/Edge
    // need returnValue set as well as preventDefault). Registered once.
    if (!boundHandlers.beforeUnload) {
        boundHandlers.beforeUnload = (e) => {
            const hasUnsaved = Array.isArray(CensorState.queue) && CensorState.queue.some(
                (it) => it && it.batchStatus !== 'saved' && itemHasCensorContent(it)
            );
            if (hasUnsaved) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', boundHandlers.beforeUnload);
    }

    // Load saved settings (use optional chaining for elements that may not exist)
    const modelPathEl = $('#censor-model-path');
    const advancedToggleEl = $('#censor-show-advanced-models');
    const outputFolderEl = $('#save-output-folder'); // Changed from removed rename-output-folder
    if (CensorState.modelPath && modelPathEl) modelPathEl.value = CensorState.modelPath;
    if (advancedToggleEl) advancedToggleEl.checked = CensorState.showAdvancedLegacyModels;
    if (CensorState.outputFolder && outputFolderEl) outputFolderEl.value = CensorState.outputFolder;
    updateDetectionModelInputs();
    loadCensorModelStatus();

    // Only bind events once to prevent duplicate listeners
    if (!censorEventsInitialized) {
        bindEvents();
        initDragAndDrop();
        initZoomControls();
        initPanControls();
        censorEventsInitialized = true;
    }

    // QA P3-11: bring back the previous session's queue (composition only —
    // edits and processing state intentionally reset, see persistCensorQueue).
    const restoredCount = restoreCensorQueueFromStorage();
    if (restoredCount > 0) {
        renderQueue();
        window.App?.showToast?.(
            censorT('censor.queueRestored', { count: restoredCount }, 'Restored your last censor queue ({count} images). Canvas edits and processing state do not survive a reload.'),
            'info'
        );
    }

    updateUndoRedoButtons();
}

// Open/close censor-owned modals (#detect-modal, #rename-modal) through the
// shared modal helpers in app.js so they get the single shared focus-trap,
// Esc-to-close, and focus-restore behavior. Falls back to a raw class toggle
// only if the shared helper is somehow unavailable.
function openCensorModal(modalId) {
    if (typeof window.App?.showModal === 'function') {
        window.App.showModal(modalId);
    } else {
        document.getElementById(modalId)?.classList.add('visible');
    }
}

function closeCensorModal(modalId) {
    if (typeof window.App?.hideModal === 'function') {
        window.App.hideModal(modalId);
    } else {
        document.getElementById(modalId)?.classList.remove('visible');
    }
}

function refreshLocalizedCensorContent() {
    markRecommendedDetectorMode();
    renderQueue();
}

function bindEvents() {
    const { $, $$ } = window.App;

    // Clean up any existing global listeners first to prevent accumulation
    cleanupGlobalListeners();

    // Sidebar: Queue Actions — handled by consolidated clearQueueHandler below

    // 3-tab shell (画笔 / 调整 / 审核) + review conveyor controls.
    initCensorTabs();
    $('#btn-review-detect')?.addEventListener('click', censorReviewDetect);
    $('#btn-review-approve')?.addEventListener('click', censorReviewApprove);
    $('#btn-review-skip')?.addEventListener('click', () => censorReviewGoTo(1, { atEndMessage: true }));
    $('#btn-review-prev')?.addEventListener('click', () => censorReviewGoTo(-1));
    $('#btn-review-next')?.addEventListener('click', () => censorReviewGoTo(1));

    $('#btn-run-auto-censor')?.addEventListener('click', runAutoCensorBatch);
    $('#btn-batch-rename')?.addEventListener('click', () => {
        const onlySelectedCheckbox = document.getElementById('rename-only-selected');
        if (onlySelectedCheckbox) {
            onlySelectedCheckbox.checked = getOrderedSelectedQueueIds().length > 0;
        }
        refreshRenameSelectionUi();
        updateRenamePreview();
        openCensorModal('rename-modal');
    });

    // Detection Modal handlers
    $('#btn-open-detect-modal')?.addEventListener('click', async () => {
        openCensorModal('detect-modal');
        if (!CensorState.backendModelStatus) {
            renderCensorCapabilityPanel({ loading: true });
            await loadCensorModelStatus();
        }
        populateCensorModelSelect(getLegacyBackendStatus());
        updateDetectionModelInputs();
        renderCensorCapabilityPanel();
    });

    $('#btn-close-detect-modal')?.addEventListener('click', () => {
        closeCensorModal('detect-modal');
    });

    // Close modal when clicking backdrop
    $('#detect-modal .modal-backdrop')?.addEventListener('click', () => {
        closeCensorModal('detect-modal');
    });

    // Rename Modal
    $('#btn-cancel-rename')?.addEventListener('click', () => closeCensorModal('rename-modal'));
    $('#btn-close-rename')?.addEventListener('click', () => closeCensorModal('rename-modal'));
    $('#btn-apply-rename')?.addEventListener('click', applyBatchRename);

    // Live preview for rename
    $('#rename-base')?.addEventListener('input', updateRenamePreview);
    $('#rename-start')?.addEventListener('input', updateRenamePreview);
    $('#rename-pattern')?.addEventListener('input', updateRenamePreview);
    $('#rename-only-selected')?.addEventListener('change', () => {
        refreshRenameSelectionUi();
        updateRenamePreview();
    });

    // Properties Panel
    $('#censor-model-path')?.addEventListener('change', (e) => {
        CensorState.modelPath = String(e.target.value || '').trim();
        const modelFileEl = $('#censor-model-file');
        if (modelFileEl && modelFileEl.value !== CensorState.modelPath) {
            modelFileEl.value = '';
        }
        localStorage.setItem('censor_model_path', CensorState.modelPath);
        const legacy = (CensorState.backendModelStatus?.models || []).find(model => model.id === 'legacy');
        updateSelectedLegacyModelHelp(legacy);
        renderCensorCapabilityPanel();
    });

    $('#censor-model-file')?.addEventListener('change', (e) => {
        const selectedPath = String(e.target.value || '').trim();
        CensorState.modelPath = selectedPath;
        const modelPathInput = $('#censor-model-path');
        if (modelPathInput) {
            modelPathInput.value = '';
        }
        localStorage.setItem('censor_model_path', CensorState.modelPath);
        const legacy = (CensorState.backendModelStatus?.models || []).find(model => model.id === 'legacy');
        updateSelectedLegacyModelHelp(legacy);
        renderCensorCapabilityPanel();
    });

    $('#censor-show-advanced-models')?.addEventListener('change', (e) => {
        CensorState.showAdvancedLegacyModels = Boolean(e.target.checked);
        localStorage.setItem('censor_show_advanced_models', CensorState.showAdvancedLegacyModels ? '1' : '0');
        const legacy = (CensorState.backendModelStatus?.models || []).find(model => model.id === 'legacy');
        populateCensorModelSelect(legacy);
        updateDetectionModelInputs();
        syncAdvancedLegacyModelUi(legacy);
    });

    $('#censor-confidence')?.addEventListener('input', (e) => {
        CensorState.confidence = parseFloat(e.target.value);
        const display = CensorState.confidence.toFixed(2);
        const modalVal = $('#censor-confidence-value');
        const sidebarVal = $('#censor-confidence-value-sidebar');
        if (modalVal) modalVal.textContent = display;
        if (sidebarVal) sidebarVal.textContent = display;
        const sidebarSlider = $('#censor-confidence-sidebar');
        if (sidebarSlider) sidebarSlider.value = e.target.value;
    });

    $('#censor-model-type')?.addEventListener('change', () => {
        updateDetectionModelInputs();
        const legacy = (CensorState.backendModelStatus?.models || []).find(model => model.id === 'legacy');
        updateSelectedLegacyModelHelp(legacy);
        renderCensorCapabilityPanel();
    });

    // i18n resets detector labels and cannot translate JS-created outcome
    // badges in place. Refresh both after applyToDOM() has finished.
    document.addEventListener('languageChanged', refreshLocalizedCensorContent);

    $('#censor-style')?.addEventListener('change', (e) => CensorState.style = e.target.value);

    $('#censor-block-size')?.addEventListener('input', (e) => {
        CensorState.blockSize = parseInt(e.target.value, 10) || 16;
        $('#censor-block-size-value').textContent = CensorState.blockSize;
    });

    // Checkboxes
    $$('.target-region-check').forEach(cb => {
        cb.addEventListener('change', () => {
            CensorState.targetClasses = Array.from($$('.target-region-check:checked')).map(c => c.value);
        });
    });

    // Tools (support both v1 and v2 class names)
    $$('.tool-btn[data-tool], .tool-btn-v2[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    $('#btn-undo')?.addEventListener('click', undo);
    $('#btn-redo')?.addEventListener('click', redo);

    // Consolidated Clear Queue
    const clearQueueHandler = () => {
        if (!hasCensorQueueWork()) return;
        window.App.showConfirm(
            censorT('modal.confirm', null, 'Are you sure?'),
            censorT('modal.confirmAction', null, 'This action cannot be undone.'),
            () => {
                CensorState.queue = [];
                CensorState.tokenQueueSource = null;
                CensorState.activeId = null;
                CensorState.pendingActiveId = null;
                CensorState.selectedItems.clear();
                CensorState.lastSelectedIndex = -1;
                CensorState.undoStack = [];
                CensorState.redoStack = [];
                CensorState.baseCanvasState = null;
                CensorState.baseItemState = null;
                CensorState.filterActionUndoStack = [];
                CensorState.filterActionRedoStack = [];
                CensorState.lastHistorySource = null;
                CensorState.originalImage = null;
                CensorState.originalImageData = null;
                CensorState.activeImagePixels = 0;
                CensorState.lowMemoryMode = false;
                CensorState.preChangesData = null;
                CensorState.showingChanges = false;
                renderQueue();
                clearCanvas();
                window.App.showToast(censorT('censor.queueCleared', null, 'Queue cleared'), 'success');
            }
        );
    };

    $('#btn-clear-queue')?.addEventListener('click', clearQueueHandler);
    $('#btn-clear-selected')?.addEventListener('click', clearQueueHandler);
    $('#btn-queue-move-top')?.addEventListener('click', () => moveQueueSelection('top'));
    $('#btn-queue-move-up')?.addEventListener('click', () => moveQueueSelection('up'));
    $('#btn-queue-move-down')?.addEventListener('click', () => moveQueueSelection('down'));
    $('#btn-queue-move-bottom')?.addEventListener('click', () => moveQueueSelection('bottom'));

    // Canvas Interactions
    const wrapper = $('#canvas-wrapper');
    if (wrapper) {
        wrapper.addEventListener('mousedown', onCanvasMouseDown);
        // Store references to global handlers so they can be removed later
        boundHandlers.mousemove = onCanvasMouseMove;
        boundHandlers.mouseup = onCanvasMouseUp;
        window.addEventListener('mousemove', boundHandlers.mousemove);
        window.addEventListener('mouseup', boundHandlers.mouseup);
        wrapper.addEventListener('mouseenter', updateCursorOverlay);
        wrapper.addEventListener('mouseleave', () => $('#cursor-overlay').style.display = 'none');
        wrapper.addEventListener('contextmenu', e => e.preventDefault());
    }

    // Actions
    $('#btn-censor-detect-single')?.addEventListener('click', () => {
        if (CensorState.activeId) runDetectionForImage(CensorState.queue.find(i => i.id === CensorState.activeId));
    });

    // Save All - opens options popup first
    $('#btn-save-all-processed')?.addEventListener('click', openSaveOptionsPopup);
    $('#btn-close-save-options')?.addEventListener('click', () => $('#save-options-modal')?.classList.remove('visible'));
    $('#btn-cancel-save-options')?.addEventListener('click', () => $('#save-options-modal')?.classList.remove('visible'));
    $('#btn-confirm-save-options')?.addEventListener('click', confirmAndSaveAll);

    // New button handlers
    $('#btn-auto-detect-current')?.addEventListener('click', () => {
        if (CensorState.activeId) {
            runDetectionForImage(CensorState.queue.find(i => i.id === CensorState.activeId));
        } else {
            window.App.showToast(censorT('censor.noImageSelected', null, 'No image selected'), 'error');
        }
    });

    $('#btn-auto-detect-current-modal')?.addEventListener('click', () => {
        if (CensorState.activeId) {
            closeCensorModal('detect-modal');
            runDetectionForImage(CensorState.queue.find(i => i.id === CensorState.activeId));
        } else {
            window.App.showToast(censorT('censor.noImageSelected', null, 'No image selected'), 'error');
        }
    });

    $('#btn-auto-detect-all-modal')?.addEventListener('click', () => {
        closeCensorModal('detect-modal');
        runDetectionForAll();
    });

    // Sidebar "Detect All" button
    $('#btn-auto-detect-all-sidebar')?.addEventListener('click', () => {
        runDetectionForAll();
    });

    // SAM3 common words popup
    $('#btn-sam3-common-words')?.addEventListener('click', () => {
        _showSam3CommonWordsPopup();
    });

    // SAM3 Batch Refine button
    $('#btn-sam3-batch-refine')?.addEventListener('click', async () => {
        closeCensorModal('detect-modal');
        await runSam3BatchRefine();
    });

    // Surfaced "Refine all with SAM3" in the Auto Detect sidebar card
    $('#btn-sam3-refine-all-sidebar')?.addEventListener('click', async () => {
        await runSam3BatchRefine();
    });

    // Mask shape: precise pixel mask (YOLO-seg / SAM3 polygon) vs box rectangle.
    // Stored choice applies on the next detect (mirrors the confidence control).
    const maskShapeSelect = $('#censor-mask-shape');
    if (maskShapeSelect) {
        maskShapeSelect.value = CensorState.maskShape;
        maskShapeSelect.addEventListener('change', (e) => {
            CensorState.maskShape = e.target.value === 'box' ? 'box' : 'precise';
            try { localStorage.setItem('censor_mask_shape', CensorState.maskShape); } catch (_) {}
        });
    }

    // SAM3 confidence sliders (sync sidebar and modal)
    $('#sam3-confidence')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        CensorState.sam3Confidence = val;
        const display = val.toFixed(2);
        const sidebarVal = $('#sam3-confidence-value');
        const modalVal = $('#sam3-confidence-modal-value');
        if (sidebarVal) sidebarVal.textContent = display;
        if (modalVal) modalVal.textContent = display;
        const modalSlider = $('#sam3-confidence-modal');
        if (modalSlider && modalSlider !== e.target) modalSlider.value = val;
    });

    $('#sam3-confidence-modal')?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        CensorState.sam3Confidence = val;
        const display = val.toFixed(2);
        const sidebarVal = $('#sam3-confidence-value');
        const modalVal = $('#sam3-confidence-modal-value');
        if (sidebarVal) sidebarVal.textContent = display;
        if (modalVal) modalVal.textContent = display;
        const sidebarSlider = $('#sam3-confidence');
        if (sidebarSlider && sidebarSlider !== e.target) sidebarSlider.value = val;
    });

    // Sidebar confidence slider (sync with modal)
    $('#censor-confidence-sidebar')?.addEventListener('input', (e) => {
        CensorState.confidence = parseFloat(e.target.value);
        const display = CensorState.confidence.toFixed(2);
        const sidebarVal = $('#censor-confidence-value-sidebar');
        const modalVal = $('#censor-confidence-value');
        if (sidebarVal) sidebarVal.textContent = display;
        if (modalVal) modalVal.textContent = display;
        const modalSlider = $('#censor-confidence');
        if (modalSlider) modalSlider.value = e.target.value;
    });

    // Queue management buttons
    $('#btn-queue-select-all')?.addEventListener('click', () => {
        CensorState.selectedItems = new Set(CensorState.queue.map(item => item.id));
        CensorState.lastSelectedIndex = CensorState.queue.length - 1;
        updateQueueSelection();
        window.App.showToast(censorT('censor.queueSelectedAll', null, 'Selected the whole queue'), 'info');
    });

    $('#btn-queue-deselect-all')?.addEventListener('click', () => {
        CensorState.selectedItems.clear();
        CensorState.lastSelectedIndex = -1;
        updateQueueSelection();
    });

    // Queue filter toggle
    $('#btn-queue-filter')?.addEventListener('click', () => {
        const filterRow = $('#queue-filter-row');
        if (filterRow) {
            const isVisible = filterRow.style.display !== 'none';
            filterRow.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                const filterInput = $('#queue-filter-input');
                if (filterInput) filterInput.focus();
            }
        }
    });

    $('#queue-filter-input')?.addEventListener('input', (e) => {
        const filterText = String(e.target.value || '').toLowerCase().trim();
        document.querySelectorAll('.queue-thumb-v2').forEach(thumb => {
            const itemTitle = String(thumb.title || '').toLowerCase();
            const queueItem = thumb.closest('.queue-thumb-shell-v2') || thumb;
            queueItem.style.display = (!filterText || itemTitle.includes(filterText)) ? '' : 'none';
        });
    });

    $('#btn-censor-empty-open-gallery')?.addEventListener('click', () => {
        if (typeof window.App?.switchView === 'function') {
            window.App.switchView('gallery');
        }
    });

    $('#btn-open-queue-manager')?.addEventListener('click', openQueueManager);
    $('#btn-close-queue-manager')?.addEventListener('click', closeQueueManager);
    $('#btn-close-queue-manager-footer')?.addEventListener('click', closeQueueManager);
    $('#btn-queue-manager-select-all')?.addEventListener('click', () => {
        CensorState.selectedItems = new Set(CensorState.queue.map(item => item.id));
        CensorState.lastSelectedIndex = CensorState.queue.length - 1;
        updateQueueSelection();
    });
    $('#btn-queue-manager-deselect-all')?.addEventListener('click', () => {
        CensorState.selectedItems.clear();
        CensorState.lastSelectedIndex = -1;
        updateQueueSelection();
    });
    $('#queue-manager-search')?.addEventListener('input', (e) => {
        CensorState.queueManagerSearch = String(e.target.value || '');
        renderQueueManager();
    });
    $('#queue-manager-show-selected')?.addEventListener('change', (e) => {
        CensorState.queueManagerShowSelectedOnly = Boolean(e.target.checked);
        renderQueueManager();
    });
    $('#btn-queue-manager-move-top')?.addEventListener('click', () => moveQueueSelection('top'));
    $('#btn-queue-manager-move-up')?.addEventListener('click', () => moveQueueSelection('up'));
    $('#btn-queue-manager-move-down')?.addEventListener('click', () => moveQueueSelection('down'));
    $('#btn-queue-manager-move-bottom')?.addEventListener('click', () => moveQueueSelection('bottom'));
    $('#btn-queue-manager-move-position')?.addEventListener('click', () => {
        const input = document.getElementById('queue-manager-position');
        const rawValue = Number.parseInt(String(input?.value || ''), 10);
        moveQueueSelectionToPosition(rawValue);
    });

    // Queue Manager: Batch rename selected
    $('#btn-queue-manager-batch-rename')?.addEventListener('click', () => {
        const onlySelectedCheckbox = document.getElementById('rename-only-selected');
        if (onlySelectedCheckbox) {
            onlySelectedCheckbox.checked = true;
        }
        populateRenamePreview();
        openCensorModal('rename-modal');
    });

    // Queue Manager: Remove selected from queue
    $('#btn-queue-manager-remove-selected')?.addEventListener('click', () => {
        const selectedIds = getOrderedSelectedQueueIds();
        if (!selectedIds.length) {
            window.App?.showToast?.(censorT('censor.selectItemsFirst', null, 'Select items first'), 'warning');
            return;
        }
        const selectedSet = new Set(selectedIds);
        CensorState.queue = CensorState.queue.filter(item => !selectedSet.has(item.id));
        CensorState.selectedItems.clear();
        renderQueue();
        renderQueueManager();
        window.App?.showToast?.(
            censorT('censor.removedItems', { count: selectedIds.length }, 'Removed {count} items'),
            'success'
        );
    });

    $('#btn-segment-text-current')?.addEventListener('click', async () => {
        closeCensorModal('detect-modal');
        await segmentCurrentImageByText();
    });

    $('#btn-clear-edits')?.addEventListener('click', () => {
        if (!CensorState.activeId || !CensorState.originalImage) {
            window.App.showToast(censorT('censor.noImageToReset', null, 'No image to reset'), 'error');
            return;
        }
        window.App.showConfirm(
            censorT('censor.resetEditsTitle', null, 'Reset All Edits'),
            censorT('censor.resetEditsConfirm', null, 'This will revert all edits to the original image. Continue?'),
            clearAllEdits
        );
    });

    $('#btn-show-changes')?.addEventListener('click', toggleShowChanges);

    // Pen/Brush settings
    $('#pen-color')?.addEventListener('input', (e) => {
        CensorState.penColor = e.target.value;
    });

    $('#pen-opacity')?.addEventListener('input', (e) => {
        CensorState.penOpacity = (parseInt(e.target.value, 10) || 100) / 100;
        $('#pen-opacity-value').textContent = e.target.value + '%';
    });

    $('#tool-size')?.addEventListener('input', (e) => {
        CensorState.brushSize = parseInt(e.target.value, 10) || 50;
        $('#tool-size-value').textContent = e.target.value;
    });

    // Metadata option
    $('#censor-metadata-option')?.addEventListener('change', (e) => {
        CensorState.metadataOption = e.target.value;
    });

    // Use Original Filename toggle - hide/show custom name fields
    $('#rename-use-original')?.addEventListener('change', (e) => {
        const customGroup = $('#rename-custom-group');
        const startGroup = document.getElementById('rename-start')?.parentElement;
        if (customGroup) customGroup.style.display = e.target.checked ? 'none' : 'block';
        if (startGroup) startGroup.style.display = e.target.checked ? 'none' : 'block';
        refreshRenameSelectionUi();
        updateRenamePreview();
    });

    // Single rename button
    $('#btn-rename-single')?.addEventListener('click', promptSingleRename);

    // Browse model path button (opens prompt since browser can't access filesystem directly)
    $('#btn-browse-model')?.addEventListener('click', async () => {
        const path = await window.App.showInputModal(
            'YOLO Model Path',
            'Enter the full path to your YOLO model (.pt or .onnx)',
            CensorState.modelPath
        );
        if (path !== null) {
            CensorState.modelPath = path;
            const modelFileEl = $('#censor-model-file');
            if (modelFileEl) modelFileEl.value = '';
            $('#censor-model-path').value = path;
            localStorage.setItem('censor_model_path', path);
            const legacy = getLegacyBackendStatus();
            updateSelectedLegacyModelHelp(legacy);
            renderCensorCapabilityPanel();
        }
    });

    // Keybinds - track for cleanup
    boundHandlers.keydown = handleKeydown;
    document.addEventListener('keydown', boundHandlers.keydown);

    // Add to Queue bridge for Gallery/App without mutating window.App.
    window.CensorEdit = window.CensorEdit || {};
    window.CensorEdit.addToQueue = async (imageIds) => {
        const tokenSource = normalizeTokenQueueSourcePayload(imageIds);
        if (tokenSource) {
            return addTokenBackedQueue(tokenSource);
        }

        const { API } = window.App;
        switchToCensorView();

        const requestedIds = normalizeCensorImageIds(imageIds);
        const queueIds = new Set(CensorState.queue.map((item) => item.id));
        const idsToFetch = requestedIds.filter((id) => !queueIds.has(id) && !CensorState.pendingQueueIds.has(id));

        if (!idsToFetch.length) {
            if (!CensorState.activeId && CensorState.queue.length > 0) {
                setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
            }
            return true;
        }

        idsToFetch.forEach((id) => CensorState.pendingQueueIds.add(id));
        const nextItems = [];
        const failedIds = [];
        try {
            const selectionLoader = window.App?.loadSelectionData;

            if (typeof selectionLoader === 'function') {
                const payload = await selectionLoader(idsToFetch);
                const detailMap = new Map((payload?.images || []).map((image) => [image.id, image]));

                idsToFetch.forEach((id) => {
                    CensorState.pendingQueueIds.delete(id);
                    const image = detailMap.get(id);
                    const item = buildCensorQueueItemFromImage({ ...image, id });
                    if (!item) {
                        failedIds.push(id);
                        return;
                    }

                    nextItems.push(item);
                });
            } else {
                const settled = await Promise.allSettled(idsToFetch.map((id) => API.getImage(id)));

                settled.forEach((entry, index) => {
                    const id = idsToFetch[index];
                    CensorState.pendingQueueIds.delete(id);

                    if (entry.status !== 'fulfilled' || !entry.value?.image) {
                        failedIds.push(id);
                        return;
                    }

                    const item = buildCensorQueueItemFromImage({ ...entry.value.image, id });
                    if (item) nextItems.push(item);
                    else failedIds.push(id);
                });
            }
        } catch (error) {
            idsToFetch.forEach((id) => {
                CensorState.pendingQueueIds.delete(id);
                failedIds.push(id);
            });
        }

        if (nextItems.length) {
            CensorState.queue.push(...nextItems);
            renderQueue();
            if (!CensorState.activeId && CensorState.queue.length > 0) {
                setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
            }
        }

        if (failedIds.length) {
            window.App?.showToast?.(
                censorT('censor.queueAddFailed', {
                    count: failedIds.length,
                }, 'Failed to queue {count} image(s) for Censor.'),
                'error'
            );
        }
        return failedIds.length === 0;
    };

    // Collapse toggle listener for sections
    document.addEventListener('click', (e) => {
        const header = e.target.closest('.section-header');
        if (header) {
            const sectionId = header.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
            if (sectionId) {
                toggleSection(sectionId);
                e.stopPropagation();
            } else {
                // If no onclick attribute with ID, look for ID on the content element next to it
                const content = header.nextElementSibling;
                if (content && content.classList.contains('section-content')) {
                    header.parentElement.classList.toggle('collapsed');
                }
            }
        }
    });
}

