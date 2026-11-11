/**
 * Drop pictures on a folder in the sidebar to move their files there.
 *
 * The Gallery's cards already carry what a drop needs (the picture, or the
 * whole selection when the dragged card is part of it: collections-tree.js
 * markImageDrag), and "Move to folder" already knows how to move files with a
 * progress bar and an Undo. This joins the two: a folder row lights up under
 * the drag, and a drop asks the same question the menu does ("Move N files to
 * <folder>?") and then runs the same move. Nothing moves without that answer,
 * and the result toast keeps its Undo.
 */
(function initFolderTreeDrop(global) {
    'use strict';

    const IMAGE_DRAG = 'application/x-sd-sorter-images';
    const TARGET_CLASS = 'is-drop-target';

    const carriesPictures = (event) => Array.from(event.dataTransfer?.types || []).includes(IMAGE_DRAG);
    const rowUnder = (event) => event.target?.closest?.('.folder-row[data-path]') || null;

    function clearTarget(tree) {
        tree.querySelectorAll(`.${TARGET_CLASS}`).forEach((row) => row.classList.remove(TARGET_CLASS));
    }

    function readPayload(event) {
        try {
            const payload = JSON.parse(event.dataTransfer.getData(IMAGE_DRAG) || 'null');
            if (!payload) return null;
            const ids = (payload.ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0);
            return { ids, token: payload.token || null };
        } catch (_error) {
            return null;
        }
    }

    function moveTo(payload, folder) {
        const move = global.moveOrCopyGalleryImages;
        if (typeof move !== 'function') return;
        // A drag that stands for "all matching" is the selection itself: the move reads it the way the menu does.
        if (payload.token) {
            const selected = typeof global.getSelectedGalleryIds === 'function' ? global.getSelectedGalleryIds() : [];
            move(selected, 'move', { source: 'selection', destination: folder });
            return;
        }
        move(payload.ids, 'move', { source: payload.ids.length === 1 ? 'context' : 'drag', destination: folder });
    }

    function wire() {
        const tree = document.getElementById('folder-tree');
        if (!tree || tree.dataset.dropBound === '1') return;
        tree.dataset.dropBound = '1';

        tree.addEventListener('dragover', (event) => {
            if (!carriesPictures(event)) return;
            const row = rowUnder(event);
            clearTarget(tree);
            if (!row) return;
            event.preventDefault();
            // The page itself takes drops as "import these files": this one is ours.
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            row.classList.add(TARGET_CLASS);
        });
        tree.addEventListener('dragleave', (event) => {
            if (!tree.contains(event.relatedTarget)) clearTarget(tree);
        });
        tree.addEventListener('drop', (event) => {
            if (!carriesPictures(event)) return;
            const row = rowUnder(event);
            clearTarget(tree);
            if (!row) return;
            event.preventDefault();
            event.stopPropagation();
            const payload = readPayload(event);
            if (!payload || (payload.ids.length === 0 && !payload.token)) {
                global.App?.showToast?.(
                    typeof global.appT === 'function'
                        ? global.appT('folders.dropNothing', 'Nothing to move yet: the selection is still updating. Try again in a moment.')
                        : 'Nothing to move yet: the selection is still updating. Try again in a moment.',
                    'info',
                );
                return;
            }
            moveTo(payload, row.dataset.path);
        });
        document.addEventListener('dragend', () => clearTarget(tree));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
