/**
 * SD Image Sorter - Censor Edit Module (Overhauled)
 * Queue-based workflow with professional editing tools.
 */

const CENSOR_UNDO_DEFAULT_DEPTH = 20;
const CENSOR_UNDO_MIN_DEPTH = 5;
const CENSOR_UNDO_MAX_DEPTH = 200;

function getCensorUndoDepth() {
    const raw = parseInt(localStorage.getItem('censor_undo_depth'), 10);
    if (!Number.isFinite(raw)) return CENSOR_UNDO_DEFAULT_DEPTH;
    return Math.max(CENSOR_UNDO_MIN_DEPTH, Math.min(CENSOR_UNDO_MAX_DEPTH, raw));
}

const CensorState = {
    // Queue of { id, originalFilename, outputFilename, originalUrl, currentDataUrl, regions, isProcessed, isModified }
    queue: [],
    pendingQueueIds: new Set(),
    activeId: null, // ID of currently edited image
    selectedItems: new Set(), // IDs of selected items for multi-select
    lastSelectedIndex: -1, // Last clicked index for shift-select range

    // Tools
    currentTool: 'brush', // brush, pen, eraser, clone
    brushSize: 30,
    isDrawing: false,
    lastPoint: null,

    // Pen tool properties
    penColor: '#ff0000',
    penOpacity: 1.0,

    // Canvas
    scale: 1,
    pan: { x: 0, y: 0 },
    originalImage: null,  // HTMLImageElement
    originalImageData: null, // ImageData for reset/compare

    // Clone tool state
    cloneSource: null,
    cloneOffset: null,
    cloneSourceSet: false, // Whether source has been set with Alt+click

    // Show changes state
    showingChanges: false,
    preChangesData: null, // Stores canvas state before showing changes

    // Undo/Redo
    undoStack: [],
    redoStack: [],
    baseCanvasState: null,
    baseItemState: null,
    filterActionUndoStack: [],
    filterActionRedoStack: [],
    lastHistorySource: null,

    // Config
    modelPath: localStorage.getItem('censor_model_path') || '',
    showAdvancedLegacyModels: localStorage.getItem('censor_show_advanced_models') === '1',
    availableLegacyModels: [],
    backendModelStatus: null,
    modelStatusLoading: false,
    modelStatusError: '',
    outputFolder: localStorage.getItem('censor_output_folder') || '',
    confidence: 0.5,
    style: 'mosaic',
    blockSize: 16,
    targetClasses: ['breasts', 'pussy', 'dick', 'penis', 'anus', 'buttocks'], // Covers the main privacy classes used by Wenaka + NudeNet
    metadataOption: 'keep', // 'keep', 'minimal', or 'strip'
    outputFormat: 'png', // 'png', 'jpg', or 'webp'
    sam3Confidence: 0.5, // SAM3 confidence threshold

    // Queue Manager
    queueManagerSearch: '',
    queueManagerShowSelectedOnly: false,
};

if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__CENSOR_STATE__ = CensorState;
}

// Track bound handlers for cleanup to prevent memory leaks
let boundHandlers = {
    mousemove: null,
    mouseup: null,
    keydown: null,
    panMousemove: null,
    panMouseup: null,
    spaceKeydown: null,
    spaceKeyup: null
};

let censorModelStatusPromise = null;

function isZhCn() {
    return window.I18n?.getLang?.() === 'zh-CN';
}

function tText(enText, zhText) {
    return isZhCn() ? zhText : enText;
}

function tKey(key, enText, zhText = enText) {
    const translated = window.I18n?.t?.(key);
    return translated && translated !== key ? translated : tText(enText, zhText);
}

function isEditableTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tagName = String(target.tagName || '').toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    if (target.getAttribute('contenteditable') === 'true') return true;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function isCensorViewActive() {
    const censorView = document.getElementById('view-censor');
    return Boolean(censorView && censorView.classList.contains('active'));
}

function cleanupGlobalListeners() {
    if (boundHandlers.mousemove) {
        window.removeEventListener('mousemove', boundHandlers.mousemove);
        boundHandlers.mousemove = null;
    }
    if (boundHandlers.mouseup) {
        window.removeEventListener('mouseup', boundHandlers.mouseup);
        boundHandlers.mouseup = null;
    }
    if (boundHandlers.keydown) {
        document.removeEventListener('keydown', boundHandlers.keydown);
        boundHandlers.keydown = null;
    }
    if (boundHandlers.panMousemove) {
        window.removeEventListener('mousemove', boundHandlers.panMousemove);
        boundHandlers.panMousemove = null;
    }
    if (boundHandlers.panMouseup) {
        window.removeEventListener('mouseup', boundHandlers.panMouseup);
        boundHandlers.panMouseup = null;
    }
    if (boundHandlers.spaceKeydown) {
        document.removeEventListener('keydown', boundHandlers.spaceKeydown);
        boundHandlers.spaceKeydown = null;
    }
    if (boundHandlers.spaceKeyup) {
        document.removeEventListener('keyup', boundHandlers.spaceKeyup);
        boundHandlers.spaceKeyup = null;
    }
}

// ============== Init ==============

// Guard flag to prevent duplicate event binding
let censorEventsInitialized = false;

function initCensorEdit() {
    const { $, $$ } = window.App || { $: (s) => document.querySelector(s), $$: (s) => document.querySelectorAll(s) };

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
    updateUndoRedoButtons();
}

function bindEvents() {
    const { $, $$ } = window.App;

    // Clean up any existing global listeners first to prevent accumulation
    cleanupGlobalListeners();

    // Sidebar: Queue Actions — handled by consolidated clearQueueHandler below

    $('#btn-run-auto-censor')?.addEventListener('click', runAutoCensorBatch);
    $('#btn-batch-rename')?.addEventListener('click', () => {
        const onlySelectedCheckbox = document.getElementById('rename-only-selected');
        if (onlySelectedCheckbox) {
            onlySelectedCheckbox.checked = getOrderedSelectedQueueIds().length > 0;
        }
        refreshRenameSelectionUi();
        updateRenamePreview();
        $('#rename-modal').classList.add('visible');
    });

    // Detection Modal handlers
    $('#btn-open-detect-modal')?.addEventListener('click', async () => {
        $('#detect-modal')?.classList.add('visible');
        if (!CensorState.backendModelStatus) {
            renderCensorCapabilityPanel({ loading: true });
            await loadCensorModelStatus();
        }
        updateDetectionModelInputs();
        renderCensorCapabilityPanel();
    });

    $('#btn-close-detect-modal')?.addEventListener('click', () => {
        $('#detect-modal')?.classList.remove('visible');
    });

    // Close modal when clicking backdrop
    $('#detect-modal .modal-backdrop')?.addEventListener('click', () => {
        $('#detect-modal')?.classList.remove('visible');
    });

    // Rename Modal
    $('#btn-cancel-rename')?.addEventListener('click', () => $('#rename-modal').classList.remove('visible'));
    $('#btn-close-rename')?.addEventListener('click', () => $('#rename-modal').classList.remove('visible'));
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
            modelPathInput.value = selectedPath;
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
        renderCensorCapabilityPanel();
    });

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
        if (CensorState.queue.length === 0) return;
        window.App.showConfirm(
            tKey('modal.confirm', 'Are you sure?', '确定吗？'),
            tKey('modal.confirmAction', 'This action cannot be undone.', '此操作无法撤销。'),
            () => {
                CensorState.queue = [];
                CensorState.activeId = null;
                CensorState.selectedItems.clear();
                CensorState.lastSelectedIndex = -1;
                CensorState.undoStack = [];
                CensorState.redoStack = [];
                CensorState.baseCanvasState = null;
                CensorState.baseItemState = null;
                CensorState.filterActionUndoStack = [];
                CensorState.filterActionRedoStack = [];
                CensorState.lastHistorySource = null;
                CensorState.originalImageData = null;
                renderQueue();
                clearCanvas();
                window.App.showToast(tKey('censor.queueCleared', 'Queue cleared', '队列已清空'), 'success');
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
        wrapper.addEventListener('mouseenter', () => $('#cursor-overlay').style.display = 'block');
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
            window.App.showToast('No image selected', 'error');
        }
    });

    $('#btn-auto-detect-current-modal')?.addEventListener('click', () => {
        if (CensorState.activeId) {
            $('#detect-modal')?.classList.remove('visible');
            runDetectionForImage(CensorState.queue.find(i => i.id === CensorState.activeId));
        } else {
            window.App.showToast('No image selected', 'error');
        }
    });

    $('#btn-auto-detect-all-modal')?.addEventListener('click', () => {
        $('#detect-modal')?.classList.remove('visible');
        runDetectionForAll();
    });

    // Sidebar "Detect All" button
    $('#btn-auto-detect-all-sidebar')?.addEventListener('click', () => {
        runDetectionForAll();
    });

    // SAM3 Batch Refine button
    $('#btn-sam3-batch-refine')?.addEventListener('click', async () => {
        $('#detect-modal')?.classList.remove('visible');
        await runSam3BatchRefine();
    });

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
        window.App.showToast(tText('Selected the whole queue', '已选中整个队列'), 'info');
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
            thumb.style.display = (!filterText || itemTitle.includes(filterText)) ? '' : 'none';
        });
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
        if (typeof showModal === 'function') {
            showModal('rename-modal');
        } else {
            document.getElementById('rename-modal')?.classList.add('visible');
        }
    });

    // Queue Manager: Remove selected from queue
    $('#btn-queue-manager-remove-selected')?.addEventListener('click', () => {
        const selectedIds = getOrderedSelectedQueueIds();
        if (!selectedIds.length) {
            window.App?.showToast?.(tText('Select items first', '请先选中项目'), 'warning');
            return;
        }
        const selectedSet = new Set(selectedIds);
        CensorState.queue = CensorState.queue.filter(item => !selectedSet.has(item.id));
        CensorState.selectedItems.clear();
        renderQueue();
        renderQueueManager();
        window.App?.showToast?.(tText(`Removed ${selectedIds.length} items`, `已移除 ${selectedIds.length} 项`), 'success');
    });

    $('#btn-segment-text-current')?.addEventListener('click', async () => {
        $('#detect-modal')?.classList.remove('visible');
        await segmentCurrentImageByText();
    });

    $('#btn-clear-edits')?.addEventListener('click', () => {
        if (!CensorState.activeId || !CensorState.originalImageData) {
            window.App.showToast('No image to reset', 'error');
            return;
        }
        window.App.showConfirm(
            'Reset All Edits',
            'This will revert all edits to the original image. Continue?',
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
        }
    });

    // Keybinds - track for cleanup
    boundHandlers.keydown = handleKeydown;
    document.addEventListener('keydown', boundHandlers.keydown);

    // Add to Queue (Hook for Gallery)
    window.App._addToCensorQueue = async (imageIds) => {
        const { API } = window.App;
        // Switch view to censor tab - use nav tab click for reliable switching
        const censorTab = document.querySelector('.nav-tab[data-view="censor"]');
        if (censorTab) {
            censorTab.click();
        } else if (typeof window.App?.switchView === 'function') {
            window.App.switchView('censor');
        }
        // Ensure the censor view is scrolled into visibility
        const censorView = document.getElementById('view-censor');
        if (censorView) {
            censorView.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        const requestedIds = Array.from(new Set((Array.isArray(imageIds) ? imageIds : [imageIds])
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0)));
        const queueIds = new Set(CensorState.queue.map((item) => item.id));
        const idsToFetch = requestedIds.filter((id) => !queueIds.has(id) && !CensorState.pendingQueueIds.has(id));

        if (!idsToFetch.length) {
            if (!CensorState.activeId && CensorState.queue.length > 0) {
                setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
            }
            return true;
        }

        idsToFetch.forEach((id) => CensorState.pendingQueueIds.add(id));

        const settled = await Promise.allSettled(idsToFetch.map((id) => API.getImage(id)));
        const nextItems = [];
        const failedIds = [];

        settled.forEach((entry, index) => {
            const id = idsToFetch[index];
            CensorState.pendingQueueIds.delete(id);

            if (entry.status !== 'fulfilled' || !entry.value?.image) {
                failedIds.push(id);
                return;
            }

            const image = entry.value.image;
            nextItems.push({
                id,
                originalFilename: image.filename,
                outputFilename: image.filename,
                originalUrl: API.getImageUrl(id),
                currentDataUrl: null,
                regions: [],
                isProcessed: false,
                isModified: false,
            });
        });

        if (nextItems.length) {
            CensorState.queue.push(...nextItems);
            renderQueue();
            if (!CensorState.activeId && CensorState.queue.length > 0) {
                setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
            }
        }

        if (failedIds.length) {
            window.App?.showToast?.(
                tText(
                    `Failed to queue ${failedIds.length} image(s) for Censor.`,
                    `有 ${failedIds.length} 张图片加入 Censor 队列失败。`
                ),
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

// ============== Queue Logic ==============

function _resetBatchStatus(items = CensorState.queue) {
    items.forEach((item) => {
        delete item.batchStatus;
        delete item.batchError;
    });
}

function _summarizeBatchFailures(items = CensorState.queue) {
    const failed = items.filter((it) => it.batchStatus === 'failed');
    return {
        failedCount: failed.length,
        firstFailedName: failed[0]?.outputFilename || failed[0]?.originalFilename || '',
    };
}

function renderQueue() {
    const list = document.getElementById('censor-queue-list');
    if (!list) return;

    const validIds = new Set(CensorState.queue.map(item => item.id));
    CensorState.selectedItems = new Set(
        [...CensorState.selectedItems].filter(id => validIds.has(id))
    );
    if (CensorState.activeId && !validIds.has(CensorState.activeId)) {
        CensorState.activeId = null;
    }

    // Handle empty state
    if (CensorState.queue.length === 0) {
        list.innerHTML = `
            <div class="queue-empty-state-v2">
                <span class="empty-icon">📷</span>
                <p>${escapeHtml(tText('No images selected', '未选择图片'))}</p>
                <small>${escapeHtml(tText('Select from Gallery', '从图库中选择'))}</small>
            </div>
        `;
        updateQueueSelection();
        updateUndoRedoButtons();
        return;
    }

    // Get existing thumbnails
    const existingThumbs = list.querySelectorAll('.queue-thumb-v2');
    const existingIds = new Set([...existingThumbs].map(t => t.dataset.id));
    const queueIds = new Set(CensorState.queue.map(item => item.id.toString()));

    // Remove thumbnails not in queue anymore
    existingThumbs.forEach(thumb => {
        if (!queueIds.has(thumb.dataset.id)) {
            thumb.remove();
        }
    });

    // Clear empty state if present
    const emptyState = list.querySelector('.queue-empty-state-v2');
    if (emptyState) emptyState.remove();

    // Update or create thumbnails
    CensorState.queue.forEach((item, index) => {
        const itemIdStr = item.id.toString();
        let img = list.querySelector(`.queue-thumb-v2[data-id="${itemIdStr}"]`);

        if (!img) {
            // Create new thumbnail
            img = document.createElement('img');
            img.className = 'queue-thumb-v2';
            img.draggable = true;
            img.setAttribute('role', 'button');
            img.setAttribute('tabindex', '0');
            img.setAttribute('aria-selected', 'false');
            img.setAttribute('aria-pressed', 'false');
            img.dataset.id = itemIdStr;

            // Click to load with multi-select support
            const syncSelectedState = () => {
                const isSelected = CensorState.selectedItems.has(item.id);
                img.classList.toggle('selected', isSelected);
                img.setAttribute('aria-selected', String(isSelected));
                img.setAttribute('aria-pressed', String(isSelected));
            };

            img.addEventListener('click', (e) => {
                const clickedIndex = parseInt(img.dataset.index, 10);
                const clickedId = item.id;

                if (e.ctrlKey || e.metaKey) {
                    // Ctrl+click: toggle selection
                    if (CensorState.selectedItems.has(clickedId)) {
                        CensorState.selectedItems.delete(clickedId);
                    } else {
                        CensorState.selectedItems.add(clickedId);
                    }
                    CensorState.lastSelectedIndex = clickedIndex;
                } else if (e.shiftKey && CensorState.lastSelectedIndex >= 0) {
                    // Shift+click: range selection
                    const start = Math.min(CensorState.lastSelectedIndex, clickedIndex);
                    const end = Math.max(CensorState.lastSelectedIndex, clickedIndex);
                    CensorState.selectedItems.clear();
                    for (let i = start; i <= end; i++) {
                        if (CensorState.queue[i]) {
                            CensorState.selectedItems.add(CensorState.queue[i].id);
                        }
                    }
                } else {
                    // Normal click: select single and load
                    CensorState.selectedItems.clear();
                    CensorState.selectedItems.add(clickedId);
                    CensorState.lastSelectedIndex = clickedIndex;
                    loadCanvasImage(item.id);
                }

                updateQueueSelection();
            });

            syncSelectedState();

            // DnD Events
            img.addEventListener('dragstart', handleDragStart);
            img.addEventListener('dragend', handleDragEnd);
            img.addEventListener('dragover', handleDragOver);
            img.addEventListener('drop', handleDrop);
            img.addEventListener('dragenter', (e) => e.target.classList.add('drag-over'));
            img.addEventListener('dragleave', (e) => e.target.classList.remove('drag-over'));

            list.appendChild(img);
        }

        // Always append to maintain order (appendChild moves existing node to end)
        list.appendChild(img);

        // Update properties (always update these - they may have changed)
        img.dataset.index = index;
        const baseTitle = item.outputFilename || '';
        img.title = item.batchError ? `${baseTitle}\n⚠ ${item.batchError}` : baseTitle;

        // Only update src if it changed (prevents reload flash)
        const newSrc = item.currentDataUrl || item.originalUrl;
        if (img.src !== newSrc) {
            img.src = newSrc;
        }

        // Update classes
        const isActive = item.id === CensorState.activeId;
        const isProcessed = item.isProcessed;
        const isSelected = CensorState.selectedItems.has(item.id);
        const batchFailed = item.batchStatus === 'failed';
        const batchRefined = item.batchStatus === 'refined';
        img.classList.toggle('active', isActive);
        img.classList.toggle('processed', isProcessed);
        img.classList.toggle('selected', isSelected);
        img.classList.toggle('batch-error', batchFailed);
        img.classList.toggle('batch-refined', batchRefined && !isProcessed);
        img.setAttribute('aria-selected', String(isSelected));
        img.setAttribute('aria-pressed', String(isSelected));
    });

    updateQueueSelection();
    updateUndoRedoButtons();
}

function initDragAndDrop() {
    // Basic setup handled in renderQueue listeners
}

function getQueueManagerItems() {
    const search = String(CensorState.queueManagerSearch || '').trim().toLowerCase();
    return CensorState.queue.filter((item) => {
        if (CensorState.queueManagerShowSelectedOnly && !CensorState.selectedItems.has(item.id)) {
            return false;
        }
        if (!search) return true;
        const haystack = `${item.outputFilename || ''} ${item.originalFilename || ''}`.toLowerCase();
        return haystack.includes(search);
    });
}

function openQueueManager() {
    // Use the new Solitaire queue manager if available
    if (window.QueueSolitaire) {
        window.QueueSolitaire.open();
        return;
    }
    // Fallback to old modal
    CensorState.queueManagerSearch = '';
    CensorState.queueManagerShowSelectedOnly = false;
    const searchInput = document.getElementById('queue-manager-search');
    const selectedToggle = document.getElementById('queue-manager-show-selected');
    if (searchInput) searchInput.value = '';
    if (selectedToggle) selectedToggle.checked = false;
    renderQueueManager();
    if (typeof showModal === 'function') {
        showModal('queue-manager-modal');
    } else {
        document.getElementById('queue-manager-modal')?.classList.add('visible');
    }
    setTimeout(() => searchInput?.focus(), 140);
}

function closeQueueManager() {
    if (typeof hideModal === 'function') {
        hideModal('queue-manager-modal');
    } else {
        document.getElementById('queue-manager-modal')?.classList.remove('visible');
    }
}

function formatQueueManagerSummary(visibleCount) {
    return tKey(
        'censor.queueManagerSummary',
        '{selected} selected • {visible}/{total} visible • drag rows or use the move bar below',
        '已选 {selected} 项 • 当前显示 {visible}/{total} • 可拖拽行或使用下方移动栏'
    )
        .replace('{selected}', CensorState.selectedItems.size)
        .replace('{visible}', visibleCount)
        .replace('{total}', CensorState.queue.length);
}

function getQueueManagerThumbnailSrc(item) {
    const api = window.App?.API;
    if (item?.currentDataUrl) return item.currentDataUrl;
    if (item?.id && typeof api?.getThumbnailUrl === 'function') {
        return api.getThumbnailUrl(item.id, 320);
    }
    return item?.originalUrl || '';
}

function getQueueManagerStatusBadges(item) {
    const badges = [];
    if (item.id === CensorState.activeId) {
        badges.push(`<span class="queue-manager-badge is-active">${escapeHtml(tKey('common.current', 'Current', '当前'))}</span>`);
    }
    if (item.isProcessed) {
        badges.push(`<span class="queue-manager-badge is-processed">${escapeHtml(tKey('common.processed', 'Processed', '已处理'))}</span>`);
    }
    return badges.join('');
}

function renderQueueManagerSelectionStrip(items = []) {
    const strip = document.getElementById('queue-manager-selection-strip');
    const countEl = document.getElementById('queue-manager-selection-count');
    const selectedItems = Array.isArray(items) ? items : [];

    if (countEl) {
        countEl.textContent = selectedItems.length > 0
            ? tText(`${selectedItems.length} selected`, `已选 ${selectedItems.length} 项`)
            : tText('No selection', '未选择');
        countEl.classList.toggle('is-empty', selectedItems.length === 0);
    }

    if (!strip) return;

    if (!selectedItems.length) {
        strip.innerHTML = `
            <div class="queue-manager-selection-empty">
                ${escapeHtml(tText('Pick one or more thumbnails to enable batch moves.', '选择一个或多个缩略图后即可批量移动。'))}
            </div>
        `;
        return;
    }

    strip.innerHTML = selectedItems.map((item) => {
        const thumbSrc = escapeHtml(getQueueManagerThumbnailSrc(item));
        const label = escapeHtml(item.outputFilename || item.originalFilename || `Image ${item.id}`);
        return `
            <button class="queue-manager-selection-chip" type="button" data-id="${item.id}" title="${label}">
                <img class="queue-manager-selection-chip-thumb" src="${thumbSrc}" alt="${label}" loading="lazy" decoding="async">
                <span class="queue-manager-selection-chip-label">${label}</span>
            </button>
        `;
    }).join('');

    strip.querySelectorAll('.queue-manager-selection-chip[data-id]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const itemId = Number.parseInt(chip.dataset.id, 10);
            scrollQueueItemIntoView(itemId);
        });
    });
}

