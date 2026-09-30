/**
 * Region landmarks (slice S3b.2): what a corner of the map stands for. The
 * backend (GET /api/style-map/regions) splits the displayed layout into
 * k <= 12 regions, each with 1-2 representative pictures and, only when the
 * evidence is strong, WD14 style tags and confident artists. This module
 * draws them as an HTML overlay over the canvas: one solid card per region
 * (a 96 px thumbnail plus at most one line of text, no text row when there
 * is nothing to say), re-projected only when the camera moved. Cards that
 * would overlap an earlier (larger) region keep the thumbnail only; far
 * cards shrink and fade. Hovering a card opens it (second picture, every
 * label, picture count) and asks the scene to light that region's dots.
 * Nothing here is clickable (S4 decides what a click does).
 */
import { t } from './text.js';

const THUMBNAIL_SIZE = 256; // cached size closest to the card (2x for HiDPI)
const MAX_CARDS = 12;
const STORAGE_KEY = 'sd-stylemap-landmarks';
// Card metrics (px, before the depth scale). One set per canvas size: a
// canvas whose short side is under SMALL_CANVAS_SHORT_SIDE (the 1366x768
// canvas is ~570 px tall, 1920x1080 ~880) gets the small set so six cards do
// not cover the cloud. The CSS reads these through variables set on the
// layer; nothing else carries a size.
const SMALL_CANVAS_SHORT_SIDE = 700;
const CARD_SIZES = {
    large: { thumb: 96, pad: 8, gap: 6, font: 12, textLine: 16 },
    small: { thumb: 64, pad: 6, gap: 4, font: 11, textLine: 14 },
};
const TEXT_SIDE_ROOM = 16; // a card is a little wider than its picture so a word fits
const FAR_SCALE = 0.72; // a card at the back of the cloud
const FAR_OPACITY = 0.55;
const EDGE_MARGIN = 6;
const NUDGE_STEP = 20; // px per try when a thumbnail-only card still collides
const NUDGE_MAX = 80;
const DIAGONAL = Math.SQRT1_2;
const NUDGE_DIRECTIONS = [
    [0, -1], [0, 1], [-1, 0], [1, 0],
    [-DIAGONAL, -DIAGONAL], [DIAGONAL, -DIAGONAL], [-DIAGONAL, DIAGONAL], [DIAGONAL, DIAGONAL],
];

export function readLandmarksPreference() {
    try {
        return localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch (_error) {
        return true;
    }
}

export function writeLandmarksPreference(on) {
    try {
        localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch (_error) {
        // private window or blocked storage: the switch still works for this visit
    }
}

/** Display name of a WD14 style tag (language packs carry stylemap.tag.<tag>). */
export function tagName(tag) {
    const fallback = String(tag).replace(/_\(medium\)$/, '').replace(/_/g, ' ');
    return t(`stylemap.tag.${tag}`, fallback);
}

export function artistLine(artist) {
    return t('stylemap.landmarkArtist', 'maybe: {artist} ({count}/{total} confident)', {
        artist: artist.artist,
        count: artist.count,
        total: artist.high_total,
    });
}

/**
 * The one line a closed card shows: its tags, else its top artist (name
 * only; the coverage "5/6 confident" belongs to the open card, where it
 * fits), else nothing.
 */
export function summaryLine(region) {
    const tags = Array.isArray(region.tags) ? region.tags : [];
    if (tags.length) return tags.map((tag) => tagName(tag.tag)).join(' · ');
    const artists = Array.isArray(region.artists) ? region.artists : [];
    if (artists.length) return t('stylemap.landmarkArtistShort', 'maybe: {artist}', { artist: artists[0].artist });
    return '';
}

/**
 * Which region each dot belongs to: the nearest region centre in the
 * displayed coordinates (what k-means converged to). Int8, -1 = none.
 */
export function assignRegions(positions, regions) {
    const count = positions ? positions.count : 0;
    const labels = new Int8Array(count).fill(-1);
    if (!count || !regions.length) return labels;
    const centers = regions.map((region) => region.center || [0, 0, 0]);
    for (let i = 0; i < count; i += 1) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);
        let best = -1;
        let bestDistance = Infinity;
        for (let r = 0; r < centers.length; r += 1) {
            const [cx, cy, cz] = centers[r];
            const d = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
            if (d < bestDistance) {
                bestDistance = d;
                best = r;
            }
        }
        labels[i] = best;
    }
    return labels;
}

/** An <img> for one picture id, or null when the id is not a picture id. */
function thumbnail(id) {
    if (!Number.isInteger(id) || id <= 0) return null;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = `/api/image-thumbnail/${id}?size=${THUMBNAIL_SIZE}`;
    return img;
}

function appendThumbnail(parent, id) {
    const img = thumbnail(id);
    if (img) parent.appendChild(img);
}

/** Which card set a canvas gets; exported so the scene / tests can ask. */
export function cardSizeFor(width, height) {
    return Math.min(width, height) < SMALL_CANVAS_SHORT_SIDE ? 'small' : 'large';
}

