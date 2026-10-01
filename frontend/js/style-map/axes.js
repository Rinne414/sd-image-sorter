/**
 * Axis meanings (slice S4e): what the two ends of each axis stand for.
 *
 * GET /api/style-map/axes answers, per axis x/y/z and per end, three
 * representative pictures and the tags that set the two ends apart (or
 * `weak` when nothing does). This module draws them twice:
 *   - short labels on the floor grid of the 3-D scene ("X  <- monochrome
 *     · lineart", "color · lighting ->"), an HTML overlay re-projected only
 *     when the camera moved, so they always face the viewer; a weak axis
 *     shows a faint dash instead of an invented label;
 *   - the "what the axes mean" card (axes-panel.js) with the pictures.
 * The request follows the map on screen (state.js nearRequest-style
 * `getRequest`); a `not_started` answer rebuilds the map once per user
 * action (armRetries), never in a loop.
 */
import * as THREE from '../vendor/three/three.module.js';
import { t } from './text.js';
import { AxesPanel } from './axes-panel.js';
import { CustomAxes } from './custom-axes.js';
import { CustomAxesView } from './custom-axes-view.js';

const STORAGE_KEY = 'sd-stylemap-axis-labels';
const AXES = ['x', 'y', 'z'];
const GRID_PAD = 0.03; // scene.js fitFrame pads the floor grid by this much
const EDGE_MARGIN = 6;
const LABEL_GAP = 8; // px between the grid edge and a label
const NUDGE_STEPS = 4;
const LABEL_TAGS = 2; // tags a label names (the card names up to three)
// Screen directions in 45-degree steps, counter-clockwise from "right".
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];

export function readLabelsPreference() {
    try {
        return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch (_error) {
        return true;
    }
}

export function writeLabelsPreference(on) {
    try {
        localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (_error) {
        // private window or blocked storage: the switch still works for this visit
    }
}

/**
 * Name of one axis tag: the language packs' curated name (stylemap.tag.<tag>,
 * every tag of the style list has one), else the English tag with underscores
 * read as spaces. Never a vocabulary alias: those mix in Japanese kanji.
 */
export function axisTagName(item) {
    const tag = String(item?.tag || '');
    const key = `stylemap.tag.${tag}`;
    const curated = t(key, '');
    if (curated && curated !== key) return curated;
    return tag.replace(/_\(medium\)$/, '').replace(/_/g, ' ');
}

/** What a label says for one end: its strongest tags, or null when it has none. */
export function endText(end, limit = LABEL_TAGS) {
    const tags = Array.isArray(end?.tags) ? end.tags.slice(0, limit) : [];
    return tags.length ? tags.map(axisTagName).join(' · ') : null;
}

/** The arrow glyph for a screen-space direction (y grows downward). */
export function arrowFor(dx, dy) {
    const turn = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4));
    return ARROWS[((turn % 8) + 8) % 8];
}

function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The six end labels on the scene's floor grid. */
class AxisLabels {
    constructor(card, scene) {
        this.scene = scene;
        this.layer = document.createElement('div');
        this.layer.className = 'stylemap-axis-labels';
        this.layer.hidden = true;
        // The card says the same in words; the overlay is a visual aid.
        this.layer.setAttribute('aria-hidden', 'true');
        // Right after the canvas: the landmark cards (added later) stay above.
        const canvas = card.querySelector('canvas');
        if (canvas) canvas.after(this.layer);
        else card.append(this.layer);
        this.items = [];
        this.data = null;
        this.layout = 'pca';
        this.visible = false;
        this.lastView = null;
        this.v = new THREE.Vector3();
    }

    setVisible(flag) {
        this.visible = Boolean(flag);
        this.layer.hidden = !this.visible || !this.items.length;
        if (this.visible && this.lastView) this.place(this.lastView);
    }

    /**
     * The user's own axes ({x: {a, b}} names of the two ends of every defined
     * axis) or null. While set, only those axes are labelled, with those names.
     */
    setCustom(names) {
        this.customNames = names || null;
    }

