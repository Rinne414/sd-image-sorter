/**
 * Censor Editor - drawing tools (split VERBATIM from censor-edit.js; god-file decomposition).
 * Canvas mouse handlers, drawAtPoint/applyCensorStyle, clone tool, cursor overlay, tool selection, keyboard map (handleKeydown).
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
// ============== Drawing Tools ==============

function onCanvasMouseDown(e) {
    if (!CensorState.activeId) return;
    // Don't start drawing if space is held (pan mode)
    if (spacePressed) return;

    const point = getCanvasPointerCoordinates(e);
    if (!point) {
        updateCursorOverlay(e);
        return;
    }

    focusCanvasWrapperWithoutScroll();
    CensorState.isDrawing = true;

    const { x, y } = point;
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

    const point = getCanvasPointerCoordinates(e);
    if (!point) {
        CensorState.lastPoint = null;
        return;
    }

    const { x, y } = point;
    if (!CensorState.lastPoint) {
        if (isProxyEditActive() && CensorState.activeStrokeOperation) {
            CensorState.activeStrokeOperation.points.push(toOriginalPoint(point));
        }
        drawAtPoint(x, y);
        CensorState.lastPoint = { x, y };
        return;
    }

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
    const canvas = getActiveCensorCanvas();
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };

    // Account for CSS scaling
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function getActiveCensorCanvas() {
    return document.getElementById(CensorState.activeCanvasId || 'censor-canvas');
}

function isPointerInsideRect(e, rect) {
    if (!e || !rect || !rect.width || !rect.height) return false;
    return e.clientX >= rect.left
        && e.clientX <= rect.right
        && e.clientY >= rect.top
        && e.clientY <= rect.bottom;
}

function getCanvasPointerCoordinates(e) {
    const canvas = getActiveCensorCanvas();
    if (!canvas || !CensorState.activeId) return null;
    const rect = canvas.getBoundingClientRect();
    if (!isPointerInsideRect(e, rect)) return null;
    return getCanvasCoordinates(e);
}

function focusCanvasWrapperWithoutScroll() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper || typeof wrapper.focus !== 'function') return;
    try {
        wrapper.focus({ preventScroll: true });
    } catch (_) {
        wrapper.focus();
    }
}

function getElementViewportToCssScale(element, rect = null) {
    if (!element) return { x: 1, y: 1 };
    const bounds = rect || element.getBoundingClientRect();
    return {
        x: bounds.width ? (element.offsetWidth / bounds.width) : 1,
        y: bounds.height ? (element.offsetHeight / bounds.height) : 1,
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

// ============== Helpers ==============

function setTool(tool) {
    // Special handling for remove-bg: trigger action immediately instead of entering drawing mode
    if (tool === 'remove-bg') {
        showRemoveBackgroundPreview();
        return;
    }

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

    const canvas = getActiveCensorCanvas();
    if (!canvas || !CensorState.activeId) {
        cursor.style.display = 'none';
        return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    if (!isPointerInsideRect(e, canvasRect)) {
        cursor.style.display = 'none';
        return;
    }

    // clientX/clientY and getBoundingClientRect() are viewport coordinates.
    // Under root CSS zoom, writing those values back as CSS px zooms them a
    // second time, so convert viewport pixels into wrapper-local CSS pixels.
    const rect = wrapper.getBoundingClientRect();
    const wrapperScale = getElementViewportToCssScale(wrapper, rect);
    const x = (e.clientX - rect.left) * wrapperScale.x;
    const y = (e.clientY - rect.top) * wrapperScale.y;

    // Visible only if inside wrapper
    if (x < 0 || y < 0 || x > wrapper.offsetWidth || y > wrapper.offsetHeight) {
        cursor.style.display = 'none';
        return;
    }

    cursor.style.display = 'block';

    // Calculate visual size based on canvas scaling
    let visualSize = getCanvasBrushSize();

    if (canvas.width > 0) {
        const scale = canvasRect.width / canvas.width;
        visualSize = getCanvasBrushSize() * scale * wrapperScale.x;
    }

    cursor.style.width = `${visualSize}px`;
    cursor.style.height = `${visualSize}px`;
    // Position at mouse location - use transform for centering (set in CSS)
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
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
    } else if (key === 'r') {
        setTool('remove-bg');
        e.preventDefault();
    }
    // Rename shortcut (F2) — R is taken by Remove Background above, so the
    // rename button's "(R)" tooltip used to advertise a key that did nothing.
    else if (e.key === 'F2') {
        promptSingleRename();
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

