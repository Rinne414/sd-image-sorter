/**
 * Aurora Phase 3 — pick-order badges for gallery selection.
 *
 * Stamps `data-sel-order` (1-based pick order) onto selected tiles so the
 * CSS ♥ pill (ui-refresh.css "Gallery tile semantics") can show which image
 * was picked 1st / 2nd / …. Order comes from AppState.selectedIds — a Set,
 * whose iteration order is insertion order, i.e. the order the user clicked.
 *
 * Skipped (plain ♥, no number) when:
 *   - the selection is token-scoped ("select all matching"): every filtered
 *     image is selected, so a pick order is meaningless; or
 *   - more than MAX_NUMBERED ids are selected: past that the number carries
 *     no information and the Map build is wasted work on huge selections.
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
            const key = String(item.dataset.id);
            if (order && order.has(key)) {
                item.dataset.selOrder = String(order.get(key));
            } else if (item.dataset.selOrder !== undefined) {
                delete item.dataset.selOrder;
            }
        });
    }

    window.GallerySelectionBadges = { refresh };
})();