    /** New answer (or null: no labels). */
    setData(body, layout) {
        this.data = body?.axes ? body : null;
        this.layout = layout;
        this.items = [];
        this.layer.replaceChildren();
        const custom = this.customNames;
        if (custom || this.data) {
            for (const axis of AXES) {
                if (custom && !custom[axis]) continue;
                for (const end of ['low', 'high']) this.items.push(this.createLabel(axis, end));
            }
            this.layer.append(...this.items.map((item) => item.node));
        }
        this.layer.hidden = !this.visible || !this.items.length;
        if (this.lastView) this.place(this.lastView);
    }

    createLabel(axis, end) {
        const node = document.createElement('div');
        node.className = 'stylemap-axis-label';
        node.dataset.axis = axis;
        node.dataset.end = end;
        node.hidden = true;
        const key = document.createElement('span');
        key.className = 'stylemap-axis-key';
        key.textContent = axis.toUpperCase();
        const text = document.createElement('span');
        text.className = 'stylemap-axis-text';
        node.append(key, text);
        return { axis, end, node, text, content: null };
    }

    /** World anchors of the six labels on the grid scene.js drew, or null before a map. */
    anchors() {
        const { core, floorY, cloudTopY } = this.scene;
        if (!core || !Number.isFinite(floorY)) return null;
        const x0 = core.min[0] - GRID_PAD;
        const x1 = core.max[0] + GRID_PAD;
        const z0 = core.min[2] - GRID_PAD;
        const z1 = core.max[2] + GRID_PAD;
        const xm = (x0 + x1) / 2;
        const zm = (z0 + z1) / 2;
        return {
            center: [xm, (floorY + cloudTopY) / 2, zm],
            x: { low: [x0, floorY, zm], high: [x1, floorY, zm] },
            // The vertical axis stands on the grid's near-left corner.
            y: { low: [x0, floorY, z0], high: [x0, cloudTopY, z0] },
            z: { low: [xm, floorY, z0], high: [xm, floorY, z1] },
        };
    }

    project(xyz, view) {
        const { camera, width, height } = view;
        this.v.set(xyz[0], xyz[1], xyz[2]);
        const behind = this.v.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0;
        this.v.project(camera);
        return { x: ((this.v.x + 1) / 2) * width, y: ((1 - this.v.y) / 2) * height, behind };
    }

    /** Re-project every label; called when the camera, the canvas or the data changed. */
    place(view) {
        this.lastView = view;
        if (!this.visible || !this.items.length) return;
        const anchors = this.anchors();
        if (!anchors) {
            for (const item of this.items) item.node.hidden = true;
            return;
        }
        const centre = this.project(anchors.center, view);
        const placed = [];
        for (const item of this.items) {
            this.placeOne(item, anchors, centre, view, placed);
        }
    }

    placeOne(item, anchors, centre, view, placed) {
        const { node } = item;
        const other = item.end === 'low' ? 'high' : 'low';
        const here = this.project(anchors[item.axis][item.end], view);
        const there = this.project(anchors[item.axis][other], view);
        if (here.behind) {
            node.hidden = true;
            return;
        }
        this.writeText(item, arrowFor(here.x - there.x, here.y - there.y), here.x < there.x);
        node.hidden = false;
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        // Outside the grid: push away from the middle of the cloud along the
        // line through the anchor, by the label's own half extent plus a gap.
        let dx = here.x - centre.x;
        let dy = here.y - centre.y;
        const length = Math.hypot(dx, dy) || 1;
        dx /= length;
        dy /= length;
        const reach = Math.min(
            Math.abs(dx) > 1e-6 ? w / 2 / Math.abs(dx) : Infinity,
            Math.abs(dy) > 1e-6 ? h / 2 / Math.abs(dy) : Infinity,
        );
        const cx = here.x + dx * (reach + LABEL_GAP);
        const cy = here.y + dy * (reach + LABEL_GAP);
        const clamp = (value, size, room) => Math.min(Math.max(value, EDGE_MARGIN), Math.max(EDGE_MARGIN, room - size - EDGE_MARGIN));
        let rect = { x: clamp(cx - w / 2, w, view.width), y: clamp(cy - h / 2, h, view.height), w, h };
        rect = this.avoid(rect, placed, view);
        placed.push(rect);
        node.style.transform = `translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px)`;
    }

