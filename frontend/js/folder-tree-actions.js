/**
 * What can be done to a folder of the library, from its row in the sidebar.
 *
 * The tree (folder-tree.js) shows folders and filters by them, and takes
 * dropped pictures (folder-tree-drop.js). This adds the two things a folder
 * manager is expected to do in place: give a folder another name, and put the
 * selected pictures into a new folder inside it. Both open from the row's
 * "more" button or a right-click.
 *
 * Renaming is POST /api/folders/rename: the folder is renamed on disk and every
 * picture in it keeps its tags, rating and sets. Classic script.
 */
(function initFolderTreeActions(global) {
    'use strict';

    const EAGLE_LIBRARY_PATH = /\.library(\/|$)/i;
    const MENU_CLASS = 'folder-row-menu';

    function t(key, fallback, params) {
        return typeof global.appT === 'function' && global.I18n?.format
            ? global.I18n.format(global.appT(key, fallback), params || {})
            : fallback;
    }

    function app() {
        return global.App || {};
    }

    function baseName(path) {
        return String(path || '').replace(/\/+$/, '').split('/').pop() || '';
    }

    /** True when `path` is `folder` or lies under it. */
    function isAtOrUnder(path, folder) {
        const a = String(path || '').toLowerCase();
        const b = String(folder || '').toLowerCase();
        return a === b || a.startsWith(`${b}/`);
    }

    function reasonOf(error) {
        // The server answers a refusal as { code, message } (a dict detail is sent flat).
        const detail = error?.apiData;
        if (detail && typeof detail === 'object' && detail.code) {
            return t(`folders.why.${detail.code}`, String(detail.message || detail.code));
        }
        return typeof global.formatUserError === 'function' ? global.formatUserError(error) : String(error?.message || error);
    }

    /** The tree and the gallery after a folder changed its name. */
    async function followRename(oldPath, newPath) {
        const tree = global.FolderTreeUI;
        if (tree?._expanded) {
            [...tree._expanded].forEach((path) => {
                if (!isAtOrUnder(path, oldPath)) return;
                tree._expanded.delete(path);
                tree._expanded.add(newPath + path.slice(oldPath.length));
            });
        }
        const browsing = app().AppState?.filters?.folder || '';
        if (browsing && isAtOrUnder(browsing, oldPath)) {
            const next = newPath + browsing.slice(oldPath.length);
            app().updateFilters?.((filters) => { filters.folder = next; });
            app().updateFilterSummary?.();
        }
        await tree?.refresh?.();
        app().loadImages?.();
    }

    async function sendRename(path, name) {
        return app().API.post('/api/folders/rename', { path, new_name: name });
    }

    async function renameFolder(path) {
        const current = baseName(path);
        const typed = await app().showInputModal?.(
            t('folders.renameTitle', 'Rename folder'),
            t('folders.renameBody', 'The folder is renamed on your disk. Its pictures keep their tags, ratings and sets.'),
            current,
        );
        const name = String(typed || '').trim();
        if (!name || name === current) return;
        let result;
        try {
            result = await sendRename(path, name);
        } catch (error) {
            app().showToast?.(
                t('folders.renameFailed', 'The folder was not renamed: {reason}', { reason: reasonOf(error) }),
                'error',
                { duration: 9000 },
            );
            return;
        }
        await followRename(result.old_path, result.new_path);
        app().showToast?.(
            t('folders.renamed', 'Renamed to {name}. {count} pictures followed.', { name, count: result.pictures }),
            'success',
            {
                duration: 12000,
                actionLabel: t('common.undo', 'Undo'),
                onAction: async () => {
                    try {
                        const back = await sendRename(result.new_path, current);
                        await followRename(back.old_path, back.new_path);
                    } catch (error) {
                        app().showToast?.(
                            t('folders.renameFailed', 'The folder was not renamed: {reason}', { reason: reasonOf(error) }),
                            'error',
                        );
                    }
                },
            },
        );
    }

    /** How the current selection would be moved, or null when nothing is selected. */
    function selectionToMove() {
        const state = app().AppState || {};
        const byToken = state.selectionScope === 'filtered' && Boolean(state.selectionToken);
        const ids = typeof global.getSelectedGalleryIds === 'function' ? global.getSelectedGalleryIds() : [];
        if (!byToken && ids.length === 0) return null;
        return { ids };
    }

    async function moveSelectionToNewFolder(path) {
        const selection = selectionToMove();
        if (!selection) return;
        const typed = await app().showInputModal?.(
            t('folders.newFolderTitle', 'New folder'),
            t('folders.newFolderBody', 'A folder with this name is made inside {folder}, and the selected pictures are moved into it.', { folder: baseName(path) }),
            '',
        );
        const name = String(typed || '').trim();
        if (!name) return;
        if (/[<>:"/\\|?*]/.test(name) || /[. ]$/.test(name)) {
            app().showToast?.(
                t('folders.newFolderBadName', 'A folder name cannot contain < > : " / \\ | ? * or end with a dot.'),
                'error',
            );
            return;
        }
        global.moveOrCopyGalleryImages?.(selection.ids, 'move', {
            source: 'selection',
            destination: `${String(path).replace(/\/+$/, '')}/${name}`,
        });
    }

    function closeMenu() {
        document.querySelector(`.${MENU_CLASS}`)?.remove();
    }

    function menuItem(icon, label, action, disabledReason) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        button.setAttribute('role', 'menuitem');
        const iconEl = document.createElement('span');
        iconEl.className = 'context-menu-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        global.UiIcon?.fill(iconEl, icon);
        const labelEl = document.createElement('span');
        labelEl.className = 'context-menu-label';
        labelEl.textContent = label;
        button.append(iconEl, labelEl);
        if (disabledReason) {
            button.disabled = true;
            button.title = disabledReason;
        } else {
            button.addEventListener('click', () => {
                closeMenu();
                action();
            });
        }
        return button;
    }

    function openMenu(path, x, y, anchor) {
        closeMenu();
        document.querySelector('.gallery-context-menu:not(.folder-row-menu)')?.remove();
        const menu = document.createElement('div');
        menu.className = `gallery-context-menu ${MENU_CLASS}`;
        menu.setAttribute('role', 'menu');
        menu.dataset.path = path;
        const eagle = EAGLE_LIBRARY_PATH.test(path);
        menu.append(
            menuItem(
                'i-edit',
                t('folders.rename', 'Rename…'),
                () => renameFolder(path),
                eagle ? t('folders.eagleOwned', 'This folder belongs to an Eagle library; change it in Eagle.') : '',
            ),
            menuItem(
                'i-folder',
                t('folders.newFolderForSelection', 'Move the selection to a new folder here…'),
                () => moveSelectionToNewFolder(path),
                eagle
                    ? t('folders.eagleOwned', 'This folder belongs to an Eagle library; change it in Eagle.')
                    : (selectionToMove() ? '' : t('folders.selectFirst', 'Select the pictures to move first.')),
            ),
        );
        document.body.appendChild(menu);
        if (typeof global.Gallery?._positionContextMenu === 'function') {
            global.Gallery._positionContextMenu(menu, x, y, anchor);
        } else {
            menu.style.left = `${x}px`;
            menu.style.top = `${y}px`;
        }
        menu.querySelector('.context-menu-item:not(:disabled)')?.focus?.();
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            // Esc closes the top layer only: this menu, not what is under it.
            event.stopPropagation();
            done();
            anchor?.focus?.();
        };
        const done = () => {
            closeMenu();
            document.removeEventListener('click', done);
            document.removeEventListener('keydown', onKey, true);
        };
        document.addEventListener('keydown', onKey, true);
        setTimeout(() => document.addEventListener('click', done), 0);
    }

    function wire() {
        const tree = document.getElementById('folder-tree');
        if (!tree || tree.dataset.actionsBound === '1') return;
        tree.dataset.actionsBound = '1';
        tree.addEventListener('click', (event) => {
            const more = event.target.closest('.folder-row-more');
            if (!more) return;
            event.stopPropagation();
            const box = more.getBoundingClientRect();
            openMenu(more.dataset.path, box.left, box.bottom + 2, more);
        });
        tree.addEventListener('contextmenu', (event) => {
            const row = event.target.closest('.folder-row');
            if (!row?.dataset.path) return;
            event.preventDefault();
            openMenu(row.dataset.path, event.clientX, event.clientY, row.querySelector('.folder-row-more'));
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
