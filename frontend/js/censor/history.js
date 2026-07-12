/**
 * Censor Editor - undo/redo history (split VERBATIM from censor-edit.js; god-file decomposition).
 * Canvas snapshot stack, operation redo stack, filter-action history and arbitration between the three, clear-all-edits reset.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
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

