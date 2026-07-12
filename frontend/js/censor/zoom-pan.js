/**
 * Censor Editor - zoom + pan (split VERBATIM from censor-edit.js; god-file decomposition).
 * Zoom controls, space-drag panning, full censor view cleanup.
 * Shared top-level bindings (CensorState, ...) are declared in censor/state.js;
 * classic-script global lexical scoping keeps them single instances across parts.
 * Load order is pinned in index.html - see censor/state.js for the full note.
 */
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

