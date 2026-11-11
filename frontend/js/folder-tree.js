/**
 * SD Image Sorter - Library folder-tree navigation (gallery subset filter)
 *
 * v3.3.2 Library Navigation: renders a collapsible "Folders" tree inside the
 * gallery filter sidebar built from the distinct directories that contain
 * indexed images (GET /api/folders). Clicking a folder scopes the gallery to
 * that folder *and everything beneath it* (recursive subtree) via the
 * `folder` gallery filter, exactly the way the Collections section drives
 * `collectionId`. Re-clicking the active folder clears the scope.
 *
 * This is distinct from `folder-browser.js`, which is a raw filesystem picker
 * for the scan/import modal. This module only ever lists folders that are
 * already in the library.
 *
 * Single source of truth for the folder scope is the gallery filter state,
 * driven through App.updateFilters(f => { f.folder = path; }).
 */
(function () {
    'use strict';

    function appRef() {
        return window.App || {};
    }

    const EAGLE_LIBRARY_PATH = /\.library([\\/]|$)/i;
    const EAGLE_ITEM_FOLDER = /^(.*\.library[\\/]images)[\\/][^\\/]+\.info$/i;

    /**
     * An Eagle library keeps every item in a folder of its own ("<ID>.info"): ten
     * thousand pictures would be ten thousand rows that mean nothing to a person.
     * They are shown as the library's one "images" folder, with their counts added up.
     */
    function collapseEagleItemFolders(folders, counts) {
        const kept = [];
        const seen = new Set();
        const sums = counts && typeof counts === 'object' ? { ...counts } : null;
        folders.forEach((path) => {
            const item = EAGLE_ITEM_FOLDER.exec(String(path));
            const shown = item ? item[1] : path;
            if (!seen.has(shown)) {
                seen.add(shown);
                kept.push(shown);
            }
            if (item && sums) {
                sums[shown] = (Number(sums[shown]) || 0) + (Number(sums[path]) || 0);
                delete sums[path];
            }
        });
        return { folders: kept, counts: sums };
    }

    function log(level, message, error) {
        const logger = appRef().Logger || window.Logger;
        if (logger && typeof logger[level] === 'function') {
            logger[level](message, error);
        }
    }

    function t(key, fallback, params) {
        const value = window.I18n.t(key, params);
        return value && value !== key ? value : window.I18n.format(fallback, params);
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }

    /**
     * Normalize a stored directory path to forward slashes with no trailing
     * separator. The backend already returns forward-slash dirs, but we stay
     * defensive so the tree keys match the value we send back as `?folder=`.
     */
    function normalizePath(raw) {
        return String(raw ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    }

    const FolderTreeUI = {
        _folders: [],
        _libraryDirs: new Set(),
        _tree: null,
        _expanded: new Set(),
        _active: null,
        _seeded: false,
        _initialized: false,

        async init() {
            if (this._initialized) {
                await this.refresh();
                return;
            }
            this._initialized = true;

            const refreshBtn = document.getElementById('btn-refresh-folders');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => this.refresh({ manual: true }));
            }
            const container = document.getElementById('folder-tree');
            if (container) {
                // Event delegation so we never re-bind per row on re-render.
                container.addEventListener('click', (event) => this._onClick(event));
            }
            document.addEventListener('languageChanged', () => this._relocalize());
            window.addEventListener('resize', () => this._scheduleActiveVisibility());
            await this.refresh();
        },

        async refresh(options = {}) {
            try {
                const result = await appRef().API?.listLibraryFolders?.();
                const listed = Array.isArray(result?.folders) ? result.folders : [];
                const { folders, counts } = collapseEagleItemFolders(listed, result?.counts);
                const previous = new Set(this._folders.map((path) => normalizePath(path)));
                this._folders = folders;
                this._libraryDirs = new Set(folders.map((path) => normalizePath(path)));
                this._tree = this._buildTree(folders);
                this._counts = counts;
                this._addCounts(this._tree, counts);
                // Sync the highlighted/active folder from the persisted gallery
                // filter so a reload keeps the tree and the gallery in step.
                const current = normalizePath(appRef().AppState?.filters?.folder || '');
                this._active = current || null;
                // Unfold once the tree first has folders (a fresh library starts
                // empty), then keep each newly imported folder in view.
                if (!this._seeded && this._tree.children.size > 0) {
                    const tops = [...this._tree.children.values()];
                    tops.forEach((node) => this._seedDefaults(node, 0, tops.length === 1));
                    this._seeded = true;
                } else if (this._seeded) {
                    folders.map((path) => normalizePath(path))
                        .filter((path) => path && !previous.has(path))
                        .forEach((path) => this._expandAncestors(path));
                }
                if (this._active) this._expandAncestors(this._active);
                this._renderTree();
                this._scheduleActiveVisibility();
            } catch (error) {
                log('warn', 'Failed to load library folders', error);
                if (options.manual) this._explainRefreshFailure(error);
            }
        },

        /** The library's folders that hold pictures, with how many (Move / Copy dialog). */
        libraryFolders() {
            // Inside an Eagle library every folder is Eagle's own: not a place to move pictures to.
            return this._folders.filter((path) => !EAGLE_LIBRARY_PATH.test(path)).map((path) => {
                const count = Number(this._counts?.[path]);
                return Number.isFinite(count) ? { path, count } : { path };
            });
        },

        /** A refresh the user asked for failed: say why, and offer another try. */
        _explainRefreshFailure(error) {
            const reason = window.ServerWatch?.isNetworkFailure(error)
                ? t('server.noAnswer', 'the program is not answering')
                : (typeof formatUserError === 'function' ? formatUserError(error) : String(error?.message || error));
            appRef().showToast?.(
                t('folders.refreshFailed', 'Could not refresh the folders: {reason}', { reason }),
                'error',
                {
                    duration: 8000,
                    actionLabel: t('folders.retry', 'Try again'),
                    onAction: () => this.refresh({ manual: true }),
                },
            );
        },

        /**
         * Each node's picture count: its own pictures plus every sub-folder's,
         * which is what clicking the row shows (the folder filter is
         * recursive). Without counts from the server no row shows a number.
         */
        _addCounts(root, counts) {
            if (!counts || typeof counts !== 'object') return;
            const direct = new Map(Object.entries(counts).map(([path, n]) => [normalizePath(path), Number(n) || 0]));
            const sum = (node) => {
                let total = direct.get(node.path) || 0;
                node.children.forEach((kid) => { total += sum(kid); });
                node.count = total;
                return total;
            };
            root.children.forEach((node) => sum(node));
        },

        /** Build a nested tree (Map of children) from a flat list of dir paths. */
        _buildTree(paths) {
            const root = { name: '', path: '', children: new Map() };
            for (const raw of paths) {
                const norm = normalizePath(raw);
                if (!norm) continue;
                const segs = norm.split('/');
                let node = root;
                for (let i = 0; i < segs.length; i++) {
                    const seg = segs[i];
                    if (seg === '' && i > 0) continue; // collapse interior // (double slash)
                    const path = segs.slice(0, i + 1).join('/') || '/';
                    const key = seg || '/';
                    if (!node.children.has(key)) {
                        node.children.set(key, { name: key, path, children: new Map() });
                    }
                    node = node.children.get(key);
                }
            }
            return root;
        },

        /**
         * Seed the default expanded set ONCE: reveal the first level and keep
         * unfolding through single-child chains so a long common prefix
         * (L:/ › Pictures › Library) doesn't force the user to click through
         * empty levels. Branch points start collapsed, except the first one
         * when every folder sits under it: that is the folder the user scanned,
         * and its sub-folders are the library's real first level (2026-11-09:
         * one collapsed "pictures" row hid all eight folders).
         */
        _seedDefaults(node, depth, onlyChain = true) {
            const kids = [...node.children.values()];
            if (kids.length === 0) return;
            if (depth === 0 || kids.length === 1) {
                this._expanded.add(node.path);
                kids.forEach((kid) => this._seedDefaults(kid, depth + 1, onlyChain && kids.length === 1));
            } else if (onlyChain) {
                this._expanded.add(node.path);
            }
        },

        /**
         * The folders that share one row: a folder that holds no pictures of its
         * own and has a single sub-folder is shown together with it, the way an
         * IDE compacts them (C:/Users/me/Pictures). Filtering by the last folder
         * gives the same pictures as filtering by any folder above it.
         */
        _chainFrom(node) {
            const chain = [node];
            let current = node;
            while (current.children.size === 1 && !this._libraryDirs.has(current.path)) {
                current = [...current.children.values()][0];
                chain.push(current);
            }
            return chain;
        },

        /** "C:/Users/me/AppData/Local/pictures" -> "C:/…/Local/pictures" (the full path is the tooltip). */
        _chainLabel(chain) {
            const names = chain.map((node) => node.name);
            const shown = names.length > 3 ? [names[0], '…', ...names.slice(-2)] : names;
            return names[0] === '/' ? `/${shown.slice(1).join('/')}` : shown.join('/');
        },

        /**
         * The chain label with its leading folders in a span a look may hide, so
         * the row can show just the folder's own name (the tooltip has the path).
         */
        _chainLabelHtml(chain) {
            const label = this._chainLabel(chain);
            const cut = label.lastIndexOf('/');
            if (cut <= 0 || cut === label.length - 1) return escapeHtml(label);
            return `<span class="folder-row-prefix">${escapeHtml(label.slice(0, cut + 1))}</span>${escapeHtml(label.slice(cut + 1))}`;
        },

        /** The row's folder button for a path; a path inside a chain finds the chain's row. */
        _openButtonFor(path) {
            const container = document.getElementById('folder-tree');
            return [...(container?.querySelectorAll('.folder-row-open') || [])].find((row) => {
                if (normalizePath(row.dataset.path) === path) return true;
                try {
                    return JSON.parse(row.dataset.chain || '[]').some((entry) => normalizePath(entry) === path);
                } catch (_error) {
                    return false;
                }
            });
        },

        /** Make sure every ancestor of `path` is expanded so it's visible. */
        _expandAncestors(path) {
            const segs = normalizePath(path).split('/');
            for (let i = 1; i < segs.length; i++) {
                const ancestor = segs.slice(0, i).join('/') || '/';
                if (ancestor) this._expanded.add(ancestor);
            }
        },

        _renderTree() {
            const container = document.getElementById('folder-tree');
            if (!container) return;
            const top = this._tree ? [...this._tree.children.values()] : [];
            if (top.length === 0) {
                container.innerHTML = `<p class="folder-tree-empty">${escapeHtml(t('folders.empty', 'No folders yet. Scan one to filter by it here.'))}</p>`;
                this._renderBrowsingIndicator();
                return;
            }
            container.innerHTML = top.map((node) => this._nodeHtml(node, 0)).join('');
            this._renderBrowsingIndicator();
        },

        _relocalize() {
            const container = document.getElementById('folder-tree');
            if (!container) return;
            const sidebarScroll = container.closest('.filter-sidebar-scroll');
            const treeScrollTop = container.scrollTop;
            const sidebarScrollTop = sidebarScroll?.scrollTop || 0;
            this._renderTree();
            container.scrollTop = treeScrollTop;
            if (sidebarScroll) sidebarScroll.scrollTop = sidebarScrollTop;
            // Re-rendering in another language reflows the rows, so the restored
            // offset alone can leave the browsed folder out of view. Reveal it
            // again, like every other path that re-renders the tree.
            this._scheduleActiveVisibility();
        },

        _scheduleActiveVisibility() {
            if (!this._active) return;
            const activePath = this._active;
            requestAnimationFrame(() => {
                if (this._active !== activePath) return;
                const container = document.getElementById('folder-tree');
                const activeRow = this._openButtonFor(activePath);
                if (!activeRow || !container) return;

                const revealWithin = (scroller) => {
                    const rowBox = activeRow.getBoundingClientRect();
                    const scrollerBox = scroller.getBoundingClientRect();
                    const margin = 1;
                    if (rowBox.top < scrollerBox.top + margin) {
                        scroller.scrollTop -= scrollerBox.top + margin - rowBox.top;
                    } else if (rowBox.bottom > scrollerBox.bottom - margin) {
                        scroller.scrollTop += rowBox.bottom - scrollerBox.bottom + margin;
                    }
                };

                revealWithin(container);
                requestAnimationFrame(() => {
                    if (this._active !== activePath) return;
                    const sidebarScroll = container.closest('.filter-sidebar-scroll');
                    if (sidebarScroll) revealWithin(sidebarScroll);
                });
            });
        },

        _isActiveVisible() {
            if (!this._active) return false;
            const container = document.getElementById('folder-tree');
            const activeRow = this._openButtonFor(this._active);
            const sidebarScroll = container?.closest('.filter-sidebar-scroll');
            if (!activeRow || !container || !sidebarScroll) return false;

            const rowBox = activeRow.getBoundingClientRect();
            return [container, sidebarScroll].every((scroller) => {
                const scrollerBox = scroller.getBoundingClientRect();
                return rowBox.top >= scrollerBox.top && rowBox.bottom <= scrollerBox.bottom;
            });
        },

        _nodeHtml(start, depth) {
            const chain = this._chainFrom(start);
            const node = chain.at(-1);
            const hasKids = node.children.size > 0;
            const isExpanded = this._expanded.has(node.path);
            const isActive = this._active != null && chain.some((link) => link.path === this._active);
            const pad = 6 + depth * 14;
            const safePath = escapeHtml(node.path);
            const chainAttr = chain.length > 1
                ? ` data-chain="${escapeHtml(JSON.stringify(chain.map((link) => link.path)))}"`
                : '';

            const toggle = hasKids
                ? `<button type="button" class="folder-row-toggle" data-action="toggle" data-path="${safePath}" `
                    + `aria-label="${escapeHtml(t('folders.toggle', 'Expand / collapse'))}" aria-expanded="${isExpanded ? 'true' : 'false'}">`
                    + '<span aria-hidden="true"></span></button>'
                : '<span class="folder-row-toggle folder-row-toggle-empty" aria-hidden="true"></span>';

            let html = `<div class="folder-row${isActive ? ' is-active' : ''}" `
                + `style="padding-left:${pad}px" data-path="${safePath}">`
                + toggle
                + `<button type="button" class="folder-row-open" data-action="browse" data-path="${safePath}"${chainAttr} `
                + `aria-pressed="${isActive ? 'true' : 'false'}" title="${safePath}">`
                + '<span class="folder-row-icon" aria-hidden="true"><svg class="icon" aria-hidden="true"><use href="#i-folder"/></svg></span>'
                + `<span class="folder-row-name">${this._chainLabelHtml(chain)}</span>`
                + (Number.isFinite(node.count) ? `<span class="folder-row-count">${node.count}</span>` : '')
                + '</button></div>';

            if (hasKids && isExpanded) {
                html += [...node.children.values()].map((kid) => this._nodeHtml(kid, depth + 1)).join('');
            }
            return html;
        },

        _renderBrowsingIndicator() {
            const container = document.getElementById('folder-tree');
            if (!container) return;
            document.getElementById('folder-tree-browsing')?.remove();
            if (this._active == null) return;

            const name = this._active;
            const indicator = document.createElement('div');
            indicator.id = 'folder-tree-browsing';
            // Reuse the Collections "Browsing: …" chrome, but the folder
            // variant wraps so the FULL path is always visible (no ellipsis).
            indicator.className = 'collections-browsing folder-tree-browsing';
            const label = I18n.format(t('folders.scoped', 'Folder: {name}'), { name: name });
            indicator.innerHTML = `<span class="folder-tree-browsing-label" title="${escapeHtml(name)}">${escapeHtml(label)}</span>`
                + '<button type="button" id="folder-tree-clear" class="collections-browsing-clear" '
                + `title="${escapeHtml(t('folders.clearScope', 'Show all folders'))}" `
                + `aria-label="${escapeHtml(t('folders.clearScope', 'Show all folders'))}">`
                + '<span aria-hidden="true"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></span></button>';
            indicator.querySelector('#folder-tree-clear')
                ?.addEventListener('click', () => this.clearBrowse());
            container.parentNode?.insertBefore(indicator, container.nextSibling);
        },

        _onClick(event) {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            const action = trigger.dataset.action;
            const path = trigger.dataset.path;
            if (!path) return;

            if (action === 'toggle') {
                const container = document.getElementById('folder-tree');
                const scrollTop = container?.scrollTop || 0;
                if (this._expanded.has(path)) {
                    this._expanded.delete(path);
                } else {
                    this._expanded.add(path);
                }
                this._renderTree();
                const refreshedToggle = [...(container?.querySelectorAll('[data-action="toggle"]') || [])]
                    .find((toggle) => normalizePath(toggle.dataset.path) === normalizePath(path));
                refreshedToggle?.focus({ preventScroll: true });
                if (container) container.scrollTop = scrollTop;
            } else if (action === 'browse') {
                this.browse(path);
            }
        },

        browse(path) {
            const app = appRef();
            const target = normalizePath(path);
            // Re-clicking the active folder toggles the scope back off.
            if (this._active === target) {
                this.clearBrowse();
                return;
            }
            this._active = target;
            this._expandAncestors(target); // keep the scoped row visible even if its parent was collapsed
            app.updateFilters?.((filters) => { filters.folder = target; });
            app.updateFilterSummary?.();
            app.loadImages?.();
            this._renderTree();
            this._scheduleActiveVisibility();
        },

        clearBrowse() {
            const app = appRef();
            this._active = null;
            app.updateFilters?.((filters) => { filters.folder = null; });
            app.updateFilterSummary?.();
            app.loadImages?.();
            this._renderTree();
        },

        isScoped() {
            return this._active != null;
        },
    };

    window.FolderTreeUI = FolderTreeUI;
})();
