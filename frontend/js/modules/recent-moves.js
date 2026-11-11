/**
 * Recent moves: undo a move or copy after its toast is gone.
 *
 * Every batch move or copy (the Gallery's Move…, a drop on a folder,
 * Auto-Separate) can be undone, but the Undo button lived only in the result
 * toast or banner: twelve seconds, or until the page changed. The server
 * keeps the record of the last 100 runs, so this dialog lists them, newest
 * first, each with when, what, where to and how many files, and an Undo for
 * the ones not undone yet.
 *
 * GET /api/batch-move/runs lists them (services/sorting/move_runs.py); the
 * undo itself is the same one the toast uses (app/gallery-move-undo.js).
 */
(function initRecentMoves(global) {
    'use strict';

    const MODAL_ID = 'recent-moves-modal';
    const PAGE = 20;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;
    let modal = null;
    let shown = 0;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    function build() {
        modal = el('div', 'modal');
        modal.id = MODAL_ID;
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'recent-moves-title');
        const backdrop = el('div', 'modal-backdrop');
        const content = el('div', 'modal-content modal-medium recent-moves-content');
        const close = el('button', 'modal-close');
        close.type = 'button';
        close.id = 'recent-moves-close';
        close.setAttribute('aria-label', tr('common.close', 'Close'));
        close.innerHTML = global.UiIcon?.html?.('i-close') || '';
        const title = el('h3', null, tr('recentMoves.title', 'Recent moves and copies'));
        title.id = 'recent-moves-title';
        const lead = el('p', 'modal-description', tr('recentMoves.lead', 'Undo puts every file of that run back where it was (for a copy: removes the copies). Files changed since are left alone and counted.'));
        const list = el('ol', 'recent-moves-list');
        list.id = 'recent-moves-list';
        const more = el('button', 'btn btn-ghost btn-small', tr('recentMoves.older', 'Show older ones'));
        more.type = 'button';
        more.id = 'recent-moves-older';
        more.hidden = true;
        content.append(close, title, lead, list, more);
        modal.append(backdrop, content);
        document.body.appendChild(modal);
        const hide = () => app()?.hideModal?.(MODAL_ID);
        close.addEventListener('click', hide);
        backdrop.addEventListener('click', hide);
        more.addEventListener('click', () => load(false));
    }

    /** "2026-11-11 16:07": exact, and the same in both languages. */
    function when(seconds) {
        if (!Number.isFinite(Number(seconds))) return '';
        const date = new Date(Number(seconds) * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** The end of the path is what tells folders apart: "…/sorted/keep"; the full path is in the tooltip. */
    function folderEnd(folder) {
        const parts = String(folder || '').split(/[\\/]+/).filter(Boolean);
        return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
    }

    function row(run) {
        const item = el('li', 'recent-moves-row');
        item.dataset.runToken = run.run_token;
        const copy = run.operation === 'copy';
        const text = el('div', 'recent-moves-text');
        text.append(
            el('span', 'recent-moves-what', copy
                ? tr('recentMoves.copied', 'Copied {n} files', { n: run.files })
                : tr('recentMoves.moved', 'Moved {n} files', { n: run.files })),
            el('span', 'recent-moves-where', folderEnd(run.destination)),
            el('span', 'recent-moves-when', when(run.started_at)),
        );
        text.querySelector('.recent-moves-where').title = run.destination || '';
        item.appendChild(text);
        if (run.undone) {
            item.appendChild(el('span', 'recent-moves-state', tr('recentMoves.undone', 'Undone')));
        } else {
            const undo = el('button', 'btn btn-secondary btn-small', tr('modal.undo', 'Undo'));
            undo.type = 'button';
            undo.addEventListener('click', async () => {
                undo.disabled = true;
                await global.undoGalleryMove?.(run.run_token, copy);
                load(true);
            });
            item.appendChild(undo);
        }
        return item;
    }

    async function load(fresh) {
        const list = document.getElementById('recent-moves-list');
        const more = document.getElementById('recent-moves-older');
        if (fresh) shown = 0;
        let page;
        try {
            page = await app().API.get(`/api/batch-move/runs?limit=${PAGE}&offset=${shown}`);
        } catch (error) {
            list.replaceChildren(el('li', 'recent-moves-empty', error?.message || String(error)));
            more.hidden = true;
            return;
        }
        const runs = Array.isArray(page?.runs) ? page.runs : [];
        if (fresh) list.replaceChildren();
        runs.forEach((run) => list.appendChild(row(run)));
        shown += runs.length;
        if (!list.children.length) {
            list.appendChild(el('li', 'recent-moves-empty', tr('recentMoves.none', 'No move or copy has been made yet.')));
        }
        more.hidden = shown >= Number(page?.total || 0) || !runs.length;
    }

    function open() {
        const api = app();
        if (!api) return;
        if (!modal) build();
        api.showModal?.(MODAL_ID);
        load(true);
    }

    function wire() {
        document.getElementById('nav-tools-recent-moves')?.addEventListener('click', open);
    }

    global.RecentMoves = Object.freeze({ open });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
