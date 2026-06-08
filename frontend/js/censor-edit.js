/**
 * SD Image Sorter - Censor Edit Module (Overhauled)
 * Queue-based workflow with professional editing tools.
 */

const CENSOR_UNDO_DEFAULT_DEPTH = 20;
const CENSOR_UNDO_MIN_DEPTH = 5;
const CENSOR_UNDO_MAX_DEPTH = 200;
const CENSOR_LOW_MEMORY_PIXEL_THRESHOLD_DEFAULT = 20_000_000;
const CENSOR_SHOW_CHANGES_PIXEL_THRESHOLD_DEFAULT = 12_000_000;
const CENSOR_LOW_MEMORY_UNDO_CAP = 4;
const CENSOR_PROXY_MAX_PIXELS_DEFAULT = 6_000_000;
const CENSOR_PROXY_MAX_EDGE_DEFAULT = 4096;
const CENSOR_ORIGINAL_STATE_TOKEN = '__CENSOR_ORIGINAL__';
const CENSOR_TOKEN_QUEUE_WINDOW_SIZE = 200;

function getCensorUndoDepth() {
    const raw = parseInt(localStorage.getItem('censor_undo_depth'), 10);
    if (!Number.isFinite(raw)) return CENSOR_UNDO_DEFAULT_DEPTH;
    return Math.max(CENSOR_UNDO_MIN_DEPTH, Math.min(CENSOR_UNDO_MAX_DEPTH, raw));
}

const CensorState = {
    // Queue of { id, originalFilename, outputFilename, originalUrl, currentDataUrl, regions, isProcessed, isModified }
    queue: [],
    pendingQueueIds: new Set(),
    tokenQueueSource: null,
    activeId: null, // ID of currently edited image
    pendingActiveId: null, // Latest requested image while a newer canvas load is still pending
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
    originalImageData: null, // Legacy field kept for compatibility; large-image mode avoids populating it
    originalLogicalWidth: 0,
    originalLogicalHeight: 0,
    activeImagePixels: 0,
    lowMemoryMode: false,
    proxyEditMode: false,
    proxyScale: 1,

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
    operationRedoStack: [],
    activeStrokeOperation: null,

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
    maskShape: localStorage.getItem('censor_mask_shape') === 'box' ? 'box' : 'precise', // 'precise': use YOLO-seg/SAM3 polygon masks; 'box': censor rectangles

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
    spaceKeyup: null,
    resize: null
};

let censorModelStatusPromise = null;

function getCensorTestFlag(name, fallback) {
    const value = window?.__SD_SORTER_TEST_FLAGS__?.[name];
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCensorLowMemoryPixelThreshold() {
    return getCensorTestFlag('censorLowMemoryPixelThreshold', CENSOR_LOW_MEMORY_PIXEL_THRESHOLD_DEFAULT);
}

function getCensorShowChangesPixelThreshold() {
    return getCensorTestFlag('censorShowChangesPixelThreshold', CENSOR_SHOW_CHANGES_PIXEL_THRESHOLD_DEFAULT);
}

function getCensorProxyMaxPixels() {
    return getCensorTestFlag('censorProxyMaxPixels', CENSOR_PROXY_MAX_PIXELS_DEFAULT);
}

function getCensorProxyMaxEdge() {
    return getCensorTestFlag('censorProxyMaxEdge', CENSOR_PROXY_MAX_EDGE_DEFAULT);
}

function isOriginalCanvasState(state) {
    return state === CENSOR_ORIGINAL_STATE_TOKEN;
}

function getEffectiveCensorUndoDepth() {
    const configured = getCensorUndoDepth();
    return CensorState.lowMemoryMode ? Math.min(configured, CENSOR_LOW_MEMORY_UNDO_CAP) : configured;
}

function restoreOriginalImageToCanvas(canvas = null) {
    const targetCanvas = canvas || document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!targetCanvas || !CensorState.originalImage) return false;
    const ctx = targetCanvas.getContext('2d');
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(CensorState.originalImage, 0, 0, targetCanvas.width, targetCanvas.height);
    return true;
}

function maybeNotifyLowMemoryMode(item, pixelCount) {
    if (!item || !CensorState.lowMemoryMode || item.__lowMemoryModeNotified) return;
    item.__lowMemoryModeNotified = true;
    const megaPixels = (pixelCount / 1_000_000).toFixed(1);
    window.App?.showToast?.(
        censorT('censor.lowMemoryModeEnabled', {
            megaPixels,
        }, 'Large image ({megaPixels} MP): proxy edit mode is on. Editing stays responsive, undo history is reduced, and Show Changes is disabled.'),
        'info'
    );
}

function getFocusedCensorImageId() {
    return CensorState.pendingActiveId ?? CensorState.activeId;
}

function getActiveCensorItem() {
    return CensorState.queue.find((item) => item.id === CensorState.activeId) || null;
}

function normalizeCensorImageIds(rawIds) {
    return Array.from(new Set((Array.isArray(rawIds) ? rawIds : [rawIds])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)));
}

function normalizeTokenQueueSourcePayload(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
    }

    const selectionToken = String(source.selectionToken || source.selection_token || '').trim();
    if (!selectionToken) return null;

    return {
        selectionToken,
        total: Math.max(0, Number(source.total ?? source.selectionTotal ?? source.selection_total ?? 0) || 0),
        exactTotal: source.exactTotal !== false && source.exact_total !== false,
        filterKey: typeof source.filterKey === 'string' ? source.filterKey : null,
        visibleImageIds: normalizeCensorImageIds(source.visibleImageIds || source.visible_image_ids || []),
        nextOffset: 0,
        hasMore: true,
        loadedCount: 0,
        loadedIds: new Set(),
        loading: false,
    };
}

function hasTokenQueueSource() {
    return Boolean(CensorState.tokenQueueSource?.selectionToken);
}

function getTokenQueueTotal() {
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken) return 0;
    return Math.max(0, Number(source.total || source.loadedCount || 0) || 0);
}

function getCensorQueueWorkCount() {
    return Math.max(CensorState.queue.length, getTokenQueueTotal());
}

function hasCensorQueueWork() {
    return getCensorQueueWorkCount() > 0;
}

function switchToCensorView() {
    const censorTab = document.querySelector('.nav-tab[data-view="censor"]');
    if (censorTab) {
        censorTab.click();
    } else if (typeof window.App?.switchView === 'function') {
        window.App.switchView('censor');
    }

    const censorView = document.getElementById('view-censor');
    if (censorView) {
        censorView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function buildCensorQueueItemFromImage(image) {
    const id = Number(image?.id);
    if (!Number.isFinite(id) || id <= 0 || !image?.filename) {
        return null;
    }

    const api = window.App?.API;
    return {
        id,
        originalFilename: image.filename,
        outputFilename: image.filename,
        originalUrl: typeof api?.getImageUrl === 'function' ? api.getImageUrl(id) : `/api/image-file/${id}`,
        currentDataUrl: null,
        previewDataUrl: null,
        width: Number(image.width || 0),
        height: Number(image.height || 0),
        editOperations: [],
        regions: [],
        isProcessed: false,
        isModified: false,
    };
}

function appendCensorQueueImages(images = [], { tokenSource = null } = {}) {
    const queueIds = new Set(CensorState.queue.map((item) => item.id));
    const nextItems = [];

    (Array.isArray(images) ? images : []).forEach((image) => {
        const item = buildCensorQueueItemFromImage(image);
        if (!item || queueIds.has(item.id) || CensorState.pendingQueueIds.has(item.id)) {
            if (item && tokenSource?.loadedIds) tokenSource.loadedIds.add(item.id);
            return;
        }

        queueIds.add(item.id);
        nextItems.push(item);
        if (tokenSource?.loadedIds) tokenSource.loadedIds.add(item.id);
    });

    if (nextItems.length > 0) {
        CensorState.queue.push(...nextItems);
    }

    if (tokenSource?.loadedIds) {
        tokenSource.loadedCount = tokenSource.loadedIds.size;
    }

    return nextItems;
}

async function fetchTokenQueueDataPage(offset = 0, limit = CENSOR_TOKEN_QUEUE_WINDOW_SIZE) {
    const source = CensorState.tokenQueueSource;
    const loader = window.App?.loadSelectionDataByToken;
    if (!source?.selectionToken || typeof loader !== 'function') {
        throw new Error('Token-backed Censor queue is not available');
    }

    return loader(source.selectionToken, {
        offset: Math.max(0, Number(offset) || 0),
        limit: Math.max(1, Math.min(Number(limit) || CENSOR_TOKEN_QUEUE_WINDOW_SIZE, CENSOR_TOKEN_QUEUE_WINDOW_SIZE)),
    });
}

function updateTokenQueueSourceFromPage(source, page, fallbackOffset = 0) {
    if (!source || !page) return;

    const images = Array.isArray(page.images) ? page.images : [];
    const pageTotal = Number(page.total || 0);
    if (Number.isFinite(pageTotal) && pageTotal > 0) {
        source.total = Math.max(source.total || 0, pageTotal);
    } else {
        source.total = Math.max(source.total || 0, Number(fallbackOffset || 0) + images.length);
    }

    source.exactTotal = page.exact_total !== false;

    const nextOffset = Number(page.next_offset);
    source.nextOffset = page.has_more && Number.isFinite(nextOffset) && nextOffset >= 0
        ? nextOffset
        : null;
    source.hasMore = Boolean(page.has_more && source.nextOffset !== null);
}

async function loadTokenQueueWindow({ offset = 0, limit = CENSOR_TOKEN_QUEUE_WINDOW_SIZE, activateFirst = false } = {}) {
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken || source.loading) {
        return { images: [], items: [] };
    }

    source.loading = true;
    renderTokenQueueLoadMoreControl(document.getElementById('censor-queue-list'));

    try {
        const page = await fetchTokenQueueDataPage(offset, limit);
        updateTokenQueueSourceFromPage(source, page, offset);
        const items = appendCensorQueueImages(page.images || [], { tokenSource: source });
        renderQueue();

        if (activateFirst && !CensorState.activeId && CensorState.queue.length > 0) {
            setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
        }

        return {
            ...page,
            images: Array.isArray(page.images) ? page.images : [],
            items,
        };
    } finally {
        source.loading = false;
        renderTokenQueueLoadMoreControl(document.getElementById('censor-queue-list'));
    }
}

async function loadNextTokenQueueWindow() {
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken || source.loading || !source.hasMore || source.nextOffset === null) {
        return { images: [], items: [] };
    }

    return loadTokenQueueWindow({
        offset: source.nextOffset,
        limit: CENSOR_TOKEN_QUEUE_WINDOW_SIZE,
    });
}

async function addTokenBackedQueue(sourcePayload) {
    const source = normalizeTokenQueueSourcePayload(sourcePayload);
    if (!source) return false;

    switchToCensorView();
    CensorState.tokenQueueSource = source;

    try {
        let loadedItems = [];
        const visibleIds = source.visibleImageIds.slice(0, CENSOR_TOKEN_QUEUE_WINDOW_SIZE);
        const selectionLoader = window.App?.loadSelectionData;
        if (visibleIds.length > 0 && typeof selectionLoader === 'function') {
            try {
                const payload = await selectionLoader(visibleIds);
                loadedItems = appendCensorQueueImages(payload?.images || [], { tokenSource: source });
                renderQueue();
                if (!CensorState.activeId && CensorState.queue.length > 0) {
                    setTimeout(() => loadCanvasImage(CensorState.queue[0].id), 100);
                }
            } catch (error) {
                Logger.warn('Failed to load visible Censor queue window, falling back to token page', error);
            }
        }

        if (loadedItems.length === 0) {
            const page = await loadTokenQueueWindow({
                offset: 0,
                limit: CENSOR_TOKEN_QUEUE_WINDOW_SIZE,
                activateFirst: true,
            });
            loadedItems = page.items || [];
        } else {
            renderTokenQueueLoadMoreControl(document.getElementById('censor-queue-list'));
        }

        if (!loadedItems.length && source.total === 0) {
            window.App?.showToast?.(
                censorT('censor.queueEmpty', null, 'Queue is empty'),
                'info'
            );
        }
        return true;
    } catch (error) {
        CensorState.tokenQueueSource = null;
        renderQueue();
        window.App?.showToast?.(
            formatUserError(error, censorT('censor.queueAddFailed', { count: source.total || 1 }, 'Failed to queue {count} image(s) for Censor.')),
            'error'
        );
        return false;
    }
}

function renderTokenQueueLoadMoreControl(list) {
    if (!list) return;

    const existing = list.querySelector('.queue-token-window-control');
    const source = CensorState.tokenQueueSource;
    if (!source?.selectionToken) {
        existing?.remove();
        return;
    }

    let control = existing;
    if (!control) {
        control = document.createElement('div');
        control.className = 'queue-token-window-control';
        control.innerHTML = `
            <div class="queue-token-window-summary"></div>
            <button class="btn btn-secondary btn-small" type="button"></button>
        `;
        control.querySelector('button')?.addEventListener('click', () => {
            loadNextTokenQueueWindow();
        });
    }

    const loaded = Math.max(0, Number(source.loadedCount || 0) || 0);
    const total = source.total || loaded;
    const summary = control.querySelector('.queue-token-window-summary');
    const button = control.querySelector('button');
    if (summary) {
        summary.textContent = total > loaded
            ? `Loaded ${loaded.toLocaleString()} of ${total.toLocaleString()} filtered images`
            : `Loaded ${loaded.toLocaleString()} filtered images`;
    }
    if (button) {
        button.textContent = source.loading
            ? censorT('common.loading', null, 'Loading...')
            : censorT('common.loadMore', null, 'Load more');
        button.disabled = Boolean(source.loading || !source.hasMore);
        button.style.display = source.hasMore ? '' : 'none';
    }

    list.appendChild(control);
}

function getCensorItemLogicalDimensions(item, fallbackWidth = 0, fallbackHeight = 0) {
    const width = Number(item?.width || fallbackWidth || 0);
    const height = Number(item?.height || fallbackHeight || 0);
    return {
        width: Number.isFinite(width) && width > 0 ? width : 0,
        height: Number.isFinite(height) && height > 0 ? height : 0,
    };
}

function getCensorItemPixelCount(item, fallbackWidth = 0, fallbackHeight = 0) {
    const { width, height } = getCensorItemLogicalDimensions(item, fallbackWidth, fallbackHeight);
    return width > 0 && height > 0 ? width * height : 0;
}

function shouldUseProxyEditMode(item, fallbackWidth = 0, fallbackHeight = 0) {
    return getCensorItemPixelCount(item, fallbackWidth, fallbackHeight) >= getCensorLowMemoryPixelThreshold();
}

function buildProxyCanvasDimensions(width, height) {
    const safeWidth = Math.max(1, Number(width || 1));
    const safeHeight = Math.max(1, Number(height || 1));
    const pixelScale = Math.sqrt(getCensorProxyMaxPixels() / (safeWidth * safeHeight));
    const edgeScale = getCensorProxyMaxEdge() / Math.max(safeWidth, safeHeight);
    const scale = Math.max(0.01, Math.min(1, pixelScale, edgeScale));
    return {
        width: Math.max(1, Math.round(safeWidth * scale)),
        height: Math.max(1, Math.round(safeHeight * scale)),
        scale,
    };
}

function getCensorItemCanvasDimensions(item, fallbackWidth = 0, fallbackHeight = 0) {
    const logical = getCensorItemLogicalDimensions(item, fallbackWidth, fallbackHeight);
    if (logical.width <= 0 || logical.height <= 0) {
        return {
            width: Math.max(1, Number(fallbackWidth || 1)),
            height: Math.max(1, Number(fallbackHeight || 1)),
            scale: 1,
        };
    }
    if (!shouldUseProxyEditMode(item, fallbackWidth, fallbackHeight)) {
        return { width: logical.width, height: logical.height, scale: 1 };
    }
    return buildProxyCanvasDimensions(logical.width, logical.height);
}

