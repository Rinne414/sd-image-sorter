/**
 * gallery/run-groups.js - pictures from one generation run, as one stack.
 *
 * A run is pictures next to each other in time order with the same run key
 * (the server's hash of prompt, negative prompt, checkpoint and size) and
 * each made within RUN_GAP_MS of the previous one. groupRuns() turns the
 * gallery's flat list into the list the grid shows: a closed run becomes one
 * stack item (its first picture, which is the newest under "newest first"),
 * an open run shows every picture marked as a member. The flat list itself
 * never changes: preview next/previous, selection and every batch action keep
 * working on pictures.
 *
 * Classic script with no dependencies: window.GalleryRunGroups.
 */
(function () {
    'use strict';

    // Two pictures more than this far apart start a new run.
    const RUN_GAP_MS = 10 * 60 * 1000;

    function timeOf(image) {
        const value = image && (image.library_order_time || image.created_at);
        if (value == null || value === '') return null;
        const number = typeof value === 'number' ? value * 1000 : Date.parse(String(value).replace(' ', 'T'));
        return Number.isFinite(number) ? number : null;
    }

    function sameRun(previous, image) {
        if (!previous || !image || !image.run_key || image.run_key !== previous.run_key) return false;
        const a = timeOf(previous);
        const b = timeOf(image);
        return a === null || b === null || Math.abs(a - b) <= RUN_GAP_MS;
    }

    /**
     * Runs as [start, end) index pairs over the flat list; single pictures are runs of one.
     * @param {Array<object>} images
     * @returns {Array<[number, number]>}
     */
    function findRuns(images) {
        const runs = [];
        let start = 0;
        for (let index = 1; index <= images.length; index += 1) {
            if (index === images.length || !sameRun(images[index - 1], images[index])) {
                runs.push([start, index]);
                start = index;
            }
        }
        return images.length ? runs : [];
    }

    // A view of the picture (its prototype) with the grid's own marks. Not a
    // copy: a rating or favourite set on the picture later shows through when
    // the virtual list redraws the tile.
    function view(image, marks) {
        return Object.assign(Object.create(image), marks);
    }

    /**
     * The list the grid shows. Every item reads the picture's fields and adds
     * `_flatIndex`; a closed run's item adds `_stack` ({ key, ids, size }),
     * an open run's pictures add `_runMember` ({ key, position, size }).
     * @param {Array<object>} images the flat list, in the gallery's order
     * @param {{ openKeys?: Set<string> }} [options]
     */
    function groupRuns(images, options = {}) {
        const openKeys = options.openKeys || new Set();
        const items = [];
        findRuns(images).forEach(([start, end]) => {
            const size = end - start;
            if (size === 1) {
                items.push(view(images[start], { _flatIndex: start }));
                return;
            }
            const first = images[start];
            const key = `${first.run_key}:${first.id}`;
            if (!openKeys.has(key)) {
                const ids = images.slice(start, end).map((image) => image.id);
                items.push(view(first, { _flatIndex: start, _stack: { key, ids, size } }));
                return;
            }
            for (let index = start; index < end; index += 1) {
                items.push(view(images[index], { _flatIndex: index, _runMember: { key, position: index - start, size } }));
            }
        });
        return items;
    }

    window.GalleryRunGroups = { groupRuns, findRuns, RUN_GAP_MS };
})();
