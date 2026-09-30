/**
 * The 3-D point cloud: one THREE.Points draw call fed by typed arrays built
 * straight from the compact `points` rows, orbit controls, and a raycast
 * hover that reports the picture under the pointer. Dots are round sprites
 * (a small shader: size attenuates with distance, dots that stand for more
 * pictures are a little larger), the camera fits the cloud from an oblique
 * angle and refits when the canvas changes shape. Colours come from the
 * Graphite tokens; the hovered dot takes the accent (the focus meaning the
 * accent has everywhere else) plus a ring.
 */
import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

// World-unit dot size ~ 0.6 / sqrt(n): ~10 px dots with gaps at 500
// points on a 1920 canvas, ~1.5 px dots that still draw the shape at 50k.
const POINT_SIZE_COEFF = 0.6;
const MIN_POINT_SIZE = 0.008; // ~3 px at 50k points on a 1920 canvas
const MAX_POINT_SIZE = 0.035;
const FAR_ALPHA = 0.45; // dots at the back fade to this (depth cue)
const MEMBER_SIZE_BONUS = 0.4; // a dot standing for many pictures grows up to +40%
const MAX_MEMBERS = 65535;
const FIT_SHARE = 0.8; // the cloud spans ~80% of the canvas's short side
const FRAME_MAX_SHARE = 0.97; // outliers and the grid may reach this, never past the edge
const CORE_LOW = 0.02; // percentile box that counts as "the cloud" for the fit and the grid
const CORE_HIGH = 0.98;
const VIEW_DIRECTION = new THREE.Vector3(1, 0.5, 1.2).normalize();
const FOV = 50;

const VERTEX_SHADER = `
    attribute float size;
    attribute vec3 color;
    uniform float scale;
    uniform float fogNear;
    uniform float fogFar;
    varying vec3 vColor;
    varying float vFade;
    void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / -mv.z;
        // 0 at the front of the cloud, 1 at the back: the same grey reads
        // as near or far only with a depth cue.
        vFade = smoothstep(fogNear, fogFar, -mv.z);
        gl_Position = projectionMatrix * mv;
    }
`;

const FRAGMENT_SHADER = `
    uniform float farAlpha;
    varying vec3 vColor;
    varying float vFade;
    void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        float edge = 1.0 - smoothstep(0.40, 0.5, d);
        float depth = mix(1.0, farAlpha, vFade);
        gl_FragColor = vec4(vColor * mix(1.0, 0.75, vFade), edge * depth);
    }
`;

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function colorFrom(name, fallback) {
    try {
        return new THREE.Color(cssVar(name, fallback));
    } catch (_error) {
        return new THREE.Color(fallback);
    }
}

function basePointSize(count) {
    const size = POINT_SIZE_COEFF / Math.sqrt(Math.max(count, 1));
    return Math.min(MAX_POINT_SIZE, Math.max(MIN_POINT_SIZE, size));
}

