/**
 * "Pick the most different N" for a Gallery selection.
 *
 * Cutting a pile of candidates down to a training set by eye is slow and keeps
 * near-duplicates. From the selected pictures this asks the similarity index
 * for the N that differ most from one another and opens exactly those in the
 * Gallery, all selected, so they can go straight to the Dataset Maker or a
 * collection. Pictures that are not in the similarity index cannot take part,
 * and the result says how many that was.
 *
 * POST /api/similarity/pick-varied does the picking (services/varied_pick.py).
 */
(function initPickVaried(global) {
    'use strict';

    const MIN_SELECTED = 3;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;

    async function selectedIds() {
        if (typeof global.DatasetMaker?._resolveGallerySelectionIds === 'function') {
            return global.DatasetMaker._resolveGallerySelectionIds();
        }
        return typeof global.getSelectedGalleryIds === 'function' ? global.getSelectedGalleryIds() : [];
    }

    /** A sensible first offer: a third of the pile, at most 30. */
    function suggested(total) {
        return String(Math.max(2, Math.min(30, Math.round(total / 3))));
    }

    async function run() {
        const api = app();
        if (!api) return;
        let ids = [];
        try {
            ids = (await selectedIds()).map(Number).filter(Boolean);
        } catch (error) {
            api.showToast?.(error?.message || String(error), 'error');
            return;
        }
        if (ids.length < MIN_SELECTED) {
            api.showToast?.(tr('pickVaried.tooFew', 'Select at least {n} pictures first.', { n: MIN_SELECTED }), 'info');
            return;
        }
        const answer = await api.showInputModal(
            tr('pickVaried.title', 'Pick the most different pictures'),
            tr('pickVaried.ask', 'How many of the {n} selected pictures? They are chosen to differ from one another as much as possible.', { n: ids.length.toLocaleString() }),
            suggested(ids.length),
        );
        if (answer === null || answer === undefined) return;
        const count = Number(String(answer).trim());
        if (!Number.isInteger(count) || count < 1 || count >= ids.length) {
            api.showToast?.(tr('pickVaried.badNumber', 'Enter a whole number from 1 to {max}.', { max: ids.length - 1 }), 'error');
            return;
        }
        let result;
        try {
            result = await api.API.post('/api/similarity/pick-varied', { image_ids: ids, count });
        } catch (error) {
            api.showToast?.(error?.message || String(error), 'error');
            return;
        }
        const picked = result?.picked || [];
        if (!picked.length) {
            api.showToast?.(
                tr('pickVaried.noIndex', 'None of these pictures are in the similarity index yet. Build it on the Similar page, then try again.'),
                'warning',
                { duration: 12000, actionLabel: tr('pickVaried.openSimilar', 'Open Similar'), onAction: () => api.switchView?.('similar') },
            );
            return;
        }
        await global.GalleryPin?.open?.(picked, { source: 'varied' });
        const leftOut = Number(result.not_indexed || 0);
        api.showToast?.(
            leftOut > 0
                ? tr('pickVaried.doneSome', 'Picked {picked} of {total}. {left} pictures are not in the similarity index and could not take part.', { picked: picked.length, total: ids.length, left: leftOut })
                : tr('pickVaried.done', 'Picked {picked} of {total} for variety. They are selected: send them on, or close the banner to go back.', { picked: picked.length, total: ids.length }),
            leftOut > 0 ? 'warning' : 'success',
            { duration: 9000 },
        );
    }

    function wire() {
        document.getElementById('btn-pick-varied')?.addEventListener('click', run);
    }

    global.PickVaried = Object.freeze({ run });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
