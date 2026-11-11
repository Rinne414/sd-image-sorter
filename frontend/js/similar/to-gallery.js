/**
 * Find Similar results as a Gallery view.
 *
 * A search here ended in its own list: each result had its own buttons, but
 * the results could not be selected together, moved, tagged or sent on. A line
 * above the results now opens exactly these pictures in the Gallery (the same
 * "only these pictures" view the Style Map uses), all selected, so every
 * Gallery action works on them. The Gallery's banner gives the way back.
 */
(function initSimilarToGallery(global) {
    'use strict';

    const BAR_ID = 'similar-results-bar';
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );

    function bar(container) {
        let node = document.getElementById(BAR_ID);
        if (!node) {
            node = document.createElement('div');
            node.id = BAR_ID;
            node.className = 'similar-results-bar';
            container.parentNode.insertBefore(node, container);
        }
        return node;
    }

    /** Draw (or hide) the line above the results for the pictures now listed. */
    function show(container, ids) {
        if (!container?.parentNode) return;
        const node = bar(container);
        node.hidden = !ids.length || !global.GalleryPin;
        if (node.hidden) return;
        node.textContent = '';
        const count = document.createElement('span');
        count.className = 'similar-results-count';
        count.textContent = tr('similar.resultsCount', '{n} pictures found', { n: ids.length });
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary btn-small';
        button.dataset.action = 'similar-to-gallery';
        button.innerHTML = global.UiIcon?.html?.('i-images') || '';
        button.append(` ${tr('similar.openInGallery', 'Open these in the Gallery to select and act on them')}`);
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await global.GalleryPin.open(ids, { source: 'similar' });
            } finally {
                button.disabled = false;
            }
        });
        node.append(count, button);
    }

    global.SimilarToGallery = Object.freeze({ show });
})(window);
