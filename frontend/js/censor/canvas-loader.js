/**
 * Censor Editor - canvas loading (split VERBATIM from censor-edit.js; god-file decomposition).
 * Double-buffer canvas swap (loadCanvasImage), fit/refit/resize, proxy-edit-mode decisions, show-changes compare, image/data-url loaders.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
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

// ============== Canvas & Editing ==============

// State for double buffering
CensorState.activeCanvasId = 'censor-canvas';
CensorState.isLoadingImage = false;
CensorState.activeImageLoadRequest = 0;

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
    // Show the filename immediately, not only inside the RAF swap below — a
    // superseded load request early-returns before the RAF write, which used to
    // leave the status bar stuck on the empty-state text.
    if (filenameEl && item) filenameEl.textContent = item.outputFilename || item.originalFilename || '';
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
            scheduleCensorCanvasRefit(nextCanvas.width, nextCanvas.height);
            if (typeof window.__updateCensorFilterPreview === 'function') {
                window.__updateCensorFilterPreview();
            }
            CensorState.isLoadingImage = false;
            if (proxyMode) {
                syncProxyItemPreviewFromCanvas(item, nextCanvas);
            }
            renderQueue();
            // Keep the 审核 conveyor in step with the newly active image (progress,
            // button states, stale-overlay clearing). No-op when its elements are
            // absent; cheap enough to run on every load.
            if (typeof updateCensorReviewPanel === 'function') updateCensorReviewPanel();
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
    if (!container || !(canvas instanceof HTMLCanvasElement)) return;

    // Get container dimensions (minus padding if any)
    const contW = container.clientWidth;
    const contH = container.clientHeight;
    if (contW <= 0 || contH <= 0 || imgW <= 0 || imgH <= 0) return;

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

function refitCensorCanvasPair(width = null, height = null) {
    const c1 = document.getElementById('censor-canvas');
    const c2 = document.getElementById('censor-canvas-buffer');
    const referenceCanvas = document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
    const refWidth = width || referenceCanvas?.width || CensorState.originalImage?.width || 0;
    const refHeight = height || referenceCanvas?.height || CensorState.originalImage?.height || 0;
    fitCanvasToContainer(c1, refWidth, refHeight);
    fitCanvasToContainer(c2, refWidth, refHeight);
    // Keep the review annotation overlay letterboxed like the content canvases
    // (only meaningful while it's showing detected regions).
    const overlay = document.getElementById('censor-review-overlay');
    if (overlay && overlay.style.opacity !== '0') {
        fitCanvasToContainer(overlay, refWidth, refHeight);
    }
}

function scheduleCensorCanvasRefit(width = null, height = null) {
    refitCensorCanvasPair(width, height);
    requestAnimationFrame(() => {
        refitCensorCanvasPair(width, height);
        applyZoom();
    });
    setTimeout(() => {
        refitCensorCanvasPair(width, height);
        applyZoom();
    }, 80);
    setTimeout(() => {
        refitCensorCanvasPair(width, height);
        applyZoom();
    }, 180);
}

// Re-fit on window resize (debounced, removable)
let _resizeDebounceTimer = null;
function _handleCensorResize() {
    clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = setTimeout(() => {
        if (CensorState.activeId && CensorState.originalImage) {
            refitCensorCanvasPair();
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
    // Localized empty state (the element no longer carries data-i18n, so JS owns
    // both the live filename and this reset text).
    document.getElementById('censor-filename').textContent = censorT('censor.noImageSelected', null, 'No image selected');
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