    /** Slide a label up or down until it clears the ones placed before it. */
    avoid(rect, placed, view) {
        if (!placed.some((other) => overlaps(rect, other))) return rect;
        for (let step = 1; step <= NUDGE_STEPS; step += 1) {
            for (const sign of [1, -1]) {
                const y = rect.y + sign * step * (rect.h + 4);
                const next = { ...rect, y };
                if (y >= EDGE_MARGIN && y + rect.h <= view.height - EDGE_MARGIN
                    && !placed.some((other) => overlaps(next, other))) return next;
            }
        }
        return rect;
    }

    /** The label's words: axis letter, a direction arrow, the end's strongest tags or a dash. */
    writeText(item, arrow, arrowLast) {
        if (this.customNames) {
            const names = this.customNames[item.axis];
            const name = (item.end === 'low' ? names?.a : names?.b)
                || (item.end === 'low' ? t('stylemap.customEndA', 'End A') : t('stylemap.customEndB', 'End B'));
            const text = arrowLast ? `${name} ${arrow}` : `${arrow} ${name}`;
            item.node.classList.remove('is-weak');
            item.node.classList.add('is-custom');
            if (item.content !== text) {
                item.text.textContent = text;
                item.content = text;
            }
            return;
        }
        const entry = this.data?.axes?.[item.axis];
        const words = entry?.weak ? null : endText(entry?.[item.end]);
        const content = words ? (arrowLast ? `${words} ${arrow}` : `${arrow} ${words}`) : '—';
        item.node.classList.toggle('is-weak', !words);
        const full = entry?.weak
            ? t('stylemap.axesWeak', 'The tags cannot name the difference along this axis; compare the pictures at both ends')
            : (entry?.[item.end]?.tags || []).map(axisTagName).join(' · ');
        const note = this.layout === 'umap'
            ? t('stylemap.axesUmapNote', 'UMAP: directions are not fixed, only distances mean something')
            : '';
        const title = [full, note].filter(Boolean).join('\n');
        if (item.content !== content) {
            item.text.textContent = content;
            item.content = content;
        }
        if (item.node.title !== title) item.node.title = title;
    }

    dispose() {
        this.layer.remove();
    }
}

export class StyleMapAxes {
    /**
     * `host.getRequest()` gives {query, signature, layout} for the map on
     * screen (null while there is none), `host.refreshMap()` asks for the
     * points again, `host.preview(id)` shows a picture in the preview pane,
     * `host.isActive()` tells whether the page is still on screen. `scene`
     * turns the camera.
     */
    constructor(root, host, scene) {
        this.host = host;
        this.scene = scene;
        this.toggleButton = root.querySelector('#stylemap-axes-toggle');
        this.labelsButton = root.querySelector('#stylemap-axes-labels-toggle');
        const card = root.querySelector('#stylemap-canvas-card');
        this.labels = new AxisLabels(card, scene);
        // The user's own axes (S4g): definitions, request and the card's tab.
        this.custom = new CustomAxes({ ...host.custom, reloadModel: () => this.mapChanged(), onChange: () => this.render() });
        this.customView = new CustomAxesView(this.custom, {
            hasSelection: () => host.custom.getSelection().length > 0,
        });
        this.panel = new AxesPanel(card, {
            pick: (id) => this.pick(id),
            retry: () => this.retry(),
            tagText: axisTagName,
            customView: this.customView,
            onClose: () => this.renderToggle(),
        });
        this.labelsOn = readLabelsPreference();
        this.labels.setVisible(this.labelsOn);
        this.status = 'idle'; // idle | loading | ok | error
        this.data = null;
        this.layout = 'pca';
        this.seq = 0;
        this.retried = false;
        this.toggleButton?.addEventListener('click', () => this.setOpen(!this.panel.open));
        this.labelsButton?.addEventListener('click', () => this.setLabelsOn(!this.labelsOn));
        this.renderToggle();
        this.render();
    }

    /** The user's own action re-arms the one rebuild a lost map gets. */
    armRetries() {
        this.retried = false;
        this.custom.armRetries();
    }

    /** The picked dots changed: the card's add buttons follow. */
    refreshSelection() {
        if (this.panel.open && this.panel.mode === 'custom') this.panel.paint();
    }

    setOpen(flag) {
        this.panel.setOpen(flag);
        this.renderToggle();
    }

