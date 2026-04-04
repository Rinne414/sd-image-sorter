/**
 * SD Image Sorter - Censor Edit Module (Overhauled)
 * Queue-based workflow with professional editing tools.
 */

const CensorState = {
    // Queue of { id, originalFilename, outputFilename, originalUrl, currentDataUrl, regions, isProcessed, isModified }
    queue: [],
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
    baseCanvasState: null,
    baseItemState: null,

    // Config
    modelPath: localStorage.getItem('censor_model_path') || '',
    showAdvancedLegacyModels: localStorage.getItem('censor_show_advanced_models') === '1',
    availableLegacyModels: [],
    backendModelStatus: null,
    outputFolder: localStorage.getItem('censor_output_folder') || '',
    confidence: 0.5,
    style: 'mosaic',
    blockSize: 16,
    targetClasses: ['breasts', 'pussy', 'dick', 'anus'], // Matches Wenaka YOLO model classes
    metadataOption: 'keep', // 'keep', 'minimal', or 'strip'
    outputFormat: 'png' // 'png', 'jpg', or 'webp'
};

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

function isZhCn() {
    return window.I18n?.getLang?.() === 'zh-CN';
}

function tText(enText, zhText) {
    return isZhCn() ? zhText : enText;
}

function isEditableTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tagName = String(target.tagName || '').toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    if (target.getAttribute('contenteditable') === 'true') return true;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
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
}

