/**
 * "Compare these two" for a Gallery selection of exactly two pictures.
 *
 * The viewer compares a picture with the one made just before it; here the
 * user names both. A dialog shows the two side by side (the earlier one on
 * the left) and, under them, what the later one has that the earlier does
 * not: prompt words, settings, LoRAs, seed. Either picture opens in the
 * viewer from there.
 *
 * GET /api/images/{later}/changes?against={earlier} does the comparing; the
 * rows are drawn by gallery/modal-changes.js, the same as in the viewer.
 */
(function initCompareTwo(global) {
    'use strict';

    const MODAL_ID = 'compare-two-modal';
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;
    let modal = null;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    function build() {
        modal = el('div', 'modal');
        modal.id = MODAL_ID;
        modal.innerHTML = `
            <div class="modal-backdrop"></div>
            <div class="modal-content compare-two-content" role="dialog" aria-modal="true" aria-labelledby="compare-two-title">
                <button type="button" class="modal-close" id="compare-two-close">${global.UiIcon?.html?.('i-close') || ''}</button>
                <h3 id="compare-two-title"></h3>
                <div class="compare-two-pictures"></div>
                <div class="compare-two-changes modal-changes-body"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#compare-two-title').textContent = tr('compareTwo.title', 'What differs between these two');
        const close = modal.querySelector('#compare-two-close');
        close.setAttribute('aria-label', tr('common.close', 'Close'));
        const hide = () => app()?.hideModal?.(MODAL_ID);
        close.addEventListener('click', hide);
        modal.querySelector('.modal-backdrop').addEventListener('click', hide);
    }

    function picture(info, label) {
        const figure = el('button', 'compare-two-picture');
        figure.type = 'button';
        figure.title = tr('compareTwo.open', 'Open this picture');
        const image = document.createElement('img');
        image.alt = info.filename || '';
        image.src = app()?.API?.getThumbnailUrl?.(info.id) || `/api/image-thumbnail/${info.id}?size=256`;
        figure.append(image, el('span', 'compare-two-label', label), el('span', 'compare-two-name', info.filename || `#${info.id}`));
        figure.addEventListener('click', () => {
            app()?.hideModal?.(MODAL_ID);
            global.Gallery?.openPreview?.(info.id);
        });
        return figure;
    }

    async function run() {
        const api = app();
        if (!api) return;
        const ids = (typeof global.getSelectedGalleryIds === 'function' ? global.getSelectedGalleryIds() : []).map(Number).filter(Boolean);
        if (ids.length !== 2) {
            api.showToast?.(tr('compareTwo.needTwo', 'Select exactly two pictures to compare them.'), 'info');
            return;
        }
        // The earlier picture is "before": by the library's time when the Gallery has it, else by id.
        const loaded = new Map((api.AppState?.images || []).map((image) => [Number(image.id), image]));
        const when = (id) => Number(loaded.get(id)?.library_order_time ?? loaded.get(id)?.created_at ?? NaN);
        const [earlier, later] = [...ids].sort((a, b) => {
            const gap = when(a) - when(b);
            return Number.isFinite(gap) && gap !== 0 ? gap : a - b;
        });
        let data;
        try {
            data = await api.API.get(`/api/images/${later}/changes?against=${earlier}`);
        } catch (error) {
            api.showToast?.(error?.message || String(error), 'error');
            return;
        }
        if (!modal) build();
        const pictures = modal.querySelector('.compare-two-pictures');
        pictures.replaceChildren(
            picture(data.before, tr('compareTwo.before', 'Before')),
            picture(data.after, tr('compareTwo.after', 'After')),
        );
        const body = modal.querySelector('.compare-two-changes');
        if (!data.comparable) {
            body.replaceChildren(el('p', 'modal-change-same', tr('compareTwo.noData', 'At least one of these pictures has no generation data, so there is nothing to compare.')));
        } else {
            global.ModalChanges?.draw?.(body, data, { showHead: false });
        }
        api.showModal?.(MODAL_ID);
    }

    function wire() {
        document.getElementById('btn-compare-selected')?.addEventListener('click', run);
    }

    global.CompareTwo = Object.freeze({ run });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