    close() {
        this.setOpen(false);
    }

    setLabelsOn(on) {
        this.labelsOn = Boolean(on);
        writeLabelsPreference(this.labelsOn);
        this.labels.setVisible(this.labelsOn);
        this.render();
    }

    /** The button says the state it is in (rule 16). */
    renderToggle() {
        const button = this.toggleButton;
        if (!button) return;
        const open = this.panel.open;
        const key = open ? 'stylemap.axesButtonClose' : 'stylemap.axesButton';
        button.setAttribute('data-i18n', key);
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        button.classList.toggle('is-on', open);
        button.textContent = open ? t(key, 'Hide axis meanings') : t(key, 'Axis meanings');
    }

    /** The labels switch says the state it is in (rule 16), like the landmarks switch. */
    renderLabelsToggle() {
        const button = this.labelsButton;
        if (!button) return;
        const key = this.labelsOn ? 'stylemap.axesLabelsHide' : 'stylemap.axesLabelsShow';
        button.setAttribute('data-i18n', key);
        button.setAttribute('aria-pressed', this.labelsOn ? 'true' : 'false');
        button.textContent = t(key, this.labelsOn ? 'Hide axis labels' : 'Show axis labels');
    }

    /** Repaint every word from the current state (also on a language switch). */
    render() {
        this.renderToggle();
        this.renderLabelsToggle();
        const names = this.custom.names();
        this.panel.render({ status: this.status, data: this.data, layout: this.layout, customApplied: Boolean(names) });
        // Your own axes replace the model's labels on the grid, with your names.
        this.labels.setCustom(names);
        this.labels.setData(names || this.status !== 'ok' ? null : this.data, this.layout);
    }

    /** A new map is on screen (space, filter, PCA -> UMAP): ask for its axes. */
    mapChanged() {
        this.seq += 1;
        this.data = null;
        // Another library's definitions (and applied state) first: they decide what is asked for.
        this.custom.syncLibrary();
        if (this.custom.applied) {
            // The model's meanings describe the original layout: not asked for.
            this.status = 'idle';
            this.render();
            this.custom.mapChanged();
            return;
        }
        const request = this.host.getRequest();
        this.layout = request?.layout || 'pca';
        this.status = request ? 'loading' : 'idle';
        this.render();
        if (request) this.load(request);
    }

    retry() {
        this.retried = false;
        this.mapChanged();
    }

    async load(request) {
        const seq = this.seq;
        try {
            const body = await window.App.API.get(`/api/style-map/axes?${request.query}`);
            if (seq !== this.seq) return;
            if (!this.host.isActive()) {
                // Left the page meanwhile: coming back asks for the map again.
                this.status = 'idle';
                this.render();
                return;
            }
            if (body?.status === 'not_started') {
                // The server no longer holds this map: one rebuild per user
                // action (a points answer calls mapChanged again).
                if (!this.retried) {
                    this.retried = true;
                    await this.host.refreshMap();
                    return;
                }
                throw new Error('not_started');
            }
            if (body?.status === 'empty') {
                this.status = 'idle';
                this.data = null;
            } else if (body?.status === 'ok') {
                this.status = 'ok';
                this.data = body;
            } else {
                throw new Error(String(body?.status || 'bad answer'));
            }
        } catch (_error) {
            if (seq !== this.seq) return;
            this.status = 'error';
            this.data = null;
        }
        this.render();
    }

    /** World position of a picture's dot, or null when the map does not hold it. */
    positionOf(id) {
        const ids = this.scene.ids;
        const attribute = this.scene.geometry.getAttribute('position');
        if (!attribute) return null;
        for (let i = 0; i < ids.length; i += 1) {
            if (ids[i] === id) return [attribute.getX(i), attribute.getY(i), attribute.getZ(i)];
        }
        return null;
    }

    /** A picture of the card: show it in the preview and turn the camera to its dot. */
    pick(id) {
        this.host.preview(id);
        const position = this.positionOf(id);
        if (position) this.scene.flyTo(position, 380, { exact: true });
    }

    /** Camera moved: the labels follow. */
    place(view) {
        this.labels.place(view);
    }

    dispose() {
        this.seq += 1;
        this.panel.dispose();
        this.labels.dispose();
    }
}
