/**
 * The program's one way to find a picture's main colours, in HSV.
 *
 * Keep in step with backend/hsv_palette.py (the reasons and measurements are
 * there) and frontend-v4/src/lib/hsvPalette.ts: all three give the answers in
 * backend/tests/fixtures/hsv_palette_vectors.json. Classic script; exposes
 * window.hsvPalette(rgba, top) -> [{ hex, pct, share }], largest share first,
 * from canvas ImageData (fully transparent pixels are not part of the picture).
 */
(function () {
    'use strict';

    const BLACK_VALUE = 0.14;
    const GRAY_SATURATION = 0.10;
    const HUE_BIN_DEGREES = 12;
    const SATURATION_EDGES = [0.35, 0.65];
    const VALUE_EDGES = [0.40, 0.70];
    const GRAY_VALUE_EDGES = [0.40, 0.70, 0.85];
    const MERGE_HUE_DEGREES = 20;
    const MERGE_SATURATION = 0.35;
    const MERGE_VALUE = 0.30;
    const MERGE_GRAY_VALUE = 0.20;
    const MIN_SHARE_PERCENT = 1;
    const RADIANS = Math.PI / 180;

    function band(value, edges) {
        for (let index = 0; index < edges.length; index += 1) {
            if (value < edges[index]) return index;
        }
        return edges.length;
    }

    function toHsv(r, g, b) {
        const red = r / 255;
        const green = g / 255;
        const blue = b / 255;
        const high = Math.max(red, green, blue);
        const spread = high - Math.min(red, green, blue);
        if (spread === 0) return [0, 0, high];
        let sector;
        if (high === red) sector = ((green - blue) / spread + 6) % 6;
        else if (high === green) sector = (blue - red) / spread + 2;
        else sector = (red - green) / spread + 4;
        return [sector * 60, spread / high, high];
    }

    function toHex(hue, saturation, value) {
        const chroma = value * saturation;
        const sector = hue / 60;
        const second = chroma * (1 - Math.abs((sector % 2) - 1));
        const base = value - chroma;
        const parts = [
            [chroma, second, 0],
            [second, chroma, 0],
            [0, chroma, second],
            [0, second, chroma],
            [second, 0, chroma],
            [chroma, 0, second],
        ][Math.floor(sector) % 6];
        const hex = parts.map((part) => Math.floor((part + base) * 255 + 0.5).toString(16).padStart(2, '0'));
        return `#${hex.join('')}`;
    }

    function binKey(hue, saturation, value) {
        if (value < BLACK_VALUE) return 'k';
        if (saturation < GRAY_SATURATION) return `g${band(value, GRAY_VALUE_EDGES)}`;
        const hueBin = Math.floor(hue / HUE_BIN_DEGREES) % 30;
        return `c${hueBin}.${band(saturation, SATURATION_EDGES)}.${band(value, VALUE_EDGES)}`;
    }

    function collectBins(rgba) {
        const bins = new Map();
        let total = 0;
        for (let offset = 0; offset + 3 < rgba.length; offset += 4) {
            if (rgba[offset + 3] === 0) continue;
            total += 1;
            const [hue, saturation, value] = toHsv(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
            const key = binKey(hue, saturation, value);
            let entry = bins.get(key);
            if (!entry) {
                entry = { key, count: 0, sines: 0, cosines: 0, saturations: 0, values: 0 };
                bins.set(key, entry);
            }
            const angle = hue * RADIANS;
            entry.count += 1;
            entry.sines += Math.sin(angle);
            entry.cosines += Math.cos(angle);
            entry.saturations += saturation;
            entry.values += value;
        }
        const summaries = [...bins.values()].map((entry) => ({
            chromatic: entry.key[0] === 'c',
            count: entry.count,
            hue: ((Math.atan2(entry.sines / entry.count, entry.cosines / entry.count) / RADIANS) % 360 + 360) % 360,
            saturation: entry.saturations / entry.count,
            value: entry.values / entry.count,
        }));
        summaries.sort((a, b) => b.count - a.count);
        return { summaries, total };
    }

    function sameColour(seed, other) {
        if (seed.chromatic !== other.chromatic) return false;
        if (!seed.chromatic) return Math.abs(seed.value - other.value) <= MERGE_GRAY_VALUE;
        const gap = Math.abs(seed.hue - other.hue) % 360;
        return Math.min(gap, 360 - gap) <= MERGE_HUE_DEGREES
            && Math.abs(seed.saturation - other.saturation) <= MERGE_SATURATION
            && Math.abs(seed.value - other.value) <= MERGE_VALUE;
    }

    function hsvPalette(rgba, top = 5) {
        const { summaries, total } = collectBins(rgba);
        if (total === 0) return [];
        const used = new Array(summaries.length).fill(false);
        const groups = [];
        summaries.forEach((seed, index) => {
            if (used[index]) return;
            used[index] = true;
            let count = seed.count;
            for (let other = index + 1; other < summaries.length; other += 1) {
                if (!used[other] && sameColour(seed, summaries[other])) {
                    used[other] = true;
                    count += summaries[other].count;
                }
            }
            groups.push({ count, seed });
        });
        groups.sort((a, b) => b.count - a.count);
        const largeEnough = groups.filter((group) => (group.count / total) * 100 >= MIN_SHARE_PERCENT);
        return (largeEnough.length ? largeEnough : groups.slice(0, 1)).slice(0, top).map(({ count, seed }) => ({
            hex: toHex(seed.hue, seed.saturation, seed.value),
            pct: Math.round((count / total) * 1000) / 10,
            share: count / total,
        }));
    }

    window.hsvPalette = hsvPalette;
})();