function renderQueueManager() {
    const list = document.getElementById('queue-manager-list');
    const summary = document.getElementById('queue-manager-summary');
    const positionInput = document.getElementById('queue-manager-position');
    const countEl = document.getElementById('queue-manager-selection-count');
    if (!list || !summary) return;

    const items = getQueueManagerItems();
    summary.textContent = formatQueueManagerSummary(items.length);

    if (countEl) {
        const count = CensorState.selectedItems.size;
        countEl.textContent = count > 0
            ? tText(`${count} selected`, `已选 ${count} 项`)
            : tText('0 selected', '0 已选');
    }

    if (positionInput && CensorState.selectedItems.size > 0) {
        const firstSelectedIndex = CensorState.queue.findIndex((item) => CensorState.selectedItems.has(item.id));
        if (firstSelectedIndex >= 0) {
            positionInput.value = String(firstSelectedIndex + 1);
        }
    }

    if (!items.length) {
        list.innerHTML = `<div class="queue-manager-empty">${escapeHtml(tKey('censor.queueManagerEmpty', 'No queue items match the current filter.', '当前筛选下没有匹配的队列项。'))}</div>`;
        return;
    }

    list.innerHTML = items.map((item) => {
        const index = CensorState.queue.findIndex((entry) => entry.id === item.id);
        const isActive = item.id === CensorState.activeId;
        const isSelected = CensorState.selectedItems.has(item.id);
        const isProcessed = item.processed || item.saved;
        const classes = [
            'queue-manager-grid-item',
            isActive ? 'is-active' : '',
            isSelected ? 'is-selected' : '',
            isProcessed ? 'is-processed' : '',
        ].filter(Boolean).join(' ');
        const badgeClass = isActive ? 'is-active' : isProcessed ? 'is-processed' : '';
        const displayName = item.outputFilename || item.originalFilename || `Image ${item.id}`;
        return `
            <div class="${classes}" data-id="${item.id}" data-index="${index}" draggable="true" title="${escapeHtml(displayName)}">
                <img class="queue-manager-grid-thumb" src="${escapeHtml(getQueueManagerThumbnailSrc(item))}" alt="${escapeHtml(displayName)}" loading="lazy" decoding="async">
                <span class="queue-manager-grid-index">${index + 1}</span>
                ${badgeClass ? `<span class="queue-manager-grid-badge ${badgeClass}"></span>` : ''}
                <div class="queue-manager-grid-label" title="Double-click to rename">${escapeHtml(displayName)}</div>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.queue-manager-grid-item').forEach((item) => {
        item.addEventListener('click', (event) => {
            const clickedId = Number.parseInt(item.dataset.id, 10);
            const clickedIndex = Number.parseInt(item.dataset.index, 10);

            if (event.ctrlKey || event.metaKey) {
                if (CensorState.selectedItems.has(clickedId)) {
                    CensorState.selectedItems.delete(clickedId);
                } else {
                    CensorState.selectedItems.add(clickedId);
                }
                CensorState.lastSelectedIndex = clickedIndex;
            } else if (event.shiftKey && CensorState.lastSelectedIndex >= 0) {
                const start = Math.min(CensorState.lastSelectedIndex, clickedIndex);
                const end = Math.max(CensorState.lastSelectedIndex, clickedIndex);
                CensorState.selectedItems.clear();
                for (let i = start; i <= end; i++) {
                    if (CensorState.queue[i]) {
                        CensorState.selectedItems.add(CensorState.queue[i].id);
                    }
                }
            } else {
                CensorState.selectedItems.clear();
                CensorState.selectedItems.add(clickedId);
                CensorState.lastSelectedIndex = clickedIndex;
            }

            updateQueueSelection();
        });

        item.addEventListener('dblclick', async (event) => {
            const label = item.querySelector('.queue-manager-grid-label');
            if (label && event.target === label) {
                // Enable inline rename
                label.contentEditable = 'true';
                label.focus();
                const range = document.createRange();
                range.selectNodeContents(label);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                const finishRename = () => {
                    label.contentEditable = 'false';
                    const clickedId = Number.parseInt(item.dataset.id, 10);
                    const queueItem = CensorState.queue.find((entry) => entry.id === clickedId);
                    if (queueItem) {
                        const newName = label.textContent.trim();
                        if (newName) queueItem.outputFilename = newName;
                    }
                    label.removeEventListener('blur', finishRename);
                    label.removeEventListener('keydown', handleKey);
                };
                const handleKey = (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
                    if (e.key === 'Escape') { label.contentEditable = 'false'; }
                };
                label.addEventListener('blur', finishRename);
                label.addEventListener('keydown', handleKey);
                return;
            }
            // Double-click on thumb loads into editor
            const clickedId = Number.parseInt(item.dataset.id, 10);
            const queueItem = CensorState.queue.find((entry) => entry.id === clickedId);
            await loadCanvasImage(clickedId);
            closeQueueManager();
            window.App.showToast(
                tKey('censor.queueManagerLoaded', 'Loaded {filename} into the editor.', '已把 {filename} 载入编辑器。').replace('{filename}', queueItem?.outputFilename || queueItem?.originalFilename || String(clickedId)),
                'success'
            );
        });

        item.addEventListener('dragstart', handleQueueManagerDragStart);
        item.addEventListener('dragend', handleQueueManagerDragEnd);
        item.addEventListener('dragover', (event) => {
            event.preventDefault();
            item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', handleQueueManagerDrop);
    });
}

function moveQueueSelectionToPosition(targetPosition) {
    const selectedIds = getOrderedSelectedQueueIds();
    if (!selectedIds.length) {
        window.App.showToast(
            tText('Select at least one queue item first', '请先选中至少一个队列项目'),
            'warning'
        );
        return;
    }

    const selectedSet = new Set(selectedIds);
    const selectedItems = CensorState.queue.filter((item) => selectedSet.has(item.id));
    const remainingItems = CensorState.queue.filter((item) => !selectedSet.has(item.id));
    const normalizedPosition = Math.min(
        Math.max((Number.isFinite(targetPosition) ? targetPosition : 1) - 1, 0),
        remainingItems.length
    );

    const nextQueue = [
        ...remainingItems.slice(0, normalizedPosition),
        ...selectedItems,
        ...remainingItems.slice(normalizedPosition),
    ];

    const changed = nextQueue.some((item, index) => item.id !== CensorState.queue[index]?.id);
    if (!changed) return;

    CensorState.queue = nextQueue;
    CensorState.lastSelectedIndex = CensorState.queue.findIndex((item) => item.id === selectedIds[0]);
    renderQueue();
    scrollQueueItemIntoView(selectedIds[0]);
}

function reorderQueueByDraggedTarget(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return false;

    const moveAsGroup = CensorState.selectedItems.size > 1 && CensorState.selectedItems.has(draggedId);
    const movingIds = moveAsGroup ? getOrderedSelectedQueueIds() : [draggedId];
    const movingSet = new Set(movingIds);
    const originalDraggedIndex = CensorState.queue.findIndex((item) => item.id === draggedId);
    const originalTargetIndex = CensorState.queue.findIndex((item) => item.id === targetId);
    const movingItems = CensorState.queue.filter((item) => movingSet.has(item.id));
    const remainingItems = CensorState.queue.filter((item) => !movingSet.has(item.id));
    let insertIndex = remainingItems.findIndex((item) => item.id === targetId);
    if (insertIndex < 0) insertIndex = remainingItems.length;

    const movingForward = originalDraggedIndex >= 0 && originalTargetIndex >= 0 && originalDraggedIndex < originalTargetIndex;
    if (movingForward) {
        insertIndex += 1;
    }

    const nextQueue = [
        ...remainingItems.slice(0, insertIndex),
        ...movingItems,
        ...remainingItems.slice(insertIndex),
    ];

    const changed = nextQueue.some((item, index) => item.id !== CensorState.queue[index]?.id);
    if (!changed) return false;

    CensorState.queue = nextQueue;
    CensorState.lastSelectedIndex = CensorState.queue.findIndex((item) => item.id === movingIds[0]);
    renderQueue();
    scrollQueueItemIntoView(movingIds[0]);
    return true;
}

function handleQueueManagerDragStart(e) {
    const draggedId = this.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedId);
    this.classList.add('dragging');
}

function handleQueueManagerDragEnd() {
    this.classList.remove('dragging');
    document.querySelectorAll('.queue-manager-grid-item').forEach((el) => el.classList.remove('drag-over'));
}

function handleQueueManagerDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
    const targetId = Number.parseInt(this.dataset.id, 10);
    this.classList.remove('drag-over');
    reorderQueueByDraggedTarget(draggedId, targetId);
}

function updateQueueSelection() {
    // Update visual selection state on all queue thumbnails
    document.querySelectorAll('.queue-thumb-v2').forEach(img => {
        // IDs can be string or number — normalize to string for comparison
        const itemIdStr = img.dataset.id;
        const isSelected = [...CensorState.selectedItems].some(id => id.toString() === itemIdStr);
        img.classList.toggle('selected', isSelected);
        img.setAttribute('aria-selected', String(isSelected));
        img.setAttribute('aria-pressed', String(isSelected));
    });

    // Update selection count indicator if it exists
    const countEl = document.getElementById('queue-selection-count');
    if (countEl) {
        const count = CensorState.selectedItems.size;
        countEl.textContent = count > 0
            ? tText(`${count} selected`, `已选 ${count} 项`)
            : '';
        countEl.style.display = count > 0 ? 'inline-flex' : 'none';
    }

    updateQueueActionState();
    renderQueueManager();
}

function updateQueueActionState() {
    const hasQueue = CensorState.queue.length > 0;
    const hasSelection = CensorState.selectedItems.size > 0;
    [
        'btn-queue-move-top',
        'btn-queue-move-up',
        'btn-queue-move-down',
        'btn-queue-move-bottom',
        'btn-queue-manager-move-top',
        'btn-queue-manager-move-up',
        'btn-queue-manager-move-down',
        'btn-queue-manager-move-bottom',
        'btn-queue-manager-move-position',
    ].forEach(id => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = !hasQueue || !hasSelection;
    });
}

function getOrderedSelectedQueueIds() {
    return CensorState.queue
        .filter(item => CensorState.selectedItems.has(item.id))
        .map(item => item.id);
}

function scrollQueueItemIntoView(itemId) {
    const thumb = document.querySelector(`.queue-thumb-v2[data-id="${itemId}"]`);
    thumb?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

function moveQueueSelection(direction) {
    const disabledButton = document.getElementById(`btn-queue-move-${direction}`);
    if (disabledButton?.disabled) {
        return;
    }

    const selectedIds = getOrderedSelectedQueueIds();
    if (!selectedIds.length) {
        window.App.showToast(
            tText('Select at least one queue item first', '请先选中至少一个队列项目'),
            'warning'
        );
        return;
    }

    const selectedSet = new Set(selectedIds);
    let changed = false;

    switch (direction) {
        case 'top': {
            const selectedItems = CensorState.queue.filter(item => selectedSet.has(item.id));
            const remainingItems = CensorState.queue.filter(item => !selectedSet.has(item.id));
            changed = CensorState.queue.length > 1 && selectedItems.length > 0;
            CensorState.queue = [...selectedItems, ...remainingItems];
            break;
        }
        case 'bottom': {
            const selectedItems = CensorState.queue.filter(item => selectedSet.has(item.id));
            const remainingItems = CensorState.queue.filter(item => !selectedSet.has(item.id));
            changed = CensorState.queue.length > 1 && selectedItems.length > 0;
            CensorState.queue = [...remainingItems, ...selectedItems];
            break;
        }
        case 'up': {
            for (let i = 1; i < CensorState.queue.length; i++) {
                if (selectedSet.has(CensorState.queue[i].id) && !selectedSet.has(CensorState.queue[i - 1].id)) {
                    [CensorState.queue[i - 1], CensorState.queue[i]] = [CensorState.queue[i], CensorState.queue[i - 1]];
                    changed = true;
                }
            }
            break;
        }
        case 'down': {
            for (let i = CensorState.queue.length - 2; i >= 0; i--) {
                if (selectedSet.has(CensorState.queue[i].id) && !selectedSet.has(CensorState.queue[i + 1].id)) {
                    [CensorState.queue[i], CensorState.queue[i + 1]] = [CensorState.queue[i + 1], CensorState.queue[i]];
                    changed = true;
                }
            }
            break;
        }
        default:
            return;
    }

    if (!changed) {
        return;
    }

    CensorState.lastSelectedIndex = CensorState.queue.findIndex(item => item.id === selectedIds[0]);
    renderQueue();
    scrollQueueItemIntoView(selectedIds[0]);
}

let draggedItemIndex = null;
const QUEUE_DRAG_SCROLL_EDGE_PX = 64;
const QUEUE_DRAG_SCROLL_STEP_PX = 28;

function handleDragStart(e) {
    draggedItemIndex = parseInt(this.dataset.index, 10);
    e.dataTransfer.effectAllowed = 'move';
    // Use the ID as the data to ensure we identify the right item even if index changes
    e.dataTransfer.setData('text/plain', this.dataset.id);
    this.classList.add('dragging');
    // Set dragging opacity
    setTimeout(() => { this.style.opacity = '0.5'; }, 0);
}

function handleDragEnd(e) {
    this.style.opacity = '1';
    this.classList.remove('dragging');
    // Clean up all drag-over states
    document.querySelectorAll('.queue-thumb-v2').forEach(el => {
        el.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    maybeAutoScrollQueue(e.clientY);
    return false;
}

function maybeAutoScrollQueue(clientY) {
    const queueList = document.getElementById('censor-queue-list');
    if (!queueList) return;

    const rect = queueList.getBoundingClientRect();
    if (!rect.height) return;

    const distanceFromTop = clientY - rect.top;
    const distanceFromBottom = rect.bottom - clientY;

    if (distanceFromTop >= 0 && distanceFromTop < QUEUE_DRAG_SCROLL_EDGE_PX) {
        const intensity = 1 - (distanceFromTop / QUEUE_DRAG_SCROLL_EDGE_PX);
        queueList.scrollTop -= Math.max(10, Math.round(QUEUE_DRAG_SCROLL_STEP_PX * intensity));
    } else if (distanceFromBottom >= 0 && distanceFromBottom < QUEUE_DRAG_SCROLL_EDGE_PX) {
        const intensity = 1 - (distanceFromBottom / QUEUE_DRAG_SCROLL_EDGE_PX);
        queueList.scrollTop += Math.max(10, Math.round(QUEUE_DRAG_SCROLL_STEP_PX * intensity));
    }
}

function handleDrop(e) {
    e.stopPropagation();
    e.preventDefault();
    const targetItem = e.target.closest('.queue-thumb-v2');
    if (!targetItem) return false;

    const draggedId = e.dataTransfer.getData('text/plain');
    const targetId = Number.parseInt(targetItem.dataset.id, 10);
    reorderQueueByDraggedTarget(Number.parseInt(draggedId, 10), targetId);

    document.querySelectorAll('.queue-thumb-v2').forEach(el => {
        el.classList.remove('dragging', 'drag-over');
    });
    return false;
}

// ============== Canvas & Editing ==============

// State for double buffering
CensorState.activeCanvasId = 'censor-canvas';
CensorState.isLoadingImage = false; // Lock for preventing rapid load race conditions


async function loadCanvasImage(id) {
    const item = CensorState.queue.find(i => i.id === id);
    if (!item) return;

    if (typeof window.__invalidateCensorFilterPreview === 'function') {
        window.__invalidateCensorFilterPreview();
    }

    CensorState.selectedItems.clear();
    CensorState.selectedItems.add(id);
    CensorState.lastSelectedIndex = CensorState.queue.findIndex(queueItem => queueItem.id === id);

    // Prevent race conditions from rapid clicking
    if (CensorState.isLoadingImage) return;
    CensorState.isLoadingImage = true;

    if (CensorState.activeId && CensorState.activeId !== id) {
        saveCurrentCanvasToState();
    }

    CensorState.activeId = id;
    renderQueue();
    scrollQueueItemIntoView(id);

    // Identify current and next canvas
    const currentCanvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const nextCanvasId = CensorState.activeCanvasId === 'censor-canvas' ? 'censor-canvas-buffer' : 'censor-canvas';
    const nextCanvas = document.getElementById(nextCanvasId);

    // UI Updates
    const noImageEl = document.getElementById('censor-no-image');
    const filenameEl = document.getElementById('censor-filename');
    showLoading(true, 'Loading image...');

    try {
        const imgUrl = item.currentDataUrl || item.originalUrl;

        // Load images
        const [img, originalImg] = await Promise.all([
            loadImage(imgUrl),
            loadImage(item.originalUrl)
        ]);

        CensorState.originalImage = originalImg;

        // Draw to NEXT canvas (hidden)
        nextCanvas.width = img.width;
        nextCanvas.height = img.height;
        const ctx = nextCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        // Store true original image data for eraser/reset
        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = originalImg.width;
        originalCanvas.height = originalImg.height;
        const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
        originalCtx.drawImage(originalImg, 0, 0);
        CensorState.originalImageData = originalCtx.getImageData(0, 0, originalImg.width, originalImg.height);

        // Initialize undo stack from the image that is actually shown on screen
        const initialState = captureCanvasState(nextCanvas);
        CensorState.baseCanvasState = initialState;
        CensorState.baseItemState = {
            currentDataUrl: item.currentDataUrl || null,
            isModified: Boolean(item.isModified)
        };
        CensorState.undoStack = initialState ? [initialState] : [];
        CensorState.redoStack = [];
        updateUndoRedoButtons();

        // Fit canvases to container before showing
        fitCanvasToContainer(nextCanvas, img.width, img.height);
        fitCanvasToContainer(currentCanvas, img.width, img.height);

        // SWAP: Show next, Hide current (with RAF)
        requestAnimationFrame(() => {
            nextCanvas.style.opacity = '1';
            nextCanvas.style.pointerEvents = 'auto';
            nextCanvas.style.zIndex = '10';

            currentCanvas.style.opacity = '0';
            currentCanvas.style.pointerEvents = 'none';
            currentCanvas.style.zIndex = '0';

            // Update State
            CensorState.activeCanvasId = nextCanvasId;

            // Finalize
            noImageEl.style.display = 'none';
            showLoading(false);
            if (filenameEl) filenameEl.textContent = item.outputFilename;

            resetZoom();
            if (typeof window.__updateCensorFilterPreview === 'function') {
                window.__updateCensorFilterPreview();
            }
            CensorState.isLoadingImage = false; // Release lock
        });

    } catch (error) {
        Logger.error('Failed to load image:', error);
        showLoading(false);
        CensorState.isLoadingImage = false; // Release lock on error
        window.App.showToast(formatUserError(error, "Operation failed"), "error");
    }

    // Safety fallback: release lock after timeout in case RAF never fires
    setTimeout(() => { CensorState.isLoadingImage = false; }, 2000);
}

function fitCanvasToContainer(canvas, imgW, imgH) {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    // Get container dimensions (minus padding if any)
    const contW = container.clientWidth;
    const contH = container.clientHeight;

    // Calculate aspect ratios
    const imgRatio = imgW / imgH;
    const contRatio = contW / contH;

    let finalW, finalH;

    if (imgRatio > contRatio) {
        // Image is wider than container - fit to width
        finalW = contW;
        finalH = contW / imgRatio;
    } else {
        // Image is taller than container - fit to height
        finalH = contH;
        finalW = contH * imgRatio;
    }

    // Check against max checks? No, container size is the truth.

    canvas.style.width = `${finalW}px`;
    canvas.style.height = `${finalH}px`;
}

// Re-fit on window resize
window.addEventListener('resize', () => {
    if (CensorState.activeId && CensorState.originalImage) {
        const c1 = document.getElementById('censor-canvas');
        const c2 = document.getElementById('censor-canvas-buffer');
        const img = CensorState.originalImage;
        fitCanvasToContainer(c1, img.width, img.height);
        fitCanvasToContainer(c2, img.width, img.height);
    }
});

function saveCurrentCanvasToState(serializedState = null) {
    // Save from the CURRENT active canvas
    if (!CensorState.activeId) return;
    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');

    if (item && canvas) {
        const nextState = serializedState || captureCanvasState(canvas);
        if (!nextState) return;

        if (CensorState.baseCanvasState && nextState === CensorState.baseCanvasState) {
            item.currentDataUrl = CensorState.baseItemState?.currentDataUrl || null;
            item.isModified = Boolean(CensorState.baseItemState?.isModified);
            return;
        }

        item.currentDataUrl = nextState;
        item.isModified = true;
    }
}

async function loadCensorModelStatus() {
    const banner = document.getElementById('censor-model-health');
    const simpleGuide = document.getElementById('censor-simple-guide');
    if (CensorState.backendModelStatus) {
        return CensorState.backendModelStatus;
    }
    if (censorModelStatusPromise) {
        return censorModelStatusPromise;
    }

    CensorState.modelStatusError = '';
    CensorState.modelStatusLoading = true;
    renderCensorCapabilityPanel({ loading: true });

    censorModelStatusPromise = (async () => {
        try {
            const result = await window.App.API.get('/api/censor/models');
            CensorState.backendModelStatus = result;

            const legacy = (result.models || []).find(model => model.id === 'legacy');
            CensorState.availableLegacyModels = legacy?.files || [];
            populateCensorModelSelect(legacy);
            const modelTypeSelect = document.getElementById('censor-model-type');
            if (modelTypeSelect && result.recommended_backend) {
                modelTypeSelect.value = result.recommended_backend;
            }
            updateDetectionModelInputs();

            if (banner) {
                const classes = ['model-health-banner', 'model-health-banner-compact', 'is-visible'];
                if (!result.recommended_backend) {
                    classes.push('model-health-banner-danger');
                } else if (!(legacy?.available)) {
                    classes.push('model-health-banner-warning');
                }

                const readyNotes = (result.models || [])
                    .filter(model => model.available)
                    .map(model => model.name)
                    .join(' / ');
                const recommended = result.recommended_backend
                    ? `Recommended mode: ${result.recommended_backend}.`
                    : 'No detection backend is fully ready yet.';
                const defaultLegacy = legacy?.files?.find(file => file.path === legacy?.default_model_path);
                const extraNotes = [];
                if (defaultLegacy) {
                    extraNotes.push(`Legacy default: ${defaultLegacy.name} (${defaultLegacy.profile_label})`);
                } else if (legacy?.default_model_path) {
                    extraNotes.push(`Legacy default: ${legacy.default_model_path}`);
                }
                if ((legacy?.general_model_count || 0) > 0) {
                    extraNotes.push(`${legacy.general_model_count} general YOLO model(s) installed for compatibility tests`);
                }
                const extra = extraNotes.length
                    ? `<br><small>${escapeHtml(extraNotes.join(' · '))}</small>`
                    : '';

                banner.className = classes.join(' ');
                banner.innerHTML = `<strong>Detection Ready:</strong> ${escapeHtml(readyNotes || 'None')} ${escapeHtml(recommended)}${extra}`;
            }
            if (simpleGuide) {
                simpleGuide.textContent = legacy?.simple_user_advice || 'Keep the recommended mode and only touch custom paths if you know why.';
            }
            renderCensorCapabilityPanel();
            return result;
        } catch (e) {
            CensorState.modelStatusError = e?.message || 'Model readiness could not be loaded right now.';
            if (banner) {
                banner.className = 'model-health-banner model-health-banner-compact is-visible model-health-banner-warning';
                banner.textContent = 'Model readiness could not be loaded right now.';
            }
            if (simpleGuide) {
                simpleGuide.textContent = '';
            }
            renderCensorCapabilityPanel();
            return null;
        } finally {
            CensorState.modelStatusLoading = false;
            censorModelStatusPromise = null;
        }
    })();

    return censorModelStatusPromise;
}

function getLegacyModelRecordByPath(path) {
    const normalized = String(path || '').trim();
    if (!normalized) return null;
    return CensorState.availableLegacyModels.find(file => file?.path === normalized) || null;
}

function getSelectedLegacyModelRecord() {
    const manualPath = String(document.getElementById('censor-model-path')?.value || '').trim();
    const selectedPath = manualPath || String(document.getElementById('censor-model-file')?.value || '').trim();
    const legacy = (CensorState.backendModelStatus?.models || []).find(model => model.id === 'legacy');
    return getLegacyModelRecordByPath(selectedPath) || getLegacyModelRecordByPath(legacy?.default_model_path);
}

function buildCapabilityCardHtml(title, badge, lines = [], note = '', { recommended = false } = {}) {
    const safeLines = Array.isArray(lines)
        ? lines.filter(Boolean).map(line => `<div>${escapeHtml(line)}</div>`).join('')
        : '';
    const cardClass = recommended
        ? 'censor-capability-card is-recommended'
        : 'censor-capability-card';
    return `
        <div class="${cardClass}">
            <div class="censor-capability-title">
                <span>${escapeHtml(title)}</span>
                ${badge ? `<span class="censor-capability-badge">${escapeHtml(badge)}</span>` : ''}
            </div>
            <div class="censor-capability-lines">${safeLines}</div>
            ${note ? `<div class="censor-capability-note">${escapeHtml(note)}</div>` : ''}
        </div>
    `;
}

function renderCensorCapabilityPanel(options = {}) {
    const panel = document.getElementById('censor-capability-panel');
    const targetHelp = document.getElementById('censor-target-region-help');
    const promptHelp = document.getElementById('censor-text-prompt-help');
    const promptInput = document.getElementById('censor-text-prompt');
    const simpleGuide = document.getElementById('censor-simple-guide');
    const segmentButton = document.getElementById('btn-segment-text-current');
    const targetGroup = document.getElementById('censor-target-region-group');
    const targetChecks = Array.from(document.querySelectorAll('.target-region-check'));

    if (!panel) return;

    const isLoading = Boolean(options.loading || CensorState.modelStatusLoading);
    const loadError = String(CensorState.modelStatusError || '').trim();

    if (!CensorState.backendModelStatus) {
        panel.innerHTML = buildCapabilityCardHtml(
            tText('Model readiness', '模型就绪状态'),
            isLoading ? tText('Loading', '加载中') : tText('Unavailable', '暂不可用'),
            isLoading
                ? [
                    tText('Checking local YOLO, NudeNet, and SAM3 availability...', '正在检查本地 YOLO、NudeNet 和 SAM3 的可用性...'),
                    tText('The panel will fill in as soon as the backend responds.', '后端返回后，这里会马上补上详细能力说明。'),
                ]
                : [
                    loadError || tText('Model readiness could not be loaded right now.', '暂时无法读取模型就绪状态。'),
                    tText('You can reopen this dialog after the backend finishes loading.', '等后端加载完成后，重新打开这个窗口即可。'),
                ],
            ''
        );

        targetChecks.forEach(input => {
            input.disabled = true;
        });
        if (targetGroup) {
            targetGroup.style.display = '';
            targetGroup.classList.add('is-disabled');
        }
        if (targetHelp) {
            targetHelp.textContent = isLoading
                ? tText('Quick privacy targets are loading.', '隐私快捷目标正在加载中。')
                : tText('Quick privacy targets are temporarily unavailable.', '隐私快捷目标暂时不可用。');
        }
        if (promptHelp) {
            promptHelp.textContent = isLoading
                ? tText('Loading SAM3 readiness for the pro prompt tool.', '正在读取 SAM3 的可用状态。')
                : tText('SAM3 readiness is temporarily unavailable.', 'SAM3 状态暂时无法读取。');
        }
        if (promptInput) {
            promptInput.readOnly = false;
            promptInput.removeAttribute('disabled');
            promptInput.setAttribute('aria-disabled', 'false');
        }
        if (segmentButton) {
            segmentButton.disabled = true;
            segmentButton.title = isLoading
                ? tText('Loading model readiness…', '正在加载模型状态…')
                : tText('Model readiness is unavailable right now.', '当前无法读取模型状态。');
        }
        if (simpleGuide) {
            simpleGuide.textContent = isLoading
                ? tText('Loading the recommended detection route…', '正在加载推荐检测路线…')
                : tText('Model readiness is temporarily unavailable.', '模型状态暂时不可用。');
        }
        return;
    }

    const models = CensorState.backendModelStatus?.models || [];
    const legacy = models.find(model => model.id === 'legacy');
    const nudenet = models.find(model => model.id === 'nudenet');
    const sam3 = models.find(model => model.id === 'sam3');
    const selectedLegacy = getSelectedLegacyModelRecord();
    const modelType = document.getElementById('censor-model-type')?.value || 'legacy';
    const quickAutoFallback = getQuickAutoCensorFallbackConfig();

    const cards = [];
    if (selectedLegacy) {
        const caps = selectedLegacy.capabilities || {};
        cards.push(buildCapabilityCardHtml(
            selectedLegacy.name,
            selectedLegacy.profile_label,
            [
                `Input: ${caps.input_mode_label || 'Fixed model labels'}`,
                `Output: ${caps.output_mode_label || 'Legacy detection'}`,
                `Scope: ${caps.class_scope_label || 'Unknown'}`,
                `Text prompt: ${caps.supports_text_prompt ? 'Yes' : 'No'}`,
            ],
            caps.plain_english || selectedLegacy.message || '',
            { recommended: Boolean(selectedLegacy.recommended_for_censor) }
        ));
    }

    if (nudenet) {
        const caps = nudenet.capabilities || {};
        cards.push(buildCapabilityCardHtml(
            nudenet.name,
            nudenet.available ? 'Ready' : 'Optional',
            [
                `Input: ${caps.input_mode_label || 'Built-in NSFW labels'}`,
                `Output: ${caps.output_mode_label || 'Detection boxes'}`,
                `Scope: ${caps.class_scope_label || 'Built-in NSFW labels'}`,
                `Text prompt: ${caps.supports_text_prompt ? 'Yes' : 'No'}`,
            ],
            caps.plain_english || nudenet.message || '',
            { recommended: Boolean(nudenet.recommended) }
        ));
    }

    if (sam3) {
        const caps = sam3.capabilities || {};
        cards.push(buildCapabilityCardHtml(
            sam3.name,
            sam3.available ? 'Precision' : 'GPU-only optional',
            [
                `Input: ${caps.input_mode_label || 'Text prompt or box prompt'}`,
                `Output: ${caps.output_mode_label || 'Pixel masks'}`,
                `Scope: ${caps.class_scope_label || 'Prompt-guided segmentation'}`,
                `Text prompt: ${caps.supports_text_prompt ? 'Yes' : 'No'}`,
            ],
            caps.plain_english || sam3.message || '',
            { recommended: Boolean(sam3.available) }
        ));
    }

    panel.innerHTML = cards.join('');

    const quickFilterEnabled = shouldUseQuickTargetFilters(modelType);
    const quickFilterDisabled = shouldDisableQuickTargetFilters(modelType);
    targetChecks.forEach(input => {
        input.disabled = quickFilterDisabled;
    });
    if (targetGroup) {
        targetGroup.style.display = '';
        targetGroup.classList.toggle('is-disabled', quickFilterDisabled);
    }

    if (targetHelp) {
        if (modelType === 'both') {
            targetHelp.textContent = tText(
                'These quick privacy targets work across Wenaka and NudeNet family labels. They do not control generic COCO classes.',
                '这些快捷隐私目标会同时作用在 Wenaka 和 NudeNet 的隐私类别上，但不会控制通用 COCO 类别。'
            );
        } else if (modelType === 'nudenet') {
            targetHelp.textContent = tText(
                'NudeNet uses its own label system, but these quick privacy targets now map to the matching NudeNet families.',
                'NudeNet 有自己的一套标签，但这些快捷隐私目标现在会映射到对应的 NudeNet 类别。'
            );
        } else if (quickFilterEnabled) {
            if (modelType === 'legacy' && selectedLegacy?.profile !== 'privacy-censor' && quickAutoFallback.canAutoRestore) {
                targetHelp.textContent = tText(
                    'These quick privacy targets stay active. When you run Quick Auto Censor, the app will switch back to the recommended privacy detector instead of using this general YOLO test model.',
                    '这些快捷隐私目标会继续生效。等你真正运行快捷自动打码时，应用会自动切回推荐的隐私检测路线，而不会继续使用当前这个通用 YOLO 测试模型。'
                );
            } else {
                targetHelp.textContent = tText(
                    'These quick privacy targets map to the fixed privacy classes inside the current local model.',
                    '这些快捷隐私目标会映射到当前本地模型里的固定隐私类别。'
                );
            }
        } else {
            targetHelp.textContent = tText(
                'These quick privacy targets stay visible so you can see the normal workflow, but the current general segmentation model cannot map them. Switch back to the recommended privacy model or Both if you want clickable privacy presets.',
                '这些快捷隐私目标会继续显示，方便你看见正常工作流；但当前这个通用分割模型无法映射它们。想要可点击的隐私预设，请切回推荐隐私模型或“两者一起”。'
            );
        }
    }

    if (promptHelp) {
        promptHelp.textContent = sam3?.available
            ? tText(
                'Uses SAM3 text-prompt segmentation on the current image. This is the precise pro tool.',
                '这里会对当前图片执行 SAM3 文本提示分割，这是给专业用户用的精细工具。'
            )
            : tText(
                `You can still type a prompt here, but this machine cannot run SAM3 yet. ${sam3?.message || ''}`.trim(),
                `你现在仍然可以先输入提示词，但这台机器暂时跑不了 SAM3。${sam3?.message || ''}`.trim()
            );
    }

    if (promptInput) {
        promptInput.readOnly = false;
        promptInput.removeAttribute('disabled');
        promptInput.setAttribute('aria-disabled', 'false');
    }
    if (segmentButton) {
        segmentButton.disabled = !sam3?.available;
        segmentButton.title = sam3?.available
            ? ''
            : (sam3?.message || tText('SAM3 is not available in this environment yet.', '当前环境暂时无法使用 SAM3。'));
    }

    if (simpleGuide) {
        if (modelType === 'nudenet') {
            simpleGuide.textContent = tText(
                'NudeNet is the simple path: no text prompt, no custom labels. Use it when you want quick NSFW/body-region boxes.',
                'NudeNet 是最省事的路线：不用填文本，也不用自定义类别。适合快速拿到 NSFW / 身体区域框。'
            );
        } else if (modelType === 'both') {
            simpleGuide.textContent = tText(
                'Recommended for most people: run NudeNet together with the auto-picked privacy model. If the local model has segmentation masks, the auto-censor path will use them.',
                '大多数人建议用这个：让 NudeNet 和自动挑选的隐私模型一起跑。如果本地模型带 segmentation mask，自动打码会优先用 mask。'
            );
        } else if (selectedLegacy?.profile === 'privacy-censor') {
            simpleGuide.textContent = tText(
                'This local model is the privacy-part route. It only understands its fixed privacy labels, but if it exposes segmentation masks the auto-censor path will use them instead of raw rectangles.',
                '当前这个本地模型就是隐私部位路线。它只认固定隐私标签；如果它本身提供 segmentation mask，自动打码会优先用 mask，而不是只用矩形框。'
            );
        } else if (selectedLegacy) {
            simpleGuide.textContent = quickAutoFallback.canAutoRestore
                ? tText(
                    `${selectedLegacy.name} is a general fixed-class segmentation model kept for advanced tests. Quick Auto Censor will automatically switch back to the recommended privacy route before it runs.`,
                    `${selectedLegacy.name} 是保留下来的通用固定类分割模型，只给高级测试用。真正运行快捷自动打码前，应用会自动切回推荐的隐私检测路线。`
                )
                : tText(
                    `${selectedLegacy.name} is a general fixed-class segmentation model kept for advanced tests. It can segment its own built-in object classes, but it is not an open-text privacy detector.`,
                    `${selectedLegacy.name} 是保留下来的通用固定类分割模型，只给高级测试用。它可以分割自己内置的物体类别，但不是开放文本隐私检测器。`
                );
        } else {
            simpleGuide.textContent = tText(
                'Keep the recommended mode and leave custom paths blank unless you are doing advanced model experiments.',
                '除非你在做高级模型实验，否则保持推荐模式、把自定义路径留空就好。'
            );
        }
    }
}

function formatLegacyModelOptionLabel(file) {
    const profile = file?.profile_label ? ` - ${file.profile_label}` : '';
    const purpose = file?.recommended_for_censor
        ? tText('Recommended privacy route', '推荐隐私路线')
        : tText('Advanced test only', '仅高级测试');
    return `${file.name} (${file.size_mb} MB)${profile} · ${purpose}`;
}

function getVisibleLegacyModels(files, currentValue = '') {
    return files.filter((file) => {
        if (!file?.path) return false;
        if (CensorState.showAdvancedLegacyModels) return true;
        if (file.recommended_for_censor) return true;
        return Boolean(currentValue) && file.path === currentValue;
    });
}

function syncAdvancedLegacyModelUi(legacyModel) {
    const toggle = document.getElementById('censor-show-advanced-models');
    const help = document.getElementById('censor-advanced-models-help');
    if (toggle) {
        toggle.checked = CensorState.showAdvancedLegacyModels;
    }
    if (!help) return;

    const generalCount = Number(legacyModel?.general_model_count || 0);
    if (generalCount <= 0) {
        help.textContent = tText(
            'No extra general YOLO compatibility models were found locally.',
            '本地没有额外的通用 YOLO 兼容模型。'
        );
        return;
    }

    help.textContent = CensorState.showAdvancedLegacyModels
        ? tText(
            `${generalCount} advanced fixed-class YOLO model(s) are visible below. They are for compatibility tests, not normal privacy censoring.`,
            `下方已显示 ${generalCount} 个高级固定类 YOLO 模型。它们是给兼容/分割测试用的，不是普通隐私打码主流程。`
        )
        : tText(
            `${generalCount} advanced fixed-class YOLO model(s) are hidden to keep the normal workflow simpler. Leave this off unless you intentionally want advanced fixed-class YOLO compatibility tests.`,
            `为了让普通流程更简单，已隐藏 ${generalCount} 个高级固定类 YOLO 模型。除非你是故意要做高级固定类 YOLO 兼容测试，否则不要打开。`
        );
}

function updateSelectedLegacyModelHelp(legacyModel) {
    const help = document.getElementById('censor-model-file-help');
    if (!help) return;

    const manualPath = String(document.getElementById('censor-model-path')?.value || '').trim();
    if (manualPath) {
        help.textContent = tText(
            'Custom path is active. Leave it blank if you want the app to auto-pick the recommended local privacy model.',
            '当前正在使用自定义路径。如果你想让应用自动挑选推荐的本地隐私模型，就把这里留空。'
        );
        return;
    }

    const selectedPath = String(document.getElementById('censor-model-file')?.value || '').trim();
    const selectedFile = getLegacyModelRecordByPath(selectedPath) || getLegacyModelRecordByPath(legacyModel?.default_model_path);
    if (!selectedFile) {
        help.textContent = tText(
            'No local YOLO model was found. NudeNet can still work if it is installed.',
            '本地没有找到 YOLO 模型。如果已经装好 NudeNet，它仍然可以继续工作。'
        );
        return;
    }

    const parts = [tText(`Selected: ${selectedFile.name}`, `当前选择：${selectedFile.name}`)];
    if (selectedFile.profile_label) {
        parts.push(selectedFile.profile_label);
    }
    if (selectedFile.message) {
        parts.push(selectedFile.message);
    }
    help.textContent = parts.join(' · ');
}

function populateCensorModelSelect(legacyModel) {
    const select = document.getElementById('censor-model-file');
    if (!select) return;

    const currentValue = CensorState.modelPath || '';
    const files = Array.isArray(legacyModel?.files) ? legacyModel.files : [];
    const visibleFiles = getVisibleLegacyModels(files, currentValue);
    const seen = new Set();
    const options = [`<option value="">${escapeHtml(tText('Auto-pick the recommended local model', '自动选择推荐的本地模型'))}</option>`];

    visibleFiles.forEach(file => {
        if (!file?.path || seen.has(file.path)) return;
        seen.add(file.path);
        const label = formatLegacyModelOptionLabel(file);
        options.push(`<option value="${escapeHtml(file.path)}">${escapeHtml(label)}</option>`);
    });

    select.innerHTML = options.join('');
    if (currentValue && seen.has(currentValue)) {
        select.value = currentValue;
    } else {
        select.value = '';
    }

    syncAdvancedLegacyModelUi(legacyModel);
    updateSelectedLegacyModelHelp(legacyModel);
    renderCensorCapabilityPanel();
}

function updateDetectionModelInputs() {
    const modelType = document.getElementById('censor-model-type')?.value || 'legacy';
    const needsLegacyPath = modelType === 'legacy' || modelType === 'both';
    const modelFileGroup = document.getElementById('censor-model-file')?.closest('.form-group');
    const modelPathGroup = document.getElementById('censor-model-path')?.closest('.form-group');
    const manualPath = String(document.getElementById('censor-model-path')?.value || '').trim();
    const showAdvancedInputs = CensorState.showAdvancedLegacyModels || Boolean(manualPath);

    if (modelFileGroup) modelFileGroup.style.display = needsLegacyPath ? '' : 'none';
    if (modelPathGroup) modelPathGroup.style.display = needsLegacyPath && showAdvancedInputs ? '' : 'none';

    // Show/hide SAM3 confidence slider in sidebar based on SAM3 availability
    const sam3Group = document.getElementById('sam3-confidence-group');
    if (sam3Group) {
        const sam3Model = (CensorState.backendModelStatus?.models || []).find(m => m.id === 'sam3');
        sam3Group.style.display = sam3Model?.available ? '' : 'none';
    }

    renderCensorCapabilityPanel();
}

function getLegacyBackendStatus() {
    return (CensorState.backendModelStatus?.models || []).find(model => model.id === 'legacy') || null;
}

function getQuickAutoCensorFallbackConfig() {
    const legacy = getLegacyBackendStatus();
    const nudenet = (CensorState.backendModelStatus?.models || []).find(model => model.id === 'nudenet') || null;
    const privacyPath = String(
        legacy?.default_model_path
        || legacy?.files?.find(file => file?.recommended_for_censor)?.path
        || ''
    ).trim();

    let fallbackModelType = String(CensorState.backendModelStatus?.recommended_backend || '').trim();
    if (!fallbackModelType) {
        if (nudenet?.available && privacyPath) {
            fallbackModelType = 'both';
        } else if (nudenet?.available) {
            fallbackModelType = 'nudenet';
        } else if (privacyPath) {
            fallbackModelType = 'legacy';
        }
    }

    return {
        legacy,
        nudenet,
        privacyPath,
        fallbackModelType,
        canAutoRestore: Boolean(fallbackModelType || privacyPath),
    };
}

function setPreferredLegacyModelPath(nextPath = '') {
    const normalized = String(nextPath || '').trim();
    const modelPathInput = document.getElementById('censor-model-path');
    const select = document.getElementById('censor-model-file');

    if (modelPathInput) {
        modelPathInput.value = '';
    }

    if (select) {
        const optionExists = Array.from(select.options).some(option => option.value === normalized);
        select.value = optionExists ? normalized : '';
    }

    CensorState.modelPath = normalized;
    localStorage.setItem('censor_model_path', normalized);

    const legacy = getLegacyBackendStatus();
    updateSelectedLegacyModelHelp(legacy);
}

function getSelectedLegacyModelPath() {
    const modelPathInput = document.getElementById('censor-model-path');
    const select = document.getElementById('censor-model-file');
    const manualPath = String(modelPathInput?.value || '').trim();
    if (manualPath) {
        return manualPath;
    }
    return String(select?.value || '').trim();
}

function shouldUseQuickTargetFilters(modelType = document.getElementById('censor-model-type')?.value || 'legacy') {
    const selectedLegacy = getSelectedLegacyModelRecord();
    if (modelType === 'nudenet' || modelType === 'both') {
        return true;
    }
    if (modelType === 'legacy' && selectedLegacy?.profile === 'privacy-censor') {
        return true;
    }
    if (modelType === 'legacy') {
        return getQuickAutoCensorFallbackConfig().canAutoRestore;
    }
    return false;
}

function shouldDisableQuickTargetFilters(modelType = document.getElementById('censor-model-type')?.value || 'legacy') {
    const selectedLegacy = getSelectedLegacyModelRecord();
    if (modelType === 'nudenet' || modelType === 'both') {
        return false;
    }
    if (modelType === 'legacy' && selectedLegacy?.profile === 'privacy-censor') {
        return false;
    }
    return !getQuickAutoCensorFallbackConfig().canAutoRestore;
}

function getSelectedTargetClassesForDetection(modelType) {
    return shouldUseQuickTargetFilters(modelType) ? [...CensorState.targetClasses] : null;
}

async function resolveQuickAutoCensorExecutionPlan(options = {}) {
    const { silent = false } = options;
    const { showToast } = window.App;

    if (!CensorState.backendModelStatus) {
        await loadCensorModelStatus();
    }

    const modelTypeSelect = document.getElementById('censor-model-type');
    let modelType = modelTypeSelect?.value || 'legacy';
    let selectedLegacy = getSelectedLegacyModelRecord();
    const { fallbackModelType, privacyPath, canAutoRestore } = getQuickAutoCensorFallbackConfig();

    let switchMessage = '';

    if ((modelType === 'legacy' || modelType === 'both') && selectedLegacy?.profile !== 'privacy-censor') {
        if (!canAutoRestore) {
            return {
                ok: false,
                message: tText(
                    'Quick Auto Censor needs a real privacy detector, but this machine does not have one ready yet.',
                    '快捷自动打码需要真正的隐私检测模型，但这台机器当前还没有可用的隐私检测路线。'
                ),
            };
        }

        if (modelType === 'legacy' && fallbackModelType) {
            modelType = fallbackModelType;
            if (modelTypeSelect) {
                modelTypeSelect.value = modelType;
            }
        }

        if (privacyPath) {
            setPreferredLegacyModelPath(privacyPath);
        }

        updateDetectionModelInputs();
        selectedLegacy = getSelectedLegacyModelRecord();

        const routeLabel = modelType === 'both'
            ? tText('Both mode', '两者一起')
            : (modelType === 'nudenet'
                ? 'NudeNet'
                : tText('the privacy-part detector', '隐私部位检测模型'));

        switchMessage = tText(
            `Quick Auto Censor switched back to ${routeLabel} so the general YOLO test model will not blur unrelated parts of the image.`,
            `快捷自动打码已自动切回 ${routeLabel}，避免继续用通用 YOLO 测试模型去误糊图片里的无关区域。`
        );

        if (!silent && switchMessage) {
            showToast(switchMessage, 'warning');
        }
    }

    const targetClasses = getSelectedTargetClassesForDetection(modelType);
    if (Array.isArray(targetClasses) && targetClasses.length === 0) {
        return {
            ok: false,
            message: tText(
                'Select at least one quick privacy target first.',
                '请先勾选至少一个快捷隐私目标。'
            ),
        };
    }

    return {
        ok: true,
        modelType,
        modelPath: getSelectedLegacyModelPath(),
        targetClasses,
        switchMessage,
        selectedLegacy,
    };
}

function captureCanvasState(canvas = null) {
    const targetCanvas = canvas || document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!targetCanvas || !targetCanvas.width) return null;

    try {
        return targetCanvas.toDataURL('image/png');
    } catch (error) {
        Logger.error('Failed to capture canvas state:', error);
        return null;
    }
}

function pushUndoState(serializedState = null) {
    const state = serializedState || captureCanvasState();
    if (!state) return null;

    const previousState = CensorState.undoStack[CensorState.undoStack.length - 1];
    if (previousState === state) {
        return state;
    }

    CensorState.undoStack.push(state);
    const maxDepth = getCensorUndoDepth();
    while (CensorState.undoStack.length > maxDepth) CensorState.undoStack.shift();
    if (typeof window.__invalidateCensorFilterPreview === 'function') {
        window.__invalidateCensorFilterPreview();
    }
    CensorState.redoStack = [];
    CensorState.lastHistorySource = 'canvas';
    updateUndoRedoButtons();
    return state;
}

function updateUndoRedoButtons() {
    const canUndoCanvas = CensorState.undoStack.length > 1;
    const canRedoCanvas = CensorState.redoStack.length > 0;
    const canUndoFilter = CensorState.filterActionUndoStack.length > 0;
    const canRedoFilter = CensorState.filterActionRedoStack.length > 0;
    const canUndo = canUndoFilter || canUndoCanvas;
    const canRedo = canRedoFilter || canRedoCanvas;

    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) {
        undoBtn.disabled = !canUndo;
        undoBtn.setAttribute('aria-disabled', String(!canUndo));
    }
    if (redoBtn) {
        redoBtn.disabled = !canRedo;
        redoBtn.setAttribute('aria-disabled', String(!canRedo));
    }
}

function pushFilterActionHistory(entry) {
    if (!entry?.snapshots?.length) return;
    CensorState.filterActionUndoStack.push(entry);
    if (CensorState.filterActionUndoStack.length > 20) {
        CensorState.filterActionUndoStack.shift();
    }
    CensorState.filterActionRedoStack = [];
    CensorState.lastHistorySource = 'filter';
    updateUndoRedoButtons();
}

async function restoreFilterActionEntry(entry, direction = 'undo') {
    if (!entry?.snapshots?.length) return;

    for (const snapshot of entry.snapshots) {
        const item = CensorState.queue.find((queueItem) => queueItem.id === snapshot.id);
        if (!item) continue;
        if (direction === 'undo') {
            item.currentDataUrl = snapshot.beforeDataUrl || null;
            item.isModified = Boolean(snapshot.beforeModified);
        } else {
            item.currentDataUrl = snapshot.afterDataUrl || null;
            item.isModified = Boolean(snapshot.afterModified);
        }
    }

    renderQueue();
    if (CensorState.activeId && entry.targetIds?.includes(CensorState.activeId)) {
        await loadCanvasImage(CensorState.activeId);
    }
    updateUndoRedoButtons();
}

function clearCanvas() {
    // Clear the ACTIVE canvas, not always the default one
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Also clear the buffer canvas
    const bufferId = CensorState.activeCanvasId === 'censor-canvas' ? 'censor-canvas-buffer' : 'censor-canvas';
    const bufferCanvas = document.getElementById(bufferId);
    if (bufferCanvas) {
        const bufCtx = bufferCanvas.getContext('2d');
        bufCtx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);
    }
    document.getElementById('censor-no-image').style.display = 'flex';
    document.getElementById('censor-filename').textContent = '-';
}

// ============== Drawing Tools ==============

function onCanvasMouseDown(e) {
    if (!CensorState.activeId) return;
    // Don't start drawing if space is held (pan mode)
    if (spacePressed) return;
    document.getElementById('canvas-wrapper')?.focus();
    CensorState.isDrawing = true;

    const { x, y } = getCanvasCoordinates(e);
    CensorState.lastPoint = { x, y };

    if (CensorState.currentTool === 'clone' && e.altKey) {
        CensorState.cloneSource = { x, y };
        CensorState.cloneOffset = null;
        CensorState.cloneSourceSet = true;
        window.App.showToast('Clone source set - now paint to clone', 'info');
        CensorState.isDrawing = false;
        return;
    }

    drawAtPoint(x, y);
}

function onCanvasMouseMove(e) {
    if (!isCensorViewActive()) return;

    // Update cursor overlay position (relative to screen/wrapper)
    updateCursorOverlay(e);

    if (!CensorState.isDrawing || !CensorState.activeId) return;

    const { x, y } = getCanvasCoordinates(e);

    // Interpolate
    const steps = Math.max(1, Math.floor(Math.hypot(x - CensorState.lastPoint.x, y - CensorState.lastPoint.y) / 2));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        drawAtPoint(
            CensorState.lastPoint.x + (x - CensorState.lastPoint.x) * t,
            CensorState.lastPoint.y + (y - CensorState.lastPoint.y) * t
        );
    }
    CensorState.lastPoint = { x, y };
}

function onCanvasMouseUp() {
    if (!isCensorViewActive()) return;

    const wasDrawing = CensorState.isDrawing;
    CensorState.isDrawing = false;

    if (!wasDrawing || !CensorState.activeId) return;

    const committedState = pushUndoState();
    saveCurrentCanvasToState(committedState);
}

function getCanvasCoordinates(e) {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const rect = canvas.getBoundingClientRect();

    // Account for CSS scaling
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function drawAtPoint(x, y) {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const ctx = canvas.getContext('2d');
    const size = CensorState.brushSize;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);

    if (CensorState.currentTool === 'brush') {
        applyCensorStyle(ctx, x, y, size);
    } else if (CensorState.currentTool === 'pen') {
        // Draw with pen color and opacity
        ctx.globalAlpha = CensorState.penOpacity;
        ctx.fillStyle = CensorState.penColor;
        ctx.fill();
        ctx.globalAlpha = 1.0;
    } else if (CensorState.currentTool === 'eraser') {
        // Restore from original image
        ctx.clip();
        if (CensorState.originalImage) {
            ctx.drawImage(CensorState.originalImage, 0, 0, canvas.width, canvas.height);
        } else if (CensorState.originalImageData) {
            // Fallback to stored image data
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = canvas.width;
            tempCanvas.height = canvas.height;
            tempCanvas.getContext('2d').putImageData(CensorState.originalImageData, 0, 0);
            ctx.drawImage(tempCanvas, 0, 0);
        }
    } else if (CensorState.currentTool === 'clone') {
        if (!CensorState.cloneSourceSet) {
            // Clone source not set - show hint
            return;
        }
        performClone(ctx, x, y, size);
    }

    ctx.restore();
}

function applyCensorStyle(ctx, x, y, size) {
    const style = CensorState.style;
    const b = CensorState.blockSize;
    const canvas = ctx.canvas;

    if (style === 'mosaic') {
        // Snap to grid
        const startX = Math.floor((x - size / 2) / b) * b;
        const startY = Math.floor((y - size / 2) / b) * b;
        const endX = Math.ceil((x + size / 2) / b) * b;
        const endY = Math.ceil((y + size / 2) / b) * b;

        for (let bx = startX; bx < endX; bx += b) {
            for (let by = startY; by < endY; by += b) {
                // Circle check
                if (Math.hypot(bx + b / 2 - x, by + b / 2 - y) <= size / 2) {
                    const data = ctx.getImageData(bx, by, b, b);
                    const avg = getAverageColor(data);
                    ctx.fillStyle = avg;
                    ctx.fillRect(bx, by, b, b);
                }
            }
        }
    } else if (style === 'blur') {
        // Apply actual blur effect
        const blurRadius = Math.max(8, CensorState.blockSize);
        const regionX = Math.max(0, Math.floor(x - size / 2));
        const regionY = Math.max(0, Math.floor(y - size / 2));
        const regionW = Math.min(canvas.width - regionX, Math.ceil(size));
        const regionH = Math.min(canvas.height - regionY, Math.ceil(size));

        if (regionW > 0 && regionH > 0) {
            // Create temporary canvas for blur
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = regionW;
            tempCanvas.height = regionH;
            const tempCtx = tempCanvas.getContext('2d');

            // Copy region to temp canvas
            tempCtx.drawImage(canvas, regionX, regionY, regionW, regionH, 0, 0, regionW, regionH);

            // Apply blur filter
            tempCtx.filter = `blur(${blurRadius}px)`;
            tempCtx.drawImage(tempCanvas, 0, 0);
            tempCtx.filter = 'none';

            // Draw back with circular clip
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(tempCanvas, regionX, regionY);
            ctx.restore();
        }
    } else if (style === 'black_bar') {
        ctx.fillStyle = '#000';
        ctx.fill();
    } else if (style === 'white_bar') {
        ctx.fillStyle = '#fff';
        ctx.fill();
    }
}

function getAverageColor(imageData) {
    const d = imageData.data;
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; c++; }
    return c ? `rgb(${r / c | 0},${g / c | 0},${b / c | 0})` : '#000';
}

function performClone(ctx, x, y, size) {
    if (!CensorState.cloneSource) return;

    if (!CensorState.cloneOffset) {
        CensorState.cloneOffset = { x: CensorState.cloneSource.x - x, y: CensorState.cloneSource.y - y };
    }

    const sourceX = x + CensorState.cloneOffset.x;
    const sourceY = y + CensorState.cloneOffset.y;

    ctx.clip();
    // Draw directly from current canvas state (or original? usually current)
    // Actually cloning usually samples from same layer.
    // To simplify: Clone samples from a snapshot of the canvas taken at start of stroke?
    // For now: Clone from original image for simplicity (allows "repair" using clean parts)
    if (CensorState.originalImage) {
        ctx.drawImage(CensorState.originalImage, sourceX - size / 2, sourceY - size / 2, size, size, x - size / 2, y - size / 2, size, size);
    }
}

// ============== Auto Censor Logic ==============

async function runAutoCensorBatch() {
    const { showToast } = window.App;
    if (CensorState.queue.length === 0) {
        showToast(tText('Queue is empty', '队列为空'), 'error');
        return;
    }

    const executionPlan = await resolveQuickAutoCensorExecutionPlan();
    if (!executionPlan?.ok) {
        showToast(executionPlan?.message || tText('Quick Auto Censor could not start.', '快捷自动打码无法开始。'), 'warning');
        return;
    }

    const tracker = window.App.createProgressTracker();

    showLoading(true, 'Auto Censor · preparing queue...');

    for (let index = 0; index < CensorState.queue.length; index += 1) {
        const item = CensorState.queue[index];
        showLoading(true, window.App.buildProgressText({
            progress: { message: item.originalFilename || item.outputFilename || `Image ${item.id}` },
            completed: index,
            total: CensorState.queue.length,
            tracker,
            defaultMessage: 'Running auto-censor...',
            primaryLabel: 'Auto Censor'
        }));
        await runDetectionForImage(item, true, executionPlan); // true = silent/no-refresh
    }

    showLoading(false);
    renderQueue();
    // Reload canvas if active item was updated
    if (CensorState.activeId) loadCanvasImage(CensorState.activeId);
    showToast(
        executionPlan.switchMessage
            ? tText('Batch processing complete. The app auto-restored the privacy detector before running.', '批量处理完成。开始前应用已自动恢复为隐私检测路线。')
            : tText('Batch processing complete', '批量处理完成'),
        'success'
    );
}

async function runDetectionForImage(item, silent = false, executionPlan = null) {
    try {
        const plan = executionPlan || await resolveQuickAutoCensorExecutionPlan({ silent });
        if (!plan?.ok) {
            item.regions = [];
            item.currentDataUrl = null;
            item.isProcessed = false;
            if (!silent && item.id === CensorState.activeId) {
                loadCanvasImage(item.id);
                window.App.showToast(
                    plan?.message || tText('Quick Auto Censor could not start.', '快捷自动打码无法开始。'),
                    'warning'
                );
            }
            return;
        }

        const data = await window.App.API.post('/api/censor/detect', {
            image_id: item.id,
            model_path: plan.modelPath,
            model_type: plan.modelType,
            confidence_threshold: CensorState.confidence,
            target_classes: plan.targetClasses,
        });

        const regions = [...(data.detections || [])].sort((a, b) => b.confidence - a.confidence);
        item.regions = regions;

        // Apply to a temporary canvas to generate DataURL
        const img = await loadImage(item.originalUrl);
        const cvs = document.createElement('canvas');
        cvs.width = img.width;
        cvs.height = img.height;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const { maskRegions, boxRegions } = splitDetectionGeometry(regions);
        const shouldUseMask = Boolean(data.combined_mask) && maskRegions.length > 0;
        const shouldUseBoxes = boxRegions.length > 0;

        if (shouldUseMask) {
            await renderRasterMaskEffectOntoCanvas(cvs, data.combined_mask);
        }
        if (shouldUseBoxes) {
            applyBoxRegionsToCanvas(cvs, img, boxRegions);
        }

        if (shouldUseMask || shouldUseBoxes) {
            item.currentDataUrl = cvs.toDataURL('image/png');
            item.isProcessed = true;
        } else {
            item.currentDataUrl = null;
            item.isProcessed = false;
        }

        if (!silent && item.id === CensorState.activeId) {
            loadCanvasImage(item.id);
            if (regions.length === 0) {
                window.App.showToast(
                    tText('No matching regions were found. Try lowering confidence or changing the model.', '没有找到匹配区域。可以试着降低置信度，或换一条检测路线。'),
                    'info'
                );
            } else {
                const usedMask = shouldUseMask;
                window.App.showToast(
                    usedMask && shouldUseBoxes
                        ? tText(`Applied mixed auto-censor to ${regions.length} region(s)`, `已对 ${regions.length} 个区域应用混合自动打码`)
                        : (usedMask
                            ? tText(`Applied auto-censor mask to ${regions.length} matched region(s)`, `已对 ${regions.length} 个匹配区域应用自动打码 mask`)
                            : tText(`Applied box-based auto-censor to ${regions.length} region(s)`, `已对 ${regions.length} 个区域应用基于框的自动打码`)),
                    'success'
                );
            }
        }

    } catch (e) {
        Logger.error(e);
        if (!silent) window.App.showToast(formatUserError(e, "Detection failed"), "error");
    }
}

function applyBoxRegionsToCanvas(canvas, baseImage, regions) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    regions.forEach(r => {
        if (!Array.isArray(r?.box) || r.box.length !== 4) return;
        const [x1, y1, x2, y2] = r.box;
        const w = x2 - x1;
        const h = y2 - y1;

        if (CensorState.style === 'mosaic') {
            const b = CensorState.blockSize;
            for (let bx = x1; bx < x2; bx += b) {
                for (let by = y1; by < y2; by += b) {
                    const bw = Math.min(b, x2 - bx);
                    const bh = Math.min(b, y2 - by);
                    const d = ctx.getImageData(bx, by, bw, bh);
                    ctx.fillStyle = getAverageColor(d);
                    ctx.fillRect(bx, by, bw, bh);
                }
            }
        } else if (CensorState.style === 'blur') {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1, y1, w, h);
            ctx.clip();
            ctx.filter = `blur(${CensorState.blockSize / 2}px)`;
            ctx.drawImage(baseImage, 0, 0);
            ctx.restore();
        } else if (CensorState.style === 'white_bar') {
            ctx.fillStyle = '#fff';
            ctx.fillRect(x1, y1, w, h);
        } else {
            ctx.fillStyle = '#000';
            ctx.fillRect(x1, y1, w, h);
        }
    });
    ctx.restore();
}

async function normalizeMaskDataUrl(maskDataUrl) {
    const maskImage = await loadImage(maskDataUrl);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = maskImage.naturalWidth || maskImage.width;
    maskCanvas.height = maskImage.naturalHeight || maskImage.height;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);

    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const pixels = imageData.data;
    for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3];
        const luminance = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
        const hasVisibleAlpha = alpha > 0;
        const hasOpaqueRgbWithoutAlpha = !hasVisibleAlpha && luminance > 0;
        const nextAlpha = hasVisibleAlpha ? alpha : (hasOpaqueRgbWithoutAlpha ? luminance : 0);
        pixels[index] = 255;
        pixels[index + 1] = 255;
        pixels[index + 2] = 255;
        pixels[index + 3] = nextAlpha;
    }
    maskCtx.putImageData(imageData, 0, 0);
    return loadImage(maskCanvas.toDataURL('image/png'));
}

function splitDetectionGeometry(regions = []) {
    const maskRegions = [];
    const boxRegions = [];

    regions.forEach(region => {
        const polygon = Array.isArray(region?.polygon) ? region.polygon : [];
        const validPointCount = polygon.filter(point => Array.isArray(point) && point.length >= 2).length;
        if (validPointCount >= 3) {
            maskRegions.push(region);
        } else if (Array.isArray(region?.box) && region.box.length === 4) {
            boxRegions.push(region);
        }
    });

    return { maskRegions, boxRegions };
}

async function renderRasterMaskEffectOntoCanvas(canvas, maskDataUrl) {
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    const ctx = canvas.getContext('2d');
    const snapshot = captureCanvasState(canvas);
    if (!snapshot) {
        throw new Error('Could not capture the current canvas state');
    }

    const [baseImage, maskImage] = await Promise.all([
        loadImage(snapshot),
        normalizeMaskDataUrl(maskDataUrl),
    ]);

    const effectCanvas = document.createElement('canvas');
    effectCanvas.width = canvas.width;
    effectCanvas.height = canvas.height;
    const effectCtx = effectCanvas.getContext('2d');

    if (CensorState.style === 'mosaic') {
        const downscale = Math.max(1, Math.round(CensorState.blockSize));
        const smallW = Math.max(1, Math.floor(canvas.width / downscale));
        const smallH = Math.max(1, Math.floor(canvas.height / downscale));
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = smallW;
        tmpCanvas.height = smallH;
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.imageSmoothingEnabled = false;
        tmpCtx.drawImage(baseImage, 0, 0, smallW, smallH);
        effectCtx.imageSmoothingEnabled = false;
        effectCtx.drawImage(tmpCanvas, 0, 0, smallW, smallH, 0, 0, canvas.width, canvas.height);
    } else if (CensorState.style === 'blur') {
        effectCtx.filter = `blur(${Math.max(1, Math.round(CensorState.blockSize / 2))}px)`;
        effectCtx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
        effectCtx.filter = 'none';
    } else if (CensorState.style === 'white_bar') {
        effectCtx.fillStyle = '#fff';
        effectCtx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
        effectCtx.fillStyle = '#000';
        effectCtx.fillRect(0, 0, canvas.width, canvas.height);
    }

    effectCtx.globalCompositeOperation = 'destination-in';
    effectCtx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);

    ctx.drawImage(effectCanvas, 0, 0);
}

async function applyRasterMaskToActiveCanvas(maskDataUrl) {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    await renderRasterMaskEffectOntoCanvas(canvas, maskDataUrl);
    const committedState = pushUndoState();
    saveCurrentCanvasToState(committedState);

    const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (activeItem) {
        activeItem.isProcessed = true;
    }
    renderQueue();
}

async function segmentCurrentImageByText() {
    if (!CensorState.activeId) {
        window.App.showToast('No image selected', 'error');
        return;
    }

    const textPrompt = String(document.getElementById('censor-text-prompt')?.value || '').trim();
    if (!textPrompt) {
        window.App.showToast('Enter a text prompt first', 'warning');
        return;
    }

    showLoading(true, `SAM3 text segment · ${textPrompt}`);
    try {
        const result = await window.App.API.post('/api/censor/segment-text', {
            image_id: CensorState.activeId,
            text_prompt: textPrompt,
        });

        if (!result?.mask) {
            window.App.showToast(result?.message || 'No matching regions were found', 'info');
            return;
        }

        await applyRasterMaskToActiveCanvas(result.mask);
        window.App.showToast(`Applied SAM3 mask for "${textPrompt}"`, 'success');
    } catch (error) {
        window.App.showToast(formatUserError(error, 'SAM3 text segmentation failed'), 'error');
    } finally {
        showLoading(false);
    }
}

// ============== Batch Actions ==============

function resolveRenamePattern(pattern, vars) {
    return pattern.replace(/\{(\w+)(?::(\d+)d)?\}/g, function(match, key, pad) {
        var value = vars[key];
        if (value === undefined) return match;
        if (pad && typeof value === 'number') {
            return String(value).padStart(parseInt(pad, 10), '0');
        }
        if (key === 'n' && typeof value === 'number') {
            return String(value).padStart(3, '0');
        }
        return String(value);
    });
}

function getRenameTargetItems() {
    const onlySelected = document.getElementById('rename-only-selected')?.checked || false;
    const selectedIds = getOrderedSelectedQueueIds();
    if (onlySelected && selectedIds.length) {
        const selectedSet = new Set(selectedIds);
        return CensorState.queue.filter(item => selectedSet.has(item.id));
    }
    return CensorState.queue.slice();
}

function buildRenameFilename(item, index, options = {}) {
    const useOriginal = Boolean(options.useOriginal);
    const base = options.base || 'Image';
    const start = Number(options.start || 1);
    const pattern = String(options.pattern || '').trim();
    const dateStr = options.dateStr || '';
    const timeStr = options.timeStr || '';

    if (useOriginal) {
        const originalName = item?.originalFilename || item?.filename || `image_${index + 1}`;
        const baseName = originalName.replace(/\.[^/.]+$/, '');
        return `${baseName}.png`;
    }

    if (pattern) {
        const originalName = item
            ? (item.originalFilename || item.filename || `image_${index + 1}`).replace(/\.[^/.]+$/, '')
            : `image_${index + 1}`;
        var resolved = resolveRenamePattern(pattern, {
            original: originalName,
            n: start + index,
            date: dateStr,
            time: timeStr
        });
        return resolved + '.png';
    }

    const num = String(start + index).padStart(3, '0');
    return `${base}_${num}.png`;
}

function refreshRenameSelectionUi() {
    const checkbox = document.getElementById('rename-only-selected');
    const help = document.getElementById('rename-selection-help');
    if (!checkbox || !help) return;

    const selectedCount = getOrderedSelectedQueueIds().length;
    checkbox.disabled = selectedCount === 0;
    if (selectedCount === 0) {
        checkbox.checked = false;
        help.textContent = tText(
            'Nothing is selected right now, so the whole queue will be renamed.',
            '当前没有选中队列项目，所以会对整个队列重命名。'
        );
        return;
    }

    help.textContent = checkbox.checked
        ? tText(
            `Only the ${selectedCount} selected queue item(s) will be renamed. The rest stay untouched.`,
            `只会重命名当前选中的 ${selectedCount} 个队列项目，其余项目保持不变。`
        )
        : tText(
            `You have ${selectedCount} selected item(s), but this preview is still targeting the whole queue.`,
            `你当前选中了 ${selectedCount} 个队列项目，但现在这个预览仍然会作用于整个队列。`
        );
}

function updateRenamePreview() {
    const useOriginal = document.getElementById('rename-use-original')?.checked || false;
    const base = document.getElementById('rename-base')?.value || 'Image';
    const start = parseInt(document.getElementById('rename-start')?.value, 10) || 1;
    const patternEl = document.getElementById('rename-pattern');
    const pattern = patternEl ? patternEl.value.trim() : '';
    const previewSummary = document.getElementById('rename-preview-summary');
    const previewList = document.getElementById('rename-preview-list');
    const previewAlert = document.getElementById('rename-preview-alert');
    const escape = window.escapeHtml;
    if (!escape) { console.error('escapeHtml not available'); return; }

    if (!previewSummary || !previewList || !previewAlert) return;

    var now = new Date();
    var dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    var timeStr = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('');

    const targets = getRenameTargetItems();
    const previewItems = targets.length ? targets : CensorState.queue.slice(0, 1);
    const rows = previewItems.map((item, index) => ({
        item,
        currentName: item?.outputFilename || item?.originalFilename || item?.filename || `image_${index + 1}.png`,
        newName: buildRenameFilename(item, index, {
            useOriginal,
            base,
            start,
            pattern,
            dateStr,
            timeStr
        })
    }));

    const duplicateMap = rows.reduce((acc, row) => {
        const key = row.newName.toLowerCase();
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
    }, new Map());
    const duplicateCount = Array.from(duplicateMap.values()).filter(count => count > 1).length;

    const rowHtml = rows.map((row) => {
        const isDuplicate = (duplicateMap.get(row.newName.toLowerCase()) || 0) > 1;
        return `
            <div class="rename-preview-row${isDuplicate ? ' is-duplicate' : ''}">
                <span>${escape(row.currentName)}</span>
                <span>${escape(row.newName)}</span>
            </div>
        `;
    }).join('');

    previewList.innerHTML = `
        <div class="rename-preview-row rename-preview-row-head">
            <span>${escape(tText('Current', '当前文件名'))}</span>
            <span>${escape(tText('New name', '新文件名'))}</span>
        </div>
        ${rowHtml || `
            <div class="rename-preview-row">
                <span>${escape(tText('No queue items yet', '当前还没有队列项目'))}</span>
                <span>${escape(tText('Preview will appear here', '预览会显示在这里'))}</span>
            </div>
        `}
    `;

    const selectedCount = getOrderedSelectedQueueIds().length;
    const previewScope = document.getElementById('rename-only-selected')?.checked && selectedCount > 0
        ? tText(`Previewing ${targets.length} selected item(s).`, `当前预览 ${targets.length} 个已选项目。`)
        : tText(`Previewing ${targets.length} queue item(s).`, `当前预览 ${targets.length} 个队列项目。`);
    const extensionNote = tText(
        ' Final export extension still follows Save Options.',
        ' 最终导出的扩展名仍然以保存设置为准。'
    );
    previewSummary.textContent = `${previewScope}${extensionNote}`;

    if (duplicateCount > 0) {
        previewAlert.className = 'rename-preview-alert is-warning';
        previewAlert.textContent = tText(
            `Duplicate output names detected in this preview (${duplicateCount} conflict group${duplicateCount > 1 ? 's' : ''}). Fix the pattern before applying.`,
            `当前预览里检测到重复输出文件名（${duplicateCount} 组冲突）。请先修改命名规则，再执行重命名。`
        );
    } else {
        previewAlert.className = 'rename-preview-alert';
        previewAlert.textContent = '';
    }
}

async function applyBatchRename() {
    const useOriginal = document.getElementById('rename-use-original')?.checked || false;
    const base = document.getElementById('rename-base')?.value || 'Image';
    const start = parseInt(document.getElementById('rename-start')?.value, 10) || 1;
    const patternEl = document.getElementById('rename-pattern');
    const pattern = patternEl ? patternEl.value.trim() : '';
    const targets = getRenameTargetItems();

    if (!targets.length) {
        window.App.showToast(tText('No queue items to rename', '当前没有可重命名的队列项目'), 'error');
        return;
    }

    var now = new Date();
    var dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    var timeStr = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('');
    const plannedNames = targets.map((item, index) => buildRenameFilename(item, index, {
        useOriginal,
        base,
        start,
        pattern,
        dateStr,
        timeStr
    }));
    const duplicateNames = plannedNames.filter((name, index) => {
        const lower = name.toLowerCase();
        return plannedNames.findIndex(candidate => candidate.toLowerCase() === lower) !== index;
    });
    if (duplicateNames.length > 0) {
        window.App.showToast(
            tText('Rename blocked because the preview still contains duplicate output names.', '当前重命名已被拦截，因为预览里还有重复输出文件名。'),
            'error'
        );
        return;
    }

    targets.forEach((item, index) => {
        item.outputFilename = plannedNames[index];
    });

    renderQueue();
    document.getElementById('rename-modal').classList.remove('visible');

    // Refresh current title if viewing
    if (CensorState.activeId) {
        const item = CensorState.queue.find(i => i.id === CensorState.activeId);
        if (item) document.getElementById('censor-filename').textContent = item.outputFilename;
    }

    window.App.showToast(
        tText(
            `Renamed ${targets.length} image(s)`,
            `已重命名 ${targets.length} 张图片`
        ),
        'success'
    );
}

function openSaveOptionsPopup() {
    if (CensorState.queue.length === 0) {
        window.App.showToast('No images in queue to save', 'error');
        return;
    }

    // Pre-fill with saved values
    const outputFolder = document.getElementById('save-output-folder');
    if (outputFolder) {
        outputFolder.value = CensorState.outputFolder || localStorage.getItem('censor_output_folder') || '';
    }

    const metadataOption = document.getElementById('save-metadata-option');
    if (metadataOption) {
        metadataOption.value = CensorState.metadataOption || 'strip';
    }

    const formatOption = document.getElementById('save-format-option');
    if (formatOption) {
        formatOption.value = CensorState.outputFormat || 'png';
    }

    document.getElementById('save-options-modal')?.classList.add('visible');
}

async function confirmAndSaveAll() {
    // Read options from popup
    const folder = document.getElementById('save-output-folder')?.value;
    const metadataOption = document.getElementById('save-metadata-option')?.value || 'strip';
    const formatOption = document.getElementById('save-format-option')?.value || 'png';

    if (!folder) {
        window.App.showToast('Please specify an output folder', 'error');
        return;
    }

    // Save settings
    CensorState.outputFolder = folder;
    CensorState.metadataOption = metadataOption;
    CensorState.outputFormat = formatOption;
    localStorage.setItem('censor_output_folder', folder);

    // Close popup and start saving
    document.getElementById('save-options-modal')?.classList.remove('visible');

    await saveAllProcessed(formatOption, metadataOption);
}

async function saveAllProcessed(formatOption = 'png', metadataOption = 'strip') {
    const folder = CensorState.outputFolder;
    if (!folder) {
        window.App.showToast('Set output folder in Rename or Setup first', 'error');
        return;
    }

    _resetBatchStatus();
    const tracker = window.App.createProgressTracker();
    showLoading(true, 'Save · preparing files...');

    let count = 0;
    for (let index = 0; index < CensorState.queue.length; index += 1) {
        const item = CensorState.queue[index];
        try {
            showLoading(true, window.App.buildProgressText({
                progress: { message: item.outputFilename || item.originalFilename || `Image ${item.id}` },
                completed: index,
                total: CensorState.queue.length,
                tracker,
                defaultMessage: 'Saving processed images...',
                primaryLabel: 'Save'
            }));
            let dataUrl;

            if (item.currentDataUrl) {
                // Already edited - canvas data has no metadata
                dataUrl = item.currentDataUrl;
            } else if (metadataOption === 'strip') {
                // No edits but stripping metadata - draw through canvas to remove all metadata
                dataUrl = await stripMetadataViaCanvas(item.originalUrl);
            } else {
                // Keep metadata - use original blob (metadata preserved in blob)
                dataUrl = await urlToDataUrl(item.originalUrl);
            }

            // Update filename extension to match selected format
            const baseName = item.outputFilename.replace(/\.[^/.]+$/, '');
            const finalFilename = `${baseName}.${formatOption}`;

            await window.App.API.post('/api/censor/save-data', {
                image_data: dataUrl,
                filename: finalFilename,
                output_folder: folder,
                metadata_option: metadataOption,
                output_format: formatOption,
                original_image_id: item.id  // Pass original image ID for metadata copying
            });
            item.batchStatus = 'saved';
            count++;
        } catch (e) {
            Logger.error(e);
            item.batchStatus = 'failed';
            item.batchError = `${tText('Save failed', '保存失败')}: ${e?.message || e || ''}`.trim();
        }
    }

    showLoading(false);
    renderQueue();
    const { failedCount } = _summarizeBatchFailures();
    if (failedCount > 0) {
        window.App.showToast(
            tText(
                `Saved ${count} images · ${failedCount} failed (red-outlined thumbnails)`,
                `已保存 ${count} 张图片 · ${failedCount} 张失败（红框缩略图）`
            ),
            'warning'
        );
    } else {
        window.App.showToast(
            tText(`Saved ${count} images to ${folder}`, `已保存 ${count} 张图片到 ${folder}`),
            'success'
        );
    }
}

/**
 * Strips all metadata from an image by drawing it through a canvas.
 * Canvas toDataURL() produces a clean image with no embedded metadata.
 */
async function stripMetadataViaCanvas(url) {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // toDataURL creates a clean PNG with no metadata
    return canvas.toDataURL('image/png');
}

async function promptSingleRename() {
    if (!CensorState.activeId) {
        window.App.showToast('No image selected', 'error');
        return;
    }

    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (!item) return;

    const currentName = item.outputFilename || item.filename || 'image.png';
    const newName = await window.App.showInputModal(
        'Rename File',
        'Enter the new filename:',
        currentName
    );

    if (newName !== null && newName !== currentName) {
        // Ensure it has an extension
        let finalName = newName;
        if (!/\.\w+$/.test(finalName)) {
            finalName += '.png';
        }

        item.outputFilename = finalName;
        document.getElementById('censor-filename').textContent = finalName;
        renderQueue();
        window.App.showToast(`Renamed to "${finalName}"`, 'success');
    }
}

// ============== Helpers ==============

function setTool(tool) {
    CensorState.currentTool = tool;
    // Update both v1 and v2 tool buttons
    document.querySelectorAll('.tool-btn, .tool-btn-v2').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === tool);
    });
}

// Collapsible section toggle for V2 properties panel
function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.classList.toggle('collapsed');
    }
}
window.toggleSection = toggleSection; // Make globally accessible for onclick

function updateCursorOverlay(e) {
    const cursor = document.getElementById('cursor-overlay');
    const wrapper = document.getElementById('canvas-wrapper');
    if (!cursor || !wrapper) return;

    // e.clientX is global. Get relative to wrapper
    const rect = wrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Visible only if inside wrapper
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        cursor.style.display = 'none';
        return;
    }

    cursor.style.display = 'block';

    // Calculate visual size based on canvas scaling
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    let visualSize = CensorState.brushSize;

    if (canvas && canvas.width > 0 && CensorState.activeId) {
        const canvasRect = canvas.getBoundingClientRect();
        const scale = canvasRect.width / canvas.width;
        visualSize = CensorState.brushSize * scale;
    }

    cursor.style.width = `${visualSize}px`;
    cursor.style.height = `${visualSize}px`;
    // Position at mouse location - use transform for centering (set in CSS)
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
}

function pushUndo() {
    return pushUndoState();
}


async function undo() {
    if (CensorState.lastHistorySource === 'filter' && CensorState.filterActionUndoStack.length > 0) {
        const entry = CensorState.filterActionUndoStack.pop();
        CensorState.filterActionRedoStack.push(entry);
        await restoreFilterActionEntry(entry, 'undo');
        return;
    }

    // Keep at least 1 item in the stack (the initial/base state)
    if (CensorState.undoStack.length <= 1) return;
    const current = CensorState.undoStack.pop(); // Discard current state
    CensorState.redoStack.push(current);
    const prev = CensorState.undoStack[CensorState.undoStack.length - 1]; // Peek at previous
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    try {
        if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
            const response = await fetch(prev);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            if (typeof bitmap.close === 'function') {
                bitmap.close();
            }
            saveCurrentCanvasToState(prev);
            CensorState.lastHistorySource = 'canvas';
            updateUndoRedoButtons();
            return;
        }
    } catch (error) {
        Logger.warn('Falling back to Image() undo restore:', error);
    }

    const img = new Image();
    img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        saveCurrentCanvasToState(prev);
        CensorState.lastHistorySource = 'canvas';
        updateUndoRedoButtons();
    };
    img.src = prev;
}

async function redo() {
    if (CensorState.lastHistorySource === 'filter' && CensorState.filterActionRedoStack.length > 0) {
        const entry = CensorState.filterActionRedoStack.pop();
        CensorState.filterActionUndoStack.push(entry);
        await restoreFilterActionEntry(entry, 'redo');
        return;
    }

    if (!CensorState.redoStack.length) return;
    const next = CensorState.redoStack.pop();
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    try {
        if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
            const response = await fetch(next);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            if (typeof bitmap.close === 'function') {
                bitmap.close();
            }
            CensorState.undoStack.push(next);
            saveCurrentCanvasToState(next);
            CensorState.lastHistorySource = 'canvas';
            updateUndoRedoButtons();
            return;
        }
    } catch (error) {
        Logger.warn('Falling back to Image() redo restore:', error);
    }

    const img = new Image();
    img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        CensorState.undoStack.push(next);
        saveCurrentCanvasToState(next);
        CensorState.lastHistorySource = 'canvas';
        updateUndoRedoButtons();
    };
    img.src = next;
}

function handleKeydown(e) {
    if (isEditableTarget(e.target)) return;

    // Only handle keys when censor view is active
    if (!isCensorViewActive()) return;

    const key = e.key.toLowerCase();
    const code = e.code;

    // Navigation: ArrowLeft/ArrowRight for prev/next
    if (code === 'ArrowLeft') {
        navigateQueue(-1);
        e.preventDefault();
    } else if (code === 'ArrowRight') {
        navigateQueue(1);
        e.preventDefault();
    } else if (e.altKey && code === 'Home') {
        moveQueueSelection('top');
        e.preventDefault();
    } else if (e.altKey && code === 'End') {
        moveQueueSelection('bottom');
        e.preventDefault();
    } else if (e.altKey && code === 'ArrowUp') {
        moveQueueSelection('up');
        e.preventDefault();
    } else if (e.altKey && code === 'ArrowDown') {
        moveQueueSelection('down');
        e.preventDefault();
    } else if (e.ctrlKey && key === 'a') {
        CensorState.selectedItems = new Set(CensorState.queue.map(item => item.id));
        CensorState.lastSelectedIndex = CensorState.queue.length - 1;
        updateQueueSelection();
        window.App.showToast(tText('Selected the whole queue', '已选中整个队列'), 'info');
        e.preventDefault();
    }
    // Brush size [ ]
    else if (e.key === '[') {
        CensorState.brushSize = Math.max(5, CensorState.brushSize - 5);
        updateBrushIndicator();
        e.preventDefault();
    } else if (e.key === ']') {
        CensorState.brushSize = Math.min(200, CensorState.brushSize + 5);
        updateBrushIndicator();
        e.preventDefault();
    }
    // Tool shortcuts
    else if (key === 'b') {
        setTool('brush');
        e.preventDefault();
    } else if (key === 'p') {
        setTool('pen');
        e.preventDefault();
    } else if (key === 'e') {
        setTool('eraser');
        e.preventDefault();
    } else if (key === 'g') {
        setTool('clone');
        e.preventDefault();
    }
    // Show Changes shortcut ('H' for Highlight changes)
    else if (key === 'h' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        toggleShowChanges();
        e.preventDefault();
    }
    // Detection shortcut ('D' for Detect)
    else if (key === 'd' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
        if (activeItem) {
            runDetectionForImage(activeItem);
        }
        e.preventDefault();
    }
    // Undo
    else if (e.ctrlKey && key === 'z') {
        if (e.shiftKey) {
            redo();
        } else {
            undo();
        }
        e.preventDefault();
    }
    else if ((e.ctrlKey && key === 'y') || (e.metaKey && key === 'y')) {
        redo();
        e.preventDefault();
    }
}

function updateBrushIndicator() {
    const indicator = document.getElementById('brush-size-indicator');
    if (indicator) {
        indicator.textContent = `${CensorState.brushSize}px`;
        // Show briefly then fade
        indicator.style.opacity = '1';
        setTimeout(() => { indicator.style.opacity = '0'; }, 1000);
    }
    // Also sync the slider in the UI
    const slider = document.getElementById('tool-size');
    const label = document.getElementById('tool-size-value');
    if (slider) slider.value = CensorState.brushSize;
    if (label) label.textContent = CensorState.brushSize;
}

function navigateQueue(direction) {
    if (CensorState.queue.length === 0) return;

    const currentIndex = CensorState.queue.findIndex(item => item.id === CensorState.activeId);
    if (currentIndex === -1) {
        // No active, load first
        if (CensorState.queue.length > 0) {
            loadCanvasImage(CensorState.queue[0].id);
        }
        return;
    }

    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < CensorState.queue.length) {
        loadCanvasImage(CensorState.queue[newIndex].id);
    }
}

function showLoading(show, msg) {
    const el = document.getElementById('censor-loading');
    if (el) {
        el.style.display = show ? 'flex' : 'none';
        if (msg) document.getElementById('censor-loading-msg').textContent = msg;
    }
}

async function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = (e) => {
            Logger.error('Image load error:', src, e);
            reject(new Error('Failed to load image'));
        };
        img.src = src;
    });
}

function urlToDataUrl(url) {
    return fetch(url)
        .then(response => response.blob())
        .then(blob => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        }));
}

// ============== New Helper Functions ==============

function clearAllEdits() {
    if (!CensorState.activeId || !CensorState.originalImageData) return;

    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const ctx = canvas.getContext('2d');

    // Restore original image data
    ctx.putImageData(CensorState.originalImageData, 0, 0);

    // Clear modified flag
    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (item) {
        item.isModified = false;
        item.currentDataUrl = null;
    }

    const restoredState = captureCanvasState(canvas);
    CensorState.baseCanvasState = restoredState;
    CensorState.baseItemState = {
        currentDataUrl: null,
        isModified: false
    };
    CensorState.undoStack = restoredState ? [restoredState] : [];
    CensorState.redoStack = [];
    CensorState.lastHistorySource = 'canvas';
    updateUndoRedoButtons();

    window.App.showToast('Edits cleared - image restored to original', 'success');
}

function toggleShowChanges() {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const ctx = canvas.getContext('2d');
    const btn = document.getElementById('btn-show-changes');

    if (!CensorState.activeId || !CensorState.originalImageData) {
        window.App.showToast('No image to compare', 'error');
        return;
    }

    if (CensorState.showingChanges) {
        // Restore the pre-changes canvas state
        if (CensorState.preChangesData) {
            ctx.putImageData(CensorState.preChangesData, 0, 0);
        }
        CensorState.showingChanges = false;
        CensorState.preChangesData = null;
        if (btn) btn.classList.remove('active');
    } else {
        // Store current state
        CensorState.preChangesData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Compare with original and highlight differences
        const currentData = CensorState.preChangesData.data;
        const originalData = CensorState.originalImageData.data;
        const highlightData = ctx.createImageData(canvas.width, canvas.height);

        for (let i = 0; i < currentData.length; i += 4) {
            // Check if pixel is different
            const diff = Math.abs(currentData[i] - originalData[i]) +
                Math.abs(currentData[i + 1] - originalData[i + 1]) +
                Math.abs(currentData[i + 2] - originalData[i + 2]);

            if (diff > 30) {
                // Mark as changed - red highlight with original underneath
                highlightData.data[i] = Math.min(255, currentData[i] + 100);
                highlightData.data[i + 1] = currentData[i + 1] * 0.5;
                highlightData.data[i + 2] = currentData[i + 2] * 0.5;
                highlightData.data[i + 3] = 255;
            } else {
                // Keep original colors
                highlightData.data[i] = currentData[i];
                highlightData.data[i + 1] = currentData[i + 1];
                highlightData.data[i + 2] = currentData[i + 2];
                highlightData.data[i + 3] = 255;
            }
        }

        ctx.putImageData(highlightData, 0, 0);
        CensorState.showingChanges = true;
        if (btn) btn.classList.add('active');
        window.App.showToast('Changed areas highlighted in red', 'info');
    }
}

async function runDetectionForAll() {
    const { showToast } = window.App;
    if (CensorState.queue.length === 0) {
        showToast(tText('Queue is empty', '队列为空'), 'error');
        return;
    }

    const executionPlan = await resolveQuickAutoCensorExecutionPlan();
    if (!executionPlan?.ok) {
        showToast(executionPlan?.message || tText('Quick Auto Censor could not start.', '快捷自动打码无法开始。'), 'warning');
        return;
    }

    _resetBatchStatus();
    const tracker = window.App.createProgressTracker();
    showLoading(true, 'Detect All · preparing queue...');
    let count = 0;

    for (let index = 0; index < CensorState.queue.length; index += 1) {
        const item = CensorState.queue[index];
        try {
            showLoading(true, window.App.buildProgressText({
                progress: { message: item.originalFilename || item.outputFilename || `Image ${item.id}` },
                completed: index,
                total: CensorState.queue.length,
                tracker,
                defaultMessage: 'Running detection...',
                primaryLabel: 'Detect All'
            }));
            await runDetectionForImage(item, true, executionPlan);
            item.batchStatus = 'detected';
            count++;
        } catch (e) {
            Logger.error('Detection error for', item.id, e);
            item.batchStatus = 'failed';
            item.batchError = `${tText('Detection failed', '检测失败')}: ${e?.message || e || ''}`.trim();
        }
    }

    showLoading(false);
    renderQueue();
    if (CensorState.activeId) loadCanvasImage(CensorState.activeId);
    const { failedCount } = _summarizeBatchFailures();
    const total = CensorState.queue.length;
    if (failedCount > 0) {
        showToast(
            tText(
                `Detection: ${count}/${total} processed · ${failedCount} failed (red-outlined thumbnails)`,
                `检测完成：${count}/${total} 张已处理 · ${failedCount} 张失败（红框缩略图）`
            ),
            'warning'
        );
    } else {
        showToast(
            executionPlan.switchMessage
                ? tText(`Detection complete: ${count}/${total} images processed. The app auto-restored the privacy detector first.`, `检测完成：${count}/${total} 张图片已处理。开始前应用已自动恢复为隐私检测路线。`)
                : tText(`Detection complete: ${count}/${total} images processed`, `检测完成：已处理 ${count}/${total} 张图片`),
            'success'
        );
    }
}


async function runSam3BatchRefine() {
    const { showToast } = window.App;
    if (CensorState.queue.length === 0) {
        showToast(tText('Queue is empty', '队列为空'), 'error');
        return;
    }

    // Build batch items from queue items that have detection regions with boxes
    const batchItems = [];
    for (const item of CensorState.queue) {
        if (!Array.isArray(item.regions) || item.regions.length === 0) continue;
        for (const region of item.regions) {
            if (Array.isArray(region.box) && region.box.length === 4) {
                batchItems.push({
                    image_id: item.id,
                    box: region.box,
                    text_prompt: null,
                });
            }
        }
    }

    if (batchItems.length === 0) {
        showToast(
            tText('No detection boxes found. Run detection first, then use SAM3 to refine the masks.', '没有找到检测框。请先运行检测，然后用 SAM3 精化 mask。'),
            'warning'
        );
        return;
    }

    // Only reset status for items included in this batch so items untouched by SAM3 keep
    // any prior save/detect status visual.
    const includedIds = new Set(batchItems.map((entry) => entry.image_id));
    CensorState.queue.forEach((item) => {
        if (includedIds.has(item.id)) {
            delete item.batchStatus;
            delete item.batchError;
        }
    });

    showLoading(true, `SAM3 Batch Refine · 0/${batchItems.length}`);

    try {
        const result = await window.App.API.post('/api/censor/batch-refine-mask', {
            items: batchItems,
            sam3_confidence: CensorState.sam3Confidence,
        });

        showLoading(false);

        const refinedIds = new Set();
        const failedErrorById = new Map();
        for (const refined of result.results || []) {
            if (refined.status === 'ok' && refined.mask) {
                refinedIds.add(refined.image_id);
            } else {
                failedErrorById.set(
                    refined.image_id,
                    refined.error || tText('Mask refine returned no result', 'Mask 精化没有返回结果')
                );
            }
        }

        if (result.completed > 0) {
            // Apply refined masks back to queue items
            for (const refined of result.results) {
                if (refined.status !== 'ok' || !refined.mask) continue;
                const item = CensorState.queue.find(i => i.id === refined.image_id);
                if (!item) continue;

                // Apply mask to this item's canvas
                try {
                    const img = await loadImage(item.currentDataUrl || item.originalUrl);
                    const cvs = document.createElement('canvas');
                    cvs.width = img.width;
                    cvs.height = img.height;
                    const ctx = cvs.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    await renderRasterMaskEffectOntoCanvas(cvs, refined.mask);
                    item.currentDataUrl = cvs.toDataURL('image/png');
                    item.isProcessed = true;
                    item.batchStatus = 'refined';
                } catch (maskErr) {
                    Logger.error('Failed to apply SAM3 mask for item', refined.image_id, maskErr);
                    refinedIds.delete(refined.image_id);
                    failedErrorById.set(
                        refined.image_id,
                        `${tText('Mask apply failed', 'Mask 应用失败')}: ${maskErr?.message || ''}`.trim()
                    );
                }
            }
        }

        CensorState.queue.forEach((item) => {
            if (!includedIds.has(item.id)) return;
            if (failedErrorById.has(item.id)) {
                item.batchStatus = 'failed';
                item.batchError = `${tText('SAM3 refine failed', 'SAM3 精化失败')}: ${failedErrorById.get(item.id)}`;
            }
        });

        renderQueue();
        if (CensorState.activeId) loadCanvasImage(CensorState.activeId);

        showToast(
            tText(
                `SAM3 Batch Refine complete: ${result.completed} refined, ${result.failed} failed out of ${result.total} boxes`,
                `SAM3 批量精化完成：${result.completed} 成功，${result.failed} 失败，共 ${result.total} 个框`
            ),
            result.failed > 0 ? 'warning' : 'success'
        );
    } catch (e) {
        showLoading(false);
        Logger.error('SAM3 Batch Refine error:', e);
        CensorState.queue.forEach((item) => {
            if (!includedIds.has(item.id)) return;
            item.batchStatus = 'failed';
            item.batchError = `${tText('SAM3 batch aborted', 'SAM3 批量中止')}: ${e?.message || e || ''}`.trim();
        });
        renderQueue();
        showToast(formatUserError(e, 'SAM3 Batch Refine failed'), 'error');
    }
}


// ============== Zoom Functions ==============

function zoomCanvas(delta) {
    CensorState.scale = Math.max(0.1, Math.min(10, CensorState.scale + delta));
    applyZoom();
}

function resetZoom() {
    CensorState.scale = 1;
    CensorState.pan = { x: 0, y: 0 };
    applyZoom();
}

function applyZoom() {
    // Zoom the CONTAINER, not the canvas directly, so both canvases scale together
    const container = document.getElementById('canvas-container');
    if (container) {
        // Use transform on the container with translate for panning
        container.style.transform = `translate(${CensorState.pan.x}px, ${CensorState.pan.y}px) scale(${CensorState.scale})`;
        container.style.transformOrigin = 'center center';
    }
    updateZoomDisplay();
}

function updateZoomDisplay() {
    const zoomLevel = document.getElementById('zoom-level');
    if (zoomLevel) {
        zoomLevel.textContent = Math.round(CensorState.scale * 100) + '%';
    }
}

// Initialize zoom controls on DOM ready
function initZoomControls() {
    // Both v1/v2 IDs for compatibility if needed, but primary is v2 now
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomCanvas(0.25));
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomCanvas(-0.25));
    document.getElementById('btn-zoom-fit')?.addEventListener('click', resetZoom);

    // Mouse wheel zoom
    const wrapper = document.querySelector('.censor-canvas-wrapper-v2');
    if (wrapper) {
        wrapper.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                zoomCanvas(delta);
            }
        }, { passive: false });
    }
}

// ============== Pan (Drag) Functions ==============

let isPanning = false;
let panStart = { x: 0, y: 0 };
let spacePressed = false;

function initPanControls() {
    const wrapper = document.querySelector('.censor-canvas-wrapper-v2');
    if (!wrapper) return;

    // Keep these listeners bound once and guard by active view so re-entering the
    // tab does not stack duplicate handlers or duplicate toasts/actions.
    boundHandlers.spaceKeydown = (e) => {
        if (!isCensorViewActive()) return;
        if (e.code === 'Space' && !isEditableTarget(document.activeElement)) {
            spacePressed = true;
            wrapper.style.cursor = 'grab';
            e.preventDefault();
        }
    };
    document.addEventListener('keydown', boundHandlers.spaceKeydown);

    boundHandlers.spaceKeyup = (e) => {
        if (!isCensorViewActive()) return;
        if (e.code === 'Space') {
            spacePressed = false;
            if (!isPanning) {
                wrapper.style.cursor = '';
            }
        }
    };
    document.addEventListener('keyup', boundHandlers.spaceKeyup);

    // Middle mouse button or space+left click for panning
    wrapper.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (spacePressed && e.button === 0)) {
            isPanning = true;
            panStart = {
                x: e.clientX - CensorState.pan.x,
                y: e.clientY - CensorState.pan.y
            };
            wrapper.style.cursor = 'grabbing';
            e.preventDefault();
        }
    });

    boundHandlers.panMousemove = (e) => {
        if (isPanning) {
            CensorState.pan.x = e.clientX - panStart.x;
            CensorState.pan.y = e.clientY - panStart.y;
            applyZoom();
        }
    };
    window.addEventListener('mousemove', boundHandlers.panMousemove);

    boundHandlers.panMouseup = (e) => {
        if (isPanning) {
            isPanning = false;
            wrapper.style.cursor = spacePressed ? 'grab' : '';
        }
    };
    window.addEventListener('mouseup', boundHandlers.panMouseup);
}


// View exit cleanup should only reset transient interaction state. All event
// listeners stay bound once to avoid duplicate bindings when re-entering.
function cleanupCensorViewFull() {
    CensorState.isDrawing = false;
    CensorState.isErasing = false;
    isPanning = false;
    spacePressed = false;

    const wrapper = document.querySelector('.censor-canvas-wrapper-v2');
    if (wrapper) {
        wrapper.style.cursor = '';
    }

    const cursorOverlay = document.getElementById('cursor-overlay');
    if (cursorOverlay) {
        cursorOverlay.style.display = 'none';
    }
}

// Export
window.initCensorEdit = initCensorEdit;
window.cleanupCensorView = cleanupCensorViewFull;

// =====================================================
// Image Filters & Adjustments
// =====================================================
(function initFilterControls() {
    const FILTER_DEFAULTS = {
        brightness: 0, contrast: 0, saturation: 0,
        hue: 0, blur: 0, sharpen: 0, temperature: 0, vignette: 0
    };
    const PRESETS = {
        reset:    { brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, sharpen: 0, temperature: 0, vignette: 0 },
        vivid:    { brightness: 5, contrast: 20, saturation: 40, hue: 0, blur: 0, sharpen: 30, temperature: 0, vignette: 0 },
        warm:     { brightness: 5, contrast: 10, saturation: 15, hue: 0, blur: 0, sharpen: 0, temperature: 30, vignette: 10 },
        cool:     { brightness: 0, contrast: 10, saturation: 10, hue: 0, blur: 0, sharpen: 0, temperature: -30, vignette: 10 },
        bw:       { brightness: 0, contrast: 15, saturation: -100, hue: 0, blur: 0, sharpen: 10, temperature: 0, vignette: 0 },
        dramatic: { brightness: -5, contrast: 40, saturation: 20, hue: 0, blur: 0, sharpen: 40, temperature: 5, vignette: 30 }
    };

    let currentFilters = { ...FILTER_DEFAULTS };

    function getActiveCanvas() {
        return document.getElementById(CensorState.activeCanvasId || 'censor-canvas')
            || document.getElementById('censor-canvas');
    }

    function setSliders(values) {
        Object.entries(values).forEach(([key, val]) => {
            const slider = document.getElementById(`filter-${key}`);
            const label = document.getElementById(`filter-${key}-value`);
            if (slider) slider.value = val;
            if (label) label.textContent = key === 'hue' ? `${val}°` : String(val);
            currentFilters[key] = val;
        });
    }

    // Pre-filter pixel snapshot, captured on first slider use per session.
    // Lets sharpen/vignette preview without compounding, and lets us revert when
    // the slider returns to 0.
    let preFilterSnapshot = null;
    let preFilterCanvasRef = null;
    let pixelPreviewTimer = null;

    function invalidatePreFilterSnapshot() {
        preFilterSnapshot = null;
        preFilterCanvasRef = null;
        if (pixelPreviewTimer) {
            clearTimeout(pixelPreviewTimer);
            pixelPreviewTimer = null;
        }
    }

    function ensurePreFilterSnapshot(canvas) {
        if (preFilterSnapshot && preFilterCanvasRef === canvas) return;
        try {
            const ctx = canvas.getContext('2d');
            preFilterSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
            preFilterCanvasRef = canvas;
        } catch (err) {
            preFilterSnapshot = null;
            preFilterCanvasRef = null;
        }
    }

    function runPixelPreview(canvas) {
        if (!canvas) return;
        const needsSharpen = currentFilters.sharpen > 0;
        const needsVignette = currentFilters.vignette > 0;

        if (!needsSharpen && !needsVignette) {
            if (preFilterSnapshot && preFilterCanvasRef === canvas) {
                canvas.getContext('2d').putImageData(preFilterSnapshot, 0, 0);
            }
            return;
        }

        ensurePreFilterSnapshot(canvas);
        if (!preFilterSnapshot || preFilterCanvasRef !== canvas) return;

        const ctx = canvas.getContext('2d');
        ctx.putImageData(preFilterSnapshot, 0, 0);
        if (needsSharpen) applySharpen(canvas, currentFilters.sharpen / 100);
        if (needsVignette) applyVignette(canvas, currentFilters.vignette / 100);
    }

    function schedulePixelPreview(canvas) {
        if (pixelPreviewTimer) clearTimeout(pixelPreviewTimer);
        pixelPreviewTimer = setTimeout(() => {
            pixelPreviewTimer = null;
            runPixelPreview(canvas);
            updateFilterColorPreview(canvas);
        }, 100);
    }

    function applyFilterPreview() {
        const canvas = getActiveCanvas();
        if (!canvas) return;
        const wrapper = canvas.closest('.censor-canvas-wrapper-v2') || canvas.parentElement;
        if (!wrapper) return;

        const b = 100 + currentFilters.brightness;
        const c = 100 + currentFilters.contrast;
        const s = 100 + currentFilters.saturation;
        const h = currentFilters.hue;
        const bl = currentFilters.blur;

        const filters = [
            `brightness(${b}%)`,
            `contrast(${c}%)`,
            `saturate(${s}%)`,
            `hue-rotate(${h}deg)`,
        ];
        if (bl > 0) filters.push(`blur(${bl}px)`);

        // Temperature via sepia + hue
        if (currentFilters.temperature !== 0) {
            const temp = currentFilters.temperature;
            if (temp > 0) {
                filters.push(`sepia(${Math.abs(temp)}%)`);
            } else {
                filters.push(`sepia(${Math.abs(temp) * 0.3}%)`);
                filters.push(`hue-rotate(${180 + h}deg)`);
            }
        }

        canvas.style.filter = filters.join(' ');

        // Sharpen & vignette need real pixel ops; debounce to keep slider responsive.
        schedulePixelPreview(canvas);

        updateFilterColorPreview(canvas);
    }

    function updateFilterColorPreview(canvas) {
        const histCanvas = document.getElementById('filter-histogram-canvas');
        const paletteEl = document.getElementById('filter-color-palette');
        const previewEl = document.getElementById('filter-color-preview');
        if (!histCanvas || !previewEl || !canvas) return;

        try {
            const tmpCanvas = document.createElement('canvas');
            const sampleSize = 96;
            tmpCanvas.width = sampleSize;
            tmpCanvas.height = sampleSize;
            const tmpCtx = tmpCanvas.getContext('2d');
            tmpCtx.filter = canvas.style.filter || 'none';
            tmpCtx.drawImage(canvas, 0, 0, sampleSize, sampleSize);
            const data = tmpCtx.getImageData(0, 0, sampleSize, sampleSize).data;

            // Build histograms
            const rH = new Uint32Array(256);
            const gH = new Uint32Array(256);
            const bH = new Uint32Array(256);
            const buckets = {};

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                rH[r]++; gH[g]++; bH[b]++;
                const br = Math.round(r / 32) * 32;
                const bg = Math.round(g / 32) * 32;
                const bb = Math.round(b / 32) * 32;
                const key = `${br},${bg},${bb}`;
                if (!buckets[key]) buckets[key] = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
                buckets[key].count++;
                buckets[key].sumR += r;
                buckets[key].sumG += g;
                buckets[key].sumB += b;
            }

            // Draw histogram
            const w = 256, h = 60;
            histCanvas.width = w;
            histCanvas.height = h;
            const ctx = histCanvas.getContext('2d');
            ctx.clearRect(0, 0, w, h);

            let maxVal = 1;
            for (let i = 1; i < 255; i++) {
                maxVal = Math.max(maxVal, rH[i], gH[i], bH[i]);
            }

            const drawCh = (hist, color) => {
                ctx.beginPath();
                ctx.moveTo(0, h);
                for (let i = 0; i < 256; i++) {
                    ctx.lineTo(i, h - Math.min(h, (hist[i] / maxVal) * h * 0.9));
                }
                ctx.lineTo(w, h);
                ctx.closePath();
                ctx.fillStyle = color;
                ctx.fill();
            };
            drawCh(bH, 'rgba(66,133,244,0.35)');
            drawCh(gH, 'rgba(52,211,153,0.35)');
            drawCh(rH, 'rgba(239,68,68,0.35)');

            // Palette
            if (paletteEl) {
                const sorted = Object.values(buckets).sort((a, b) => b.count - a.count).slice(0, 6);
                const total = sorted.reduce((s, b) => s + b.count, 0);
                paletteEl.innerHTML = sorted.map(b => {
                    const ar = Math.round(b.sumR / b.count);
                    const ag = Math.round(b.sumG / b.count);
                    const ab = Math.round(b.sumB / b.count);
                    const hex = '#' + [ar, ag, ab].map(v => v.toString(16).padStart(2, '0')).join('');
                    return `<div class="modal-color-swatch" onclick="navigator.clipboard.writeText('${hex}')" title="${hex}">
                        <span class="swatch-dot" style="background:${hex}"></span>
                        <span>${hex}</span>
                    </div>`;
                }).join('');
            }

            previewEl.style.display = '';
        } catch (e) {
            previewEl.style.display = 'none';
        }
    }

    function hasFilterChanges() {
        return Object.values(currentFilters).some(v => v !== 0);
    }

    async function renderFilteredDataUrlFromUrl(url) {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        const b = 100 + currentFilters.brightness;
        const c = 100 + currentFilters.contrast;
        const s = 100 + currentFilters.saturation;
        const h = currentFilters.hue;
        const bl = currentFilters.blur;

        const filters = [
            `brightness(${b}%)`,
            `contrast(${c}%)`,
            `saturate(${s}%)`,
            `hue-rotate(${h}deg)`,
        ];
        if (bl > 0) filters.push(`blur(${bl}px)`);
        if (currentFilters.temperature !== 0) {
            const temp = currentFilters.temperature;
            if (temp > 0) {
                filters.push(`sepia(${Math.abs(temp)}%)`);
            } else {
                filters.push(`sepia(${Math.abs(temp) * 0.3}%)`);
                filters.push(`hue-rotate(${180 + h}deg)`);
            }
        }

        ctx.filter = filters.join(' ');
        ctx.drawImage(img, 0, 0);

        if (currentFilters.sharpen > 0) {
            applySharpen(canvas, currentFilters.sharpen / 100);
        }
        if (currentFilters.vignette > 0) {
            applyVignette(canvas, currentFilters.vignette / 100);
        }

        return canvas.toDataURL('image/png');
    }

    async function bakeFiltersToTargets(targetIds) {
        if (!Array.isArray(targetIds) || targetIds.length === 0) {
            window.App?.showToast?.('No target images selected', 'warning');
            return;
        }

        if (!hasFilterChanges()) {
            window.App?.showToast?.('No filter changes to apply', 'info');
            return;
        }

        showLoading(true, `Filter · applying to ${targetIds.length} image(s)...`);
        let applied = 0;
        const historyEntry = {
            type: 'filter-batch',
            targetIds: [...targetIds],
            snapshots: [],
        };

        try {
            for (const targetId of targetIds) {
                const item = CensorState.queue.find(entry => entry.id === targetId);
                if (!item) continue;
                const sourceUrl = item.currentDataUrl || item.originalUrl;
                const beforeDataUrl = item.currentDataUrl || null;
                const beforeModified = Boolean(item.isModified);
                item.currentDataUrl = await renderFilteredDataUrlFromUrl(sourceUrl);
                item.isModified = true;
                historyEntry.snapshots.push({
                    id: targetId,
                    beforeDataUrl,
                    beforeModified,
                    afterDataUrl: item.currentDataUrl || null,
                    afterModified: Boolean(item.isModified),
                });
                applied += 1;
            }

            renderQueue();
            if (CensorState.activeId && targetIds.includes(CensorState.activeId)) {
                await loadCanvasImage(CensorState.activeId);
            }

            setSliders(FILTER_DEFAULTS);
            pushFilterActionHistory(historyEntry);
            window.App?.showToast?.(`Applied filters to ${applied} image(s)`, 'success');
        } finally {
            showLoading(false);
        }
    }

    async function bakeFiltersToCanvas() {
        const canvas = getActiveCanvas();
        if (!canvas || !CensorState.activeId) {
            window.App?.showToast?.('No image loaded — select an image first', 'warning');
            return;
        }

        if (!hasFilterChanges()) {
            window.App?.showToast?.('No filter changes to apply', 'info');
            return;
        }

        // Check canvas has actual content
        if (canvas.width === 0 || canvas.height === 0) {
            window.App?.showToast?.('Canvas is empty — load an image first', 'warning');
            return;
        }

        // Restore pre-preview pixels so sharpen/vignette aren't double-applied.
        if (pixelPreviewTimer) { clearTimeout(pixelPreviewTimer); pixelPreviewTimer = null; }
        if (preFilterSnapshot && preFilterCanvasRef === canvas) {
            canvas.getContext('2d').putImageData(preFilterSnapshot, 0, 0);
        }

        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = canvas.width;
        tmpCanvas.height = canvas.height;
        const ctx = tmpCanvas.getContext('2d');
        ctx.filter = canvas.style.filter || 'none';
        ctx.drawImage(canvas, 0, 0);
        canvas.style.filter = 'none';

        const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
        const historyEntry = {
            type: 'filter-batch',
            targetIds: [CensorState.activeId],
            snapshots: activeItem ? [{
                id: activeItem.id,
                beforeDataUrl: activeItem.currentDataUrl || null,
                beforeModified: Boolean(activeItem.isModified),
                afterDataUrl: null,
                afterModified: true,
            }] : [],
        };

        const destCtx = canvas.getContext('2d');
        destCtx.clearRect(0, 0, canvas.width, canvas.height);
        destCtx.drawImage(tmpCanvas, 0, 0);

        // Apply sharpen if needed
        if (currentFilters.sharpen > 0) {
            applySharpen(canvas, currentFilters.sharpen / 100);
        }

        // Apply vignette if needed
        if (currentFilters.vignette > 0) {
            applyVignette(canvas, currentFilters.vignette / 100);
        }

        // Mark the active item as modified
        if (activeItem) {
            activeItem.isModified = true;
            activeItem.currentDataUrl = canvas.toDataURL('image/png');
            if (historyEntry.snapshots[0]) {
                historyEntry.snapshots[0].afterDataUrl = activeItem.currentDataUrl || null;
                historyEntry.snapshots[0].afterModified = Boolean(activeItem.isModified);
            }
        }

        // Reset sliders after applying to current
        await loadCanvasImage(CensorState.activeId);
        invalidatePreFilterSnapshot();
        setSliders(FILTER_DEFAULTS);
        pushFilterActionHistory(historyEntry);
        window.App?.showToast?.('Filters applied to canvas', 'success');
    }

    function applySharpen(canvas, amount) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const w = canvas.width;
        const copy = new Uint8ClampedArray(data);
        const kernel = [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0];

        for (let y = 1; y < canvas.height - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                for (let c = 0; c < 3; c++) {
                    let val = 0;
                    for (let ky = -1; ky <= 1; ky++) {
                        for (let kx = -1; kx <= 1; kx++) {
                            val += copy[((y + ky) * w + (x + kx)) * 4 + c] * kernel[(ky + 1) * 3 + (kx + 1)];
                        }
                    }
                    data[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, val));
                }
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    function applyVignette(canvas, amount) {
        const ctx = canvas.getContext('2d');
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const radius = Math.max(cx, cy);
        const gradient = ctx.createRadialGradient(cx, cy, radius * (1 - amount * 0.5), cx, cy, radius);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, `rgba(0,0,0,${amount * 0.7})`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Bind events after DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        // Slider events
        Object.keys(FILTER_DEFAULTS).forEach(key => {
            const slider = document.getElementById(`filter-${key}`);
            if (slider) {
                slider.addEventListener('input', () => {
                    const val = Number(slider.value);
                    const label = document.getElementById(`filter-${key}-value`);
                    if (label) label.textContent = key === 'hue' ? `${val}°` : String(val);
                    currentFilters[key] = val;
                    applyFilterPreview();
                });
            }
        });

        // Preset buttons
        Object.entries(PRESETS).forEach(([name, values]) => {
            const btn = document.getElementById(`btn-filter-${name}`);
            if (btn) {
                btn.addEventListener('click', () => {
                    if (name === 'reset') {
                        const canvas = getActiveCanvas();
                        if (canvas && preFilterSnapshot && preFilterCanvasRef === canvas) {
                            canvas.getContext('2d').putImageData(preFilterSnapshot, 0, 0);
                        }
                        invalidatePreFilterSnapshot();
                        setSliders(values);
                        canvas && (canvas.style.filter = '');
                        updateFilterColorPreview(canvas);
                        return;
                    }
                    setSliders(values);
                    applyFilterPreview();
                });
            }
        });

        // Apply button
        const applyBtn = document.getElementById('btn-apply-filters');
        if (applyBtn) {
            applyBtn.addEventListener('click', bakeFiltersToCanvas);
        }

        document.getElementById('btn-apply-filters-selected')?.addEventListener('click', async () => {
            await bakeFiltersToTargets(getOrderedSelectedQueueIds());
        });

        document.getElementById('btn-apply-filters-all')?.addEventListener('click', async () => {
            await bakeFiltersToTargets(CensorState.queue.map(item => item.id));
        });
    });

    window.__updateCensorFilterPreview = applyFilterPreview;
    window.__invalidateCensorFilterPreview = invalidatePreFilterSnapshot;
})();