function bindEvents() {
    const { $, $$ } = window.App;

    // Clean up any existing global listeners first to prevent accumulation
    cleanupGlobalListeners();

    // Sidebar: Queue Actions — handled by consolidated clearQueueHandler below

    $('#btn-run-auto-censor')?.addEventListener('click', runAutoCensorBatch);
    $('#btn-batch-rename')?.addEventListener('click', () => {
        updateRenamePreview();
        $('#rename-modal').classList.add('visible');
    });

    // Detection Modal handlers
    $('#btn-open-detect-modal')?.addEventListener('click', () => {
        $('#detect-modal')?.classList.add('visible');
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
        $('#censor-confidence-value').textContent = CensorState.confidence.toFixed(2);
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

    // Consolidated Clear Queue
    const clearQueueHandler = () => {
        if (CensorState.queue.length === 0) return;
        window.App.showConfirm(
            'Clear Queue',
            'Are you sure you want to remove all images from the queue?',
            () => {
                CensorState.queue = [];
                CensorState.activeId = null;
                CensorState.selectedItems.clear();
                CensorState.lastSelectedIndex = -1;
                CensorState.undoStack = [];
                CensorState.baseCanvasState = null;
                CensorState.baseItemState = null;
                CensorState.originalImageData = null;
                renderQueue();
                clearCanvas();
                window.App.showToast('Queue cleared', 'success');
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
    window.App._addToCensorQueue = (imageIds) => {
        const { API } = window.App;
        imageIds.forEach(id => {
            if (!CensorState.queue.find(i => i.id === id)) {
                // Fetch basic info if not available (async)
                API.getImage(id).then(res => {
                    CensorState.queue.push({
                        id: id,
                        originalFilename: res.image.filename,
                        outputFilename: res.image.filename, // Default same name
                        originalUrl: API.getImageUrl(id),
                        currentDataUrl: null, // Will be loaded/generated
                        regions: [],
                        isProcessed: false,
                        isModified: false
                    });
                    renderQueue();
                    // Auto-select the first image if no active ID
                    if (!CensorState.activeId && CensorState.queue.length > 0) {
                        setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
                    }
                });
            }
        });
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
        return true;
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
                <p>No images selected</p>
                <small>Select from Gallery</small>
            </div>
        `;
        updateQueueSelection();
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
        img.title = item.outputFilename;

        // Only update src if it changed (prevents reload flash)
        const newSrc = item.currentDataUrl || item.originalUrl;
        if (img.src !== newSrc) {
            img.src = newSrc;
        }

        // Update classes
        const isActive = item.id === CensorState.activeId;
        const isProcessed = item.isProcessed;
        const isSelected = CensorState.selectedItems.has(item.id);
        img.classList.toggle('active', isActive);
        img.classList.toggle('processed', isProcessed);
        img.classList.toggle('selected', isSelected);
        img.setAttribute('aria-selected', String(isSelected));
        img.setAttribute('aria-pressed', String(isSelected));
    });

    updateQueueSelection();
}

function initDragAndDrop() {
    // Basic setup handled in renderQueue listeners
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
}

function updateQueueActionState() {
    const hasQueue = CensorState.queue.length > 0;
    const hasSelection = CensorState.selectedItems.size > 0;
    [
        'btn-queue-move-top',
        'btn-queue-move-up',
        'btn-queue-move-down',
        'btn-queue-move-bottom',
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

    const targetIndex = parseInt(targetItem.dataset.index, 10);
    const draggedId = e.dataTransfer.getData('text/plain');

    // Check if we're moving multiple selected items
    if (CensorState.selectedItems.size > 1 && CensorState.selectedItems.has(parseInt(draggedId, 10))) {
        // Move all selected items as a group
        const selectedIds = [...CensorState.selectedItems];
        const selectedItems = CensorState.queue.filter(item => selectedIds.includes(item.id));

        // Find the target item's ID for stable positioning after removal
        const targetId = CensorState.queue[targetIndex]?.id;

        // Remove selected items from queue
        CensorState.queue = CensorState.queue.filter(item => !selectedIds.includes(item.id));

        // Find adjusted target index using the target item's ID (stable reference)
        let adjustedTarget = CensorState.queue.findIndex(item => item.id === targetId);
        if (adjustedTarget === -1) {
            adjustedTarget = CensorState.queue.length; // Target was in selection, append to end
        }

        // Insert selected items at target position
        CensorState.queue.splice(adjustedTarget, 0, ...selectedItems);

        renderQueue();
        scrollQueueItemIntoView(selectedItems[0]?.id);
    } else {
        // Single item move (original logic)
        const currentIndex = CensorState.queue.findIndex(item => item.id.toString() === draggedId);

        if (currentIndex !== -1 && currentIndex !== targetIndex) {
            const item = CensorState.queue[currentIndex];
            CensorState.queue.splice(currentIndex, 1);
            CensorState.queue.splice(targetIndex, 0, item);
            renderQueue();
            scrollQueueItemIntoView(item.id);
        }
    }

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

        if (!banner) return;

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
        if (simpleGuide) {
            simpleGuide.textContent = legacy?.simple_user_advice || 'Keep the recommended mode and only touch custom paths if you know why.';
        }
        renderCensorCapabilityPanel();
    } catch (e) {
        if (!banner) return;
        banner.className = 'model-health-banner model-health-banner-compact is-visible model-health-banner-warning';
        banner.textContent = 'Model readiness could not be loaded right now.';
        if (simpleGuide) {
            simpleGuide.textContent = '';
        }
    }
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

function renderCensorCapabilityPanel() {
    const panel = document.getElementById('censor-capability-panel');
    const targetHelp = document.getElementById('censor-target-region-help');
    const promptHelp = document.getElementById('censor-text-prompt-help');
    const promptInput = document.getElementById('censor-text-prompt');
    const simpleGuide = document.getElementById('censor-simple-guide');
    const targetChecks = Array.from(document.querySelectorAll('.target-region-check'));

    if (!panel) return;

    const models = CensorState.backendModelStatus?.models || [];
    const legacy = models.find(model => model.id === 'legacy');
    const nudenet = models.find(model => model.id === 'nudenet');
    const sam3 = models.find(model => model.id === 'sam3');
    const selectedLegacy = getSelectedLegacyModelRecord();
    const modelType = document.getElementById('censor-model-type')?.value || 'legacy';

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

    const quickFilterEnabled = (modelType === 'legacy' || modelType === 'both')
        && selectedLegacy?.profile === 'privacy-censor';
    targetChecks.forEach(input => {
        input.disabled = !quickFilterEnabled;
    });

    if (targetHelp) {
        if (quickFilterEnabled) {
            targetHelp.textContent = tText(
                'These quick target filters are for the built-in privacy model and map to its fixed privacy classes.',
                '这些快捷目标只会作用在内置隐私模型上，对应的是它自己的固定隐私类别。'
            );
        } else if (modelType === 'nudenet') {
            targetHelp.textContent = tText(
                'NudeNet uses its own built-in exposed/covered labels, so the quick privacy checkboxes are ignored here.',
                'NudeNet 用的是自己内置的暴露/遮挡标签，所以这里的隐私复选框不会影响它。'
            );
        } else {
            targetHelp.textContent = tText(
                'The currently selected general model uses its own fixed classes. These quick privacy checkboxes do not change that model.',
                '当前这个通用模型只认它自己的固定类别，这些隐私复选框不会改变它的识别范围。'
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

    if (simpleGuide) {
        if (modelType === 'nudenet') {
            simpleGuide.textContent = tText(
                'NudeNet is the simple path: no text prompt, no custom labels. Just click Detect Current or Detect All and it will return its built-in NSFW/body-part boxes.',
                'NudeNet 是最省事的路线：不用填文本，也不用自定义类别。直接点“检测当前”或“检测全部”，它会返回自己内置的 NSFW/身体部位框。'
            );
        } else if (modelType === 'both') {
            simpleGuide.textContent = tText(
                'Recommended for most people: run NudeNet together with the auto-picked privacy YOLO. The app will use the Wenaka privacy model when it is installed.',
                '大多数人建议用这个：让 NudeNet 和自动挑选的隐私 YOLO 一起跑。只要装了 Wenaka 隐私模型，应用就会优先用它。'
            );
        } else if (selectedLegacy?.profile === 'privacy-censor') {
            simpleGuide.textContent = tText(
                'This local YOLO file is the privacy-part route. It only understands its fixed privacy labels and is meant for fast censor boxes, not free-text prompts.',
                '当前这个本地 YOLO 文件就是隐私部位路线。它只认固定隐私标签，适合快速打码框，不支持任意文本提示。'
            );
        } else if (selectedLegacy) {
            simpleGuide.textContent = tText(
                `${selectedLegacy.name} is a general fixed-class model kept for advanced compatibility and segmentation tests. It is not the normal privacy workflow and not an open-text detector.`,
                `${selectedLegacy.name} 是保留下来的通用固定类模型，只给高级兼容/分割测试用。它不是普通隐私打码主流程，也不是开放文本检测器。`
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
            `${generalCount} advanced fixed-class YOLO model(s) are hidden to keep the normal workflow simpler.`,
            `为了让普通流程更简单，已隐藏 ${generalCount} 个高级固定类 YOLO 模型。`
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
    renderCensorCapabilityPanel();
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
    if (CensorState.undoStack.length > 20) CensorState.undoStack.shift();
    return state;
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
        await runDetectionForImage(item, true); // true = silent/no-refresh
    }

    showLoading(false);
    renderQueue();
    // Reload canvas if active item was updated
    if (CensorState.activeId) loadCanvasImage(CensorState.activeId);
    showToast('Batch processing complete', 'success');
}

async function runDetectionForImage(item, silent = false) {
    try {
        const modelTypeEl = document.getElementById('censor-model-type');
        const modelType = modelTypeEl ? modelTypeEl.value : 'legacy';

        const data = await window.App.API.post('/api/censor/detect', {
            image_id: item.id,
            model_path: getSelectedLegacyModelPath(),
            model_type: modelType,
            confidence_threshold: CensorState.confidence
        });

        // Sort by confidence and take top 50 to avoid processing thousands
        const sortedDetections = data.detections.sort((a, b) => b.confidence - a.confidence).slice(0, 50);
        // Filter by target classes if needed, otherwise use all sorted detections
        let regions = sortedDetections.filter(d => CensorState.targetClasses.includes(d.class));
        // If no matches, check for class_id based filtering or use all
        if (regions.length === 0 && sortedDetections.length > 0) {
            regions = sortedDetections;
        }
        item.regions = regions;

        // Apply to a temporary canvas to generate DataURL
        const img = await loadImage(item.originalUrl);
        const cvs = document.createElement('canvas');
        cvs.width = img.width;
        cvs.height = img.height;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Apply regions
        ctx.save();
        regions.forEach(r => {
            const [x1, y1, x2, y2] = r.box;
            const w = x2 - x1, h = y2 - y1;

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
                // Apply blur
                ctx.save();
                ctx.beginPath();
                ctx.rect(x1, y1, w, h);
                ctx.clip();
                ctx.filter = `blur(${CensorState.blockSize / 2}px)`;
                ctx.drawImage(img, 0, 0);
                ctx.restore();
            } else if (CensorState.style === 'black_bar') {
                ctx.fillStyle = '#000';
                ctx.fillRect(x1, y1, w, h);
            } else if (CensorState.style === 'white_bar') {
                ctx.fillStyle = '#fff';
                ctx.fillRect(x1, y1, w, h);
            } else {
                // Default to black bar
                ctx.fillStyle = '#000';
                ctx.fillRect(x1, y1, w, h);
            }

            // Debug: Stroke box
            // ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
            // ctx.lineWidth = 2;
            // ctx.strokeRect(x1, y1, w, h);
        });
        ctx.restore();

        item.currentDataUrl = cvs.toDataURL('image/png');
        item.isProcessed = true;

        if (!silent && item.id === CensorState.activeId) {
            loadCanvasImage(item.id);
            if (regions.length === 0) {
                window.App.showToast('No relevant regions found (Try lowering confidence)', 'info');
            } else {
                window.App.showToast(`Applied censorship to ${regions.length} regions`, 'success');
            }
        }

    } catch (e) {
        Logger.error(e);
        if (!silent) window.App.showToast(formatUserError(e, "Detection failed"), "error");
    }
}

async function applyRasterMaskToActiveCanvas(maskDataUrl) {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    const ctx = canvas.getContext('2d');
    const snapshot = captureCanvasState(canvas) || CensorState.queue.find(i => i.id === CensorState.activeId)?.originalUrl;
    if (!snapshot) {
        throw new Error('Could not capture the current canvas state');
    }

    const [baseImage, maskImage] = await Promise.all([
        loadImage(snapshot),
        loadImage(maskDataUrl),
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
    const committedState = pushUndoState();
    saveCurrentCanvasToState(committedState);

    const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (activeItem) {
        activeItem.isProcessed = true;
    }
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

function updateRenamePreview() {
    const useOriginal = document.getElementById('rename-use-original')?.checked || false;
    const base = document.getElementById('rename-base')?.value || 'Image';
    const start = parseInt(document.getElementById('rename-start')?.value, 10) || 1;
    const previewContainer = document.querySelector('.rename-preview');

    if (!previewContainer) return;

    // Generate preview items
    let previewHtml = '';
    const sampleCount = Math.min(3, CensorState.queue.length || 3);

    for (let i = 0; i < sampleCount; i++) {
        let filename;
        if (useOriginal) {
            const item = CensorState.queue[i];
            if (item) {
                const originalName = item.originalFilename || item.filename || `image_${i + 1}`;
                const baseName = originalName.replace(/\.[^/.]+$/, '');
                filename = `${baseName}.png`;
            } else {
                filename = `original_name_${i + 1}.png`;
            }
        } else {
            const num = String(start + i).padStart(3, '0');
            filename = `${base}_${num}.png`;
        }
        previewHtml += `<div class="preview-item">${filename}</div>`;
    }

    if (CensorState.queue.length > 3 || sampleCount === 3) {
        previewHtml += '<div class="preview-hint">...and so on</div>';
    }

    previewContainer.innerHTML = previewHtml;
}

async function applyBatchRename() {
    const useOriginal = document.getElementById('rename-use-original')?.checked || false;
    const base = document.getElementById('rename-base')?.value || 'Image';
    const start = parseInt(document.getElementById('rename-start')?.value, 10) || 1;
    // Note: Output folder is configured in Save Options modal, not here

    CensorState.queue.forEach((item, i) => {
        if (useOriginal) {
            // Use original filename (keeping extension as .png)
            const originalName = item.originalFilename || item.filename || `image_${i + 1}`;
            const baseName = originalName.replace(/\.[^/.]+$/, ''); // Remove extension
            item.outputFilename = `${baseName}.png`;
        } else {
            const num = String(start + i).padStart(3, '0');
            item.outputFilename = `${base}_${num}.png`;
        }
    });

    renderQueue();
    document.getElementById('rename-modal').classList.remove('visible');

    // Refresh current title if viewing
    if (CensorState.activeId) {
        const item = CensorState.queue.find(i => i.id === CensorState.activeId);
        if (item) document.getElementById('censor-filename').textContent = item.outputFilename;
    }

    window.App.showToast(`Renamed ${CensorState.queue.length} images`, 'success');
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
            count++;
        } catch (e) {
            Logger.error(e);
        }
    }

    showLoading(false);
    window.App.showToast(`Saved ${count} images to ${folder}`, 'success');
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


function undo() {
    // Keep at least 1 item in the stack (the initial/base state)
    if (CensorState.undoStack.length <= 1) return;
    CensorState.undoStack.pop(); // Discard current state
    const prev = CensorState.undoStack[CensorState.undoStack.length - 1]; // Peek at previous
    const img = new Image();
    img.onload = () => {
        const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        saveCurrentCanvasToState(prev);
    };
    img.src = prev;
}

function handleKeydown(e) {
    if (isEditableTarget(e.target)) return;

    // Only handle keys when censor view is active
    const censorView = document.getElementById('view-censor');
    if (!censorView || !censorView.classList.contains('active')) return;

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
        undo();
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
        showToast('Queue is empty', 'error');
        return;
    }

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
            await runDetectionForImage(item, true);
            count++;
        } catch (e) {
            Logger.error('Detection error for', item.id, e);
        }
    }

    showLoading(false);
    renderQueue();
    if (CensorState.activeId) loadCanvasImage(CensorState.activeId);
    showToast(`Detection complete: ${count}/${CensorState.queue.length} images processed`, 'success');
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

    // Space key to enable pan mode - store for cleanup
    boundHandlers.spaceKeydown = (e) => {
        if (e.code === 'Space' && !isEditableTarget(document.activeElement)) {
            spacePressed = true;
            wrapper.style.cursor = 'grab';
            e.preventDefault();
        }
    };
    document.addEventListener('keydown', boundHandlers.spaceKeydown);

    boundHandlers.spaceKeyup = (e) => {
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


// Cleanup function that also resets init flag so events can be re-bound if view is re-entered
function cleanupCensorViewFull() {
    cleanupGlobalListeners();
    censorEventsInitialized = false;
}

// Export
window.initCensorEdit = initCensorEdit;
window.cleanupCensorView = cleanupCensorViewFull;
