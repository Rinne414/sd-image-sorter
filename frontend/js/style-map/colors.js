/**
 * Dot colours (slice S4a): the user picks a data field in the toolbar and
 * every dot of the map takes that field's colour. The values come from
 * GET /api/style-map/colors (ids + values in point order, never part of the
 * cached points); this module turns one answer into the per-point RGB
 * array the scene paints from, and draws the legend next to the select.
 *
 * Palette (registered in docs/DESIGN.md §color-exemptions "Style map point
 * colouring"): twelve fixed category hues that stay clear of pure blue,
 * purple, pink and the amber accent; a viridis ramp for scores; one neutral
 * grey for "no data". The hex values are written to the shader as they are
 * (the point shader outputs raw values), so a legend swatch and its dots
 * are the same colour on screen.
 */
import { t } from './text.js';

export const COLOR_FIELDS = ['generator', 'folder', 'artist', 'aesthetic_score', 'aesthetic_waifu', 'aesthetic_anime'];
export const DEFAULT_COLOR_BY = 'generator';
export const CATEGORY_HEX = [
    '#D8524B', '#E8927C', '#A9A331', '#7FB83C', '#36A853', '#1E7F55',
    '#5FC9A6', '#239E9A', '#3BA7D1', '#1F6F8E', '#8B5E3C', '#E0C84D',
];
export const OTHER_HEX = '#9A9A94';
export const NO_DATA_HEX = '#5A5A60';
export const RAMP_HEX = ['#443983', '#21918C', '#FDE725'];
export const OTHER_KEY = '__other__';
const STORAGE_KEY = 'sd-stylemap-color-by';
const MORE_BUTTON_ROOM = 48; // px kept for the "+N" / "Fewer" button when chips are folded
const CHIP_GAP = 6;

export function readColorPreference() {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return COLOR_FIELDS.includes(value) ? value : DEFAULT_COLOR_BY;
    } catch (_error) {
        return DEFAULT_COLOR_BY;
    }
}

export function writeColorPreference(by) {
    try {
        localStorage.setItem(STORAGE_KEY, by);
    } catch (_error) {
        // private window or blocked storage: the choice still holds for this visit
    }
}

/** '#RRGGBB' -> [r, g, b] in 0..1 (sRGB values, no colour-space conversion). */
export function hexToRgb(hex) {
    const value = parseInt(String(hex).replace('#', ''), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export const NO_DATA_RGB = hexToRgb(NO_DATA_HEX);
const RAMP_RGB = RAMP_HEX.map(hexToRgb);
const CATEGORY_RGB = CATEGORY_HEX.map(hexToRgb);
const OTHER_RGB = hexToRgb(OTHER_HEX);

/** Colour at t in 0..1 along the three-stop ramp. */
export function rampColor(t) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    const scaled = clamped * (RAMP_RGB.length - 1);
    const low = Math.min(RAMP_RGB.length - 2, Math.floor(scaled));
    const mix = scaled - low;
    const a = RAMP_RGB[low];
    const b = RAMP_RGB[low + 1];
    return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
}

/** The swatch colour of legend entry `index` (the folded "other" entry is grey). */
export function legendHex(entry, index) {
    if (entry?.key === OTHER_KEY) return OTHER_HEX;
    return CATEGORY_HEX[index % CATEGORY_HEX.length];
}

function legendRgb(entry, index) {
    if (entry?.key === OTHER_KEY) return OTHER_RGB;
    return CATEGORY_RGB[index % CATEGORY_RGB.length];
}

/**
 * Per-point RGB (Float32Array, 3 per dot, in the scene's point order) for
 * one colours answer. Dots the answer does not cover, and dots whose value
 * is null, keep the no-data grey. Linear in the number of points.
 */
export function buildPointColors(body, sceneIds) {
    const count = sceneIds ? sceneIds.length : 0;
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
        rgb[i * 3] = NO_DATA_RGB[0];
        rgb[i * 3 + 1] = NO_DATA_RGB[1];
        rgb[i * 3 + 2] = NO_DATA_RGB[2];
    }
    if (!body || body.status !== 'ok' || !Array.isArray(body.ids) || !Array.isArray(body.values)) return rgb;
    const index = new Map();
    for (let i = 0; i < count; i += 1) index.set(sceneIds[i], i);
    const isScale = body.kind === 'scale';
    const [low, high] = Array.isArray(body.range) ? body.range : [0, 0];
    const span = high - low;
    const palette = isScale ? null : (body.legend || []).map(legendRgb);
    const ids = body.ids;
    const values = body.values;
    for (let i = 0; i < ids.length; i += 1) {
        const value = values[i];
        if (value === null || value === undefined) continue;
        const at = index.get(ids[i]);
        if (at === undefined) continue;
        let color;
        if (isScale) {
            color = rampColor(span > 0 ? (value - low) / span : 0.5);
        } else {
            color = palette[value];
            if (!color) continue;
        }
        rgb[at * 3] = color[0];
        rgb[at * 3 + 1] = color[1];
        rgb[at * 3 + 2] = color[2];
    }
    return rgb;
}