function getCensorPreviewBaseUrl(item, dims = null) {
    if (!item?.id) return item?.originalUrl || '';
    const api = window.App?.API;
    const targetDims = dims || getCensorItemCanvasDimensions(item);
    if (typeof api?.getThumbnailUrl === 'function' && shouldUseProxyEditMode(item, targetDims.width, targetDims.height)) {
        return api.getThumbnailUrl(item.id, Math.max(targetDims.width, targetDims.height));
    }
    return item.originalUrl || '';
}

function getCensorItemPreviewSrc(item) {
    return item?.previewDataUrl || item?.currentDataUrl || item?.originalUrl || '';
}

function isProxyEditActive() {
    return Boolean(CensorState.proxyEditMode);
}

function getCurrentLogicalToCanvasScale() {
    return isProxyEditActive() ? Math.max(0.0001, Number(CensorState.proxyScale || 1)) : 1;
}

function toOriginalPoint(point) {
    const scale = getCurrentLogicalToCanvasScale();
    return {
        x: point.x / scale,
        y: point.y / scale,
    };
}

function toCanvasPoint(point) {
    const scale = getCurrentLogicalToCanvasScale();
    return {
        x: point.x * scale,
        y: point.y * scale,
    };
}

function getCanvasBrushSize(brushSize = CensorState.brushSize) {
    return Math.max(1, brushSize * getCurrentLogicalToCanvasScale());
}

function cloneOperationPoints(points = []) {
    return points.map((point) => ({
        x: Number(point?.x || 0),
        y: Number(point?.y || 0),
    }));
}

function cloneNumberArray(values = []) {
    return Array.isArray(values) ? values.map((value) => Number(value || 0)) : values;
}

function cloneEditOperations(operations = []) {
    return operations.map((operation) => {
        if (!operation || typeof operation !== 'object') return operation;
        return {
            ...operation,
            points: cloneOperationPoints(operation.points),
            clone_offset: operation.clone_offset ? { ...operation.clone_offset } : operation.clone_offset,
            values: operation.values ? { ...operation.values } : operation.values,
            mask_bounds: cloneNumberArray(operation.mask_bounds),
            regions: Array.isArray(operation.regions)
                ? operation.regions.map((region) => ({
                    ...region,
                    box: Array.isArray(region?.box) ? [...region.box] : region?.box,
                    polygon: Array.isArray(region?.polygon)
                        ? region.polygon.map((point) => Array.isArray(point) ? [...point] : point)
                        : region?.polygon,
                }))
                : operation.regions,
        };
    });
}

function formatCensorFallback(text, params = null) {
    if (!params || typeof params !== 'object') return text;
    return Object.entries(params).reduce(
        (out, [token, value]) => out.replaceAll(`{${token}}`, String(value)),
        text
    );
}

function censorT(key, params = null, fallback = '') {
    const translated = window.I18n?.t?.(key, params || undefined);
    if (translated && translated !== key) return translated;
    return formatCensorFallback(fallback || key, params);
}

