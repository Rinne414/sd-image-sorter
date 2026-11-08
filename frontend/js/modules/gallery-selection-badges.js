/**
 * Aurora Phase 3 — pick-order badges for gallery selection.
 *
 * Stamps `data-sel-order` (1-based pick order) onto selected tiles so the
 * CSS ✓ pill (ui-refresh.css "Gallery tile semantics") can show which image
 * was picked 1st / 2nd / …. Order comes from AppState.selectedIds — a Set,
 * whose iteration order is insertion order, i.e. the order the user clicked.
 *
 * Skipped (plain ✓, no number) when:
 *   - the selection is token-scoped ("select all matching"): every filtered
 *     image is selected, so a pick order is meaningless; or
 *   - more than MAX_NUMBERED ids are selected: past that the number carries
 *     no information and the Map build is wasted work on huge selections.
 *
 * A "Group runs" stack tile shows the orders of all its pictures (orderLabel).
 *
 * Called from app.js updateSelectionUI() — the common tail of every
 * selection mutation path (tile toggles, select-all, invert, clear).
 */
(function () {
    'use strict';

    const MAX_NUMBERED = 999;

    function refresh(appState) {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;

        const ids = appState && appState.selectedIds;
        const tokenScoped = !!(appState && appState.selectionToken);
        let order = null;
        if (ids && ids.size > 0 && ids.size <= MAX_NUMBERED && !tokenScoped) {
            order = new Map();
            let position = 0;
            ids.forEach((id) => {
                position += 1;
                order.set(String(id), position);
            });
        }

        grid.querySelectorAll('.gallery-item').forEach((item) => {
            const label = order ? orderLabel(item, order) : null;
            if (label) {
                item.dataset.selOrder = label;
            } else if (item.dataset.selOrder !== undefined) {
                delete item.dataset.selOrder;
            }
        });
    }

    /**
     * A tile's pick order. A stack of one generation run ("Group runs") holds
     * several pictures, so it shows their orders as ranges, e.g. "2-5" or
     * "1, 4-6"; past two ranges the rest is elided.
     */
    function orderLabel(item, order) {
        const runIds = item.dataset.runIds;
        if (!runIds) {
            const position = order.get(String(item.dataset.id));
            return position ? String(position) : null;
        }
        const ids = runIds.split(',');
        const positions = ids.map((id) => order.get(id)).filter(Boolean).sort((a, b) => a - b);
        // A stack counts as picked only when every picture of it is (as its mark).
        if (positions.length !== ids.length) return null;
        const ranges = [];
        positions.forEach((position) => {
            const last = ranges[ranges.length - 1];
            if (last && position === last[1] + 1) last[1] = position;
            else ranges.push([position, position]);
        });
        const text = ranges.slice(0, 2).map(([from, to]) => (from === to ? String(from) : `${from}\u2013${to}`));
        return ranges.length > 2 ? `${text.join(', ')}\u2026` : text.join(', ');
    }

    window.GallerySelectionBadges = { refresh };
})();