function formatScore(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '';
}

/**
 * The legend: one row of chips (category) or a ramp with its two end
 * numbers (scale), plus a grey "no data" chip when some dots have none.
 * Chips that do not fit the row fold into a "+N" button that opens the full
 * list; the button's words flip with its state (rule 16).
 */
export class ColorLegend {
    constructor(host) {
        this.host = host;
        this.body = null;
        this.by = null;
        this.pop = null;
        this.moreButton = null;
        this.onDocumentClick = (event) => {
            if (this.pop && !this.host.contains(event.target) && !this.pop.contains(event.target)) this.closePop();
        };
        this.onKeyDown = (event) => {
            if (event.key === 'Escape') this.closePop();
        };
        if (host && typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => this.fold());
            this.resizeObserver.observe(host);
        }
    }

    /** Legend text of one entry (generators are named the way the Gallery names them). */
    labelOf(entry) {
        if (entry.key === OTHER_KEY) return t('stylemap.legendOther', 'Other');
        if (this.by === 'generator') {
            const format = window.App?.formatGeneratorLabel;
            if (typeof format === 'function') return format(entry.key, t('generator.unknown', 'Unknown'));
        }
        return entry.label || entry.key;
    }

    chip(entry, index, { noData = false } = {}) {
        const chip = document.createElement('span');
        chip.className = `stylemap-legend-chip${noData ? ' is-nodata' : ''}`;
        const swatch = document.createElement('span');
        swatch.className = 'stylemap-swatch';
        swatch.style.background = noData ? NO_DATA_HEX : legendHex(entry, index);
        const label = document.createElement('span');
        label.className = 'stylemap-legend-label';
        label.textContent = noData ? t('stylemap.legendNoData', 'No data') : this.labelOf(entry);
        const count = document.createElement('span');
        count.className = 'stylemap-legend-count';
        count.textContent = String(entry.count);
        chip.append(swatch, label, count);
        const pictures = t('stylemap.legendPictures', '{n} pictures', { n: entry.count });
        chip.title = noData || entry.key === OTHER_KEY ? pictures : `${entry.key}\n${pictures}`;
        if (!noData) chip.dataset.key = entry.key;
        return chip;
    }

    scaleBlock(body) {
        const block = document.createElement('span');
        block.className = 'stylemap-legend-scale';
        if (!Array.isArray(body.range)) {
            const none = document.createElement('span');
            none.className = 'stylemap-legend-chip is-nodata';
            none.innerHTML = '<span class="stylemap-swatch"></span><span class="stylemap-legend-label"></span>';
            none.querySelector('.stylemap-swatch').style.background = NO_DATA_HEX;
            none.querySelector('.stylemap-legend-label').textContent = t('stylemap.legendNoScores', 'No scores yet');
            block.append(none);
            return block;
        }
        const low = document.createElement('span');
        low.className = 'stylemap-legend-min';
        low.textContent = formatScore(body.range[0]);
        const ramp = document.createElement('span');
        ramp.className = 'stylemap-legend-ramp';
        ramp.style.setProperty('--stylemap-ramp', `linear-gradient(90deg, ${RAMP_HEX.join(', ')})`);
        const high = document.createElement('span');
        high.className = 'stylemap-legend-max';
        high.textContent = formatScore(body.range[1]);
        block.append(low, ramp, high);
        return block;
    }

    /** Draw the legend of one answer (null clears it); `by` names the field. */
    render(body, by) {
        this.body = body;
        this.by = by;
        this.closePop();
        if (!this.host) return;
        this.host.replaceChildren();
        this.moreButton = null;
        if (!body || body.status !== 'ok') return;
        if (body.kind === 'scale') {
            this.host.append(this.scaleBlock(body));
        } else {
            (body.legend || []).forEach((entry, index) => this.host.append(this.chip(entry, index)));
        }
        if (body.missing > 0) this.host.append(this.chip({ count: body.missing }, 0, { noData: true }));
        this.fold();
    }

    /** Same answer, current language (after a language switch). */
    repaintText() {
        if (this.body) this.render(this.body, this.by);
    }

    /**
     * Hide the chips past the row's width and show "+N" for them: as many
     * chips as fit beside the button, never fewer (rule 18: no dead space).
     * A re-fold (row resized) closes an open list first, so the button's
     * words and the list never disagree.
     */
    fold() {
        const { host } = this;
        if (!host || !this.body || this.body.kind === 'scale') return;
        this.closePop();
        const chips = [...host.querySelectorAll(':scope > .stylemap-legend-chip')];
        if (this.moreButton) {
            this.moreButton.remove();
            this.moreButton = null;
        }
        chips.forEach((chip) => { chip.hidden = false; });
        const width = host.clientWidth;
        if (!width || chips.length === 0) return;
        const widths = chips.map((chip) => chip.offsetWidth);
        const rowWidth = (count) => widths.slice(0, count).reduce((sum, w, i) => sum + w + (i ? CHIP_GAP : 0), 0);
        if (rowWidth(chips.length) <= width) return;
        // The button is measured with its widest words (the open state's),
        // so flipping to "Fewer" never pushes it out of the row.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'stylemap-legend-more';
        button.setAttribute('aria-expanded', 'false');
        button.textContent = t('stylemap.legendLess', 'Fewer');
        host.append(button);
        const room = Math.max(button.offsetWidth, MORE_BUTTON_ROOM);
        // The largest prefix whose chips, plus the gap and the button, fit.
        let fits = 0;
        while (fits < chips.length && rowWidth(fits + 1) + CHIP_GAP + room <= width) fits += 1;
        chips.forEach((chip, index) => { chip.hidden = index >= fits; });
        const hidden = chips.length - fits;
        button.dataset.hidden = String(hidden);
        button.textContent = t('stylemap.legendMore', '+{n}', { n: hidden });
        button.title = t('stylemap.legendMoreTitle', 'Show all {n} categories', { n: chips.length });
        button.addEventListener('click', () => (this.pop ? this.closePop() : this.openPop()));
        this.moreButton = button;
    }

    openPop() {
        if (!this.body || this.pop) return;
        const pop = document.createElement('div');
        pop.className = 'stylemap-legend-pop';
        (this.body.legend || []).forEach((entry, index) => pop.append(this.chip(entry, index)));
        if (this.body.missing > 0) pop.append(this.chip({ count: this.body.missing }, 0, { noData: true }));
        // The card must escape the row's overflow clip: it hangs off the
        // toolbar (position: relative in style-map.css), under the legend.
        pop.style.top = `${this.host.offsetTop + this.host.offsetHeight + 4}px`;
        pop.style.left = `${this.host.offsetLeft}px`;
        this.host.parentElement.append(pop);
        this.pop = pop;
        if (this.moreButton) {
            this.moreButton.setAttribute('aria-expanded', 'true');
            this.moreButton.textContent = t('stylemap.legendLess', 'Fewer');
        }
        document.addEventListener('click', this.onDocumentClick, true);
        document.addEventListener('keydown', this.onKeyDown);
    }

    closePop() {
        if (!this.pop) return;
        this.pop.remove();
        this.pop = null;
        if (this.moreButton) {
            this.moreButton.setAttribute('aria-expanded', 'false');
            const hidden = Number(this.moreButton.dataset.hidden || 0);
            this.moreButton.textContent = t('stylemap.legendMore', '+{n}', { n: hidden });
        }
        document.removeEventListener('click', this.onDocumentClick, true);
        document.removeEventListener('keydown', this.onKeyDown);
    }
}
