/**
 * collections-tree.js - collections inside collections in the classic sidebar.
 *
 * The order and depth of the rows (and of the Add to collection picker), which
 * parents are folded, the Move to... picker, and drag and drop:
 * - pictures dragged from the gallery onto a collection are added to it (a
 *   picked picture brings the whole selection; a Group runs stack its run);
 * - a collection dragged onto another goes inside it, onto the "top level"
 *   strip back to the top.
 * The server keeps the rules (db_collection_tree.py): no collection inside
 * itself or below itself, Favorites at the top, deleting lifts sub-collections.
 *
 * Classic script: window.CollectionsTree. collections-ui.js renders the rows
 * and calls in here; this file never draws the list itself.
 */
(function () {
    'use strict';

    const FAVORITES_SLUG = 'favorites';
    const FOLD_KEY = 'sd-sorter:collection-folds';
    const IMAGE_DRAG = 'application/x-sd-sorter-images';
    const COLLECTION_DRAG = 'application/x-sd-sorter-collection';

    let draggingCollectionId = null;

    function t(key, fallback, params) {
        const value = window.I18n?.t?.(key, params);
        return value && value !== key ? value : (window.I18n?.format?.(fallback, params) ?? fallback);
    }

    function readFolds() {
        try {
            return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]').map(Number));
        } catch (_error) {
            return new Set();
        }
    }

    function writeFolds(folds) {
        try {
            localStorage.setItem(FOLD_KEY, JSON.stringify([...folds]));
        } catch (_error) {
            // Storage blocked: folding still works until the page reloads.
        }
    }

    /**
     * Rows in display order: Favorites, then every collection followed by the
     * ones inside it (newest first at each level), with depth and fold state.
     * A collection whose parent is gone sits at the top level; bad data that
     * loops is still shown once.
     */
    function order(collections, folds = readFolds()) {
        const ids = new Set(collections.map((c) => Number(c.id)));
        const byParent = new Map();
        collections.forEach((c) => {
            if (c.slug === FAVORITES_SLUG) return;
            const parent = c.parent_id != null && ids.has(Number(c.parent_id)) ? Number(c.parent_id) : null;
            if (!byParent.has(parent)) byParent.set(parent, []);
            byParent.get(parent).push(c);
        });
        byParent.forEach((list) => list.sort((a, b) => (b.id || 0) - (a.id || 0)));

        const rows = collections
            .filter((c) => c.slug === FAVORITES_SLUG)
            .map((c) => ({ collection: c, depth: 0, hasChildren: false, folded: false, hidden: false }));
        const seen = new Set();
        const visit = (collection, depth, hidden) => {
            const id = Number(collection.id);
            if (seen.has(id)) return;
            seen.add(id);
            const children = byParent.get(id) || [];
            const folded = children.length > 0 && folds.has(id);
            rows.push({ collection, depth, hasChildren: children.length > 0, folded, hidden });
            children.forEach((child) => visit(child, depth + 1, hidden || folded));
        };
        (byParent.get(null) || []).forEach((c) => visit(c, 0, false));
        collections.forEach((c) => {
            if (c.slug !== FAVORITES_SLUG && !seen.has(Number(c.id))) visit(c, 0, false);
        });
        return rows;
    }

    /** Ids of every collection inside this one, at any depth. */
    function descendants(collections, id) {
        const below = new Set();
        let frontier = [Number(id)];
        while (frontier.length) {
            const next = [];
            collections.forEach((c) => {
                const childId = Number(c.id);
                if (c.parent_id != null && frontier.includes(Number(c.parent_id)) && !below.has(childId)) {
                    below.add(childId);
                    next.push(childId);
                }
            });
            frontier = next;
        }
        return below;
    }

    function toggleFold(id) {
        const folds = readFolds();
        if (folds.has(Number(id))) folds.delete(Number(id));
        else folds.add(Number(id));
        writeFolds(folds);
    }

    function nameOf(collection) {
        return collection.slug === FAVORITES_SLUG ? t('collections.favorites', 'Favorites') : (collection.name || '');
    }

    function ui() {
        return window.CollectionsUI;
    }

    // ---- moving a collection ---------------------------------------------

    async function move(collectionId, parentId) {
        const list = ui()?._collections || [];
        const moving = list.find((c) => Number(c.id) === Number(collectionId));
        const target = parentId == null ? null : list.find((c) => Number(c.id) === Number(parentId));
        // Already there: nothing moves, so nothing is said.
        const currentParent = moving?.parent_id == null ? null : Number(moving.parent_id);
        if (moving && currentParent === (parentId == null ? null : Number(parentId))) return;
        try {
            await window.App?.API?.moveCollection?.(collectionId, parentId);
            if (parentId != null) {
                // Show where it went: the new parent opens.
                const folds = readFolds();
                if (folds.delete(Number(parentId))) writeFolds(folds);
            }
            await ui()?.refresh?.();
            const message = target
                ? t('collections.moved', 'Moved {name} into {target}', { name: nameOf(moving || {}), target: nameOf(target) })
                : t('collections.movedTop', 'Moved {name} to the top level', { name: nameOf(moving || {}) });
            window.App?.showToast?.(message, 'success');
        } catch (error) {
            const reason = String(error?.message || '');
            window.App?.showToast?.(t('collections.moveFailed', 'Could not move the collection: {reason}', { reason }), 'error');
        }
    }

    /** "Move to...": the top level and every collection it may go into (not itself, not below it, not Favorites). */
    function openMovePicker(collectionId) {
        const list = ui()?._collections || [];
        const moving = list.find((c) => Number(c.id) === Number(collectionId));
        if (!moving) return;
        const blocked = descendants(list, collectionId);
        blocked.add(Number(collectionId));
        const header = t('collections.moveToTitle', 'Move "{name}" to', { name: nameOf(moving) });
        const items = [{ label: t('collections.topLevel', 'Top level'), depth: 0, current: moving.parent_id == null, run: () => move(collectionId, null) }];
        order(list, new Set()).forEach(({ collection, depth }) => {
            const id = Number(collection.id);
            if (collection.slug === FAVORITES_SLUG || blocked.has(id)) return;
            items.push({
                label: nameOf(collection),
                depth: depth + 1,
                current: Number(moving.parent_id) === id,
                run: () => move(collectionId, id),
            });
        });
        ui()?._openMenu?.(header, items);
    }

    /** The row's "More" menu: make a collection inside it, or move it. */
    function openRowMenu(collectionId) {
        const list = ui()?._collections || [];
        const collection = list.find((c) => Number(c.id) === Number(collectionId));
        if (!collection) return;
        ui()?._openMenu?.(nameOf(collection), [
            { label: t('collections.newInside', 'New collection inside…'), depth: 0, run: () => ui()?.createPrompt?.(Number(collectionId)) },
            { label: t('collections.moveTo', 'Move to…'), depth: 0, run: () => openMovePicker(collectionId) },
        ]);
    }

    // ---- drag and drop -------------------------------------------------------

    /** What a gallery card carries when dragged: the picks if it is picked, a stack's run, or itself. */
    function imagePayload(image, card) {
        const app = window.App || {};
        const id = Number(image?.id);
        // As the tile shows it: a Group runs stack counts as picked only when all of it is.
        const picked = card?.classList
            ? card.classList.contains('selected')
            : (typeof window.isGalleryImageSelected === 'function' && app.AppState
                && window.isGalleryImageSelected(app.AppState, id));
        if (picked) {
            const ids = typeof window.getSelectedGalleryIds === 'function' ? window.getSelectedGalleryIds() : [id];
            const token = typeof window.getActiveSelectionTokenForActions === 'function'
                ? window.getActiveSelectionTokenForActions()
                : null;
            return { ids, token: token || null };
        }
        const runIds = card?.dataset?.runIds;
        if (runIds) return { ids: runIds.split(',').map(Number), token: null };
        return { ids: [id], token: null };
    }

    /** Called from the gallery card's dragstart: adds what the sidebar needs, leaves the file drag as it is. */
    function markImageDrag(event, image, card) {
        try {
            event.dataTransfer.setData(IMAGE_DRAG, JSON.stringify(imagePayload(image, card)));
        } catch (_error) {
            // A browser that refuses custom types still drags the file out as before.
        }
    }

    function dragKind(event) {
        const types = Array.from(event.dataTransfer?.types || []);
        if (types.includes(COLLECTION_DRAG) && draggingCollectionId != null) return 'collection';
        if (types.includes(IMAGE_DRAG)) return 'images';
        return null;
    }

    /** Whether the row under the pointer takes this drag. */
    function rowAccepts(kind, row) {
        if (!row) return false;
        const id = Number(row.dataset.id);
        if (kind === 'images') return true;
        if (kind !== 'collection' || row.classList.contains('is-favorites')) return false;
        const list = ui()?._collections || [];
        if (id === Number(draggingCollectionId)) return false;
        return !descendants(list, draggingCollectionId).has(id);
    }

    function clearTargets(listEl) {
        listEl.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        document.getElementById('collections-drop-top')?.classList.remove('is-drop-target');
    }

    function endCollectionDrag() {
        draggingCollectionId = null;
        document.getElementById('sidebar-body-collections')?.classList.remove('is-moving-collection');
        const listEl = document.getElementById('collections-list');
        if (listEl) clearTargets(listEl);
    }

    async function dropImages(event, row) {
        let payload = null;
        try {
            payload = JSON.parse(event.dataTransfer.getData(IMAGE_DRAG) || 'null');
        } catch (_error) {
            payload = null;
        }
        if (!payload) return;
        const id = Number(row.dataset.id);
        const collection = (ui()?._collections || []).find((c) => Number(c.id) === id);
        if (!collection) return;
        const ids = (payload.ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
        if (ids.length === 0 && !payload.token) {
            window.App?.showToast?.(t('collections.dropNothing', 'Nothing to add yet: the selection is still updating. Try again in a moment.'), 'info');
            return;
        }
        await ui()?._addToCollection?.(id, nameOf(collection), ids, payload.token || null);
    }

    function bind() {
        const listEl = document.getElementById('collections-list');
        const topEl = document.getElementById('collections-drop-top');
        const body = document.getElementById('sidebar-body-collections');
        if (!listEl || listEl.dataset.treeBound === '1') return;
        listEl.dataset.treeBound = '1';

        listEl.addEventListener('dragstart', (event) => {
            const row = event.target.closest?.('.collection-row[draggable="true"]');
            if (!row) return;
            draggingCollectionId = Number(row.dataset.id);
            event.dataTransfer.setData(COLLECTION_DRAG, String(draggingCollectionId));
            event.dataTransfer.effectAllowed = 'move';
            const moving = (ui()?._collections || []).find((c) => Number(c.id) === draggingCollectionId);
            // The "top level" strip is offered only to a collection that is inside another.
            if (moving?.parent_id != null) body?.classList.add('is-moving-collection');
        });
        listEl.addEventListener('dragend', endCollectionDrag);
        // The source row can be redrawn mid-drag and never send dragend: the document still does.
        document.addEventListener('dragend', () => {
            if (draggingCollectionId != null) endCollectionDrag();
        });

        // dragenter must be cancelled too: an element that lets dragenter pass
        // is not a drop target, and the browser sends the following dragover
        // events to the page body instead (the HTML drag-and-drop rules).
        const onOver = (event) => {
            const kind = dragKind(event);
            if (!kind) return;
            const row = event.target.closest?.('.collection-row');
            clearTargets(listEl);
            if (!rowAccepts(kind, row)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = kind === 'images' ? 'copy' : 'move';
            row.classList.add('is-drop-target');
        };
        listEl.addEventListener('dragenter', onOver);
        listEl.addEventListener('dragover', onOver);
        listEl.addEventListener('dragleave', (event) => {
            if (!listEl.contains(event.relatedTarget)) clearTargets(listEl);
        });
        listEl.addEventListener('drop', (event) => {
            const kind = dragKind(event);
            const row = event.target.closest?.('.collection-row');
            if (!kind || !rowAccepts(kind, row)) return;
            event.preventDefault();
            // Handled here: the gallery view's own drop (import files) must not see it.
            event.stopPropagation();
            const movingId = draggingCollectionId;
            clearTargets(listEl);
            if (kind === 'images') dropImages(event, row);
            else move(movingId, Number(row.dataset.id));
            endCollectionDrag();
        });

        if (topEl) {
            const onTopOver = (event) => {
                if (dragKind(event) !== 'collection') return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                topEl.classList.add('is-drop-target');
            };
            topEl.addEventListener('dragenter', onTopOver);
            topEl.addEventListener('dragover', onTopOver);
            topEl.addEventListener('dragleave', () => topEl.classList.remove('is-drop-target'));
            topEl.addEventListener('drop', (event) => {
                if (dragKind(event) !== 'collection') return;
                event.preventDefault();
                event.stopPropagation();
                const movingId = draggingCollectionId;
                endCollectionDrag();
                move(movingId, null);
            });
        }
    }

    window.CollectionsTree = {
        order,
        descendants,
        readFolds,
        toggleFold,
        openRowMenu,
        openMovePicker,
        move,
        markImageDrag,
        imagePayload,
        bind,
        IMAGE_DRAG,
        COLLECTION_DRAG,
    };
})();
