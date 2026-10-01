/**
 * Marker rings for the nearest-picture lookup (S4c): a pool of camera-facing
 * sprites over the point cloud. The query point is a large filled amber disc,
 * a near neighbour a thin amber ring, a far one (below the weak threshold) a
 * grey dashed ring. Sprites are reused between lookups; the ones not needed
 * are hidden, never destroyed, so repeated drops allocate nothing.
 */
import * as THREE from '../vendor/three/three.module.js';

const TEXTURE_SIZE = 128;
const QUERY_SCALE = 6.5; // x the dot size
const NEAR_SCALE = 4;
// On a 50k map the dots are tiny; a ring never gets smaller than this (world
// units; the cloud spans about 2) so it stays easy to find.
const QUERY_MIN_SIZE = 0.1;
const NEAR_MIN_SIZE = 0.055;
const RENDER_ORDER = 9; // under the hover ring (10)

export const RING_KINDS = ['query', 'near', 'far'];

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/** One texture per kind, drawn once on a canvas. */
function drawTexture(kind, accent, muted) {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    const centre = TEXTURE_SIZE / 2;
    ctx.beginPath();
    if (kind === 'query') {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.38;
        ctx.arc(centre, centre, centre - 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.arc(centre, centre, centre - 8, 0, Math.PI * 2);
        ctx.stroke();
    } else {
        ctx.strokeStyle = kind === 'far' ? muted : accent;
        ctx.lineWidth = kind === 'far' ? 7 : 6;
        if (kind === 'far') ctx.setLineDash([12, 10]);
        ctx.arc(centre, centre, centre - 8, 0, Math.PI * 2);
        ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export class RingPool {
    constructor(scene) {
        this.scene = scene;
        const accent = cssVar('--accent', '#C8873C');
        const muted = cssVar('--muted', '#8A8A90');
        this.materials = Object.fromEntries(RING_KINDS.map((kind) => [
            kind,
            new THREE.SpriteMaterial({
                map: drawTexture(kind, accent, muted),
                transparent: true,
                depthTest: false,
            }),
        ]));
        this.sprites = [];
        this.items = [];
    }

    /**
     * Show `items` ({kind, x, y, z}) at world size `dotSize` times the kind's
     * scale; every sprite beyond the list is hidden.
     */
    show(items, dotSize) {
        this.items = items.map((item) => ({ ...item }));
        items.forEach((item, index) => {
            const sprite = this.spriteAt(index);
            sprite.material = this.materials[item.kind] || this.materials.near;
            sprite.position.set(item.x, item.y, item.z);
            const isQuery = item.kind === 'query';
            const size = Math.max(dotSize * (isQuery ? QUERY_SCALE : NEAR_SCALE), isQuery ? QUERY_MIN_SIZE : NEAR_MIN_SIZE);
            sprite.scale.set(size, size, 1);
            sprite.visible = true;
        });
        for (let i = items.length; i < this.sprites.length; i += 1) this.sprites[i].visible = false;
    }

    clear() {
        this.items = [];
        for (const sprite of this.sprites) sprite.visible = false;
    }

    spriteAt(index) {
        while (this.sprites.length <= index) {
            const sprite = new THREE.Sprite(this.materials.near);
            sprite.renderOrder = RENDER_ORDER;
            sprite.visible = false;
            this.scene.add(sprite);
            this.sprites.push(sprite);
        }
        return this.sprites[index];
    }

    /** What is drawn now (for tests and the card): kind and position per ring. */
    describe() {
        return this.items.map((item, index) => ({ ...item, visible: this.sprites[index]?.visible === true }));
    }
}
