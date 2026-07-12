/**
 * Censor Editor - shared state (split VERBATIM from censor-edit.js; god-file decomposition).
 *
 * The censor editor is a family of classic (non-module) scripts under
 * frontend/js/censor/, loaded in a pinned order by index.html. Top-level
 * const/let declarations in classic scripts live in the ONE shared global
 * lexical environment, so the mutable singletons declared here (CensorState,
 * boundHandlers, censorModelStatusPromise, censorEventsInitialized) are the
 * same single instances in every other censor/*.js part - exactly as they were
 * when all parts shared one file. This file must load FIRST in the family.
 */
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
    // Default to STRIP: this is a censor-for-publishing tool, so exporting the
    // full generation prompt/metadata by default was a privacy leak. Matches the
    // 'strip' fallback every save function already uses. Users can still pick
    // keep/minimal per export. ('keep', 'minimal', or 'strip')
    metadataOption: 'strip',
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

// An item carries real censoring worth saving (and worth an unsaved-work
// warning) when it has been rendered (isProcessed / currentDataUrl) OR holds
// proxy-mode edit operations — large-image strokes that persist via
// /save-operations rather than baked pixels, so isProcessed stays false while
// the edits are real. This is the single source of truth for "did the user
// actually censor this?"; keep saveAllProcessed and the beforeunload guard on it
// so the never-fallback-to-uncensored invariant never skips a real proxy stroke.
function itemHasCensorContent(item) {
    return Boolean(item && (
        item.isProcessed || item.currentDataUrl ||
        (Array.isArray(item.editOperations) && item.editOperations.length > 0)
    ));
}

// Guard flag to prevent duplicate event binding
let censorEventsInitialized = false;

