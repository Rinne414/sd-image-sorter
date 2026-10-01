/**
 * Box selection on the point cloud. Everything is done in normalised canvas
 * coordinates (u, v in 0..1, v down) so the CSS zoom the app applies on large
 * screens (ui-scale.js) cannot skew the box or the dots.
 *
 * Shift + left-drag draws a rectangle; the toolbar's "box select" switch
 * (for trackpad users) makes a plain left-drag do the same. Both go through
 * `begin()`. The pointerdown listener runs in the capture phase and stops the
 * event, because OrbitControls reads Shift / Ctrl + left button as a pan:
 * right-drag pan, wheel zoom and a plain left-drag rotate stay untouched.
 * Shift + click on a dot toggles that dot. Esc cancels a drag in progress.
 */
import * as THREE from '../vendor/three/three.module.js';

const CLICK_SLOP_PX = 4; // a drag shorter than this is a click
const PICK_RADIUS_PX = 9; // a Shift+click reaches a dot this close

const PROJECTION = new THREE.Matrix4();

/**
 * Where each dot lands on the canvas: 3 floats per dot (u, v, visible).
 * `visible` is 0 for a dot behind the camera or outside the near / far
 * planes (nothing is drawn there, so nothing can be picked there).
 */
export function projectPoints(positions, count, camera, out = new Float32Array(count * 3)) {
    camera.updateMatrixWorld();
    PROJECTION.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = PROJECTION.elements;
    for (let i = 0; i < count; i += 1) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        const depth = (m[2] * x + m[6] * y + m[10] * z + m[14]) / (w || 1);
        const at = i * 3;
        if (w <= 0 || depth < -1 || depth > 1) {
            out[at + 2] = 0;
            continue;
        }
        out[at] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2;
        out[at + 1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2;
        out[at + 2] = 1;
    }
    return out;
}

/** Indices of the visible dots inside the rectangle (corners in any order). */
export function dotsInRect(projected, count, a, b) {
    const left = Math.min(a.u, b.u);
    const right = Math.max(a.u, b.u);
    const top = Math.min(a.v, b.v);
    const bottom = Math.max(a.v, b.v);
    const hits = [];
    for (let i = 0; i < count; i += 1) {
        const at = i * 3;
        if (!projected[at + 2]) continue;
        const u = projected[at];
        const v = projected[at + 1];
        if (u >= left && u <= right && v >= top && v <= bottom) hits.push(i);
    }
    return hits;
}

/** The visible dot closest to (u, v) within `radiusPx` on a width x height canvas; -1 for none. */
export function nearestDot(projected, count, point, { width, height, radiusPx = PICK_RADIUS_PX }) {
    let best = -1;
    let bestDistance = radiusPx * radiusPx;
    for (let i = 0; i < count; i += 1) {
        const at = i * 3;
        if (!projected[at + 2]) continue;
        const dx = (projected[at] - point.u) * width;
        const dy = (projected[at + 1] - point.v) * height;
        const distance = dx * dx + dy * dy;
        if (distance <= bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}

export class BoxSelector {
    /**
     * @param canvas  the scene's canvas
     * @param scene   StyleMapScene (camera, geometry, count)
     * @param handlers {onBox(indices), onToggle(index), onModeChange(armed)}
     */
    constructor(canvas, scene, handlers = {}) {
        this.canvas = canvas;
        this.scene = scene;
        this.onBox = handlers.onBox || (() => {});
        this.onToggle = handlers.onToggle || (() => {});
        this.onModeChange = handlers.onModeChange || (() => {});
        this.armed = false;
        this.drag = null;
        this.box = document.createElement('div');
        this.box.className = 'stylemap-lasso';
        this.box.hidden = true;
        this.box.setAttribute('aria-hidden', 'true');
        canvas.parentElement?.append(this.box);
        canvas.addEventListener('pointerdown', (event) => this.pointerDown(event), true);
        canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
        canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
        canvas.addEventListener('pointercancel', () => this.cancel());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.drag) {
                event.preventDefault();
                this.cancel();
            }
        });
    }

    setArmed(armed) {
        this.armed = Boolean(armed);
        this.canvas.classList.toggle('is-box-select', this.armed);
        this.onModeChange(this.armed);
    }

    /** Canvas-relative position of a pointer event as 0..1 fractions. */
    locate(event) {
        const rect = this.canvas.getBoundingClientRect();
        const clamp = (value) => Math.min(1, Math.max(0, value));
        return {
            u: clamp((event.clientX - rect.left) / rect.width),
            v: clamp((event.clientY - rect.top) / rect.height),
        };
    }

    pointerDown(event) {
        if (event.button !== 0 || !(event.shiftKey || this.armed)) return;
        // Capture phase: keep OrbitControls from turning Shift / Ctrl + drag into a pan.
        event.stopImmediatePropagation();
        event.preventDefault();
        this.begin(event);
    }

    begin(event) {
        const start = this.locate(event);
        this.drag = { start, current: start, pointerId: event.pointerId, moved: false, shift: event.shiftKey };
        this.canvas.setPointerCapture?.(event.pointerId);
    }

    pointerMove(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        const rect = this.canvas.getBoundingClientRect();
        const current = this.locate(event);
        const { start } = this.drag;
        const travelled = Math.hypot((current.u - start.u) * rect.width, (current.v - start.v) * rect.height);
        this.drag.current = current;
        if (!this.drag.moved && travelled < CLICK_SLOP_PX) return;
        this.drag.moved = true;
        this.draw(start, current);
    }

    pointerUp(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        this.finish();
        const end = this.locate(event);
        const scene = this.scene;
        const positions = scene.geometry.getAttribute('position')?.array;
        if (!positions || scene.count === 0) return;
        const projected = projectPoints(positions, scene.count, scene.camera);
        if (drag.moved) {
            this.onBox(dotsInRect(projected, scene.count, drag.start, end));
            return;
        }
        // A click: Shift + click toggles the dot under the pointer; with the
        // switch armed a click on empty space does nothing.
        const index = nearestDot(projected, scene.count, end, {
            width: this.canvas.clientWidth,
            height: this.canvas.clientHeight,
        });
        if (index >= 0) this.onToggle(index);
    }

    draw(a, b) {
        const style = this.box.style;
        style.left = `${Math.min(a.u, b.u) * 100}%`;
        style.top = `${Math.min(a.v, b.v) * 100}%`;
        style.width = `${Math.abs(b.u - a.u) * 100}%`;
        style.height = `${Math.abs(b.v - a.v) * 100}%`;
        this.box.hidden = false;
    }

    finish() {
        if (this.drag) this.canvas.releasePointerCapture?.(this.drag.pointerId);
        this.drag = null;
        this.box.hidden = true;
    }

    cancel() {
        this.finish();
    }
}
