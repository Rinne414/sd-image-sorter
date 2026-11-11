/**
 * Wander: look around the library batch by batch.
 *
 * A similarity search always shows the same neighbours. Wandering starts at a
 * picture (a random one, or the one selected in the Gallery), shows a batch of
 * pictures somewhat like it that were not shown before, and goes on from the
 * least similar one of the batch, so each "More" drifts a little further.
 * The pictures seen so far can be opened in the Gallery as one set.
 *
 * POST /api/similarity/wander gives each batch (services/wander.py).
 */
(function initWander(global) {
    'use strict';

    const BATCH = 24;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;
    const byId = (id) => document.getElementById(id);

    const walk = { seen: [], nextStart: null, busy: false };

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    function say(text, tone) {
        const status = byId('wander-status');
        if (!status) return;
        status.textContent = text;
        status.dataset.tone = tone || 'info';
    }

    function syncButtons() {
        const started = walk.seen.length > 0;
        const more = byId('btn-wander-more');
        const open = byId('btn-wander-to-gallery');
        if (more) {
            more.hidden = !started;
            more.disabled = walk.busy || walk.nextStart === null;
        }
        if (open) {
            open.hidden = !started;
            open.textContent = tr('wander.toGallery', 'Open the {n} seen in the Gallery', { n: walk.seen.length });
        }
        ['btn-wander-random', 'btn-wander-from-selection'].forEach((id) => {
            const button = byId(id);
            if (button) button.disabled = walk.busy;
        });
    }

    function card(image, isStart) {
        const button = el('button', `wander-item${isStart ? ' is-start' : ''}`);
        button.type = 'button';
        button.dataset.id = String(image.id);
        button.title = image.filename || '';
        const picture = document.createElement('img');
        picture.loading = 'lazy';
        picture.alt = image.filename || '';
        picture.src = app()?.API?.getThumbnailUrl?.(image.id) || `/api/image-thumbnail/${image.id}?size=256`;
        button.appendChild(picture);
        if (isStart) button.appendChild(el('span', 'wander-item-mark', tr('wander.startMark', 'Start')));
        button.addEventListener('click', () => global.Gallery?.openPreview?.(image.id));
        return button;
    }

    /** The last cell of the grid goes on with the walk, so "more" is where the eye ends up. */
    function moreTile(grid) {
        grid.querySelector('.wander-more-tile')?.remove();
        if (walk.nextStart === null) return;
        const tile = el('button', 'wander-item wander-more-tile', tr('wander.more', 'More, a little further'));
        tile.type = 'button';
        tile.addEventListener('click', () => batch(walk.nextStart, false));
        grid.appendChild(tile);
    }

    async function batch(startId, fresh) {
        const api = app();
        const grid = byId('wander-results');
        if (!api || !grid || walk.busy) return;
        walk.busy = true;
        syncButtons();
        say(tr('wander.loading', 'Looking around...'));
        if (fresh) {
            walk.seen = [];
            walk.nextStart = null;
            grid.textContent = '';
        }
        grid.querySelector('.wander-more-tile')?.remove();
        try {
            const body = await api.API.post('/api/similarity/wander', { start_id: startId, seen_ids: walk.seen, count: BATCH });
            const images = body.images || [];
            if (fresh && body.start) {
                grid.appendChild(card(body.start, true));
                walk.seen.push(body.start.id);
            }
            images.forEach((image) => {
                grid.appendChild(card(image, false));
                walk.seen.push(image.id);
            });
            walk.nextStart = images.length ? body.next_start_id : null;
            moreTile(grid);
            if (!images.length) {
                say(walk.seen.length
                    ? tr('wander.allSeen', 'You have seen every picture in the similarity index.')
                    : tr('wander.empty', 'There is nothing to wander through yet.'));
            } else {
                say(tr('wander.count', '{n} seen so far, {left} not yet.', { n: walk.seen.length, left: Number(body.left || 0) }));
            }
        } catch (error) {
            say(error?.message || String(error), 'error');
        } finally {
            walk.busy = false;
            syncButtons();
        }
    }

    function fromSelection() {
        const ids = typeof global.getSelectedGalleryIds === 'function' ? global.getSelectedGalleryIds() : [];
        if (!ids.length) {
            say(tr('wander.selectFirst', 'Select a picture in the Gallery first, then come back; or start from a random one.'));
            return;
        }
        batch(Number(ids[ids.length - 1]), true);
    }

    function wire() {
        byId('btn-wander-random')?.addEventListener('click', () => batch(null, true));
        byId('btn-wander-from-selection')?.addEventListener('click', fromSelection);
        byId('btn-wander-more')?.addEventListener('click', () => batch(walk.nextStart, false));
        byId('btn-wander-to-gallery')?.addEventListener('click', () => {
            if (walk.seen.length) global.GalleryPin?.open?.([...walk.seen], { source: 'wander' });
        });
        document.addEventListener('languageChanged', syncButtons);
        syncButtons();
    }

    /** Start a walk from one picture (used by other pages, e.g. a result's own button). */
    global.Wander = Object.freeze({ startFrom: (id) => batch(Number(id), true) });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