// MODELS-05: surface the backend-recommended detector inline on the
// #censor-model-type dropdown so a new user can see which mode to pick without
// reading the separate "Recommended mode" banner. The option text is owned by
// i18n (data-i18n -> textContent on every languageChanged), so we recompute the
// base label from the data-i18n key and re-append the marker; this runs after
// i18n.applyToDOM() because the languageChanged event is dispatched last.
function markRecommendedDetectorMode() {
    const select = document.getElementById('censor-model-type');
    if (!select) return;
    const recommended = CensorState.backendModelStatus?.recommended_backend || '';
    const label = censorT('censor.recommendedTag', null, 'Recommended');
    Array.from(select.options).forEach((option) => {
        const key = option.getAttribute('data-i18n');
        const base = key && window.I18n?.t ? window.I18n.t(key) : option.textContent.replace(/\s+\([^)]*\)\s*$/, '');
        option.textContent = (recommended && option.value === recommended)
            ? `${base} (${label})`
            : base;
    });
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

    // Re-attach resize listener if it was cleaned up
    if (!boundHandlers.resize) {
        boundHandlers.resize = _handleCensorResize;
        window.addEventListener('resize', _handleCensorResize);
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

    // i18n resets the detector option labels on language switch (data-i18n ->
    // textContent); re-apply the "(Recommended)" marker afterwards. The event is
    // dispatched after i18n.applyToDOM(), so this runs last.
    document.addEventListener('languageChanged', markRecommendedDetectorMode);

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
            thumb.style.display = (!filterText || itemTitle.includes(filterText)) ? '' : 'none';
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

async function processCensorBatchItems(handler, { pageSize = CENSOR_TOKEN_QUEUE_WINDOW_SIZE } = {}) {
    const seenIds = new Set();
    let completed = 0;
    let total = getCensorQueueWorkCount();

    for (const item of CensorState.queue) {
        if (!item?.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        await handler(item, {
            index: completed,
            total: Math.max(total, completed + 1),
            transient: false,
        });
        completed += 1;
    }

    const source = CensorState.tokenQueueSource;
    if (source?.selectionToken) {
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const page = await fetchTokenQueueDataPage(offset, pageSize);
            updateTokenQueueSourceFromPage(source, page, offset);
            total = Math.max(total, getTokenQueueTotal());

            const images = Array.isArray(page.images) ? page.images : [];
            for (const image of images) {
                const id = Number(image?.id);
                if (!Number.isFinite(id) || id <= 0 || seenIds.has(id)) continue;

                const existingItem = CensorState.queue.find((entry) => entry.id === id);
                const item = existingItem || buildCensorQueueItemFromImage(image);
                if (!item) continue;

                seenIds.add(id);
                await handler(item, {
                    index: completed,
                    total: Math.max(total, completed + 1),
                    transient: !existingItem,
                });
                completed += 1;
            }

            const nextOffset = Number(page.next_offset);
            hasMore = Boolean(page.has_more && Number.isFinite(nextOffset) && nextOffset >= 0);
            if (!hasMore) break;
            offset = nextOffset;
        }
    }

    return {
        completed,
        total: Math.max(total, completed),
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
    if (CensorState.pendingActiveId && !validIds.has(CensorState.pendingActiveId)) {
        CensorState.pendingActiveId = null;
    }

    // Handle empty state
    if (CensorState.queue.length === 0) {
        CensorState.pendingActiveId = null;
        list.innerHTML = `
            <div class="queue-empty-state-v2">
                <span class="empty-icon">📷</span>
                <p>${escapeHtml(censorT('censor.noImages', null, 'No images selected'))}</p>
                <small>${escapeHtml(censorT('censor.selectFromGallery', null, 'Select from Gallery'))}</small>
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
        const newSrc = getCensorItemPreviewSrc(item);
        if (img.src !== newSrc) {
            img.src = newSrc;
        }

        // Update classes
        const isActive = item.id === getFocusedCensorImageId();
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

    renderTokenQueueLoadMoreControl(list);
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
    return censorT(
        'censor.queueManagerSummary',
        {
            selected: CensorState.selectedItems.size,
            visible: visibleCount,
            total: CensorState.queue.length,
        },
        '{selected} selected • {visible}/{total} visible • drag rows or use the move bar below'
    );
}

function getQueueManagerThumbnailSrc(item) {
    const api = window.App?.API;
    if (item?.previewDataUrl) return item.previewDataUrl;
    if (item?.currentDataUrl) return item.currentDataUrl;
    if (item?.id && typeof api?.getThumbnailUrl === 'function') {
        return api.getThumbnailUrl(item.id, 320);
    }
    return item?.originalUrl || '';
}

function getQueueManagerStatusBadges(item) {
    const badges = [];
    if (item.id === getFocusedCensorImageId()) {
        badges.push(`<span class="queue-manager-badge is-active">${escapeHtml(censorT('common.current', null, 'Current'))}</span>`);
    }
    if (item.isProcessed) {
        badges.push(`<span class="queue-manager-badge is-processed">${escapeHtml(censorT('common.processed', null, 'Processed'))}</span>`);
    }
    return badges.join('');
}

function renderQueueManagerSelectionStrip(items = []) {
    const strip = document.getElementById('queue-manager-selection-strip');
    const countEl = document.getElementById('queue-manager-selection-count');
    const selectedItems = Array.isArray(items) ? items : [];

    if (countEl) {
        countEl.textContent = selectedItems.length > 0
            ? censorT('censor.queueSelectionSummary', { count: selectedItems.length }, '{count} selected')
            : censorT('censor.queueNoSelection', null, 'No selection');
        countEl.classList.toggle('is-empty', selectedItems.length === 0);
    }

    if (!strip) return;

    if (!selectedItems.length) {
        strip.innerHTML = `
            <div class="queue-manager-selection-empty">
                ${escapeHtml(censorT('censor.queueSelectionHelp', null, 'Pick one or more thumbnails to enable batch moves.'))}
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
            ? censorT('censor.queueSelectionSummary', { count }, '{count} selected')
            : censorT('censor.queueSelectionZero', null, '0 selected');
    }

    if (positionInput && CensorState.selectedItems.size > 0) {
        const firstSelectedIndex = CensorState.queue.findIndex((item) => CensorState.selectedItems.has(item.id));
        if (firstSelectedIndex >= 0) {
            positionInput.value = String(firstSelectedIndex + 1);
        }
    }

    if (!items.length) {
        list.innerHTML = `<div class="queue-manager-empty">${escapeHtml(censorT('censor.queueManagerEmpty', null, 'No queue items match the current filter.'))}</div>`;
        return;
    }

    list.innerHTML = items.map((item) => {
        const index = CensorState.queue.findIndex((entry) => entry.id === item.id);
        const isActive = item.id === getFocusedCensorImageId();
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
                censorT(
                    'censor.queueManagerLoaded',
                    { filename: queueItem?.outputFilename || queueItem?.originalFilename || String(clickedId) },
                    'Loaded {filename} into the editor.'
                ),
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
            censorT('censor.queueMoveSelectionRequired', null, 'Select at least one queue item first'),
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
            ? censorT('censor.queueSelectionSummary', { count }, '{count} selected')
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
            censorT('censor.queueMoveSelectionRequired', null, 'Select at least one queue item first'),
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
CensorState.isLoadingImage = false;
CensorState.activeImageLoadRequest = 0;

function buildFilterCssParts(values = {}) {
    const brightness = 100 + Number(values.brightness || 0);
    const contrast = 100 + Number(values.contrast || 0);
    const saturation = 100 + Number(values.saturation || 0);
    const hue = Number(values.hue || 0);
    const blur = Number(values.blur || 0);
    const temperature = Number(values.temperature || 0);
    const filters = [
        `brightness(${brightness}%)`,
        `contrast(${contrast}%)`,
        `saturate(${saturation}%)`,
        `hue-rotate(${hue}deg)`,
    ];
    if (blur > 0) filters.push(`blur(${blur}px)`);
    if (temperature !== 0) {
        if (temperature > 0) {
            filters.push(`sepia(${Math.abs(temperature)}%)`);
        } else {
            filters.push(`sepia(${Math.abs(temperature) * 0.3}%)`);
            filters.push(`hue-rotate(${180 + hue}deg)`);
        }
    }
    return filters;
}

function applySharpenToCanvasPixels(canvas, amount) {
    if (!(canvas instanceof HTMLCanvasElement) || amount <= 0) return;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    const copy = new Uint8ClampedArray(data);
    const kernel = [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0];

    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            for (let channel = 0; channel < 3; channel += 1) {
                let value = 0;
                for (let ky = -1; ky <= 1; ky += 1) {
                    for (let kx = -1; kx <= 1; kx += 1) {
                        value += copy[((y + ky) * width + (x + kx)) * 4 + channel] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                data[(y * width + x) * 4 + channel] = Math.max(0, Math.min(255, value));
            }
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

function applyVignetteToCanvasPixels(canvas, amount) {
    if (!(canvas instanceof HTMLCanvasElement) || amount <= 0) return;
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

async function applyFilterValuesToCanvas(canvas, values = {}) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.filter = buildFilterCssParts(values).join(' ');
    tempCtx.drawImage(canvas, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);

    const sharpen = Number(values.sharpen || 0);
    const vignette = Number(values.vignette || 0);
    if (sharpen > 0) {
        applySharpenToCanvasPixels(canvas, sharpen / 100);
    }
    if (vignette > 0) {
        applyVignetteToCanvasPixels(canvas, vignette / 100);
    }
}

function scaleRegionGeometry(region, scaleX, scaleY) {
    const scaled = { ...region };
    if (Array.isArray(region?.box) && region.box.length === 4) {
        scaled.box = [
            Number(region.box[0] || 0) * scaleX,
            Number(region.box[1] || 0) * scaleY,
            Number(region.box[2] || 0) * scaleX,
            Number(region.box[3] || 0) * scaleY,
        ];
    }
    if (Array.isArray(region?.polygon)) {
        scaled.polygon = region.polygon
            .filter((point) => Array.isArray(point) && point.length >= 2)
            .map((point) => [Number(point[0] || 0) * scaleX, Number(point[1] || 0) * scaleY]);
    }
    return scaled;
}

function createWorkingCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(Number(width || 1)));
    canvas.height = Math.max(1, Math.round(Number(height || 1)));
    return canvas;
}

function getDrawableDimensions(source) {
    return {
        width: Number(source?.naturalWidth || source?.videoWidth || source?.width || 0),
        height: Number(source?.naturalHeight || source?.videoHeight || source?.height || 0),
    };
}

function clampCanvasBounds(bounds, width, height) {
    const x1 = Math.max(0, Math.floor(Number(bounds?.x1 ?? bounds?.[0] ?? 0)));
    const y1 = Math.max(0, Math.floor(Number(bounds?.y1 ?? bounds?.[1] ?? 0)));
    const x2 = Math.min(width, Math.ceil(Number(bounds?.x2 ?? bounds?.[2] ?? width)));
    const y2 = Math.min(height, Math.ceil(Number(bounds?.y2 ?? bounds?.[3] ?? height)));
    if (!(x2 > x1) || !(y2 > y1)) {
        return null;
    }
    return {
        x1,
        y1,
        x2,
        y2,
        width: x2 - x1,
        height: y2 - y1,
    };
}

function scaleOperationEffectValue(value, scaleX = 1, scaleY = 1) {
    return Math.max(1, Math.round(Number(value || 1) * Math.max(scaleX, scaleY)));
}

function cropCanvasRegion(canvas, bounds) {
    const regionCanvas = createWorkingCanvas(bounds.width, bounds.height);
    const regionCtx = regionCanvas.getContext('2d');
    regionCtx.drawImage(
        canvas,
        bounds.x1,
        bounds.y1,
        bounds.width,
        bounds.height,
        0,
        0,
        bounds.width,
        bounds.height
    );
    return regionCanvas;
}

function drawScaledSourceCrop(ctx, sourceImage, sourceBounds, destBounds, options = {}) {
    if (!sourceImage || !ctx) return;
    const sourceDims = getDrawableDimensions(sourceImage);
    const referenceWidth = Math.max(1, Number(options.referenceWidth || ctx.canvas?.width || destBounds?.width || 1));
    const referenceHeight = Math.max(1, Number(options.referenceHeight || ctx.canvas?.height || destBounds?.height || 1));
    const scaleX = sourceDims.width > 0 ? (sourceDims.width / referenceWidth) : 1;
    const scaleY = sourceDims.height > 0 ? (sourceDims.height / referenceHeight) : 1;
    const sx = Math.max(0, Number(sourceBounds.x || 0) * scaleX);
    const sy = Math.max(0, Number(sourceBounds.y || 0) * scaleY);
    const sw = Math.max(1, Number(sourceBounds.width || 1) * scaleX);
    const sh = Math.max(1, Number(sourceBounds.height || 1) * scaleY);
    ctx.drawImage(
        sourceImage,
        sx,
        sy,
        sw,
        sh,
        Number(destBounds.x || 0),
        Number(destBounds.y || 0),
        Number(destBounds.width || 1),
        Number(destBounds.height || 1)
    );
}

function buildPixelatedCanvas(sourceCanvas, blockSize) {
    const downscale = Math.max(1, Math.round(Number(blockSize || 1)));
    const smallW = Math.max(1, Math.floor(sourceCanvas.width / downscale));
    const smallH = Math.max(1, Math.floor(sourceCanvas.height / downscale));
    const tinyCanvas = createWorkingCanvas(smallW, smallH);
    const tinyCtx = tinyCanvas.getContext('2d');
    tinyCtx.imageSmoothingEnabled = false;
    tinyCtx.drawImage(sourceCanvas, 0, 0, smallW, smallH);

    const pixelatedCanvas = createWorkingCanvas(sourceCanvas.width, sourceCanvas.height);
    const pixelatedCtx = pixelatedCanvas.getContext('2d');
    pixelatedCtx.imageSmoothingEnabled = false;
    pixelatedCtx.drawImage(tinyCanvas, 0, 0, smallW, smallH, 0, 0, sourceCanvas.width, sourceCanvas.height);
    return pixelatedCanvas;
}

function drawStrokeMaskOnCanvas(maskCtx, points, brushSize) {
    if (!maskCtx || !Array.isArray(points) || points.length === 0) return;
    const safeBrushSize = Math.max(1, Number(brushSize || 1));
    const radius = safeBrushSize / 2;
    maskCtx.fillStyle = '#fff';
    maskCtx.strokeStyle = '#fff';
    if (points.length === 1) {
        const point = points[0];
        maskCtx.beginPath();
        maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        maskCtx.fill();
        return;
    }

    maskCtx.lineWidth = safeBrushSize;
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';
    maskCtx.beginPath();
    maskCtx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
        maskCtx.lineTo(points[index].x, points[index].y);
    }
    maskCtx.stroke();

    [points[0], points[points.length - 1]].forEach((point) => {
        maskCtx.beginPath();
        maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        maskCtx.fill();
    });
}

function getStrokeMaskBounds(points, brushSize, width, height) {
    if (!Array.isArray(points) || points.length === 0) return null;
    const radius = Math.max(1, Number(brushSize || 1)) / 2;
    const xs = points.map((point) => Number(point?.x || 0));
    const ys = points.map((point) => Number(point?.y || 0));
    return clampCanvasBounds({
        x1: Math.min(...xs) - radius,
        y1: Math.min(...ys) - radius,
        x2: Math.max(...xs) + radius,
        y2: Math.max(...ys) + radius,
    }, width, height);
}

function getRegionBounds(regions = [], width, height) {
    const xs = [];
    const ys = [];
    regions.forEach((region) => {
        if (Array.isArray(region?.box) && region.box.length === 4) {
            xs.push(Number(region.box[0] || 0), Number(region.box[2] || 0));
            ys.push(Number(region.box[1] || 0), Number(region.box[3] || 0));
        }
        if (Array.isArray(region?.polygon)) {
            region.polygon.forEach((point) => {
                if (!Array.isArray(point) || point.length < 2) return;
                xs.push(Number(point[0] || 0));
                ys.push(Number(point[1] || 0));
            });
        }
    });
    if (!xs.length || !ys.length) return null;
    return clampCanvasBounds({
        x1: Math.min(...xs),
        y1: Math.min(...ys),
        x2: Math.max(...xs),
        y2: Math.max(...ys),
    }, width, height);
}

function getMaskCanvasBounds(maskCanvas) {
    if (!(maskCanvas instanceof HTMLCanvasElement) || !maskCanvas.width || !maskCanvas.height) return null;
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const pixels = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    let minX = maskCanvas.width;
    let minY = maskCanvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < maskCanvas.height; y += 1) {
        for (let x = 0; x < maskCanvas.width; x += 1) {
            const alpha = pixels[(y * maskCanvas.width + x) * 4 + 3];
            if (alpha <= 0) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (maxX < minX || maxY < minY) return null;
    return clampCanvasBounds({
        x1: minX,
        y1: minY,
        x2: maxX + 1,
        y2: maxY + 1,
    }, maskCanvas.width, maskCanvas.height);
}

function renderMaskStyleToCanvas(canvas, maskCanvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement) || !(maskCanvas instanceof HTMLCanvasElement)) return;
    const bounds = clampCanvasBounds(
        options.bounds || getMaskCanvasBounds(maskCanvas),
        canvas.width,
        canvas.height
    );
    if (!bounds) return;

    const style = String(options.style || 'mosaic').trim().toLowerCase();
    const blockSize = Math.max(1, Math.round(Number(options.blockSize || 16)));
    const blurRadius = Math.max(1, Math.round(Number(options.blurRadius || 20)));
    const maskCrop = cropCanvasRegion(maskCanvas, bounds);
    const sourceCrop = cropCanvasRegion(canvas, bounds);
    const effectCanvas = createWorkingCanvas(bounds.width, bounds.height);
    const effectCtx = effectCanvas.getContext('2d');

    if (style === 'pen') {
        effectCtx.globalAlpha = Math.max(0, Math.min(1, Number(options.penOpacity ?? 1)));
        effectCtx.fillStyle = options.penColor || '#ff0000';
        effectCtx.fillRect(0, 0, bounds.width, bounds.height);
        effectCtx.globalAlpha = 1;
    } else if (style === 'eraser') {
        drawScaledSourceCrop(
            effectCtx,
            options.originalImage || canvas,
            { x: bounds.x1, y: bounds.y1, width: bounds.width, height: bounds.height },
            { x: 0, y: 0, width: bounds.width, height: bounds.height },
            { referenceWidth: canvas.width, referenceHeight: canvas.height }
        );
    } else if (style === 'white_bar') {
        effectCtx.fillStyle = '#fff';
        effectCtx.fillRect(0, 0, bounds.width, bounds.height);
    } else if (style === 'black_bar' || style === 'black' || style === 'solid') {
        effectCtx.fillStyle = '#000';
        effectCtx.fillRect(0, 0, bounds.width, bounds.height);
    } else if (style === 'blur') {
        effectCtx.filter = `blur(${blurRadius}px)`;
        effectCtx.drawImage(sourceCrop, 0, 0);
        effectCtx.filter = 'none';
    } else {
        effectCtx.drawImage(buildPixelatedCanvas(sourceCrop, blockSize), 0, 0);
    }

    effectCtx.globalCompositeOperation = 'destination-in';
    effectCtx.drawImage(maskCrop, 0, 0);
    effectCtx.globalCompositeOperation = 'source-over';

    const ctx = canvas.getContext('2d');
    ctx.drawImage(effectCanvas, bounds.x1, bounds.y1);
}

function createStrokeOperationFromCurrentState(tool) {
    const operation = {
        kind: 'stroke',
        tool,
        points: [],
        brush_size: Number(CensorState.brushSize || 1),
    };
    if (tool === 'brush') {
        operation.style = CensorState.style;
        operation.block_size = Number(CensorState.blockSize || 16);
        operation.blur_radius = Math.max(8, Number(CensorState.blockSize || 16));
    } else if (tool === 'pen') {
        operation.pen_color = CensorState.penColor;
        operation.pen_opacity = Number(CensorState.penOpacity || 1);
    }
    return operation;
}

async function applyStrokeOperationToCanvas(canvas, originalImage, operation, scaleX = 1, scaleY = 1) {
    if (!(canvas instanceof HTMLCanvasElement) || !operation) return;
    const points = Array.isArray(operation.points) ? operation.points : [];
    if (!points.length) return;

    const tool = String(operation.tool || 'brush').trim().toLowerCase();
    const canvasPoints = points.map((point) => ({
        x: Number(point?.x || 0) * scaleX,
        y: Number(point?.y || 0) * scaleY,
    }));
    const scaledBrushSize = Math.max(1, Number(operation.brush_size || 1) * Math.max(scaleX, scaleY));
    const ctx = canvas.getContext('2d');

    if (tool === 'clone') {
        for (const point of canvasPoints) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(point.x, point.y, scaledBrushSize / 2, 0, Math.PI * 2);
            performClone(ctx, point.x, point.y, scaledBrushSize, {
                sourceImage: originalImage,
                cloneOffset: {
                    x: Number(operation.clone_offset?.x || 0) * scaleX,
                    y: Number(operation.clone_offset?.y || 0) * scaleY,
                },
            });
            ctx.restore();
        }
        return;
    }

    const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
    const maskCtx = maskCanvas.getContext('2d');
    drawStrokeMaskOnCanvas(maskCtx, canvasPoints, scaledBrushSize);
    renderMaskStyleToCanvas(canvas, maskCanvas, {
        bounds: getStrokeMaskBounds(canvasPoints, scaledBrushSize, canvas.width, canvas.height),
        style: tool === 'brush' ? operation.style : tool,
        blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
        blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
        penColor: operation.pen_color,
        penOpacity: operation.pen_opacity,
        originalImage,
    });
}

async function applyGeometryOperationToCanvas(canvas, originalImage, operation, scaleX = 1, scaleY = 1) {
    if (!(canvas instanceof HTMLCanvasElement) || !operation) return;
    const sourceImage = originalImage || CensorState.originalImage;
    const regions = Array.isArray(operation.regions) ? operation.regions : [];
    if (!regions.length) return;

    const scaledRegions = regions.map((region) => scaleRegionGeometry(region, scaleX, scaleY));
    const { maskRegions, boxRegions } = splitDetectionGeometry(scaledRegions);
    if (maskRegions.length) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.fillStyle = '#fff';
        maskRegions.forEach((region) => {
            const polygon = Array.isArray(region?.polygon) ? region.polygon : [];
            const validPoints = polygon.filter((point) => Array.isArray(point) && point.length >= 2);
            if (validPoints.length < 3) return;
            maskCtx.beginPath();
            validPoints.forEach((point, index) => {
                const x = Number(point[0] || 0);
                const y = Number(point[1] || 0);
                if (index === 0) {
                    maskCtx.moveTo(x, y);
                } else {
                    maskCtx.lineTo(x, y);
                }
            });
            maskCtx.closePath();
            maskCtx.fill();
        });
        renderMaskStyleToCanvas(canvas, maskCanvas, {
            style: operation.style,
            blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
            blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
            originalImage: sourceImage,
            bounds: getRegionBounds(maskRegions, canvas.width, canvas.height),
        });
    }
    if (boxRegions.length) {
        const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.fillStyle = '#fff';
        boxRegions.forEach((region) => {
            if (!Array.isArray(region?.box) || region.box.length !== 4) return;
            const [x1, y1, x2, y2] = region.box;
            maskCtx.fillRect(x1, y1, x2 - x1, y2 - y1);
        });
        renderMaskStyleToCanvas(canvas, maskCanvas, {
            style: operation.style,
            blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
            blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
            originalImage: sourceImage,
            bounds: getRegionBounds(boxRegions, canvas.width, canvas.height),
        });
    }
}

async function applyMaskOperationToCanvas(canvas, originalImage, operation, scaleX = 1, scaleY = 1) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
    const maskCtx = maskCanvas.getContext('2d');
    const maskBounds = operation?.mask_data
        ? null
        : getMaskOperationCanvasBounds(operation, scaleX, scaleY, canvas);
    const maskImage = await loadMaskImageForOperation(operation, maskBounds);
    if (!maskImage) return;

    if (maskBounds) {
        maskCtx.drawImage(maskImage, maskBounds.x, maskBounds.y, maskBounds.width, maskBounds.height);
    } else {
        maskCtx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
    }
    renderMaskStyleToCanvas(canvas, maskCanvas, {
        style: operation.style,
        blockSize: scaleOperationEffectValue(operation.block_size || 16, scaleX, scaleY),
        blurRadius: scaleOperationEffectValue(operation.blur_radius || 20, scaleX, scaleY),
        originalImage,
        bounds: maskBounds || undefined,
    });
}

async function applyEditOperationToCanvas(canvas, item, operation, originalImage = null) {
    if (!operation || typeof operation !== 'object') return;
    const kind = String(operation.kind || '').trim().toLowerCase();
    const logical = getCensorItemLogicalDimensions(item, CensorState.originalLogicalWidth, CensorState.originalLogicalHeight);
    const scaleX = logical.width > 0 ? (canvas.width / logical.width) : 1;
    const scaleY = logical.height > 0 ? (canvas.height / logical.height) : 1;

    if (kind === 'stroke') {
        await applyStrokeOperationToCanvas(canvas, originalImage || CensorState.originalImage, operation, scaleX, scaleY);
    } else if (kind === 'geometry_effect') {
        await applyGeometryOperationToCanvas(canvas, originalImage || CensorState.originalImage, operation, scaleX, scaleY);
    } else if (kind === 'mask_effect') {
        await applyMaskOperationToCanvas(canvas, originalImage || CensorState.originalImage, operation, scaleX, scaleY);
    } else if (kind === 'filter') {
        await applyFilterValuesToCanvas(canvas, operation.values || {});
    }
}

async function replayEditOperationsOntoCanvas(canvas, item, originalImage = null) {
    if (!(canvas instanceof HTMLCanvasElement) || !item?.editOperations?.length) return;
    for (const operation of item.editOperations) {
        await applyEditOperationToCanvas(canvas, item, operation, originalImage || CensorState.originalImage);
    }
}

function syncProxyItemPreviewFromCanvas(item, canvas = null) {
    if (!item) return;
    const targetCanvas = canvas || document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!item.editOperations?.length) {
        item.previewDataUrl = null;
        item.currentDataUrl = null;
        item.isModified = false;
        return;
    }
    item.previewDataUrl = captureCanvasState(targetCanvas);
    item.currentDataUrl = null;
    item.isModified = true;
}

async function redrawProxyCanvasFromOperations(item, canvas = null, baseImage = null) {
    if (!item) return null;
    const targetCanvas = canvas || document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!(targetCanvas instanceof HTMLCanvasElement) || !targetCanvas.width || !targetCanvas.height) {
        return null;
    }
    const dims = getCensorItemCanvasDimensions(item);
    const sourceImage = baseImage || CensorState.originalImage || await loadImage(getCensorPreviewBaseUrl(item, dims));
    const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(sourceImage, 0, 0, targetCanvas.width, targetCanvas.height);
    await replayEditOperationsOntoCanvas(targetCanvas, item, sourceImage);
    syncProxyItemPreviewFromCanvas(item, targetCanvas);
    return targetCanvas;
}

async function renderProxyPreviewDataForItem(item) {
    if (!item) return null;
    const dims = getCensorItemCanvasDimensions(item);
    const previewBaseUrl = getCensorPreviewBaseUrl(item, dims);
    const baseImage = await loadImage(previewBaseUrl);
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    await redrawProxyCanvasFromOperations(item, canvas, baseImage);
    return item.previewDataUrl;
}