/** A soft ring drawn once on a canvas: the hover marker's sprite texture. */
function ringTexture(color) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export class StyleMapScene {
    constructor(canvas, { onHover } = {}) {
        this.canvas = canvas;
        this.onHover = typeof onHover === 'function' ? onHover : () => {};
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.scene = new THREE.Scene();
        this.scene.background = colorFrom('--surface-1', '#151517');
        this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 0.2;
        this.controls.maxDistance = 20;

        this.baseColor = colorFrom('--text-2', '#A6A6AB');
        this.hoverColor = colorFrom('--accent', '#C8873C');
        this.ids = new Int32Array(0);
        this.members = new Uint16Array(0);
        this.count = 0;
        this.hovered = -1;
        this.center = new THREE.Vector3();
        this.radius = 1;

        this.geometry = new THREE.BufferGeometry();
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                scale: { value: 1 },
                fogNear: { value: 0 },
                fogFar: { value: 1 },
                farAlpha: { value: FAR_ALPHA },
            },
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
        });
        this.points = new THREE.Points(this.geometry, this.material);
        this.points.frustumCulled = false;
        this.scene.add(this.points);

        // A faint ground grid under the cloud (rebuilt per map by fitFrame,
        // hidden while there is nothing to place); its corners join the
        // camera fit so it never runs off the canvas.
        this.frame = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
            new THREE.LineBasicMaterial({ color: colorFrom('--border-strong', '#3A3A3E'), transparent: true, opacity: 0.5 }),
        );
        this.frame.visible = false;
        this.frameCorners = [];
        this.floorY = NaN;
        this.cloudTopY = NaN;
        this.core = null;
        this.scene.add(this.frame);

        this.ring = new THREE.Sprite(new THREE.SpriteMaterial({
            map: ringTexture(cssVar('--accent', '#C8873C')),
            transparent: true,
            depthTest: false,
        }));
        this.ring.renderOrder = 10;
        this.ring.visible = false;
        this.scene.add(this.ring);

        this.raycaster = new THREE.Raycaster();
        this.raycaster.params.Points.threshold = MAX_POINT_SIZE;
        this.pointer = new THREE.Vector2();
        this.pointerInside = false;
        this.pointerDirty = false;
        this.running = false;
        this.frameHandle = 0;
        this.aspect = 1;

        canvas.addEventListener('pointermove', (event) => {
            const rect = canvas.getBoundingClientRect();
            this.pointer.set(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1,
            );
            this.pointerInside = true;
            this.pointerDirty = true;
            this.requestRender();
        });
        canvas.addEventListener('pointerleave', () => {
            this.pointerInside = false;
            this.pointerDirty = true;
            this.requestRender();
        });
        // Frames are drawn only when something changed: a control event,
        // damping still settling, a hover change, new data or a resize.
        this.controls.addEventListener('change', () => this.requestRender());
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas.parentElement || canvas);
        this.resize();
        this.fitCamera({ keepDirection: false });
        this.controls.saveState();
    }

    /** Rows are the compact `points` arrays; `layout` names their columns. */
    setPoints(rows, layout) {
        const names = Array.isArray(layout) && layout.length ? layout : ['id', 'x', 'y', 'z', 'members'];
        const col = Object.fromEntries(names.map((name, index) => [name, index]));
        const count = rows.length;
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        const ids = new Int32Array(count);
        const members = new Uint16Array(count);
        const { r, g, b } = this.baseColor;
        const base = basePointSize(count);
        for (let i = 0; i < count; i += 1) {
            const row = rows[i];
            positions[i * 3] = row[col.x];
            positions[i * 3 + 1] = row[col.y];
            positions[i * 3 + 2] = row[col.z];
            colors[i * 3] = r;
            colors[i * 3 + 1] = g;
            colors[i * 3 + 2] = b;
            ids[i] = row[col.id];
            const group = Math.min(MAX_MEMBERS, row[col.members] || 1);
            members[i] = group;
            // +0..40% over 1..4 members, then flat: a dot never becomes a blob.
            sizes[i] = base * (1 + MEMBER_SIZE_BONUS * Math.min(group - 1, 3) / 3);
        }
        this.hovered = -1;
        this.ring.visible = false;
        this.ids = ids;
        this.members = members;
        this.sizes = sizes;
        this.count = count;
        // A fresh geometry per map; the old one's GPU buffers are freed.
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        const previous = this.geometry;
        this.geometry = geometry;
        this.points.geometry = geometry;
        previous.dispose();
        this.geometry.computeBoundingSphere();
        const sphere = this.geometry.boundingSphere;
        if (count > 0 && sphere && Number.isFinite(sphere.radius)) {
            this.center.copy(sphere.center);
            this.radius = Math.max(sphere.radius, 0.05);
        } else {
            this.center.set(0, 0, 0);
            this.radius = 1;
        }
        this.fitFrame(positions, count);
        this.raycaster.params.Points.threshold = base * 0.9;
        this.fitCamera({ keepDirection: false });
        this.controls.saveState();
        this.onHover(null);
        this.render();
        this.requestRender();
    }

    /**
     * Place the camera so the cloud's bounding sphere spans FIT_SHARE of the
     * canvas's short side. With `keepDirection` only the distance changes
     * (a resize must not throw away the user's rotation).
     */
    fitCamera({ keepDirection }) {
        const halfFov = THREE.MathUtils.degToRad(FOV) / 2;
        const shortHalfAngle = this.aspect >= 1 ? halfFov : Math.atan(Math.tan(halfFov) * this.aspect);
        let distance = this.radius / (Math.sin(shortHalfAngle) * FIT_SHARE);
        const direction = keepDirection && this.camera.position.distanceTo(this.controls.target) > 1e-6
            ? this.camera.position.clone().sub(this.controls.target).normalize()
            : VIEW_DIRECTION.clone();
        this.controls.target.copy(this.center);
        // Look at the middle of cloud + floor grid, not the cloud alone, so
        // the grid hanging below does not push the composition off the bottom.
        if (this.count > 0 && Number.isFinite(this.floorY)) {
            this.controls.target.y = (this.cloudTopY + this.floorY) / 2;
        }
        this.place(direction, distance);
        // The sphere overstates a flat or elongated cloud; measure how far
        // from the canvas centre the dots (and the grid corners) really reach
        // and tighten the distance (three passes: the projection is only
        // nearly linear in distance).
        for (let pass = 0; pass < 3 && this.count > 0; pass += 1) {
            const { cloud, all } = this.projectedReach();
            if (!cloud) break;
            // The dots aim at FIT_SHARE of the short side; the grid only sets
            // a ceiling (it must stay inside the canvas).
            distance *= Math.max(cloud / FIT_SHARE, all / FRAME_MAX_SHARE, 0.05);
            this.place(direction, distance);
        }
    }

    place(direction, distance) {
        this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
        this.camera.near = Math.max(0.01, distance / 100);
        this.camera.far = distance * 20 + 10;
        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld();
        this.controls.update();
    }

    /** The larger of the cloud's width / height as a share of the canvas (0..1+). */
    /** The frame box = the cloud's min/max per axis (a little padding). */
    fitFrame(positions, count) {
        this.frame.visible = count > 0;
        this.frameCorners = [];
        this.floorY = NaN;
        this.cloudTopY = NaN;
        if (count === 0) return;
        // The "cloud" is the central mass: a handful of outliers must not
        // stretch the floor grid or the camera fit (2nd-98th percentile).
        const min = [0, 0, 0];
        const max = [0, 0, 0];
        for (let axis = 0; axis < 3; axis += 1) {
            const values = new Float32Array(count);
            for (let i = 0; i < count; i += 1) values[i] = positions[i * 3 + axis];
            values.sort();
            min[axis] = values[Math.floor((count - 1) * CORE_LOW)];
            max[axis] = values[Math.ceil((count - 1) * CORE_HIGH)];
        }
        this.core = { min, max };
        // A faint ground grid under the cloud (its x/z extent, a little
        // padding) instead of a box: a box's corners project well past the
        // cloud and forced it small; a floor only adds a little width.
        const pad = 0.03;
        const x0 = min[0] - pad;
        const x1 = max[0] + pad;
        const z0 = min[2] - pad;
        const z1 = max[2] + pad;
        const y = min[1] - pad * 1.5;
        this.floorY = y;
        this.cloudTopY = max[1];
        const divisions = 10;
        const vertices = [];
        for (let step = 0; step <= divisions; step += 1) {
            const t = step / divisions;
            const x = x0 + (x1 - x0) * t;
            const z = z0 + (z1 - z0) * t;
            vertices.push(x, y, z0, x, y, z1); // lines along z
            vertices.push(x0, y, z, x1, y, z); // lines along x
        }
        this.frame.geometry.dispose();
        this.frame.geometry = new THREE.BufferGeometry();
        this.frame.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.frame.position.set(0, 0, 0);
        this.frameCorners = [
            new THREE.Vector3(x0, y, z0),
            new THREE.Vector3(x1, y, z0),
            new THREE.Vector3(x0, y, z1),
            new THREE.Vector3(x1, y, z1),
        ];
    }

    /** How far the cloud (and with the grid, everything) reaches from the canvas centre, in NDC (1 = edge). */
    projectedReach() {
        const positions = this.geometry.getAttribute('position');
        if (!positions || positions.count === 0) return 0;
        const v = new THREE.Vector3();
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        const take = () => {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
        };
        // Reach = the farthest NDC coordinate from the centre (containment),
        // not the extent's size: an off-centre composition can be small and
        // still run off one edge.
        const reach = () => Math.max(-minX, maxX, -minY, maxY);
        // First the central mass (what FIT_SHARE targets), then everything.
        const core = this.core;
        const inCore = (x, y, z) => !core
            || (x >= core.min[0] && x <= core.max[0] && y >= core.min[1] && y <= core.max[1] && z >= core.min[2] && z <= core.max[2]);
        const outliers = [];
        for (let i = 0; i < positions.count; i += 1) {
            const x = positions.getX(i);
            const y = positions.getY(i);
            const z = positions.getZ(i);
            if (!inCore(x, y, z)) {
                outliers.push(x, y, z);
                continue;
            }
            v.set(x, y, z).project(this.camera);
            take();
        }
        const cloud = reach();
        for (let i = 0; i < outliers.length; i += 3) {
            v.set(outliers[i], outliers[i + 1], outliers[i + 2]).project(this.camera);
            take();
        }
        for (const corner of this.frameCorners) {
            v.copy(corner).project(this.camera);
            take();
        }
        return { cloud, all: reach() };
    }

    resize() {
        const host = this.canvas.parentElement || this.canvas;
        const width = host.clientWidth;
        const height = host.clientHeight;
        if (!width || !height) return;
        this.renderer.setSize(width, height, false);
        this.aspect = width / height;
        this.camera.aspect = this.aspect;
        // world size -> pixels at distance 1 (perspective point sprites)
        this.material.uniforms.scale.value = (height * this.pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
        this.fitCamera({ keepDirection: true });
        this.render();
    }

    resetView() {
        this.controls.reset();
        this.fitCamera({ keepDirection: false });
        this.render();
    }

    resume() {
        if (this.running) return;
        this.running = true;
        this.resize();
        this.requestRender();
    }

    pause() {
        this.running = false;
        if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
        this.frameHandle = 0;
    }

    /** Draw one frame on the next tick (at most one is ever queued). */
    requestRender() {
        if (!this.running || this.frameHandle) return;
        this.frameHandle = requestAnimationFrame(() => this.drawFrame());
    }

    drawFrame() {
        this.frameHandle = 0;
        if (!this.running) return;
        // update() returns true while damping still moves the camera (and
        // fires 'change', which queues the next frame); a hover change or a
        // still-moving camera is the only reason to keep drawing.
        const moving = this.controls.update();
        if (this.pointerDirty) this.pick();
        this.render();
        if (moving) this.requestRender();
    }

    render() {
        // Depth cue spans the cloud: front of the bounding sphere -> back.
        const distance = this.camera.position.distanceTo(this.controls.target);
        this.material.uniforms.fogNear.value = Math.max(0.01, distance - this.radius);
        this.material.uniforms.fogFar.value = distance + this.radius;
        this.renderer.render(this.scene, this.camera);
    }

    pick() {
        this.pointerDirty = false;
        if (!this.pointerInside || this.count === 0) {
            this.setHover(-1);
            return;
        }
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObject(this.points, false);
        let best = -1;
        let bestDistance = Infinity;
        for (const hit of hits) {
            if (hit.distanceToRay < bestDistance) {
                bestDistance = hit.distanceToRay;
                best = hit.index;
            }
        }
        this.setHover(best);
    }

    setHover(index) {
        if (index === this.hovered) return;
        const colors = this.geometry.getAttribute('color');
        const positions = this.geometry.getAttribute('position');
        if (!colors || !positions) return;
        if (this.hovered >= 0) colors.setXYZ(this.hovered, this.baseColor.r, this.baseColor.g, this.baseColor.b);
        if (index >= 0) {
            colors.setXYZ(index, this.hoverColor.r, this.hoverColor.g, this.hoverColor.b);
            this.ring.position.set(positions.getX(index), positions.getY(index), positions.getZ(index));
            const ringSize = this.sizes[index] * 3.2;
            this.ring.scale.set(ringSize, ringSize, 1);
            this.ring.visible = true;
        } else {
            this.ring.visible = false;
        }
        colors.needsUpdate = true;
        this.hovered = index;
        this.canvas.style.cursor = index >= 0 ? 'pointer' : '';
        this.onHover(index >= 0 ? { id: this.ids[index], members: this.members[index] } : null);
    }
}