/** Full (picture + one line) and compact (picture only) boxes of a size set. */
function cardBoxes(metrics) {
    const compact = metrics.thumb + 2 * metrics.pad;
    return {
        full: { w: compact + TEXT_SIDE_ROOM, h: compact + metrics.gap + metrics.textLine },
        compact: { w: compact, h: compact },
    };
}

function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export class RegionLandmarks {
    constructor(host, { onHoverRegion } = {}) {
        this.host = host;
        this.onHoverRegion = typeof onHoverRegion === 'function' ? onHoverRegion : () => {};
        this.layer = document.createElement('div');
        this.layer.className = 'stylemap-landmarks';
        this.layer.hidden = true;
        host.appendChild(this.layer);
        this.regions = [];
        this.cards = [];
        this.visible = false;
        this.hovered = -1;
        this.lastCamera = null;
        this.size = null;
        this.applySize('large');
    }

    /** Switch the card set: CSS variables on the layer, boxes for the layout. */
    applySize(size) {
        if (size === this.size) return;
        this.size = size;
        const metrics = CARD_SIZES[size];
        this.boxes = cardBoxes(metrics);
        const { style } = this.layer;
        style.setProperty('--landmark-thumb', `${metrics.thumb}px`);
        style.setProperty('--landmark-pad', `${metrics.pad}px`);
        style.setProperty('--landmark-gap', `${metrics.gap}px`);
        style.setProperty('--landmark-font', `${metrics.font}px`);
        style.setProperty('--landmark-card-w', `${this.boxes.full.w}px`);
        this.layer.classList.toggle('is-small', size === 'small');
    }

    setVisible(flag) {
        const on = Boolean(flag);
        if (on === this.visible) return;
        this.visible = on;
        this.layer.hidden = !on;
        if (on) this.buildCards();
        else this.clearCards();
    }

    /**
     * New regions: the cards are rebuilt (the controller clears them with
     * every new map, so a points refresh always comes through here twice:
     * empty, then filled). Thumbnail URLs repeat, so the browser cache
     * answers the rebuilt cards' pictures.
     */
    setRegions(regions) {
        this.regions = (Array.isArray(regions) ? regions : []).slice(0, MAX_CARDS);
        this.lastCamera = null;
        if (this.visible) this.buildCards();
        else this.clearCards();
    }

    clearCards() {
        this.hover(-1);
        this.layer.replaceChildren();
        this.cards = [];
    }

    buildCards() {
        this.clearCards();
        this.cards = this.regions.map((region, index) => this.createCard(region, index));
        this.layer.replaceChildren(...this.cards);
        if (this.lastCamera) this.place(this.lastCamera);
    }

    createCard(region, index) {
        const card = document.createElement('div');
        card.className = 'stylemap-landmark';
        card.dataset.region = String(region.id);
        card.hidden = true; // until projected
        const thumbs = document.createElement('div');
        thumbs.className = 'stylemap-landmark-thumbs';
        const reps = Array.isArray(region.representatives) ? region.representatives : [];
        if (reps.length) appendThumbnail(thumbs, reps[0]);
        card.appendChild(thumbs);
        // No empty text row: the line exists only when there is something to say.
        const line = summaryLine(region);
        if (line) {
            const text = document.createElement('div');
            text.className = 'stylemap-landmark-text';
            text.textContent = line;
            card.appendChild(text);
        }
        card.addEventListener('mouseenter', () => this.hover(index));
        card.addEventListener('mouseleave', () => {
            if (this.hovered === index) this.hover(-1);
        });
        // The wheel still zooms the map with the pointer on a card (and never
        // scrolls the page): hand the event to the canvas the controls watch.
        card.addEventListener('wheel', (event) => this.forwardWheel(event), { passive: false });
        return card;
    }

    forwardWheel(event) {
        event.preventDefault();
        const canvas = this.host.querySelector('canvas');
        if (!canvas) return;
        canvas.dispatchEvent(new WheelEvent('wheel', {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            deltaMode: event.deltaMode,
            clientX: event.clientX,
            clientY: event.clientY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            cancelable: true,
        }));
    }

    /** Language switch: rewrite every card's words, keep the pictures. */
    repaintText() {
        this.cards.forEach((card, index) => {
            const region = this.regions[index];
            const text = card.querySelector('.stylemap-landmark-text');
            if (text) text.textContent = summaryLine(region);
            if (card.classList.contains('is-open')) this.fillDetail(card, region);
        });
    }

    hover(index) {
        if (index === this.hovered) return;
        const previous = this.cards[this.hovered];
        if (previous) {
            previous.classList.remove('is-open');
            previous.querySelector('.stylemap-landmark-detail')?.remove();
        }
        this.hovered = index;
        const card = this.cards[index];
        if (card) {
            card.classList.add('is-open');
            card.classList.remove('is-compact');
            this.fillDetail(card, this.regions[index]);
        }
        // The open card is bigger than its closed box: lay out again so it
        // is kept inside the canvas (and a closed card gets its box back).
        if (this.lastCamera) this.place(this.lastCamera);
        this.onHoverRegion(index >= 0 ? index : null);
    }

    /** The open card: the second representative, every label, the picture count. */
    fillDetail(card, region) {
        card.querySelector('.stylemap-landmark-detail')?.remove();
        const thumbs = card.querySelector('.stylemap-landmark-thumbs');
        const reps = Array.isArray(region.representatives) ? region.representatives : [];
        if (thumbs && reps.length > 1 && thumbs.children.length < 2) appendThumbnail(thumbs, reps[1]);
        const detail = document.createElement('div');
        detail.className = 'stylemap-landmark-detail';
        const tags = Array.isArray(region.tags) ? region.tags : [];
        if (tags.length) {
            const row = document.createElement('div');
            row.className = 'stylemap-landmark-tags';
            row.textContent = tags.map((tag) => tagName(tag.tag)).join(' · ');
            detail.appendChild(row);
        }
        for (const artist of Array.isArray(region.artists) ? region.artists : []) {
            const row = document.createElement('div');
            row.className = 'stylemap-landmark-artist';
            row.textContent = artistLine(artist);
            detail.appendChild(row);
        }
        const count = document.createElement('div');
        count.className = 'stylemap-landmark-count';
        count.textContent = t('stylemap.landmarkCount', '{n} pictures', { n: region.members_total ?? region.size ?? 0 });
        detail.appendChild(count);
        card.appendChild(detail);
    }

    /**
     * Project every region centre with the scene's camera and lay the cards
     * out. Called by the scene only when the camera moved (or the map, the
     * canvas or the regions changed). `view` = { camera, width, height, near, far }.
     */
    place(view) {
        this.lastCamera = view;
        if (!this.visible || !this.cards.length) return;
        const { camera, width, height, near, far } = view;
        this.applySize(cardSizeFor(width, height));
        const { full: FULL_CARD, compact: COMPACT_CARD } = this.boxes;
        const span = Math.max(1e-6, far - near);
        const placed = [];
        const open = this.hovered;
        this.regions.forEach((region, index) => {
            const card = this.cards[index];
            const [x, y, z] = region.center || [0, 0, 0];
            const v = camera.position.clone().set(x, y, z);
            const distance = camera.position.distanceTo(v);
            // View space looks down -z: a centre at z >= 0 is behind the camera.
            const behind = v.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0;
            v.project(camera);
            const px = ((v.x + 1) / 2) * width;
            const py = ((1 - v.y) / 2) * height;
            const outside = px < -EDGE_MARGIN || px > width + EDGE_MARGIN || py < -EDGE_MARGIN || py > height + EDGE_MARGIN;
            if (behind || outside) {
                card.hidden = true;
                return;
            }
            // Depth: front of the cloud -> full size, back -> smaller and fainter.
            const depth = Math.min(1, Math.max(0, (distance - near) / span));
            const scale = index === open ? 1 : 1 - (1 - FAR_SCALE) * depth;
            const opacity = index === open ? 1 : 1 - (1 - FAR_OPACITY) * depth;
            // Greedy avoidance in size order: a card that would sit on an
            // earlier one keeps its thumbnail only, and a thumbnail that
            // still collides slides a little away from its centre; when no
            // free spot is near, the card stays off rather than on top of
            // another (a stacked card would also block the one below).
            let compact = false;
            let rect = this.rect(px, py, FULL_CARD, scale);
            if (index === open) {
                // The open card's real box (second picture, every label),
                // shifted as needed so it never runs off the canvas.
                rect = this.rect(px, py, { w: card.offsetWidth || FULL_CARD.w, h: card.offsetHeight || FULL_CARD.h }, 1);
                rect.x = Math.min(Math.max(rect.x, 0), Math.max(0, width - rect.w));
                rect.y = Math.min(Math.max(rect.y, 0), Math.max(0, height - rect.h));
            }
            const free = (candidate) => !placed.some((other) => overlaps(candidate, other));
            if (index !== open && !free(rect)) {
                compact = true;
                rect = this.rect(px, py, COMPACT_CARD, scale);
                if (!free(rect)) rect = this.nudge(rect, free, width, height);
            }
            if (!rect) {
                card.hidden = true;
                return;
            }
            placed.push(rect);
            card.hidden = false;
            card.classList.toggle('is-compact', compact && index !== open);
            card.style.transform = `translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
            card.style.opacity = opacity.toFixed(3);
        });
    }

    /** The nearest free position within NUDGE_MAX px of the projected centre, or null. */
    nudge(rect, free, width, height) {
        const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height;
        for (let step = NUDGE_STEP; step <= NUDGE_MAX; step += NUDGE_STEP) {
            for (const [dx, dy] of NUDGE_DIRECTIONS) {
                const candidate = { ...rect, x: rect.x + dx * step, y: rect.y + dy * step };
                if (inside(candidate) && free(candidate)) return candidate;
            }
        }
        return null;
    }

    rect(px, py, size, scale) {
        const w = size.w * scale;
        const h = size.h * scale;
        // transform-origin is the top-left corner: translate to the corner of
        // the scaled box centred on the projected point.
        return { x: px - w / 2, y: py - h / 2, w, h };
    }

    dispose() {
        this.clearCards();
        this.layer.remove();
    }
}