async function loadCanvasImage(id) {
    const item = CensorState.queue.find(i => i.id === id);
    if (!item) return;
    const requestId = ++CensorState.activeImageLoadRequest;
    const preserveOperationRedoStack = CensorState.activeId === id && CensorState.operationRedoStack.length > 0;

    if (typeof window.__invalidateCensorFilterPreview === 'function') {
        window.__invalidateCensorFilterPreview();
    }

    CensorState.selectedItems.clear();
    CensorState.selectedItems.add(id);
    CensorState.lastSelectedIndex = CensorState.queue.findIndex(queueItem => queueItem.id === id);
    CensorState.pendingActiveId = id;
    CensorState.isLoadingImage = true;

    if (CensorState.activeId && CensorState.activeId !== id) {
        saveCurrentCanvasToState();
    }

    renderQueue();
    scrollQueueItemIntoView(id);

    // Identify current and next canvas
    const currentCanvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const nextCanvasId = CensorState.activeCanvasId === 'censor-canvas' ? 'censor-canvas-buffer' : 'censor-canvas';
    const nextCanvas = document.getElementById(nextCanvasId);

    // UI Updates
    const noImageEl = document.getElementById('censor-no-image');
    const filenameEl = document.getElementById('censor-filename');
    showLoading(true, censorT('censor.loadingImage', null, 'Loading image...'));

    try {
        let fallbackImage = null;
        let logicalDims = getCensorItemLogicalDimensions(item);
        if (logicalDims.width <= 0 || logicalDims.height <= 0) {
            fallbackImage = await loadImage(item.originalUrl);
            logicalDims = getCensorItemLogicalDimensions(item, fallbackImage.width, fallbackImage.height);
            item.width = logicalDims.width;
            item.height = logicalDims.height;
        }

        const proxyMode = shouldUseProxyEditMode(item, logicalDims.width, logicalDims.height);
        const canvasDims = getCensorItemCanvasDimensions(item, logicalDims.width, logicalDims.height);
        const displayUrl = proxyMode
            ? getCensorPreviewBaseUrl(item, canvasDims)
            : (item.currentDataUrl || item.originalUrl);
        const originalPreviewUrl = proxyMode
            ? getCensorPreviewBaseUrl(item, canvasDims)
            : item.originalUrl;

        const [img, originalImg] = await Promise.all([
            proxyMode && fallbackImage ? Promise.resolve(fallbackImage) : loadImage(displayUrl),
            proxyMode && fallbackImage ? Promise.resolve(fallbackImage) : loadImage(originalPreviewUrl)
        ]);
        if (requestId !== CensorState.activeImageLoadRequest) {
            return;
        }

        CensorState.originalImage = originalImg;
        CensorState.originalImageData = null;
        CensorState.originalLogicalWidth = logicalDims.width || img.width;
        CensorState.originalLogicalHeight = logicalDims.height || img.height;
        CensorState.preChangesData = null;
        CensorState.showingChanges = false;
        CensorState.activeImagePixels = getCensorItemPixelCount(item, img.width, img.height) || (img.width * img.height);
        CensorState.lowMemoryMode = CensorState.activeImagePixels >= getCensorLowMemoryPixelThreshold();
        CensorState.proxyEditMode = proxyMode;
        CensorState.proxyScale = proxyMode && CensorState.originalLogicalWidth > 0
            ? canvasDims.width / CensorState.originalLogicalWidth
            : 1;
        if (!preserveOperationRedoStack) {
            CensorState.operationRedoStack = [];
        }
        CensorState.activeStrokeOperation = null;

        // Draw to NEXT canvas (hidden)
        nextCanvas.width = proxyMode ? canvasDims.width : img.width;
        nextCanvas.height = proxyMode ? canvasDims.height : img.height;
        const ctx = nextCanvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
        ctx.drawImage(img, 0, 0, nextCanvas.width, nextCanvas.height);
        if (proxyMode && Array.isArray(item.editOperations) && item.editOperations.length > 0) {
            await replayEditOperationsOntoCanvas(nextCanvas, item, originalImg);
        }

        // Initialize undo stack from the image that is actually shown on screen
        const initialState = proxyMode ? CENSOR_ORIGINAL_STATE_TOKEN : (item.currentDataUrl || CENSOR_ORIGINAL_STATE_TOKEN);
        CensorState.baseCanvasState = initialState;
        CensorState.baseItemState = {
            currentDataUrl: item.currentDataUrl || null,
            previewDataUrl: item.previewDataUrl || null,
            editOperations: cloneEditOperations(item.editOperations || []),
            isModified: Boolean(item.isModified)
        };
        CensorState.undoStack = proxyMode ? [CENSOR_ORIGINAL_STATE_TOKEN] : [initialState];
        CensorState.redoStack = [];
        updateUndoRedoButtons();
        maybeNotifyLowMemoryMode(item, CensorState.activeImagePixels);

        // Fit canvases to container before showing
        fitCanvasToContainer(nextCanvas, nextCanvas.width, nextCanvas.height);
        fitCanvasToContainer(currentCanvas, nextCanvas.width, nextCanvas.height);

        // SWAP: Show next, Hide current (with RAF)
        requestAnimationFrame(() => {
            if (requestId !== CensorState.activeImageLoadRequest) {
                return;
            }
            nextCanvas.style.opacity = '1';
            nextCanvas.style.pointerEvents = 'auto';
            nextCanvas.style.zIndex = '10';

            currentCanvas.style.opacity = '0';
            currentCanvas.style.pointerEvents = 'none';
            currentCanvas.style.zIndex = '0';

            // Update State
            CensorState.activeCanvasId = nextCanvasId;
            CensorState.activeId = id;
            CensorState.pendingActiveId = null;

            // Finalize
            noImageEl.style.display = 'none';
            setCensorEditorHasImage(true);
            showLoading(false);
            if (filenameEl) filenameEl.textContent = item.outputFilename;

            resetZoom();
            if (typeof window.__updateCensorFilterPreview === 'function') {
                window.__updateCensorFilterPreview();
            }
            CensorState.isLoadingImage = false;
            if (proxyMode) {
                syncProxyItemPreviewFromCanvas(item, nextCanvas);
            }
            renderQueue();
        });

    } catch (error) {
        if (requestId !== CensorState.activeImageLoadRequest) {
            return;
        }
        Logger.error('Failed to load image:', error);
        showLoading(false);
        CensorState.isLoadingImage = false;
        CensorState.pendingActiveId = null;
        if (CensorState.activeId) {
            CensorState.selectedItems.clear();
            CensorState.selectedItems.add(CensorState.activeId);
            CensorState.lastSelectedIndex = CensorState.queue.findIndex(queueItem => queueItem.id === CensorState.activeId);
        }
        renderQueue();
        window.App.showToast(
            formatUserError(error, censorT('censor.loadImageFailed', null, 'Failed to load image')),
            'error'
        );
    }

    // Safety fallback: only clear the newest request lock.
    setTimeout(() => {
        if (requestId === CensorState.activeImageLoadRequest) {
            CensorState.isLoadingImage = false;
        }
    }, 2000);
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

// Re-fit on window resize (debounced, removable)
let _resizeDebounceTimer = null;
function _handleCensorResize() {
    clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = setTimeout(() => {
        if (CensorState.activeId && CensorState.originalImage) {
            const c1 = document.getElementById('censor-canvas');
            const c2 = document.getElementById('censor-canvas-buffer');
            const referenceCanvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
            const width = referenceCanvas?.width || CensorState.originalImage.width;
            const height = referenceCanvas?.height || CensorState.originalImage.height;
            fitCanvasToContainer(c1, width, height);
            fitCanvasToContainer(c2, width, height);
        }
    }, 150);
}
boundHandlers.resize = _handleCensorResize;
window.addEventListener('resize', _handleCensorResize);

function saveCurrentCanvasToState(serializedState = null) {
    // Save from the CURRENT active canvas
    if (!CensorState.activeId) return;
    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');

    if (item && canvas) {
        if (isProxyEditActive()) {
            const hasPendingFilterPreview = typeof window.__censorHasPendingFilterPreview === 'function'
                ? Boolean(window.__censorHasPendingFilterPreview())
                : false;
            if (!hasPendingFilterPreview) {
                syncProxyItemPreviewFromCanvas(item, canvas);
            }
            return;
        }

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
            markRecommendedDetectorMode();
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
                    ? censorT('censor.recommendedMode', { backend: result.recommended_backend }, 'Recommended mode: {backend}.')
                    : censorT('censor.noDetectionBackendReady', null, 'No detection backend is fully ready yet.');
                const defaultLegacy = legacy?.files?.find(file => file.path === legacy?.default_model_path);
                const extraNotes = [];
                if (defaultLegacy) {
                    extraNotes.push(censorT(
                        'censor.legacyDefaultNamed',
                        {
                            name: defaultLegacy.name,
                            profile: defaultLegacy.profile_label,
                        },
                        'Legacy default: {name} ({profile})'
                    ));
                } else if (legacy?.default_model_path) {
                    extraNotes.push(censorT('censor.legacyDefaultPath', { path: legacy.default_model_path }, 'Legacy default: {path}'));
                }
                if ((legacy?.general_model_count || 0) > 0) {
                    extraNotes.push(censorT(
                        'censor.generalModelCount',
                        { count: legacy.general_model_count },
                        '{count} general YOLO model(s) installed for compatibility tests'
                    ));
                }
                const extra = extraNotes.length
                    ? `<br><small>${escapeHtml(extraNotes.join(' · '))}</small>`
                    : '';

                banner.className = classes.join(' ');
                banner.innerHTML = `<strong>${escapeHtml(censorT('censor.modelReadyLabel', null, 'Detection Ready'))}:</strong> ${escapeHtml(readyNotes || censorT('common.none', null, 'None'))} ${escapeHtml(recommended)}${extra}`;
            }
            if (simpleGuide) {
                simpleGuide.textContent = legacy?.simple_user_advice || censorT(
                    'censor.keepRecommendedModeHelp',
                    null,
                    'Keep the recommended mode and only touch custom paths if you know why.'
                );
            }
            renderCensorCapabilityPanel();
            return result;
        } catch (e) {
            CensorState.modelStatusError = e?.message || censorT('censor.modelReadinessLoadFailed', null, 'Model readiness could not be loaded right now.');
            if (banner) {
                banner.className = 'model-health-banner model-health-banner-compact is-visible model-health-banner-warning';
                banner.textContent = censorT('censor.modelReadinessLoadFailed', null, 'Model readiness could not be loaded right now.');
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

function formatCensorCapabilityLine(labelKey, value, fallbackLabel) {
    return `${censorT(labelKey, null, fallbackLabel)}: ${value}`;
}

function formatCensorYesNo(value) {
    return value
        ? censorT('censor.yes', null, 'Yes')
        : censorT('censor.no', null, 'No');
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
    const batchRefineButton = document.getElementById('btn-sam3-batch-refine');
    const targetGroup = document.getElementById('censor-target-region-group');
    const targetChecks = Array.from(document.querySelectorAll('.target-region-check'));

    if (!panel) return;

    const isLoading = Boolean(options.loading || CensorState.modelStatusLoading);
    const loadError = String(CensorState.modelStatusError || '').trim();

    if (!CensorState.backendModelStatus) {
        panel.innerHTML = buildCapabilityCardHtml(
            censorT('censor.modelReadinessTitle', null, 'Model readiness'),
            isLoading ? censorT('common.loading', null, 'Loading...') : censorT('censor.unavailable', null, 'Unavailable'),
            isLoading
                ? [
                    censorT('censor.modelReadinessChecking', null, 'Checking local YOLO, NudeNet, and SAM3 availability...'),
                    censorT('censor.modelReadinessPendingHint', null, 'The panel will fill in as soon as the backend responds.'),
                ]
                : [
                    loadError || censorT('censor.modelReadinessLoadFailed', null, 'Model readiness could not be loaded right now.'),
                    censorT('censor.modelReadinessReloadHint', null, 'You can reopen this dialog after the backend finishes loading.'),
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
                ? censorT('censor.quickTargetsLoading', null, 'Quick privacy targets are loading.')
                : censorT('censor.quickTargetsUnavailable', null, 'Quick privacy targets are temporarily unavailable.');
        }
        if (promptHelp) {
            promptHelp.textContent = isLoading
                ? censorT('censor.sam3ReadinessLoading', null, 'Loading SAM3 readiness for the pro prompt tool.')
                : censorT('censor.sam3ReadinessUnavailable', null, 'SAM3 readiness is temporarily unavailable.');
        }
        if (promptInput) {
            promptInput.readOnly = false;
            promptInput.removeAttribute('disabled');
            promptInput.setAttribute('aria-disabled', 'false');
        }
        if (segmentButton) {
            segmentButton.disabled = true;
            segmentButton.title = isLoading
                ? censorT('censor.modelReadinessButtonLoading', null, 'Loading model readiness…')
                : censorT('censor.modelReadinessButtonUnavailable', null, 'Model readiness is unavailable right now.');
        }
        if (batchRefineButton) {
            batchRefineButton.disabled = true;
            batchRefineButton.title = isLoading
                ? censorT('censor.sam3ReadinessButtonLoading', null, 'Loading SAM3 readiness…')
                : censorT('censor.sam3ReadinessButtonUnavailable', null, 'SAM3 readiness is unavailable right now.');
        }
        if (simpleGuide) {
            simpleGuide.textContent = isLoading
                ? censorT('censor.recommendedRouteLoading', null, 'Loading the recommended detection route…')
                : censorT('censor.modelReadinessTemporaryUnavailable', null, 'Model readiness is temporarily unavailable.');
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
                formatCensorCapabilityLine('censor.capabilityInput', caps.input_mode_label || censorT('censor.capabilityFixedModelLabels', null, 'Fixed model labels'), 'Input'),
                formatCensorCapabilityLine('censor.capabilityOutput', caps.output_mode_label || censorT('censor.capabilityLegacyDetection', null, 'Legacy detection'), 'Output'),
                formatCensorCapabilityLine('censor.capabilityScope', caps.class_scope_label || censorT('censor.capabilityUnknown', null, 'Unknown'), 'Scope'),
                formatCensorCapabilityLine('censor.capabilityTextPrompt', formatCensorYesNo(caps.supports_text_prompt), 'Text prompt'),
            ],
            caps.plain_english || selectedLegacy.message || '',
            { recommended: Boolean(selectedLegacy.recommended_for_censor) }
        ));
    }

    if (nudenet) {
        const caps = nudenet.capabilities || {};
        cards.push(buildCapabilityCardHtml(
            nudenet.name,
            nudenet.available ? censorT('common.ready', null, 'Ready') : censorT('censor.optional', null, 'Optional'),
            [
                formatCensorCapabilityLine('censor.capabilityInput', caps.input_mode_label || censorT('censor.capabilityBuiltInNsfwLabels', null, 'Built-in NSFW labels'), 'Input'),
                formatCensorCapabilityLine('censor.capabilityOutput', caps.output_mode_label || censorT('censor.capabilityDetectionBoxes', null, 'Detection boxes'), 'Output'),
                formatCensorCapabilityLine('censor.capabilityScope', caps.class_scope_label || censorT('censor.capabilityBuiltInNsfwLabels', null, 'Built-in NSFW labels'), 'Scope'),
                formatCensorCapabilityLine('censor.capabilityTextPrompt', formatCensorYesNo(caps.supports_text_prompt), 'Text prompt'),
            ],
            caps.plain_english || nudenet.message || '',
            { recommended: Boolean(nudenet.recommended) }
        ));
    }

    if (sam3) {
        const caps = sam3.capabilities || {};
        cards.push(buildCapabilityCardHtml(
            sam3.name,
            sam3.available ? censorT('censor.precision', null, 'Precision') : censorT('censor.gpuOnlyOptional', null, 'GPU-only optional'),
            [
                formatCensorCapabilityLine('censor.capabilityInput', caps.input_mode_label || censorT('censor.capabilityTextOrBoxPrompt', null, 'Text prompt or box prompt'), 'Input'),
                formatCensorCapabilityLine('censor.capabilityOutput', caps.output_mode_label || censorT('censor.capabilityPixelMasks', null, 'Pixel masks'), 'Output'),
                formatCensorCapabilityLine('censor.capabilityScope', caps.class_scope_label || censorT('censor.capabilityPromptGuidedSegmentation', null, 'Prompt-guided segmentation'), 'Scope'),
                formatCensorCapabilityLine('censor.capabilityTextPrompt', formatCensorYesNo(caps.supports_text_prompt), 'Text prompt'),
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
            targetHelp.textContent = censorT('censor.quickTargetsBothHelp', null, 'These quick privacy targets work across Wenaka and NudeNet family labels. They do not control generic COCO classes.');
        } else if (modelType === 'nudenet') {
            targetHelp.textContent = censorT('censor.quickTargetsNudenetHelp', null, 'NudeNet uses its own label system, but these quick privacy targets now map to the matching NudeNet families.');
        } else if (quickFilterEnabled) {
            if (modelType === 'legacy' && selectedLegacy?.profile !== 'privacy-censor' && quickAutoFallback.canAutoRestore) {
                targetHelp.textContent = censorT('censor.quickTargetsFallbackHelp', null, 'These quick privacy targets stay active. When you run Quick Auto Censor, the app will switch back to the recommended privacy detector instead of using this general YOLO test model.');
            } else {
                targetHelp.textContent = censorT('censor.quickTargetsLegacyHelp', null, 'These quick privacy targets map to the fixed privacy classes inside the current local model.');
            }
        } else {
            targetHelp.textContent = censorT('censor.quickTargetsGeneralModelHelp', null, 'These quick privacy targets stay visible so you can see the normal workflow, but the current general segmentation model cannot map them. Switch back to the recommended privacy model or Both if you want clickable privacy presets.');
        }
    }

    if (promptHelp) {
        promptHelp.textContent = sam3?.available
            ? censorT('censor.promptHelpSam3Ready', null, 'Uses SAM3 text-prompt segmentation on the current image. This is the precise pro tool.')
            : censorT(
                'censor.promptHelpSam3Unavailable',
                { message: sam3?.message || '' },
                'You can still type a prompt here, but this machine cannot run SAM3 yet. {message}'
            ).trim();
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
            : (sam3?.message || censorT('censor.sam3UnavailableMessage', null, 'SAM3 is not available in this environment yet.'));
    }
    if (batchRefineButton) {
        batchRefineButton.disabled = !sam3?.available;
        batchRefineButton.title = sam3?.available
            ? ''
            : (sam3?.message || censorT('censor.sam3BatchUnavailableMessage', null, 'SAM3 batch refine is not available in this environment yet.'));
    }

    if (simpleGuide) {
        if (modelType === 'nudenet') {
            simpleGuide.textContent = censorT('censor.simpleGuideNudenet', null, 'NudeNet is the simple path: no text prompt, no custom labels. Use it when you want quick NSFW/body-region boxes.');
        } else if (modelType === 'both') {
            simpleGuide.textContent = censorT('censor.simpleGuideBoth', null, 'Recommended for most people: run NudeNet together with the auto-picked privacy model. If the local model has segmentation masks, the auto-censor path will use them.');
        } else if (selectedLegacy?.profile === 'privacy-censor') {
            simpleGuide.textContent = censorT('censor.simpleGuidePrivacyLegacy', null, 'This local model is the privacy-part route. It only understands its fixed privacy labels, but if it exposes segmentation masks the auto-censor path will use them instead of raw rectangles.');
        } else if (selectedLegacy) {
            simpleGuide.textContent = quickAutoFallback.canAutoRestore
                ? censorT('censor.simpleGuideAdvancedLegacyAutoRestore', { name: selectedLegacy.name }, '{name} is a general fixed-class segmentation model kept for advanced tests. Quick Auto Censor will automatically switch back to the recommended privacy route before it runs.')
                : censorT('censor.simpleGuideAdvancedLegacy', { name: selectedLegacy.name }, '{name} is a general fixed-class segmentation model kept for advanced tests. It can segment its own built-in object classes, but it is not an open-text privacy detector.');
        } else {
            simpleGuide.textContent = censorT('censor.simpleGuideDefault', null, 'Keep the recommended mode and leave custom paths blank unless you are doing advanced model experiments.');
        }
    }
}

function formatLegacyModelOptionLabel(file) {
    const profile = file?.profile_label ? ` - ${file.profile_label}` : '';
    const purpose = file?.recommended_for_censor
        ? censorT('censor.recommendedPrivacyRoute', null, 'Recommended privacy route')
        : censorT('censor.advancedTestOnly', null, 'Advanced test only');
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
    help.removeAttribute('data-i18n');

    const generalCount = Number(legacyModel?.general_model_count || 0);
    if (generalCount <= 0) {
        help.textContent = censorT('censor.noAdvancedModelsFound', null, 'No extra general YOLO compatibility models were found locally.');
        return;
    }

    help.textContent = CensorState.showAdvancedLegacyModels
        ? censorT('censor.advancedModelsVisible', { count: generalCount }, '{count} advanced fixed-class YOLO model(s) are visible below. They are for compatibility tests, not normal privacy censoring.')
        : censorT('censor.advancedModelsHidden', { count: generalCount }, '{count} advanced fixed-class YOLO model(s) are hidden to keep the normal workflow simpler. Leave this off unless you intentionally want advanced fixed-class YOLO compatibility tests.');
}

function updateSelectedLegacyModelHelp(legacyModel) {
    const help = document.getElementById('censor-model-file-help');
    if (!help) return;
    help.removeAttribute('data-i18n');

    const manualPath = String(document.getElementById('censor-model-path')?.value || '').trim();
    if (manualPath) {
        help.textContent = censorT('censor.customPathActiveHelp', null, 'Custom path is active. Leave it blank if you want the app to auto-pick the recommended local privacy model.');
        return;
    }

    const selectedPath = String(document.getElementById('censor-model-file')?.value || '').trim();
    const selectedFile = getLegacyModelRecordByPath(selectedPath) || getLegacyModelRecordByPath(legacyModel?.default_model_path);
    if (!selectedFile) {
        help.textContent = censorT('censor.noLocalYoloFound', null, 'No local YOLO model was found. NudeNet can still work if it is installed.');
        updateSelectedLegacyModelStatus(null);
        return;
    }

    const parts = [censorT('censor.selectedModel', { name: selectedFile.name }, 'Selected: {name}')];
    if (selectedFile.profile_label) {
        parts.push(selectedFile.profile_label);
    }
    if (selectedFile.message) {
        parts.push(selectedFile.message);
    }
    help.textContent = parts.join(' · ');
    updateSelectedLegacyModelStatus(selectedFile);
}

function updateSelectedLegacyModelStatus(selectedFile) {
    const status = document.getElementById('censor-model-type-status');
    if (!status) return;
    status.removeAttribute('data-i18n');

    if (!selectedFile) {
        status.textContent = '';
        return;
    }

    status.textContent = censorT('censor.selectedModelOption', { name: selectedFile.name }, 'Use this file: {name}');
}

function populateCensorModelSelect(legacyModel) {
    const select = document.getElementById('censor-model-file');
    if (!select) return;

    const currentValue = CensorState.modelPath || '';
    const files = Array.isArray(legacyModel?.files) ? legacyModel.files : [];
    const visibleFiles = getVisibleLegacyModels(files, currentValue);
    const seen = new Set();
    const options = [`<option value="">${escapeHtml(censorT('censor.autoPickRecommendedLocalModel', null, 'Auto-pick the recommended local model'))}</option>`];

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

    const modelPathInput = document.getElementById('censor-model-path');
    if (modelPathInput) {
        modelPathInput.value = currentValue && !seen.has(currentValue) ? currentValue : '';
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

    const sam3PromptRow = document.getElementById('sam3-prompt-row');
    if (sam3PromptRow) sam3PromptRow.style.display = modelType === 'sam3' ? '' : 'none';

    const sam3Group = document.getElementById('sam3-confidence-group');
    if (sam3Group) {
        const sam3Model = (CensorState.backendModelStatus?.models || []).find(m => m.id === 'sam3');
        sam3Group.style.display = sam3Model?.available ? '' : 'none';
    }

    renderCensorCapabilityPanel();
}

const SAM3_COMMON_PROMPTS = {
    'Privacy / NSFW': [
        'exposed female breast', 'exposed nipple', 'exposed female genitalia',
        'exposed male genitalia', 'exposed anus', 'exposed buttocks',
    ],
    'Body Parts': [
        'face', 'eyes', 'mouth', 'hands', 'feet', 'navel', 'armpit',
    ],
    'Clothing / Objects': [
        'underwear', 'bra', 'bikini', 'tattoo', 'piercing', 'watermark', 'text', 'logo',
    ],
};

function _showSam3CommonWordsPopup() {
    // Toggle: re-clicking the trigger while the popup is open closes it.
    // The previous design left users stranded — the popup had no close
    // button and was absolutely-positioned with no offsets, so it landed
    // at the parent's (0,0) and silently covered the censor sidebar
    // controls beneath it. Now: viewport-anchored, explicit close (✕),
    // Escape closes, click-outside closes.
    const existing = document.getElementById('sam3-common-popup');
    if (existing) {
        _closeSam3CommonWordsPopup(existing);
        return;
    }

    const btn = document.getElementById('btn-sam3-common-words');
    if (!btn) return;

    const popup = document.createElement('div');
    popup.id = 'sam3-common-popup';
    popup.className = 'sam3-common-popup visible';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'SAM3 common prompts');
    popup.style.cssText = [
        'position:fixed',
        'z-index:9100',
        'background:var(--bg-card-solid,#0e1a2d)',
        'border:1px solid var(--glass-border,rgba(191,219,254,0.18))',
        'border-radius:12px',
        'padding:10px 12px 12px',
        'width:min(320px, calc(100vw - 24px))',
        'max-height:min(420px, calc(100vh - 96px))',
        'overflow-y:auto',
        'box-shadow:0 16px 40px rgba(0,0,0,0.5)',
        'color:var(--text-primary,#eef2ff)',
    ].join(';') + ';';

    const closeLabel = (window.tKey?.('censor.sam3CloseHint', 'Close', '关闭')) || 'Close';
    const headerHelp = (window.tKey?.('censor.sam3CommonHelp', 'Click to add. Separate multiple with commas.', '点击添加；多个词用逗号分隔。')) || 'Click to add. Separate multiple with commas.';

    let html = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div style="flex:1;font-size:11px;color:var(--text-muted,#94a3b8);line-height:1.4;">${window.escapeHtml(headerHelp)}</div>
            <button id="sam3-common-popup-close" type="button" aria-label="${window.escapeHtml(closeLabel)}" title="${window.escapeHtml(closeLabel)}" style="background:none;border:none;color:var(--text-muted,#94a3b8);font-size:18px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px;flex-shrink:0;">×</button>
        </div>
    `;
    for (const [group, words] of Object.entries(SAM3_COMMON_PROMPTS)) {
        html += `<div style="font-size:11px;font-weight:700;color:var(--text-secondary,#cbd5e1);margin:8px 0 4px;">${window.escapeHtml(group)}</div>`;
        html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
        for (const word of words) {
            html += `<button type="button" class="btn btn-ghost btn-small sam3-word-chip" data-word="${window.escapeHtml(word)}" style="font-size:11px;padding:3px 8px;border-radius:6px;">${window.escapeHtml(word)}</button>`;
        }
        html += '</div>';
    }
    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Anchor the popup to the trigger button. Prefer dropping below; if
    // there isn't enough room, drop above. Constrain horizontally so it
    // never overflows the viewport.
    const padding = 8;
    const reposition = () => {
        const r = btn.getBoundingClientRect();
        const pr = popup.getBoundingClientRect();
        let top = r.bottom + padding;
        if (top + pr.height > window.innerHeight - padding) {
            const above = r.top - padding - pr.height;
            top = above >= padding ? above : Math.max(padding, window.innerHeight - pr.height - padding);
        }
        let left = Math.min(r.right - pr.width, window.innerWidth - pr.width - padding);
        left = Math.max(padding, left);
        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
    };
    reposition();

    // Chip click → add word into the prompt input.
    popup.addEventListener('click', (e) => {
        const chip = e.target.closest('.sam3-word-chip');
        if (!chip) return;
        const word = chip.dataset.word;
        const input = document.getElementById('sam3-custom-prompt');
        if (!input) return;
        const current = input.value.trim();
        if (current) {
            const existing = current.split(',').map((s) => s.trim());
            if (!existing.includes(word)) {
                input.value = current + ', ' + word;
            }
        } else {
            input.value = word;
        }
    });

    document.getElementById('sam3-common-popup-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _closeSam3CommonWordsPopup(popup);
    });

    // Defer the click-outside handler so the click that opened the popup
    // doesn't immediately close it on its trailing event.
    setTimeout(() => {
        const outside = (e) => {
            if (popup.contains(e.target)) return;
            if (e.target.id === 'btn-sam3-common-words' || e.target.closest?.('#btn-sam3-common-words')) return;
            _closeSam3CommonWordsPopup(popup);
        };
        const onKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                _closeSam3CommonWordsPopup(popup);
            }
        };
        document.addEventListener('click', outside, true);
        document.addEventListener('keydown', onKeydown);
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        popup._sam3Cleanup = () => {
            document.removeEventListener('click', outside, true);
            document.removeEventListener('keydown', onKeydown);
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, 0);
}

function _closeSam3CommonWordsPopup(popup) {
    const target = popup || document.getElementById('sam3-common-popup');
    if (!target) return;
    try { target._sam3Cleanup?.(); } catch (_err) {}
    target.remove();
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
                message: censorT(
                    'censor.quickAutoNeedsPrivacyDetector',
                    null,
                    'Quick Auto Censor needs a real privacy detector, but this machine does not have one ready yet.'
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
            ? censorT('censor.bothMode', null, 'Both mode')
            : (modelType === 'nudenet'
                ? 'NudeNet'
                : censorT('censor.privacyPartDetector', null, 'the privacy-part detector'));

        switchMessage = censorT(
            'censor.quickAutoSwitchedRoute',
            { routeLabel },
            'Quick Auto Censor switched back to {routeLabel} so the general YOLO test model will not blur unrelated parts of the image.'
        );

        if (!silent && switchMessage) {
            showToast(switchMessage, 'warning');
        }
    }

    const targetClasses = getSelectedTargetClassesForDetection(modelType);
    if (Array.isArray(targetClasses) && targetClasses.length === 0) {
        return {
            ok: false,
            message: censorT('censor.quickTargetRequired', null, 'Select at least one quick privacy target first.'),
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
    const maxDepth = getEffectiveCensorUndoDepth();
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
    const activeItem = getActiveCensorItem();
    const canUndoCanvas = !isProxyEditActive() && CensorState.undoStack.length > 1;
    const canRedoCanvas = !isProxyEditActive() && CensorState.redoStack.length > 0;
    const canUndoProxy = isProxyEditActive() && Boolean(activeItem?.editOperations?.length);
    const canRedoProxy = isProxyEditActive() && CensorState.operationRedoStack.length > 0;
    const canUndoFilter = CensorState.filterActionUndoStack.length > 0;
    const canRedoFilter = CensorState.filterActionRedoStack.length > 0;
    const canUndo = canUndoFilter || canUndoCanvas || canUndoProxy;
    const canRedo = canRedoFilter || canRedoCanvas || canRedoProxy;

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
        const proxySnapshot = Boolean(snapshot.beforeOperations || snapshot.afterOperations);
        if (direction === 'undo') {
            item.currentDataUrl = proxySnapshot ? null : (snapshot.beforeDataUrl || null);
            item.previewDataUrl = snapshot.beforePreviewDataUrl || null;
            item.editOperations = cloneEditOperations(snapshot.beforeOperations || []);
            item.isModified = Boolean(snapshot.beforeModified);
        } else {
            item.currentDataUrl = proxySnapshot ? null : (snapshot.afterDataUrl || null);
            item.previewDataUrl = snapshot.afterPreviewDataUrl || null;
            item.editOperations = cloneEditOperations(snapshot.afterOperations || []);
            item.isModified = Boolean(snapshot.afterModified);
        }
    }

    renderQueue();
    if (CensorState.activeId && entry.targetIds?.includes(CensorState.activeId)) {
        await loadCanvasImage(CensorState.activeId);
    }
    updateUndoRedoButtons();
}

// v3.3.2 UX: while the editor has no image loaded, hide the editing chrome
// (toolbar + footer status/zoom bars) via a class on .censor-main-v2 so the
// "select an image" card is the clear focus instead of a wall of disabled
// tools — same idea as the Reader empty-state. The loaded layout is unchanged
// (class present => all chrome shows exactly as before). The sidebars are left
// alone: the left queue is how images arrive, and an e2e test asserts the
// right detection panel stays measurable in the empty state.
function setCensorEditorHasImage(hasImage) {
    const main = document.querySelector('.censor-main-v2');
    if (main) main.classList.toggle('censor-has-image', !!hasImage);
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
    setCensorEditorHasImage(false);
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
        window.App.showToast(
            censorT('censor.cloneSourceSet', null, 'Clone source set. Paint to clone now.'),
            'info'
        );
        CensorState.isDrawing = false;
        return;
    }

    if (isProxyEditActive()) {
        if (CensorState.currentTool === 'clone' && !CensorState.cloneSourceSet) {
            CensorState.isDrawing = false;
            return;
        }
        const originalPoint = toOriginalPoint({ x, y });
        const operation = createStrokeOperationFromCurrentState(CensorState.currentTool);
        operation.points.push(originalPoint);
        if (CensorState.currentTool === 'clone' && CensorState.cloneSourceSet) {
            const originalCloneSource = toOriginalPoint(CensorState.cloneSource);
            operation.clone_offset = {
                x: originalCloneSource.x - originalPoint.x,
                y: originalCloneSource.y - originalPoint.y,
            };
        }
        CensorState.activeStrokeOperation = operation;
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
        const point = {
            x: CensorState.lastPoint.x + (x - CensorState.lastPoint.x) * t,
            y: CensorState.lastPoint.y + (y - CensorState.lastPoint.y) * t,
        };
        if (isProxyEditActive() && CensorState.activeStrokeOperation) {
            CensorState.activeStrokeOperation.points.push(toOriginalPoint(point));
        }
        drawAtPoint(point.x, point.y);
    }
    CensorState.lastPoint = { x, y };
}

async function onCanvasMouseUp() {
    if (!isCensorViewActive()) return;

    const wasDrawing = CensorState.isDrawing;
    CensorState.isDrawing = false;

    if (!wasDrawing || !CensorState.activeId) return;

    if (isProxyEditActive()) {
        const item = getActiveCensorItem();
        if (!item || !CensorState.activeStrokeOperation?.points?.length) {
            CensorState.activeStrokeOperation = null;
            updateUndoRedoButtons();
            return;
        }
        item.editOperations = [...(item.editOperations || []), CensorState.activeStrokeOperation];
        item.isModified = true;
        item.currentDataUrl = null;
        CensorState.operationRedoStack = [];
        CensorState.lastHistorySource = 'operation';
        CensorState.activeStrokeOperation = null;
        try {
            await redrawProxyCanvasFromOperations(item);
        } catch (error) {
            Logger.error('Failed to redraw proxy censor preview:', error);
        }
        updateUndoRedoButtons();
        renderQueue();
        return;
    }

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
    const size = getCanvasBrushSize();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);

    if (CensorState.currentTool === 'brush') {
        const effectScale = getCurrentLogicalToCanvasScale();
        applyCensorStyle(ctx, x, y, size, {
            blockSize: scaleOperationEffectValue(CensorState.blockSize || 16, effectScale, effectScale),
            blurRadius: scaleOperationEffectValue(Math.max(8, CensorState.blockSize || 16), effectScale, effectScale),
        });
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
        }
    } else if (CensorState.currentTool === 'clone') {
        if (!CensorState.cloneSourceSet) {
            // Clone source not set - show hint
            ctx.restore();
            return;
        }
        performClone(ctx, x, y, size);
    }

    ctx.restore();
}

function applyCensorStyle(ctx, x, y, size, options = {}) {
    const style = options.style || CensorState.style;
    const b = Math.max(1, Number(options.blockSize || CensorState.blockSize || 16));
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
        const blurRadius = Math.max(1, Number(options.blurRadius || Math.max(8, CensorState.blockSize)));
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

function performClone(ctx, x, y, size, options = {}) {
    const cloneSource = options.cloneSource || CensorState.cloneSource;
    let cloneOffset = options.cloneOffset || CensorState.cloneOffset;
    const sourceImage = options.sourceImage || CensorState.originalImage;
    if (!cloneSource && !cloneOffset) return;

    if (!cloneOffset && cloneSource) {
        cloneOffset = { x: cloneSource.x - x, y: cloneSource.y - y };
        if (!options.cloneOffset) {
            CensorState.cloneOffset = cloneOffset;
        }
    }
    if (!cloneOffset) return;

    const sourceX = x + cloneOffset.x;
    const sourceY = y + cloneOffset.y;

    ctx.clip();
    // Draw directly from current canvas state (or original? usually current)
    // Actually cloning usually samples from same layer.
    // To simplify: Clone samples from a snapshot of the canvas taken at start of stroke?
    // For now: Clone from original image for simplicity (allows "repair" using clean parts)
    if (sourceImage) {
        drawScaledSourceCrop(
            ctx,
            sourceImage,
            {
                x: sourceX - size / 2,
                y: sourceY - size / 2,
                width: size,
                height: size,
            },
            {
                x: x - size / 2,
                y: y - size / 2,
                width: size,
                height: size,
            }
        );
    }
}

// ============== Auto Censor Logic ==============

async function runAutoCensorBatch() {
    const { showToast } = window.App;
    if (!hasCensorQueueWork()) {
        showToast(censorT('censor.queueEmpty', null, 'Queue is empty'), 'error');
        return;
    }

    const executionPlan = await resolveQuickAutoCensorExecutionPlan();
    if (!executionPlan?.ok) {
        showToast(executionPlan?.message || censorT('censor.quickAutoStartFailed', null, 'Quick Auto Censor could not start.'), 'warning');
        return;
    }

    const tracker = window.App.createProgressTracker();

    _resetBatchStatus();
    showLoading(true, censorT('censor.autoCensorPreparing', null, 'Auto Censor · preparing queue...'));

    let count = 0;
    const result = await processCensorBatchItems(async (item, { index, total }) => {
        showLoading(true, window.App.buildProgressText({
            progress: { message: item.originalFilename || item.outputFilename || `Image ${item.id}` },
            completed: index,
            total,
            tracker,
            defaultMessage: censorT('censor.autoCensorRunning', null, 'Running auto-censor...'),
            primaryLabel: censorT('censor.autoCensorPrimary', null, 'Auto Censor')
        }));
        await runDetectionForImage(item, true, executionPlan); // true = silent/no-refresh
        count += 1;
    });

    showLoading(false);
    renderQueue();
    // Reload canvas if active item was updated
    if (CensorState.activeId) loadCanvasImage(CensorState.activeId);
    showToast(
        executionPlan.switchMessage
            ? censorT('censor.batchProcessingCompleteAutoRestored', null, 'Batch processing complete. The app auto-restored the privacy detector before running.')
            : censorT('censor.batchProcessingComplete', { count, total: result.total }, 'Batch processing complete'),
        'success'
    );
}

async function runDetectionForImage(item, silent = false, executionPlan = null) {
    try {
        let reloadedActiveItem = false;
        const plan = executionPlan || await resolveQuickAutoCensorExecutionPlan({ silent });
        if (!plan?.ok) {
            item.regions = [];
            item.currentDataUrl = null;
            item.previewDataUrl = null;
            item.editOperations = [];
            item.isProcessed = false;
            if (!silent && item.id === CensorState.activeId) {
                loadCanvasImage(item.id);
                window.App.showToast(
                    plan?.message || censorT('censor.quickAutoStartFailed', null, 'Quick Auto Censor could not start.'),
                    'warning'
                );
            }
            return;
        }

        const detectBody = {
            image_id: item.id,
            model_path: plan.modelPath,
            model_type: plan.modelType,
            confidence_threshold: CensorState.confidence,
            target_classes: plan.targetClasses,
        };
        if (plan.modelType === 'sam3') {
            const customInput = document.getElementById('sam3-custom-prompt')?.value?.trim();
            if (customInput) {
                detectBody.text_prompts = customInput.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        const data = await window.App.API.post('/api/censor/detect', detectBody);

        const useBoxShape = CensorState.maskShape === 'box';
        const rawRegions = [...(data.detections || [])].sort((a, b) => b.confidence - a.confidence);
        // "Box" shape mode: drop the model's polygon/mask geometry so censoring
        // follows rectangles instead of the precise pixel outline.
        const regions = useBoxShape
            ? rawRegions.map((r) => {
                const { polygon, mask, ...rest } = r;
                return rest;
            })
            : rawRegions;
        item.regions = regions;

        // Precise was requested but a seg-capable model returned only boxes
        // (e.g. a plain detect-only YOLO file): nudge the user toward a -seg model.
        const anyPolygon = regions.some((r) => Array.isArray(r.polygon) && r.polygon.length >= 3);
        const segCapableModel = plan.modelType === 'legacy' || plan.modelType === 'both';
        if (!silent && !useBoxShape && segCapableModel && regions.length > 0 && !anyPolygon) {
            window.App.showToast(
                censorT('censor.maskShapeBoxOnly', null, 'This YOLO model returns boxes only (not a segmentation model). Use a -seg model like Wenaka for precise shapes.'),
                'info'
            );
        }

        const { maskRegions, boxRegions } = splitDetectionGeometry(regions);
        const combinedMaskSource = {
            mask: useBoxShape ? null : (data.combined_mask || null),
            mask_ref: useBoxShape ? null : (data.combined_mask_ref || null),
            mask_bounds: (!useBoxShape && Array.isArray(data.combined_mask_bounds)) ? cloneNumberArray(data.combined_mask_bounds) : null,
            image_width: data.image_width,
            image_height: data.image_height,
        };
        const shouldUseMask = Boolean(combinedMaskSource.mask || combinedMaskSource.mask_ref) && maskRegions.length > 0;
        const shouldUseBoxes = boxRegions.length > 0;

        if (shouldUseProxyEditMode(item)) {
            if (shouldUseMask || shouldUseBoxes) {
                item.editOperations = [{
                    kind: 'geometry_effect',
                    style: CensorState.style,
                    block_size: Number(CensorState.blockSize || 16),
                    blur_radius: Math.max(1, Math.round(CensorState.blockSize / 2)),
                    regions,
                }];
                item.currentDataUrl = null;
                item.isProcessed = true;
                if (item.id === CensorState.activeId) {
                    await loadCanvasImage(item.id);
                    reloadedActiveItem = true;
                } else {
                    await renderProxyPreviewDataForItem(item);
                }
            } else {
                item.editOperations = [];
                item.previewDataUrl = null;
                item.currentDataUrl = null;
                item.isProcessed = false;
                item.isModified = false;
                if (item.id === CensorState.activeId) {
                    await loadCanvasImage(item.id);
                    reloadedActiveItem = true;
                }
            }
        } else {
            // Apply to a temporary canvas to generate DataURL
            const img = await loadImage(item.originalUrl);
            const cvs = document.createElement('canvas');
            cvs.width = img.width;
            cvs.height = img.height;
            const ctx = cvs.getContext('2d');
            ctx.drawImage(img, 0, 0);

            if (shouldUseMask) {
                const maskOperation = createMaskEffectOperation(combinedMaskSource);
                await applyMaskOperationToCanvas(cvs, img, maskOperation, 1, 1);
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
            item.previewDataUrl = null;
        }

        if (!silent && item.id === CensorState.activeId) {
            if (!reloadedActiveItem) {
                await loadCanvasImage(item.id);
            }
            if (regions.length === 0) {
                window.App.showToast(
                    censorT('censor.noMatchingRegionsHint', null, 'No matching regions were found. Try lowering confidence or changing the model.'),
                    'info'
                );
            } else {
                const usedMask = shouldUseMask;
                window.App.showToast(
                    usedMask && shouldUseBoxes
                        ? censorT('censor.autoCensorAppliedMixed', { count: regions.length }, 'Applied mixed auto-censor to {count} region(s)')
                        : (usedMask
                            ? censorT('censor.autoCensorAppliedMask', { count: regions.length }, 'Applied auto-censor mask to {count} matched region(s)')
                            : censorT('censor.autoCensorAppliedBoxes', { count: regions.length }, 'Applied box-based auto-censor to {count} region(s)')),
                    'success'
                );
            }
        }

    } catch (e) {
        Logger.error(e);
        if (!silent) {
            window.App.showToast(
                formatUserError(e, censorT('censor.detectFailed', null, 'Detection failed')),
                'error'
            );
        }
    }
}

function applyBoxRegionsToCanvas(canvas, baseImage, regions, options = {}) {
    const ctx = canvas.getContext('2d');
    const style = options.style || CensorState.style;
    const blockSize = Math.max(1, Number(options.blockSize || CensorState.blockSize || 16));
    const blurRadius = Math.max(1, Number(options.blurRadius || Math.max(1, Math.round(CensorState.blockSize / 2))));
    ctx.save();
    regions.forEach(r => {
        if (!Array.isArray(r?.box) || r.box.length !== 4) return;
        const [x1, y1, x2, y2] = r.box;
        const w = x2 - x1;
        const h = y2 - y1;

        if (style === 'mosaic') {
            const b = blockSize;
            for (let bx = x1; bx < x2; bx += b) {
                for (let by = y1; by < y2; by += b) {
                    const bw = Math.min(b, x2 - bx);
                    const bh = Math.min(b, y2 - by);
                    const d = ctx.getImageData(bx, by, bw, bh);
                    ctx.fillStyle = getAverageColor(d);
                    ctx.fillRect(bx, by, bw, bh);
                }
            }
        } else if (style === 'blur') {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1, y1, w, h);
            ctx.clip();
            ctx.filter = `blur(${blurRadius}px)`;
            ctx.drawImage(baseImage, 0, 0);
            ctx.restore();
        } else if (style === 'white_bar') {
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

async function renderRasterMaskEffectOntoCanvas(canvas, maskDataUrl, options = {}) {
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    const maskImage = await normalizeMaskDataUrl(maskDataUrl);
    const maskCanvas = createWorkingCanvas(canvas.width, canvas.height);
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
    renderMaskStyleToCanvas(canvas, maskCanvas, {
        style: options.style || CensorState.style,
        blockSize: Math.max(1, Number(options.blockSize || CensorState.blockSize || 16)),
        blurRadius: Math.max(1, Number(options.blurRadius || Math.max(1, Math.round(CensorState.blockSize / 2)))),
        originalImage: options.originalImage || CensorState.originalImage,
    });
}

function buildCensorMaskCacheUrl(maskRef, width = null, height = null) {
    const token = String(maskRef || '').trim();
    if (!token) return '';
    const params = new URLSearchParams();
    if (Number.isFinite(width) && width > 0) {
        params.set('width', String(Math.max(1, Math.round(width))));
    }
    if (Number.isFinite(height) && height > 0) {
        params.set('height', String(Math.max(1, Math.round(height))));
    }
    const query = params.toString();
    return `/api/censor/mask-cache/${encodeURIComponent(token)}${query ? `?${query}` : ''}`;
}

function createMaskEffectOperation(maskSource) {
    const operation = {
        kind: 'mask_effect',
        style: CensorState.style,
        block_size: Number(CensorState.blockSize || 16),
        blur_radius: Math.max(1, Math.round(CensorState.blockSize / 2)),
    };

    if (typeof maskSource === 'string') {
        operation.mask_data = maskSource;
        return operation;
    }

    if (maskSource?.mask) {
        operation.mask_data = maskSource.mask;
    }
    if (maskSource?.mask_ref) {
        operation.mask_ref = String(maskSource.mask_ref);
        if (Array.isArray(maskSource?.mask_bounds) && maskSource.mask_bounds.length === 4) {
            operation.mask_bounds = cloneNumberArray(maskSource.mask_bounds);
        }
        const imageWidth = Number(maskSource?.image_width || 0);
        const imageHeight = Number(maskSource?.image_height || 0);
        if (Number.isFinite(imageWidth) && imageWidth > 0) {
            operation.mask_image_width = imageWidth;
        }
        if (Number.isFinite(imageHeight) && imageHeight > 0) {
            operation.mask_image_height = imageHeight;
        }
    }
    return operation;
}

function getMaskOperationCanvasBounds(operation, scaleX = 1, scaleY = 1, canvas = null) {
    if (!Array.isArray(operation?.mask_bounds) || operation.mask_bounds.length !== 4) return null;
    const targetCanvas = canvas instanceof HTMLCanvasElement ? canvas : null;
    const maxWidth = targetCanvas?.width || Number.POSITIVE_INFINITY;
    const maxHeight = targetCanvas?.height || Number.POSITIVE_INFINITY;
    const rawX1 = Number(operation.mask_bounds[0] || 0) * scaleX;
    const rawY1 = Number(operation.mask_bounds[1] || 0) * scaleY;
    const rawX2 = Number(operation.mask_bounds[2] || 0) * scaleX;
    const rawY2 = Number(operation.mask_bounds[3] || 0) * scaleY;
    const x1 = Math.max(0, Math.floor(rawX1));
    const y1 = Math.max(0, Math.floor(rawY1));
    const x2 = Math.min(maxWidth, Math.ceil(rawX2));
    const y2 = Math.min(maxHeight, Math.ceil(rawY2));
    if (!(x2 > x1) || !(y2 > y1)) return null;
    return {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
        x1,
        y1,
        x2,
        y2,
    };
}

async function loadMaskImageForOperation(operation, canvasBounds = null) {
    if (operation?.mask_data) {
        return normalizeMaskDataUrl(operation.mask_data);
    }
    if (!operation?.mask_ref) {
        return null;
    }
    const maskUrl = buildCensorMaskCacheUrl(
        operation.mask_ref,
        canvasBounds?.width || null,
        canvasBounds?.height || null
    );
    if (!maskUrl) {
        return null;
    }
    return loadImage(maskUrl);
}

async function applyRasterMaskToActiveCanvas(maskSource) {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('No editable canvas is ready');
    }

    const activeItem = CensorState.queue.find(i => i.id === CensorState.activeId);
    const operation = createMaskEffectOperation(maskSource);
    if (isProxyEditActive() && activeItem) {
        activeItem.editOperations = [
            ...(activeItem.editOperations || []),
            operation,
        ];
        activeItem.isProcessed = true;
        activeItem.isModified = true;
        CensorState.operationRedoStack = [];
        CensorState.lastHistorySource = 'operation';
        await loadCanvasImage(activeItem.id);
        renderQueue();
        return;
    }

    const logical = activeItem
        ? getCensorItemLogicalDimensions(activeItem, canvas.width, canvas.height)
        : { width: canvas.width, height: canvas.height };
    const scaleX = logical.width > 0 ? (canvas.width / logical.width) : 1;
    const scaleY = logical.height > 0 ? (canvas.height / logical.height) : 1;
    await applyMaskOperationToCanvas(canvas, CensorState.originalImage, operation, scaleX, scaleY);
    const committedState = pushUndoState();
    saveCurrentCanvasToState(committedState);

    if (activeItem) {
        activeItem.isProcessed = true;
    }
    renderQueue();
}

async function segmentCurrentImageByText() {
    if (!CensorState.activeId) {
        window.App.showToast(censorT('censor.noImageSelected', null, 'No image selected'), 'error');
        return;
    }

    const textPrompt = String(document.getElementById('censor-text-prompt')?.value || '').trim();
    if (!textPrompt) {
        window.App.showToast(
            censorT('censor.textPromptRequired', null, 'Enter a text prompt first'),
            'warning'
        );
        return;
    }

    showLoading(true, censorT('censor.loadingSegmentText', {
        prompt: textPrompt,
    }, 'SAM3 text segment · {prompt}'));
    try {
        const result = await window.App.API.post('/api/censor/segment-text', {
            image_id: CensorState.activeId,
            text_prompt: textPrompt,
        });

        if (!result?.mask && !result?.mask_ref) {
            window.App.showToast(
                result?.message || censorT('censor.sam3NoMatch', null, 'No matching regions were found'),
                'info'
            );
            return;
        }

        await applyRasterMaskToActiveCanvas(result);
        window.App.showToast(
            censorT('censor.sam3Applied', {
                prompt: textPrompt,
            }, 'Applied SAM3 mask for "{prompt}"'),
            'success'
        );
    } catch (error) {
        window.App.showToast(
            formatUserError(error, censorT('censor.sam3SegmentFailed', null, 'SAM3 text segmentation failed')),
            'error'
        );
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
        help.textContent = censorT('censor.renameWholeQueueHelp', null, 'Nothing is selected right now, so the whole queue will be renamed.');
        return;
    }

    help.textContent = checkbox.checked
        ? censorT('censor.renameSelectedOnlyHelp', { count: selectedCount }, 'Only the {count} selected queue item(s) will be renamed. The rest stay untouched.')
        : censorT('censor.renameWholeQueueSelectedHelp', { count: selectedCount }, 'You have {count} selected item(s), but this preview is still targeting the whole queue.');
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
            <span>${escape(censorT('censor.renameCurrentColumn', null, 'Current'))}</span>
            <span>${escape(censorT('censor.renameNewColumn', null, 'New name'))}</span>
        </div>
        ${rowHtml || `
            <div class="rename-preview-row">
                <span>${escape(censorT('censor.renameNoQueueItems', null, 'No queue items yet'))}</span>
                <span>${escape(censorT('censor.renamePreviewPlaceholder', null, 'Preview will appear here'))}</span>
            </div>
        `}
    `;

    const selectedCount = getOrderedSelectedQueueIds().length;
    const previewScope = document.getElementById('rename-only-selected')?.checked && selectedCount > 0
        ? censorT('censor.renamePreviewSelected', { count: targets.length }, 'Previewing {count} selected item(s).')
        : censorT('censor.renamePreviewQueue', { count: targets.length }, 'Previewing {count} queue item(s).');
    const extensionNote = censorT('censor.renameExtensionNote', null, ' Final export extension still follows Save Options.');
    previewSummary.textContent = `${previewScope}${extensionNote}`;

    if (duplicateCount > 0) {
        previewAlert.className = 'rename-preview-alert is-warning';
        previewAlert.textContent = censorT(
            'censor.renameDuplicateNamesPreview',
            { count: duplicateCount },
            'Duplicate output names detected in this preview ({count} conflict group(s)). Fix the pattern before applying.'
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
        window.App.showToast(censorT('censor.renameNoTargets', null, 'No queue items to rename'), 'error');
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
            censorT('censor.renameDuplicateNamesBlocked', null, 'Rename blocked because the preview still contains duplicate output names.'),
            'error'
        );
        return;
    }

    targets.forEach((item, index) => {
        item.outputFilename = plannedNames[index];
    });

    renderQueue();
    closeCensorModal('rename-modal');

    // Refresh current title if viewing
    if (CensorState.activeId) {
        const item = CensorState.queue.find(i => i.id === CensorState.activeId);
        if (item) document.getElementById('censor-filename').textContent = item.outputFilename;
    }

    window.App.showToast(
        censorT('censor.renamedCount', { count: targets.length }, 'Renamed {count} image(s)'),
        'success'
    );
}

function openSaveOptionsPopup() {
    if (!hasCensorQueueWork()) {
        window.App.showToast(censorT('censor.noImagesToSave', null, 'No images in queue to save'), 'error');
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

    const allowOverwrite = document.getElementById('save-allow-overwrite');
    if (allowOverwrite) {
        allowOverwrite.checked = false;
    }

    document.getElementById('save-options-modal')?.classList.add('visible');
}

async function confirmAndSaveAll() {
    // Read options from popup
    const folder = document.getElementById('save-output-folder')?.value;
    const metadataOption = document.getElementById('save-metadata-option')?.value || 'strip';
    const formatOption = document.getElementById('save-format-option')?.value || 'png';
    const allowOverwrite = Boolean(document.getElementById('save-allow-overwrite')?.checked);

    if (!folder) {
        window.App.showToast(
            censorT('censor.outputFolderRequired', null, 'Please specify an output folder'),
            'error'
        );
        return;
    }

    // Save settings
    CensorState.outputFolder = folder;
    CensorState.metadataOption = metadataOption;
    CensorState.outputFormat = formatOption;
    localStorage.setItem('censor_output_folder', folder);

    // Close popup and start saving
    document.getElementById('save-options-modal')?.classList.remove('visible');

    await saveAllProcessed(formatOption, metadataOption, allowOverwrite);
}

function markGalleryRefreshAfterCensorSave(result) {
    if (!result?.overwrote_indexed_path && !result?.reconciled_image_id) return;

    if (window.App?.markGalleryNeedsRefresh) {
        window.App.markGalleryNeedsRefresh();
    }
}

async function saveCensorQueueItem(item, formatOption = 'png', metadataOption = 'strip', allowOverwrite = false) {
    const folder = CensorState.outputFolder;
    const baseName = item.outputFilename.replace(/\.[^/.]+$/, '');
    const finalFilename = `${baseName}.${formatOption}`;

    if (shouldUseProxyEditMode(item) || (Array.isArray(item.editOperations) && item.editOperations.length > 0)) {
        const result = await window.App.API.post('/api/censor/save-operations', {
            original_image_id: item.id,
            operations: item.editOperations || [],
            filename: finalFilename,
            output_folder: folder,
            metadata_option: metadataOption,
            output_format: formatOption,
            allow_overwrite: allowOverwrite,
        });
        markGalleryRefreshAfterCensorSave(result);
        return result;
    }

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

    const result = await window.App.API.post('/api/censor/save-data', {
        image_data: dataUrl,
        filename: finalFilename,
        output_folder: folder,
        metadata_option: metadataOption,
        output_format: formatOption,
        original_image_id: item.id,
        allow_overwrite: allowOverwrite,
    });
    markGalleryRefreshAfterCensorSave(result);
    return result;
}

async function saveAllProcessed(formatOption = 'png', metadataOption = 'strip', allowOverwrite = false) {
    const folder = CensorState.outputFolder;
    if (!folder) {
        window.App.showToast(
            censorT('censor.outputFolderSetupFirst', null, 'Set output folder in Rename or Setup first'),
            'error'
        );
        return;
    }

    _resetBatchStatus();
    const tracker = window.App.createProgressTracker();
    showLoading(true, censorT('censor.loadingSavePreparing', null, 'Save · preparing files...'));

    let count = 0;
    let failedCount = 0;
    await processCensorBatchItems(async (item, { index, total }) => {
        try {
            showLoading(true, window.App.buildProgressText({
                progress: { message: item.outputFilename || item.originalFilename || `Image ${item.id}` },
                completed: index,
                total,
                tracker,
                defaultMessage: censorT('censor.loadingSaveDefault', null, 'Saving processed images...'),
                primaryLabel: censorT('censor.loadingSavePrimary', null, 'Save')
            }));

            await saveCensorQueueItem(item, formatOption, metadataOption, allowOverwrite);
            item.batchStatus = 'saved';
            count++;
        } catch (e) {
            Logger.error(e);
            item.batchStatus = 'failed';
            item.batchError = `${censorT('censor.saveFailed', null, 'Save failed')}: ${e?.message || e || ''}`.trim();
            failedCount += 1;
        }
    });

    showLoading(false);
    renderQueue();
    failedCount = Math.max(failedCount, _summarizeBatchFailures().failedCount);
    if (failedCount > 0) {
        window.App.showToast(
            censorT('censor.savePartial', {
                count,
                failedCount,
            }, 'Saved {count} images · {failedCount} failed (red-outlined thumbnails)'),
            'warning'
        );
    } else {
        window.App.showToast(
            censorT('censor.saveSuccess', { count, folder }, 'Saved {count} images to {folder}'),
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
        window.App.showToast(censorT('censor.noImageSelected', null, 'No image selected'), 'error');
        return;
    }

    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (!item) return;

    const currentName = item.outputFilename || item.filename || 'image.png';
    const newName = await window.App.showInputModal(
        censorT('censor.renameDialogTitle', null, 'Rename File'),
        censorT('censor.renameDialogMessage', null, 'Enter the new filename:'),
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
        window.App.showToast(
            censorT('censor.renamedTo', {
                name: finalName,
            }, 'Renamed to "{name}"'),
            'success'
        );
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
    let visualSize = getCanvasBrushSize();

    if (canvas && canvas.width > 0 && CensorState.activeId) {
        const canvasRect = canvas.getBoundingClientRect();
        const scale = canvasRect.width / canvas.width;
        visualSize = getCanvasBrushSize() * scale;
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

async function restoreCanvasSnapshot(canvas, serializedState) {
    const ctx = canvas.getContext('2d');
    if (isOriginalCanvasState(serializedState)) {
        restoreOriginalImageToCanvas(canvas);
        return;
    }

    try {
        if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
            const response = await fetch(serializedState);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            if (typeof bitmap.close === 'function') {
                bitmap.close();
            }
            return;
        }
    } catch (error) {
        Logger.warn('Falling back to Image() canvas restore:', error);
    }

    await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(null);
        };
        img.onerror = reject;
        img.src = serializedState;
    });
}


async function undo() {
    if (CensorState.lastHistorySource === 'filter' && CensorState.filterActionUndoStack.length > 0) {
        const entry = CensorState.filterActionUndoStack.pop();
        CensorState.filterActionRedoStack.push(entry);
        await restoreFilterActionEntry(entry, 'undo');
        return;
    }

    if (isProxyEditActive()) {
        const item = getActiveCensorItem();
        if (!item?.editOperations?.length) return;
        const operation = item.editOperations.pop();
        CensorState.operationRedoStack.push(operation);
        await loadCanvasImage(item.id);
        CensorState.lastHistorySource = 'operation';
        updateUndoRedoButtons();
        return;
    }

    // Keep at least 1 item in the stack (the initial/base state)
    if (CensorState.undoStack.length <= 1) return;
    const current = CensorState.undoStack.pop(); // Discard current state
    CensorState.redoStack.push(current);
    const prev = CensorState.undoStack[CensorState.undoStack.length - 1]; // Peek at previous
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas) return;

    await restoreCanvasSnapshot(canvas, prev);
    saveCurrentCanvasToState(prev);
    CensorState.lastHistorySource = 'canvas';
    updateUndoRedoButtons();
}

async function redo() {
    if (CensorState.lastHistorySource === 'filter' && CensorState.filterActionRedoStack.length > 0) {
        const entry = CensorState.filterActionRedoStack.pop();
        CensorState.filterActionUndoStack.push(entry);
        await restoreFilterActionEntry(entry, 'redo');
        return;
    }

    if (isProxyEditActive()) {
        const item = getActiveCensorItem();
        if (!item || !CensorState.operationRedoStack.length) return;
        const operation = CensorState.operationRedoStack.pop();
        item.editOperations = [...(item.editOperations || []), operation];
        await loadCanvasImage(item.id);
        CensorState.lastHistorySource = 'operation';
        updateUndoRedoButtons();
        return;
    }

    if (!CensorState.redoStack.length) return;
    const next = CensorState.redoStack.pop();
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    if (!canvas) return;

    await restoreCanvasSnapshot(canvas, next);
    CensorState.undoStack.push(next);
    saveCurrentCanvasToState(next);
    CensorState.lastHistorySource = 'canvas';
    updateUndoRedoButtons();
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
        window.App.showToast(censorT('censor.queueSelectedAll', null, 'Selected the whole queue'), 'info');
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

    const currentIndex = CensorState.queue.findIndex(item => item.id === getFocusedCensorImageId());
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
    if (!CensorState.activeId || !CensorState.originalImage) return;

    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    restoreOriginalImageToCanvas(canvas);

    // Clear modified flag
    const item = CensorState.queue.find(i => i.id === CensorState.activeId);
    if (item) {
        item.isModified = false;
        item.currentDataUrl = null;
        item.previewDataUrl = null;
        item.editOperations = [];
    }

    const restoredState = CENSOR_ORIGINAL_STATE_TOKEN;
    CensorState.baseCanvasState = restoredState;
    CensorState.baseItemState = {
        currentDataUrl: null,
        previewDataUrl: null,
        editOperations: [],
        isModified: false
    };
    CensorState.undoStack = [restoredState];
    CensorState.redoStack = [];
    CensorState.operationRedoStack = [];
    CensorState.activeStrokeOperation = null;
    CensorState.lastHistorySource = isProxyEditActive() ? 'operation' : 'canvas';
    updateUndoRedoButtons();
    renderQueue();

    window.App.showToast(
        censorT('censor.editsCleared', null, 'Edits cleared. Image restored to the original.'),
        'success'
    );
}

function toggleShowChanges() {
    const canvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const ctx = canvas.getContext('2d');
    const btn = document.getElementById('btn-show-changes');

    if (!CensorState.activeId || !CensorState.originalImage) {
        window.App.showToast(censorT('censor.noImageToCompare', null, 'No image to compare'), 'error');
        return;
    }

    if (CensorState.activeImagePixels > getCensorShowChangesPixelThreshold()) {
        window.App.showToast(
            censorT('censor.showChangesDisabledLargeImage', null, 'Show Changes is disabled for large images to avoid browser freezes'),
            'warning'
        );
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
        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = canvas.width;
        originalCanvas.height = canvas.height;
        const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
        originalCtx.drawImage(CensorState.originalImage, 0, 0, canvas.width, canvas.height);
        const originalData = originalCtx.getImageData(0, 0, canvas.width, canvas.height).data;
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
        window.App.showToast(
            censorT('censor.showChangesOn', null, 'Changed areas highlighted in red'),
            'info'
        );
    }
}

async function runDetectionForAll() {
    const { showToast } = window.App;
    if (!hasCensorQueueWork()) {
        showToast(censorT('censor.queueEmpty', null, 'Queue is empty'), 'error');
        return;
    }

    const executionPlan = await resolveQuickAutoCensorExecutionPlan();
    if (!executionPlan?.ok) {
        showToast(executionPlan?.message || censorT('censor.quickAutoStartFailed', null, 'Quick Auto Censor could not start.'), 'warning');
        return;
    }

    _resetBatchStatus();
    const tracker = window.App.createProgressTracker();
    showLoading(true, censorT('censor.loadingDetectPreparing', null, 'Detect All · preparing queue...'));
    let count = 0;
    let failedCount = 0;

    const result = await processCensorBatchItems(async (item, { index, total }) => {
        try {
            showLoading(true, window.App.buildProgressText({
                progress: { message: item.originalFilename || item.outputFilename || `Image ${item.id}` },
                completed: index,
                total,
                tracker,
                defaultMessage: censorT('censor.loadingDetectDefault', null, 'Running detection...'),
                primaryLabel: censorT('censor.loadingDetectPrimary', null, 'Detect All')
            }));
            await runDetectionForImage(item, true, executionPlan);
            item.batchStatus = 'detected';
            count++;
        } catch (e) {
            Logger.error('Detection error for', item.id, e);
            item.batchStatus = 'failed';
            item.batchError = `${censorT('censor.detectFailed', null, 'Detection failed')}: ${e?.message || e || ''}`.trim();
            failedCount += 1;
        }
    });

    showLoading(false);
    renderQueue();
    if (CensorState.activeId) loadCanvasImage(CensorState.activeId);
    failedCount = Math.max(failedCount, _summarizeBatchFailures().failedCount);
    const total = result.total;
    if (failedCount > 0) {
        showToast(
            censorT('censor.detectPartial', {
                count,
                total,
                failedCount,
            }, 'Detection: {count}/{total} processed · {failedCount} failed (red-outlined thumbnails)'),
            'warning'
        );
    } else {
        showToast(
            executionPlan.switchMessage
                ? censorT('censor.detectCompleteAutoRestored', { count, total }, 'Detection complete: {count}/{total} images processed. The app auto-restored the privacy detector first.')
                : censorT('censor.detectComplete', { count, total }, 'Detection complete: {count}/{total} images processed'),
            'success'
        );
    }
}


async function runSam3BatchRefine() {
    const { showToast } = window.App;
    if (CensorState.queue.length === 0) {
        showToast(censorT('censor.queueEmpty', null, 'Queue is empty'), 'error');
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
            censorT('censor.noDetectionBoxesFound', null, 'No detection boxes found. Run detection first, then use SAM3 to refine the masks.'),
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

    showLoading(true, censorT('censor.loadingSam3Batch', {
        current: 0,
        total: batchItems.length,
    }, 'SAM3 Batch Refine · {current}/{total}'));

    try {
        const result = await window.App.API.post('/api/censor/batch-refine-mask', {
            items: batchItems,
            sam3_confidence: CensorState.sam3Confidence,
        });

        showLoading(false);

        const refinedIds = new Set();
        const failedErrorById = new Map();
        for (const refined of result.results || []) {
            if (refined.status === 'ok' && (refined.mask || refined.mask_ref)) {
                refinedIds.add(refined.image_id);
            } else {
                failedErrorById.set(
                    refined.image_id,
                    refined.error || censorT('censor.maskRefineNoResult', null, 'Mask refine returned no result')
                );
            }
        }

        if (result.completed > 0) {
            // Apply refined masks back to queue items
            for (const refined of result.results) {
                if (refined.status !== 'ok' || (!refined.mask && !refined.mask_ref)) continue;
                const item = CensorState.queue.find(i => i.id === refined.image_id);
                if (!item) continue;

                // Apply mask to this item's canvas
                try {
                    const operation = createMaskEffectOperation(refined);
                    if (shouldUseProxyEditMode(item)) {
                        item.editOperations = [
                            ...(item.editOperations || []),
                            operation,
                        ];
                        item.currentDataUrl = null;
                        await renderProxyPreviewDataForItem(item);
                    } else {
                        const img = await loadImage(item.currentDataUrl || item.originalUrl);
                        const cvs = document.createElement('canvas');
                        cvs.width = img.width;
                        cvs.height = img.height;
                        const ctx = cvs.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        await applyMaskOperationToCanvas(cvs, img, operation, 1, 1);
                        item.currentDataUrl = cvs.toDataURL('image/png');
                    }
                    item.isProcessed = true;
                    item.batchStatus = 'refined';
                } catch (maskErr) {
                    Logger.error('Failed to apply SAM3 mask for item', refined.image_id, maskErr);
                    refinedIds.delete(refined.image_id);
                    failedErrorById.set(
                        refined.image_id,
                        `${censorT('censor.maskApplyFailed', null, 'Mask apply failed')}: ${maskErr?.message || ''}`.trim()
                    );
                }
            }
        }

        CensorState.queue.forEach((item) => {
            if (!includedIds.has(item.id)) return;
            if (failedErrorById.has(item.id)) {
                item.batchStatus = 'failed';
                item.batchError = `${censorT('censor.sam3RefineFailed', null, 'SAM3 refine failed')}: ${failedErrorById.get(item.id)}`;
            }
        });

        renderQueue();
        if (CensorState.activeId) loadCanvasImage(CensorState.activeId);

        const refinedCount = result.refined ?? result.completed;
        const fallbackCount = result.fallback ?? 0;
        showToast(
            censorT('censor.sam3BatchComplete', {
                refined: refinedCount,
                fallback: fallbackCount,
                failed: result.failed,
                total: result.total,
            }, 'SAM3 Batch Refine: {refined} refined, {fallback} kept as box, {failed} failed (of {total} boxes)'),
            (result.failed > 0 || fallbackCount > 0) ? 'warning' : 'success'
        );
    } catch (e) {
        showLoading(false);
        Logger.error('SAM3 Batch Refine error:', e);
        CensorState.queue.forEach((item) => {
            if (!includedIds.has(item.id)) return;
            item.batchStatus = 'failed';
            item.batchError = `${censorT('censor.sam3BatchAborted', null, 'SAM3 batch aborted')}: ${e?.message || e || ''}`.trim();
        });
        renderQueue();
        showToast(
            formatUserError(e, censorT('censor.sam3BatchRefineFailed', null, 'SAM3 Batch Refine failed')),
            'error'
        );
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

    if (boundHandlers.resize) {
        window.removeEventListener('resize', boundHandlers.resize);
        boundHandlers.resize = null;
        clearTimeout(_resizeDebounceTimer);
    }

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
        ctx.filter = buildFilterCssParts(currentFilters).join(' ');
        ctx.drawImage(img, 0, 0);

        if (currentFilters.sharpen > 0) {
            applySharpenToCanvasPixels(canvas, currentFilters.sharpen / 100);
        }
        if (currentFilters.vignette > 0) {
            applyVignetteToCanvasPixels(canvas, currentFilters.vignette / 100);
        }

        return canvas.toDataURL('image/png');
    }

    async function bakeFiltersToTargets(targetIds) {
        if (!Array.isArray(targetIds) || targetIds.length === 0) {
            window.App?.showToast?.(censorT('censor.noTargetImagesSelected', null, 'No target images selected'), 'warning');
            return;
        }

        if (!hasFilterChanges()) {
            window.App?.showToast?.(censorT('censor.noFilterChanges', null, 'No filter changes to apply'), 'info');
            return;
        }

        showLoading(true, censorT('censor.filterApplyBatchLoading', { count: targetIds.length }, 'Filter · applying to {count} image(s)...'));
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
                const beforeModified = Boolean(item.isModified);
                if (shouldUseProxyEditMode(item)) {
                    const beforeOperations = cloneEditOperations(item.editOperations || []);
                    const beforePreviewDataUrl = item.previewDataUrl || null;
                    item.editOperations = [
                        ...(item.editOperations || []),
                        {
                            kind: 'filter',
                            values: { ...currentFilters },
                        },
                    ];
                    await renderProxyPreviewDataForItem(item);
                    historyEntry.snapshots.push({
                        id: targetId,
                        beforeDataUrl: null,
                        beforePreviewDataUrl,
                        beforeOperations,
                        beforeModified,
                        afterDataUrl: null,
                        afterPreviewDataUrl: item.previewDataUrl || null,
                        afterOperations: cloneEditOperations(item.editOperations || []),
                        afterModified: Boolean(item.isModified),
                    });
                } else {
                    const sourceUrl = item.currentDataUrl || item.originalUrl;
                    const beforeDataUrl = item.currentDataUrl || null;
                    item.currentDataUrl = await renderFilteredDataUrlFromUrl(sourceUrl);
                    item.isModified = true;
                    historyEntry.snapshots.push({
                        id: targetId,
                        beforeDataUrl,
                        beforeModified,
                        afterDataUrl: item.currentDataUrl || null,
                        afterModified: Boolean(item.isModified),
                    });
                }
                applied += 1;
            }

            renderQueue();
            if (CensorState.activeId && targetIds.includes(CensorState.activeId)) {
                await loadCanvasImage(CensorState.activeId);
            }

            setSliders(FILTER_DEFAULTS);
            pushFilterActionHistory(historyEntry);
            window.App?.showToast?.(censorT('censor.filtersAppliedCount', { count: applied }, 'Applied filters to {count} image(s)'), 'success');
        } finally {
            showLoading(false);
        }
    }

    async function bakeFiltersToCanvas() {
        const canvas = getActiveCanvas();
        if (!canvas || !CensorState.activeId) {
            window.App?.showToast?.(censorT('censor.noImageLoaded', null, 'No image loaded — select an image first'), 'warning');
            return;
        }

        if (!hasFilterChanges()) {
            window.App?.showToast?.(censorT('censor.noFilterChanges', null, 'No filter changes to apply'), 'info');
            return;
        }

        // Check canvas has actual content
        if (canvas.width === 0 || canvas.height === 0) {
            window.App?.showToast?.(censorT('censor.canvasEmpty', null, 'Canvas is empty — load an image first'), 'warning');
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
                beforePreviewDataUrl: activeItem.previewDataUrl || null,
                beforeOperations: cloneEditOperations(activeItem.editOperations || []),
                beforeModified: Boolean(activeItem.isModified),
                afterDataUrl: null,
                afterPreviewDataUrl: null,
                afterOperations: [],
                afterModified: true,
            }] : [],
        };

        if (isProxyEditActive() && activeItem) {
            canvas.style.filter = 'none';
            activeItem.editOperations = [
                ...(activeItem.editOperations || []),
                {
                    kind: 'filter',
                    values: { ...currentFilters },
                },
            ];
            activeItem.currentDataUrl = null;
            activeItem.isModified = true;
            CensorState.operationRedoStack = [];
            await loadCanvasImage(CensorState.activeId);
            if (historyEntry.snapshots[0]) {
                historyEntry.snapshots[0].afterPreviewDataUrl = activeItem.previewDataUrl || null;
                historyEntry.snapshots[0].afterOperations = cloneEditOperations(activeItem.editOperations || []);
                historyEntry.snapshots[0].afterModified = Boolean(activeItem.isModified);
            }
            invalidatePreFilterSnapshot();
            setSliders(FILTER_DEFAULTS);
            pushFilterActionHistory(historyEntry);
            window.App?.showToast?.(
                censorT('censor.canvasFiltersApplied', null, 'Filters applied to canvas'),
                'success'
            );
            return;
        }

        const destCtx = canvas.getContext('2d');
        destCtx.clearRect(0, 0, canvas.width, canvas.height);
        destCtx.drawImage(tmpCanvas, 0, 0);

        // Apply sharpen if needed
        if (currentFilters.sharpen > 0) {
            applySharpenToCanvasPixels(canvas, currentFilters.sharpen / 100);
        }

        // Apply vignette if needed
        if (currentFilters.vignette > 0) {
            applyVignetteToCanvasPixels(canvas, currentFilters.vignette / 100);
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
        window.App?.showToast?.(
            censorT('censor.canvasFiltersApplied', null, 'Filters applied to canvas'),
            'success'
        );
    }

    function applySharpen(canvas, amount) {
        applySharpenToCanvasPixels(canvas, amount);
    }

    function applyVignette(canvas, amount) {
        applyVignetteToCanvasPixels(canvas, amount);
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
    window.__censorHasPendingFilterPreview = hasFilterChanges;
})();
