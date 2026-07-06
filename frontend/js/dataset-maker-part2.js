/**
 * Dataset Maker - Part 2 (active image, caption rendering, export flow,
 * modals). Loaded by dataset-maker.js as a sibling so each file stays
 * within easy reading length.
 *
 * Adds methods to ``window.DatasetMaker``.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---------- Active image + caption editor ----------
    DM._zoomLevel = 1;
    DM._queueViewMode = (() => {
        try { return localStorage.getItem('sd-image-sorter-dataset-queue-mode') || 'grid'; }
        catch { return 'grid'; }
    })();

    DM._thumbSrc = function (id, size = 128) {
        const numericId = Number(id);
        const meta = this.meta.get(numericId) || {};
        if (this.isLocalId && this.isLocalId(numericId)) {
            return meta.thumb_b64 ? `data:image/jpeg;base64,${meta.thumb_b64}` : '';
        }
        return `/api/image-thumbnail/${numericId}?size=${size}`;
    };

    const DATASET_VIRTUAL_THRESHOLD = 800;
    const DATASET_VIRTUAL_BUFFER_ROWS = 3;
    const DATASET_QUEUE_GRID_MIN = 144;
    const DATASET_QUEUE_LIST_HEIGHT = 108;
    const DATASET_IMPORT_GRID_MIN = 150;
    const DATASET_QUEUE_GRID_GAP = 8;
    const DATASET_IMPORT_GRID_GAP = 10;
    const DATASET_MAX_SCROLL_SPACER_PX = 24_000_000;

    function cleanupVirtualRenderer(owner, key) {
        const cleanup = owner[key];
        if (typeof cleanup === 'function') cleanup();
        owner[key] = null;
    }

    function getVirtualMetrics(scroller, rowCount, itemHeight) {
        const viewport = Math.max(1, scroller.clientHeight || 1);
        const totalHeight = Math.max(0, rowCount * itemHeight);
        const spacerHeight = Math.min(totalHeight, DATASET_MAX_SCROLL_SPACER_PX);
        const compressed = totalHeight > spacerHeight;
        if (!compressed) {
            return {
                viewport,
                totalHeight,
                spacerHeight,
                compressed: false,
                virtualTop: Math.max(0, scroller.scrollTop || 0),
                domTopForRow: (row) => row * itemHeight,
            };
        }
        const domScrollable = Math.max(1, spacerHeight - viewport);
        const virtualScrollable = Math.max(1, totalHeight - viewport);
        const ratio = Math.max(0, Math.min(1, (scroller.scrollTop || 0) / domScrollable));
        const virtualTop = ratio * virtualScrollable;
        return {
            viewport,
            totalHeight,
            spacerHeight,
            compressed: true,
            virtualTop,
            domTopForRow: (row) => (scroller.scrollTop || 0) + ((row * itemHeight) - virtualTop),
        };
    }

    function scrollVirtualIndexIntoView(scroller, index, columns, itemHeight) {
        if (!scroller || index < 0 || columns <= 0 || itemHeight <= 0) return;
        const row = Math.floor(index / columns);
        const rowCount = Math.ceil(Math.max(0, index + 1) / columns);
        const knownRows = Number(scroller.dataset.virtualRows || rowCount);
        const totalRows = Math.max(rowCount, knownRows);
        const totalHeight = totalRows * itemHeight;
        const viewport = Math.max(1, scroller.clientHeight || 1);
        const spacerHeight = Math.min(totalHeight, DATASET_MAX_SCROLL_SPACER_PX);
        const targetVirtualTop = row * itemHeight;
        if (totalHeight <= spacerHeight) {
            scroller.scrollTop = targetVirtualTop;
            return;
        }
        const ratio = targetVirtualTop / Math.max(1, totalHeight - viewport);
        scroller.scrollTop = ratio * Math.max(1, spacerHeight - viewport);
    }

    function getMeasuredWidth(el, fallback = 1) {
        const rectWidth = Math.floor(el?.getBoundingClientRect?.().width || 0);
        const clientWidth = Math.floor(el?.clientWidth || 0);
        const parentWidth = Math.floor(el?.parentElement?.getBoundingClientRect?.().width || 0);
        return Math.max(1, rectWidth || clientWidth || parentWidth || fallback || 1);
    }

    function getGridLayout(el, minCellWidth, gapPx) {
        const width = getMeasuredWidth(el, minCellWidth);
        const gap = Math.max(0, Number(gapPx) || 0);
        const columns = Math.max(1, Math.floor((width + gap) / (Math.max(1, minCellWidth) + gap)));
        const cellWidth = Math.max(1, Math.floor((width - (gap * (columns - 1))) / columns));
        return { width, columns, cellWidth, rowStride: cellWidth + gap, gap };
    }

    DM._setActive = function (imageId) {
        if (Number(this.activeId) !== Number(imageId)) this._flushPendingCaptionEdit?.();
        const id = Number(imageId);
        if (!this.imageIds.includes(id)) return;
        this.activeId = id;
        const meta = this.meta.get(id) || {};
        const filename = meta.filename || `#${id}`;

        const img = document.getElementById('dataset-editor-image');
        const empty = document.getElementById('dataset-editor-empty');
        const ta = document.getElementById('dataset-editor-textarea');
        const actions = document.getElementById('dataset-editor-actions');
        const filenameEl = document.getElementById('dataset-editor-filename');
        const zoomBar = document.getElementById('dataset-zoom-toolbar');

        if (img) {
            img.src = this._fullResMode ? `/api/image-file/${id}` : this._thumbSrc(id, 1024);
            img.alt = filename;
            img.hidden = false;
            let usedFallback = false;
            img.onerror = () => {
                if (!usedFallback) {
                    usedFallback = true;
                    img.src = this._thumbSrc(id, 1024);
                    return;
                }
                img.removeAttribute('src');
                img.hidden = true;
                if (empty) empty.hidden = false;
            };
        }
        if (empty) empty.hidden = true;
        if (filenameEl) filenameEl.textContent = filename;
        if (zoomBar) zoomBar.hidden = false;

        // Reset zoom on image change
        this._zoomLevel = 1;
        this._applyZoom();

        const caption = this.captionEdits.has(id)
            ? this.captionEdits.get(id)
            : (this.captions.get(id) || '');
        if (ta) {
            ta.value = caption;
            ta.hidden = false;
        }
        if (actions) actions.hidden = false;

        this._highlightActiveQueueItem();
        this._scrollActiveQueueItemIntoView?.();
        this._renderTagPills?.();
        this._ensureFullResButtons();
    };

    DM._fullResMode = false;

    DM._ensureFullResButtons = function () {
        const wrap = document.getElementById('dataset-editor-image-wrap');
        if (!wrap || wrap.querySelector('.dataset-fullres-bar')) return;
        const bar = document.createElement('div');
        bar.className = 'dataset-fullres-bar';
        const btnOne = document.createElement('button');
        btnOne.type = 'button';
        btnOne.className = 'btn btn-ghost btn-small dataset-fullres-btn';
        btnOne.textContent = '\uD83D\uDD0D';
        btnOne.title = this._t('dataset.fullResCurrent', 'Load full resolution (current)');
        btnOne.addEventListener('click', () => this._loadFullResCurrent());
        const btnAll = document.createElement('button');
        btnAll.type = 'button';
        btnAll.className = 'btn btn-ghost btn-small dataset-fullres-btn';
        btnAll.textContent = '\uD83D\uDD0D\u2726';
        btnAll.title = this._t('dataset.fullResAll', 'Full resolution mode (all)');
        btnAll.addEventListener('click', () => this._toggleFullResAll());
        bar.appendChild(btnOne);
        bar.appendChild(btnAll);
        wrap.appendChild(bar);
    };

    DM._loadFullResCurrent = function () {
        const img = document.getElementById('dataset-editor-image');
        if (!img || this.activeId == null) return;
        const id = Number(this.activeId);
        img.src = this.isLocalId?.(id) ? this._thumbSrc(id, 2048) : `/api/image-file/${id}`;
    };

    DM._toggleFullResAll = function () {
        this._fullResMode = !this._fullResMode;
        const btn = document.querySelector('.dataset-fullres-bar .dataset-fullres-btn:last-child');
        if (btn) btn.classList.toggle('active', this._fullResMode);
        if (this.activeId != null) {
            const img = document.getElementById('dataset-editor-image');
            if (img) {
                img.src = this._fullResMode
                    ? `/api/image-file/${this.activeId}`
                    : this._thumbSrc(this.activeId, 1024);
            }
        }
        this._toast(
            this._fullResMode
                ? this._t('dataset.fullResOnToast', 'Full resolution mode ON')
                : this._t('dataset.fullResOffToast', 'Full resolution mode OFF (thumbnails)'),
            'info', 2000
        );
    };

    DM._stepActive = function (delta) {
        if (this.activeId == null || this.imageIds.length === 0) return;
        const idx = this.imageIds.indexOf(Number(this.activeId));
        if (idx < 0) return;
        const next = (idx + delta + this.imageIds.length) % this.imageIds.length;
        this._setActive(this.imageIds[next]);
    };

    DM._removeActive = function () {
        if (this.activeId == null) return;
        this._removeImageById(Number(this.activeId), { confirm: true });
        this._saveSession();
    };

    DM._removeImageById = function (imageId, options = {}) {
        const id = Number(imageId);
        if (!this.imageIds.includes(id)) return;
        if (options.confirm) {
            const msg = this._t('dataset.confirmRemove', 'Remove this image from the dataset?');
            if (!window.confirm(msg)) return;
        }
        const idx = this.imageIds.indexOf(id);
        this.imageIds.splice(idx, 1);
        this.captions.delete(id);
        if (typeof this._deleteCaptionEditForDatasetRemoval === 'function') {
            this._deleteCaptionEditForDatasetRemoval(id);
        } else {
            this.captionEdits.delete(id);
        }
        this._undoStacks?.delete?.(id);
        this._queueSelection.delete(id);
        if (this.localItemPaths && this.isLocalId && this.isLocalId(id)) {
            this.localItemPaths.delete(id);
            this.localItemDsIds?.delete?.(id);
        }
        const wasActive = Number(this.activeId) === id;
        if (wasActive) this.activeId = null;
        this._renderQueue();
        this._renderImportGallery();
        this._updateCount();
        this._updateExportEnabled();
        this._updateMultiSelectUI();
        if (this.imageIds.length === 0) {
            this._renderEmptyEditor();
        } else if (wasActive) {
            this._setActive(this.imageIds[Math.min(idx, this.imageIds.length - 1)]);
        }
        this._syncSourceCapabilityStatus?.();
        this._syncOutputModeUi?.();
        this._saveSession?.();
        // Notify derived caches (confidence pills, vocab cache) that an
        // image left the dataset so they don't serve stale entries for
        // an id that may be re-added later with different tags.
        window.dispatchEvent(new CustomEvent('dataset:changed', { detail: { removed: id } }));
    };

    DM._revertActiveCaption = function () {
        if (this.activeId == null) return;
        const id = Number(this.activeId);
        this.captionEdits.delete(id);
        const ta = document.getElementById('dataset-editor-textarea');
        if (ta) ta.value = this.captions.get(id) || '';
        this._refreshQueueItem(id);
        this._saveSession?.();
    };

    DM._renderEmptyEditor = function () {
        const img = document.getElementById('dataset-editor-image');
        const empty = document.getElementById('dataset-editor-empty');
        const ta = document.getElementById('dataset-editor-textarea');
        const actions = document.getElementById('dataset-editor-actions');
        const filenameEl = document.getElementById('dataset-editor-filename');
        if (img) img.hidden = true;
        if (empty) empty.hidden = false;
        const emptyText = empty?.querySelector?.('.dataset-editor-empty-text');
        if (emptyText) {
            emptyText.textContent = this._t('dataset.editorEmpty',
                'Pick an image from the queue on the left to edit its caption.');
        }
        if (ta) ta.hidden = true;
        if (actions) actions.hidden = true;
        if (filenameEl) filenameEl.textContent = '';
    };

    // ---------- Queue rendering ----------
    DM._renderQueue = function () {
        const list = document.getElementById('dataset-queue-list');
        if (!list) return;
        this._updateCount?.();
        const mode = this._queueViewMode === 'list' ? 'list' : 'grid';
        const renderIds = this._queueIdsForCurrentFilter();
        list.classList.toggle('dataset-queue-grid-mode', mode === 'grid');
        list.classList.toggle('dataset-queue-list-mode', mode === 'list');
        if (renderIds.length > DATASET_VIRTUAL_THRESHOLD) {
            this._renderVirtualQueue(list, mode, renderIds);
            return;
        }
        cleanupVirtualRenderer(this, '_queueVirtualCleanup');
        list.classList.remove('is-virtualized');
        list.style.display = '';
        delete list.dataset.virtualRows;
        if (this.imageIds.length === 0) {
            list.innerHTML = `
                <div class="dataset-empty-state">
                    <span class="dataset-empty-icon" aria-hidden="true">📦</span>
                    <p class="dataset-empty-headline">${this._t('dataset.queueEmptyHeadline', 'No images yet')}</p>
                    <p class="dataset-empty-body">
                        <span class="dataset-empty-arrow">←</span>
                        ${this._t('dataset.queueEmptyBody',
                            'Open the 🖼️ Gallery tab, click some images, then click "Add from Gallery" above.')}
                    </p>
                </div>
            `;
            this._updateMultiSelectUI();
            return;
        }
        list.innerHTML = '';
        if (renderIds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'dataset-empty-state';
            empty.textContent = this._t('dataset.queueFilterEmpty', 'No images match this queue filter.');
            list.appendChild(empty);
            this._updateMultiSelectUI();
            return;
        }
        for (const [index, id] of renderIds.entries()) {
            list.appendChild(this._buildQueueItem(id, index));
        }
        this._highlightActiveQueueItem();
        this._applyAuditFilterToQueue?.();
        this._applyCaptionFilter?.();
        this._updateMultiSelectUI();
    };

    DM._scrollActiveQueueItemIntoView = function () {
        const list = document.getElementById('dataset-queue-list');
        if (!list || !list.classList.contains('is-virtualized') || this.activeId == null) return;
        const renderIds = this._queueIdsForCurrentFilter();
        const index = renderIds.indexOf(Number(this.activeId));
        if (index < 0) return;
        const mode = this._queueViewMode === 'list' ? 'list' : 'grid';
        const gridLayout = getGridLayout(list, DATASET_QUEUE_GRID_MIN, DATASET_QUEUE_GRID_GAP);
        const width = gridLayout.width;
        const columns = mode === 'list' ? 1 : gridLayout.columns;
        const cellWidth = mode === 'list' ? width : gridLayout.cellWidth;
        const itemHeight = mode === 'list' ? DATASET_QUEUE_LIST_HEIGHT : gridLayout.rowStride;
        list.dataset.virtualRows = String(Math.ceil(renderIds.length / columns));
        scrollVirtualIndexIntoView(list, index, columns, itemHeight);
    };

    DM._renderVirtualQueue = function (list, mode, renderIds = this._queueIdsForCurrentFilter()) {
        cleanupVirtualRenderer(this, '_queueVirtualCleanup');
        list.innerHTML = '';
        list.classList.add('is-virtualized');
        list.style.display = 'block';

        const spacer = document.createElement('div');
        spacer.className = 'dataset-virtual-spacer dataset-queue-virtual-spacer';
        list.appendChild(spacer);

        let frame = 0;
        const renderVisible = () => {
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = 0;
                const isList = mode === 'list';
                const gridLayout = getGridLayout(list, DATASET_QUEUE_GRID_MIN, DATASET_QUEUE_GRID_GAP);
                const width = gridLayout.width;
                const columns = isList ? 1 : gridLayout.columns;
                const cellWidth = isList ? width : gridLayout.cellWidth;
                const itemHeight = isList ? DATASET_QUEUE_LIST_HEIGHT : gridLayout.rowStride;
                const rowCount = Math.ceil(renderIds.length / columns);
                const metrics = getVirtualMetrics(list, rowCount, itemHeight);
                list.dataset.virtualRows = String(rowCount);
                spacer.style.height = `${metrics.spacerHeight}px`;
                spacer.style.position = 'relative';
                spacer.innerHTML = '';

                const startRow = Math.max(0, Math.floor(metrics.virtualTop / itemHeight) - DATASET_VIRTUAL_BUFFER_ROWS);
                const visibleRows = Math.ceil(metrics.viewport / itemHeight) + (DATASET_VIRTUAL_BUFFER_ROWS * 2);
                const endRow = Math.min(rowCount, startRow + visibleRows);

                for (let row = startRow; row < endRow; row += 1) {
                    for (let col = 0; col < columns; col += 1) {
                        const index = row * columns + col;
                        if (index >= renderIds.length) break;
                        const node = this._buildQueueItem(renderIds[index], index);
                        node.style.position = 'absolute';
                        node.style.top = `${metrics.domTopForRow(row)}px`;
                        node.style.left = isList ? '0' : `${col * (cellWidth + DATASET_QUEUE_GRID_GAP)}px`;
                        node.style.width = isList ? 'calc(100% - 6px)' : `${Math.max(1, cellWidth)}px`;
                        node.style.height = isList ? `${DATASET_QUEUE_LIST_HEIGHT - 4}px` : `${Math.max(1, cellWidth)}px`;
                        node.style.aspectRatio = 'auto';
                        node.style.boxSizing = 'border-box';
                        spacer.appendChild(node);
                    }
                }
                this._highlightActiveQueueItem();
                this._applyAuditFilterToQueue?.();
                this._updateMultiSelectUI();
            });
        };

        list.addEventListener('scroll', renderVisible, { passive: true });
        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(renderVisible)
            : null;
        if (resizeObserver) resizeObserver.observe(list);
        this._queueVirtualCleanup = () => {
            if (frame) cancelAnimationFrame(frame);
            list.removeEventListener('scroll', renderVisible);
            if (resizeObserver) resizeObserver.disconnect();
        };
        renderVisible();
    };

    DM._buildQueueItem = function (id, orderIndex = null) {
        const meta = this.meta.get(id) || {};
        const resolvedOrderIndex = Number.isFinite(orderIndex) ? Number(orderIndex) : this.imageIds.indexOf(id);
        const item = document.createElement('div');
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.className = 'dataset-queue-item';
        item.dataset.imageId = String(id);
        if (resolvedOrderIndex >= 0) item.dataset.queueOrder = String(resolvedOrderIndex + 1);

        const selectToggle = document.createElement('button');
        selectToggle.type = 'button';
        selectToggle.className = 'dataset-queue-select-toggle';
        selectToggle.setAttribute('role', 'checkbox');
        selectToggle.setAttribute('aria-checked', this._queueSelection.has(id) ? 'true' : 'false');
        selectToggle.title = this._t('dataset.toggleSelect', 'Select image');
        selectToggle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._toggleQueueSelection(id);
        });

        // v3.2.2 (issue #5 follow-up): caption status badge so the user
        // can see at a glance which images need work.
        //   edited   -> user manually edited the caption (sticky)
        //   tagged   -> backend produced a non-empty caption
        //   untagged -> empty rendered caption + no override; user
        //               should run "Tag all images" or write one
        const cap = this.captionEdits.has(id)
            ? this.captionEdits.get(id)
            : (this.captions.get(id) || '');
        let status = 'untagged';
        if (this.captionEdits.has(id)) status = 'edited';
        else if (String(cap).trim().length > 0) status = 'tagged';
        item.classList.add(`status-${status}`);

        const img = document.createElement('img');
        img.className = 'dataset-queue-thumb';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        item.classList.add('is-loading');
        img.onload = () => {
            item.classList.remove('is-loading');
        };
        img.onerror = () => {
            item.classList.remove('is-loading');
            img.classList.add('is-missing');
            img.removeAttribute('src');
        };
        img.src = this._thumbSrc(id, 160);
        if (img.complete) item.classList.remove('is-loading');

        const orderBadge = document.createElement('span');
        orderBadge.className = 'dataset-queue-order';
        orderBadge.textContent = resolvedOrderIndex >= 0 ? String(resolvedOrderIndex + 1) : '?';
        orderBadge.title = this._t('dataset.queueOrder', 'Queue order');

        const metaWrap = document.createElement('div');
        metaWrap.className = 'dataset-queue-meta';
        const filename = document.createElement('strong');
        filename.className = 'dataset-queue-filename';
        filename.textContent = meta.filename || `image_${id}`;
        const idLabel = document.createElement('small');
        idLabel.className = 'dataset-queue-id';
        idLabel.textContent = `#${id}`;
        metaWrap.append(filename, idLabel);

        const badge = document.createElement('span');
        badge.className = `dataset-queue-badge dataset-queue-badge-${status}`;
        const badgeMap = {
            untagged: { icon: '⚠️', key: 'dataset.statusUntagged', fallback: 'no caption' },
            tagged:   { icon: '✓',  key: 'dataset.statusTagged',   fallback: 'tagged' },
            edited:   { icon: '✏️', key: 'dataset.statusEdited',   fallback: 'edited' },
        };
        const b = badgeMap[status];
        const badgeIcon = document.createElement('span');
        badgeIcon.setAttribute('aria-hidden', 'true');
        badgeIcon.textContent = b.icon;
        const badgeText = document.createElement('span');
        badgeText.textContent = this._t(b.key, b.fallback);
        badge.append(badgeIcon, badgeText);

        item.append(selectToggle, orderBadge, img, metaWrap, badge);
        item.addEventListener('click', (e) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
                this._handleMultiSelectClick(id, e);
            } else {
                this._queueSelection.clear();
                this._updateMultiSelectUI();
                this._setActive(id);
            }
        });
        item.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            if (e.shiftKey || e.ctrlKey || e.metaKey) this._handleMultiSelectClick(id, e);
            else this._setActive(id);
        });
        return item;
    };

    DM._refreshQueueItem = function (id) {
        const list = document.getElementById('dataset-queue-list');
        if (!list) return;
        const existing = list.querySelector(`.dataset-queue-item[data-image-id="${id}"]`);
        if (!existing) return;
        if (list.classList.contains('is-virtualized')) {
            this._renderQueue();
            return;
        }
        const orderIndex = Number(existing.dataset.queueOrder || 0) - 1;
        existing.replaceWith(this._buildQueueItem(id, Number.isFinite(orderIndex) ? orderIndex : null));
        this._highlightActiveQueueItem();
        this._applyAuditFilterToQueue?.();
    };

    DM._highlightActiveQueueItem = function () {
        const list = document.getElementById('dataset-queue-list');
        if (!list) return;
        for (const el of list.querySelectorAll('.dataset-queue-item')) {
            el.classList.toggle('active', Number(el.dataset.imageId) === Number(this.activeId));
        }
    };

    DM._setQueueViewMode = function (mode) {
        this._queueViewMode = mode === 'list' ? 'list' : 'grid';
        try { localStorage.setItem('sd-image-sorter-dataset-queue-mode', this._queueViewMode); } catch {}
        document.querySelectorAll('[data-dataset-queue-mode]').forEach((btn) => {
            const active = btn.getAttribute('data-dataset-queue-mode') === this._queueViewMode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        this._renderQueue();
    };

    DM._initQueueModeControls = function () {
        document.querySelectorAll('[data-dataset-queue-mode]').forEach((btn) => {
            btn.addEventListener('click', () => this._setQueueViewMode(btn.getAttribute('data-dataset-queue-mode')));
        });
        this._setQueueViewMode(this._queueViewMode || 'grid');
    };

    // ---------- Queue caption filter ----------
    DM._queueCaptionFilter = 'all';

    DM._queueIdsForCurrentFilter = function () {
        const filter = this._queueCaptionFilter || 'all';
        if (filter === 'all') return Array.from(this.imageIds || []);
        return (this.imageIds || []).filter((id) => {
            const caption = (this.captionEdits?.get?.(id) || this.captions?.get?.(id) || '').trim();
            const hasCaption = caption.length > 0;
            return filter === 'tagged' ? hasCaption : !hasCaption;
        });
    };

    DM._initQueueCaptionFilter = function () {
        const sel = document.getElementById('dataset-queue-caption-filter');
        if (!sel) return;
        sel.addEventListener('change', () => {
            this._queueCaptionFilter = sel.value || 'all';
            this._renderQueue();
        });
    };

    DM._applyCaptionFilter = function () {
        const filter = this._queueCaptionFilter || 'all';
        const list = document.getElementById('dataset-queue-list');
        if (list?.classList.contains('is-virtualized')) {
            this._renderQueue();
            return;
        }
        const items = document.querySelectorAll('#dataset-queue-list .dataset-queue-item');
        for (const it of items) {
            if (filter === 'all') {
                it.style.display = '';
                continue;
            }
            const id = Number(it.dataset.imageId || 0);
            const caption = (this.captionEdits?.get?.(id) || this.captions?.get?.(id) || '').trim();
            const hasCaption = caption.length > 0;
            if (filter === 'tagged') it.style.display = hasCaption ? '' : 'none';
            else it.style.display = hasCaption ? 'none' : '';
        }
    };

    // ---------- Queue multi-select ----------
    DM._selectionSummaryText = function (count = this._queueSelection.size) {
        const formatted = Number(count || 0).toLocaleString();
        return this._t('dataset.selectionCount', '{count} selected', { count: formatted })
            .replace(/\{count\}/g, formatted);
    };

    DM._setSelectionSummary = function () {
        const count = this._queueSelection.size;
        const text = this._selectionSummaryText(count);
        for (const id of ['dataset-queue-selection-summary', 'dataset-import-selection-summary']) {
            const el = document.getElementById(id);
            if (el) {
                el.removeAttribute('data-i18n');
                el.textContent = text;
            }
        }
        for (const id of [
            'btn-dataset-queue-clear-selection',
            'btn-dataset-import-clear-selection',
            'btn-dataset-queue-remove-selected',
            'btn-dataset-import-remove-selected',
        ]) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = count === 0;
        }
        for (const id of ['btn-dataset-queue-select-all', 'btn-dataset-import-select-all']) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = this.imageIds.length === 0 || count >= this.imageIds.length;
        }
    };

    DM._toggleQueueSelection = function (id) {
        const n = Number(id);
        if (!this.imageIds.includes(n)) return;
        if (this._queueSelection.has(n)) this._queueSelection.delete(n);
        else this._queueSelection.add(n);
        this._lastClickedId = n;
        this._updateMultiSelectUI();
    };

    DM._selectAllQueue = function () {
        this._queueSelection = new Set(this.imageIds.map(Number));
        this._lastClickedId = this.imageIds.length ? Number(this.imageIds[this.imageIds.length - 1]) : null;
        this._updateMultiSelectUI();
    };

    DM._clearQueueSelection = function () {
        this._queueSelection.clear();
        this._updateMultiSelectUI();
    };

    DM._removeSelectedImages = function () {
        const selected = Array.from(this._queueSelection).map(Number);
        if (selected.length === 0) return;
        const msg = this._t('dataset.confirmRemoveSelected',
            'Remove {count} selected images from the dataset? Original files are not affected.',
            { count: selected.length });
        if (!window.confirm(msg)) return;

        const removeSet = new Set(selected);
        this.imageIds = this.imageIds.filter((id) => !removeSet.has(Number(id)));
        for (const id of selected) {
            if (this.isLocalId?.(id)) this._markLocalManifestExcluded?.(id);
            this.captions.delete(id);
            if (typeof this._deleteCaptionEditForDatasetRemoval === 'function') {
                this._deleteCaptionEditForDatasetRemoval(id);
            } else {
                this.captionEdits.delete(id);
            }
            this._undoStacks?.delete?.(id);
            if (this.localItemPaths && this.isLocalId && this.isLocalId(id)) {
                this.localItemPaths.delete(id);
                this.localItemDsIds?.delete?.(id);
            }
        }
        this._queueSelection.clear();
        if (this.activeId != null && !this.imageIds.includes(Number(this.activeId))) {
            this.activeId = this.imageIds.length ? Number(this.imageIds[0]) : null;
        }
        this._renderQueue();
        this._renderImportGallery?.();
        this._updateCount();
        this._updateExportEnabled();
        this._updateMultiSelectUI();
        if (this.activeId != null) this._setActive(this.activeId);
        else this._renderEmptyEditor();
        this._saveSession?.();
    };

    DM._initQueueSelectionControls = function () {
        for (const id of ['btn-dataset-queue-select-all', 'btn-dataset-import-select-all']) {
            document.getElementById(id)?.addEventListener('click', () => this._selectAllQueue());
        }
        for (const id of ['btn-dataset-queue-clear-selection', 'btn-dataset-import-clear-selection']) {
            document.getElementById(id)?.addEventListener('click', () => this._clearQueueSelection());
        }
        for (const id of ['btn-dataset-queue-remove-selected', 'btn-dataset-import-remove-selected']) {
            document.getElementById(id)?.addEventListener('click', () => this._removeSelectedImages());
        }
        this._setSelectionSummary();
    };

    DM._handleMultiSelectClick = function (id, e) {
        if (e.shiftKey && this._lastClickedId != null) {
            const startIdx = this.imageIds.indexOf(Number(this._lastClickedId));
            const endIdx = this.imageIds.indexOf(Number(id));
            if (startIdx >= 0 && endIdx >= 0) {
                const lo = Math.min(startIdx, endIdx);
                const hi = Math.max(startIdx, endIdx);
                for (let i = lo; i <= hi; i++) {
                    this._queueSelection.add(this.imageIds[i]);
                }
            }
        } else {
            // Ctrl/Cmd+click toggles individual
            if (this._queueSelection.has(id)) {
                this._queueSelection.delete(id);
            } else {
                this._queueSelection.add(id);
            }
        }
        this._lastClickedId = id;
        this._updateMultiSelectUI();
    };

    DM._updateMultiSelectUI = function () {
        const list = document.getElementById('dataset-queue-list');
        if (list) {
            for (const el of list.querySelectorAll('.dataset-queue-item')) {
                const selected = this._queueSelection.has(Number(el.dataset.imageId));
                el.classList.toggle('multi-selected', selected);
                const toggle = el.querySelector('.dataset-queue-select-toggle');
                if (toggle) toggle.setAttribute('aria-checked', selected ? 'true' : 'false');
            }
        }
        const importGrid = document.getElementById('dataset-import-gallery-grid');
        if (importGrid) {
            for (const el of importGrid.querySelectorAll('.import-thumb')) {
                el.classList.toggle('multi-selected',
                    this._queueSelection.has(Number(el.dataset.imageId)));
            }
        }
        this._setSelectionSummary();
        let bar = document.getElementById('dataset-multiselect-bar');
        if (this._queueSelection.size === 0) {
            if (bar) bar.hidden = true;
            return;
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'dataset-multiselect-bar';
            bar.className = 'dataset-multiselect-bar';
            const queuePane = document.querySelector('#view-dataset .dataset-queue-pane');
            if (queuePane) queuePane.appendChild(bar);
        }
        bar.hidden = false;
        const n = this._queueSelection.size;
        bar.innerHTML = `
            <button type="button" class="btn btn-small btn-secondary" id="btn-multisel-remove">
                ${this._t('dataset.multiRemove', 'Remove {count} selected', { count: n })}
            </button>
            <button type="button" class="btn btn-small btn-ghost" id="btn-multisel-addtag">
                ${this._t('dataset.multiAddTag', 'Add tag to {count} selected', { count: n })}
            </button>
        `;
        bar.querySelector('#btn-multisel-remove').addEventListener('click', () => {
            this._removeSelectedImages();
        });
        bar.querySelector('#btn-multisel-addtag').addEventListener('click', () => {
            const tag = prompt(this._t('dataset.multiAddTagPrompt', 'Tag to add:'));
            if (!tag || !tag.trim()) return;
            const t = tag.trim();
            for (const sid of this._queueSelection) {
                const current = this.captionEdits.has(sid)
                    ? this.captionEdits.get(sid)
                    : (this.captions.get(sid) || '');
                const updated = current ? current + ', ' + t : t;
                this.captionEdits.set(sid, updated);
            }
            this._queueSelection.clear();
            this._updateMultiSelectUI();
            this._renderQueue();
            if (this.activeId != null) this._setActive(this.activeId);
            this._toast(this._t('dataset.multiAddTagDone',
                'Added tag to {count} images', { count: n }), 'success');
            this._saveSession?.();
        });
    };

    // ---------- Split view ----------
    DM._splitActive = false;

    DM._closeSplitView = function () {
        this._splitActive = false;
        document.getElementById('btn-dataset-split-view')?.classList.remove('active');
        this._applySplitView();
    };

    DM._initSplitView = function () {
        const btn = document.getElementById('btn-dataset-split-view');
        if (!btn) return;
        btn.addEventListener('click', () => {
            this._splitActive = !this._splitActive;
            btn.classList.toggle('active', this._splitActive);
            this._applySplitView();
        });
    };

    DM._applySplitView = function () {
        const wrap = document.getElementById('dataset-editor-image-wrap');
        const editorPane = document.querySelector('#view-dataset .dataset-editor-pane');
        if (!wrap) return;
        const existing = document.getElementById('dataset-split-panel');
        if (existing) existing.remove();

        if (!this._splitActive || this.activeId == null) {
            wrap.classList.remove('split-active');
            editorPane?.classList.remove('dataset-split-mode');
            return;
        }
        const idx = this.imageIds.indexOf(Number(this.activeId));
        // Compare with the next image; on the last one fall back to the
        // previous so the button still works everywhere. Only a 1-image
        // queue genuinely has nothing to compare with.
        const partnerIdx = idx + 1 < this.imageIds.length ? idx + 1 : idx - 1;
        if (partnerIdx < 0) {
            this._toast(this._t('dataset.splitNoNext',
                'This is the only image in the queue — nothing to compare with.'), 'info');
            this._splitActive = false;
            const btn = document.getElementById('btn-dataset-split-view');
            if (btn) btn.classList.remove('active');
            wrap.classList.remove('split-active');
            editorPane?.classList.remove('dataset-split-mode');
            return;
        }
        const partnerIsNext = partnerIdx > idx;
        editorPane?.classList.add('dataset-split-mode');
        const nextId = this.imageIds[partnerIdx];
        const panel = document.createElement('div');
        panel.id = 'dataset-split-panel';
        panel.className = 'dataset-split-panel';

        const header = document.createElement('div');
        header.className = 'dataset-split-head';
        const headerCopy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = this._t('dataset.splitTitle', 'Compare captions');
        const hint = document.createElement('span');
        hint.textContent = this._t('dataset.splitHint', 'Edit either image. Changes are saved automatically.');
        headerCopy.append(title, hint);
        const headerActions = document.createElement('div');
        headerActions.className = 'dataset-split-head-actions';
        const openNext = document.createElement('button');
        openNext.type = 'button';
        openNext.className = 'btn btn-secondary btn-small';
        openNext.textContent = this._t('dataset.splitOpenNext', 'Switch to this one');
        openNext.addEventListener('click', () => this._setActive(nextId));
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-ghost btn-small';
        close.textContent = this._t('dataset.splitClose', 'Close comparison');
        close.addEventListener('click', () => this._closeSplitView());
        headerActions.append(openNext, close);
        header.append(headerCopy, headerActions);

        const grid = document.createElement('div');
        grid.className = 'dataset-split-grid';
        grid.append(
            this._buildSplitCard(Number(this.activeId), this._t('dataset.splitCurrent', 'Current')),
            this._buildSplitCard(nextId, partnerIsNext
                ? this._t('dataset.splitNext', 'Next')
                : this._t('dataset.splitPrev', 'Previous'))
        );
        panel.append(header, grid);
        wrap.before(panel);
    };

    DM._buildSplitCard = function (id, positionLabel) {
        const meta = this.meta.get(Number(id)) || {};
        const filename = meta.filename || `#${id}`;
        const booruText = typeof this._booruTextFor === 'function'
            ? this._booruTextFor(id)
            : (this.captionEdits.has(id) ? this.captionEdits.get(id) : (this.captions.get(id) || ''));
        const nlText = typeof this._nlTextFor === 'function' ? this._nlTextFor(id) : '';

        const card = document.createElement('section');
        card.className = 'dataset-split-card';
        card.dataset.imageId = String(id);

        const cardHead = document.createElement('div');
        cardHead.className = 'dataset-split-card-head';
        const label = document.createElement('span');
        label.className = 'dataset-split-position';
        label.textContent = positionLabel;
        const name = document.createElement('strong');
        name.className = 'dataset-split-filename';
        name.textContent = filename;
        cardHead.append(label, name);

        const imageFrame = document.createElement('div');
        imageFrame.className = 'dataset-split-image-frame';
        const image = document.createElement('img');
        image.className = 'dataset-split-image';
        image.src = this._thumbSrc(id, 768);
        image.alt = filename;
        const unavailable = document.createElement('span');
        unavailable.className = 'dataset-split-image-unavailable';
        unavailable.textContent = this._t('dataset.splitImageUnavailable', 'Image unavailable');
        unavailable.hidden = true;
        image.addEventListener('error', () => {
            imageFrame.classList.add('is-unavailable');
            unavailable.hidden = false;
        }, { once: true });
        imageFrame.append(image, unavailable);

        const booruLabel = document.createElement('label');
        booruLabel.className = 'dataset-split-field-label';
        booruLabel.textContent = this._t('dataset.booruBoxLabel', 'Booru tags');
        const booru = document.createElement('textarea');
        booru.className = 'dataset-split-textarea';
        booru.value = booruText || '';
        booru.placeholder = this._t('dataset.captionPlaceholder', 'caption text...');
        booru.addEventListener('input', () => this._updateSplitCaption(id, 'booru', booru.value));

        const nlLabel = document.createElement('label');
        nlLabel.className = 'dataset-split-field-label';
        nlLabel.textContent = this._t('dataset.nlBoxLabel', 'Natural language');
        const nl = document.createElement('textarea');
        nl.className = 'dataset-split-textarea dataset-split-textarea-nl';
        nl.value = nlText || '';
        nl.placeholder = this._t('dataset.nlPlaceholder', 'natural-language caption...');
        nl.addEventListener('input', () => this._updateSplitCaption(id, 'nl', nl.value));

        card.append(cardHead, imageFrame, booruLabel, booru, nlLabel, nl);
        return card;
    };

    DM._updateSplitCaption = function (id, kind, value) {
        const numericId = Number(id);
        if (kind === 'nl') {
            this.nlEdits?.set(numericId, value);
            if (Number(this.activeId) === numericId) {
                const activeNl = document.getElementById('dataset-editor-nl');
                if (activeNl) activeNl.value = value;
            }
        } else {
            this.captionEdits.set(numericId, value);
            if (Number(this.activeId) === numericId) {
                const activeBooru = document.getElementById('dataset-editor-textarea');
                if (activeBooru) activeBooru.value = value;
                this._renderTagPills?.();
            }
        }
        this._refreshQueueItem?.(numericId);
        this._scheduleSaveSession?.();
        this._refreshExportPreview?.();
    };

    // Patch _setActive to refresh split view
    const _origSetActive = DM._setActive;
    DM._setActive = function (imageId) {
        _origSetActive.call(this, imageId);
        if (this._splitActive) this._applySplitView();
    };

    // Init split view button binding
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => DM._initSplitView(), { once: true });
        document.addEventListener('DOMContentLoaded', () => DM._initQueueModeControls(), { once: true });
        document.addEventListener('DOMContentLoaded', () => DM._initQueueCaptionFilter(), { once: true });
        document.addEventListener('DOMContentLoaded', () => DM._initQueueSelectionControls(), { once: true });
    } else {
        DM._initSplitView();
        DM._initQueueModeControls();
        DM._initQueueCaptionFilter();
        DM._initQueueSelectionControls();
    }

    DM._updateCount = function () {
        const num = document.getElementById('dataset-count-num');
        if (num) num.textContent = String(this.imageIds.length);
        const clearBtn = document.getElementById('btn-dataset-clear');
        if (clearBtn) clearBtn.hidden = this.imageIds.length === 0;
        if (DM._refreshExportPreview) DM._refreshExportPreview();
    };

    DM._renderImportGallery = function () {
        const container = document.getElementById('dataset-import-gallery');
        const grid = document.getElementById('dataset-import-gallery-grid');
        const countEl = document.getElementById('dataset-import-gallery-count');
        if (!container || !grid) return;

        if (this.imageIds.length === 0) {
            container.hidden = true;
            grid.innerHTML = '';
            grid.classList.remove('is-virtualized');
            delete grid.dataset.virtualRows;
            cleanupVirtualRenderer(this, '_importVirtualCleanup');
            this._updateMultiSelectUI();
            return;
        }

        container.hidden = false;
        if (countEl) {
            countEl.textContent = this._t('dataset.importGalleryCount',
                '{count} images imported', { count: this.imageIds.length });
        }

        if (this.imageIds.length > DATASET_VIRTUAL_THRESHOLD) {
            this._renderVirtualImportGallery(grid);
            return;
        }

        cleanupVirtualRenderer(this, '_importVirtualCleanup');
        grid.classList.remove('is-virtualized');
        delete grid.dataset.virtualRows;
        grid.innerHTML = '';
        for (const [index, id] of this.imageIds.entries()) {
            grid.appendChild(this._buildImportThumb(id, index));
        }
        this._updateMultiSelectUI();
    };

    DM._buildImportThumb = function (id, orderIndex = null) {
        const resolvedOrderIndex = Number.isFinite(orderIndex) ? Number(orderIndex) : this.imageIds.indexOf(id);
        const thumb = document.createElement('div');
        thumb.className = 'import-thumb';
        thumb.dataset.imageId = String(id);
        if (resolvedOrderIndex >= 0) thumb.dataset.queueOrder = String(resolvedOrderIndex + 1);
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        thumb.classList.add('is-loading');
        img.onload = () => {
            thumb.classList.remove('is-loading');
        };
        img.onerror = () => {
            thumb.classList.remove('is-loading');
            img.removeAttribute('src');
            thumb.classList.add('thumb-missing');
        };

        const src = this._thumbSrc(id, 160);
        if (src) img.src = src;
        else thumb.classList.add('preview-pending');
        if (!src || img.complete) thumb.classList.remove('is-loading');

        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        thumb.appendChild(img);
        const order = document.createElement('span');
        order.className = 'import-thumb-order';
        order.textContent = resolvedOrderIndex >= 0 ? String(resolvedOrderIndex + 1) : '?';
        order.title = this._t('dataset.queueOrder', 'Queue order');
        thumb.appendChild(order);
        const keep = document.createElement('span');
        keep.className = 'import-thumb-keep';
        keep.textContent = this._t('dataset.keepBadge', 'Keep');
        thumb.appendChild(keep);
        const selected = document.createElement('span');
        selected.className = 'import-thumb-selected';
        selected.textContent = '✓';
        selected.setAttribute('aria-hidden', 'true');
        thumb.appendChild(selected);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'import-thumb-remove';
        remove.textContent = 'x';
        remove.title = this._t('dataset.removeFromDataset', 'Remove');
        remove.addEventListener('click', (event) => {
            event.stopPropagation();
            this._removeImageById(id);
        });
        thumb.appendChild(remove);
        thumb.addEventListener('click', (event) => {
            if (event.shiftKey || event.ctrlKey || event.metaKey) this._handleMultiSelectClick(id, event);
            else this._toggleQueueSelection(id);
        });
        thumb.addEventListener('dblclick', () => {
            this._setActive(id);
            this._setPipelineTab?.('workbench');
        });
        return thumb;
    };

    DM._renderVirtualImportGallery = function (grid) {
        cleanupVirtualRenderer(this, '_importVirtualCleanup');
        grid.innerHTML = '';
        grid.classList.add('is-virtualized');

        const spacer = document.createElement('div');
        spacer.className = 'dataset-virtual-spacer dataset-import-virtual-spacer';
        grid.appendChild(spacer);

        let frame = 0;
        const renderVisible = () => {
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = 0;
                const gridLayout = getGridLayout(grid, DATASET_IMPORT_GRID_MIN, DATASET_IMPORT_GRID_GAP);
                const columns = gridLayout.columns;
                const cellWidth = gridLayout.cellWidth;
                const itemHeight = gridLayout.rowStride;
                const rowCount = Math.ceil(this.imageIds.length / columns);
                const metrics = getVirtualMetrics(grid, rowCount, itemHeight);
                grid.dataset.virtualRows = String(rowCount);
                spacer.style.height = `${metrics.spacerHeight}px`;
                spacer.style.position = 'relative';
                spacer.innerHTML = '';

                const startRow = Math.max(0, Math.floor(metrics.virtualTop / itemHeight) - DATASET_VIRTUAL_BUFFER_ROWS);
                const visibleRows = Math.ceil(metrics.viewport / itemHeight) + (DATASET_VIRTUAL_BUFFER_ROWS * 2);
                const endRow = Math.min(rowCount, startRow + visibleRows);

                for (let row = startRow; row < endRow; row += 1) {
                    for (let col = 0; col < columns; col += 1) {
                        const index = row * columns + col;
                        if (index >= this.imageIds.length) break;
                        const thumb = this._buildImportThumb(this.imageIds[index], index);
                        thumb.style.position = 'absolute';
                        thumb.style.top = `${metrics.domTopForRow(row)}px`;
                        thumb.style.left = `${col * (cellWidth + DATASET_IMPORT_GRID_GAP)}px`;
                        thumb.style.width = `${Math.max(1, cellWidth)}px`;
                        thumb.style.height = `${Math.max(1, cellWidth)}px`;
                        thumb.style.aspectRatio = 'auto';
                        thumb.style.boxSizing = 'border-box';
                        spacer.appendChild(thumb);
                    }
                }
                this._updateMultiSelectUI();
            });
        };

        grid.addEventListener('scroll', renderVisible, { passive: true });
        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(renderVisible)
            : null;
        if (resizeObserver) resizeObserver.observe(grid);
        this._importVirtualCleanup = () => {
            if (frame) cancelAnimationFrame(frame);
            grid.removeEventListener('scroll', renderVisible);
            if (resizeObserver) resizeObserver.disconnect();
        };
        renderVisible();
    };

    // ---------- Zoom controls ----------
    DM._applyZoom = function () {
        const img = document.getElementById('dataset-editor-image');
        const label = document.getElementById('dataset-zoom-label');
        if (img) img.style.transform = `scale(${this._zoomLevel})`;
        if (label) label.textContent = Math.round(this._zoomLevel * 100) + '%';
    };

    DM._zoomIn = function () {
        this._zoomLevel = Math.min(this._zoomLevel + 0.25, 5);
        this._applyZoom();
    };

    DM._zoomOut = function () {
        this._zoomLevel = Math.max(this._zoomLevel - 0.25, 0.25);
        this._applyZoom();
    };

    DM._zoomReset = function () {
        this._zoomLevel = 1;
        this._applyZoom();
    };

    // ---------- Tag pills ----------
    // Categories mirror the backend classifier (tag_rules.categorize_tag, served
    // by POST /api/prompts/categorize) so EVERY danbooru tag gets a real group +
    // color and the per-group reorder control (#dataset-tag-category-order)
    // covers them all. The backend is authoritative (filled async into
    // _tagCategoryCache); the local regexes below are only a synchronous
    // first-paint / offline fallback.
    const TAG_CATEGORY_ORDER_DEFAULT = [
        'quality', 'meta', 'rating', 'character', 'body', 'outfit',
        'expression', 'pose', 'action', 'angle', 'background', 'style',
        'artist', 'unknown',
    ];
    const TAG_CATEGORY_SET = new Set(TAG_CATEGORY_ORDER_DEFAULT);

    const QUALITY_RE = /^(masterpiece|best[_ ]?quality|high[_ ]?quality|normal[_ ]?quality|low[_ ]?quality|worst[_ ]?quality|absurdres|highres|lowres|score_\d|ultra-?detailed|8k|4k)$/i;
    const RATING_RE = /^(rating[:_].*|safe|sensitive|questionable|explicit|nsfw|sfw)$/i;
    const META_RE = /^(\d+\+?(girl|boy|other)s?|multiple_(girls|boys)|solo|solo_focus|signature|watermark|username|artist_name|web_address|logo|dated|commentary.*|monochrome|greyscale|grayscale)$/i;
    const ANGLE_RE = /(_focus$|from_(above|below|behind|side)|cowboy_shot|full_body|upper_body|lower_body|portrait|close[-_]?up|wide_shot|dutch_angle|fisheye|^pov$|straight-on)/i;
    const EXPRESSION_RE = /(blush|smile|smiling|frown|crying|tears|surprised|angry|sweat|^:?[dpo3<>x]$|open_mouth|closed_eyes|looking_at_viewer|looking_(away|back|down|up|to_the)|expression|embarrassed|smug|pout|grin|wink|nervous|happy|sad|scared)/i;
    const BODY_RE = /(hair|eyes?|eyebrows?|eyelashes|face|bangs|twintails|ponytail|braid|ahoge|sidelocks|skin|freckles|mole|fang|ears?|tail|wings|horns?|breasts?|cleavage|thighs?|legs?|arms?|hands?|fingers?|feet|toes|navel|stomach|collarbone|shoulders?|waist|hips?|teeth|tongue|lips|nose|cheeks?|abs|muscle)/i;
    const OUTFIT_RE = /(shirt|skirt|dress|uniform|sleeves?|jacket|coat|pants|shorts|shoes|boots|socks|gloves|hat|cap|helmet|ribbon|bowtie|bow$|necktie|tie$|scarf|clothes?|clothing|outfit|costume|bikini|swimsuit|lingerie|panties|underwear|bra|thighhighs|pantyhose|kneehighs|legwear|apron|hood|cape|armor|jewelry|earrings|necklace|bracelet|glasses|goggles|mask|veil|kimono|serafuku)/i;
    const POSE_RE = /(standing|sitting|kneeling|lying|squatting|crouching|leaning|bent_over|arms?_(up|behind|crossed)|hands?_(on|up|behind|together)|spread_|legs?_(up|apart|crossed)|knees|on_(back|side|stomach)|wariza|seiza|all_fours|arched_back)/i;
    const ACTION_RE = /(holding|hugging|kissing|licking|eating|drinking|cooking|running|walking|jumping|dancing|sleeping|reading|writing|playing|fighting|grabbing|pulling|pushing|touching|carrying|throwing|waving|pointing|covering|undressing|bathing|riding|flying|falling|smoking|singing)/i;
    const BACKGROUND_RE = /(background$|outdoors|indoors|sky|cloud|tree|forest|beach|ocean|sea|lake|river|mountain|city|town|street|road|room|classroom|bedroom|kitchen|bathroom|office|garden|field|grass|flower|water|night|day|sunset|sunrise|snow|rain|window|wall|building|nature|scenery|cityscape|landscape|interior)/i;
    const STYLE_RE = /(sketch|lineart|line_art|watercolou?r|oil_painting|painting|pixel_art|chibi|realistic|photorealistic|3d|cel_shading|flat_color|retro|art_nouveau|impasto|traditional_media|official_art|concept_art)/i;

    DM._tagCategoryCache = DM._tagCategoryCache || new Map();

    DM._classifyTagCategory = function (tag) {
        const value = String(tag || '').trim();
        if (!value) return 'unknown';
        const normalized = value.toLowerCase().replace(/\s+/g, '_');
        // Authoritative backend category once _ensureTagCategories has filled it.
        const cached = this._tagCategoryCache && this._tagCategoryCache.get(normalized);
        if (cached && TAG_CATEGORY_SET.has(cached)) return cached;
        // Synchronous best-effort fallback (first paint / offline). Character &
        // artist need the danbooru data sets, so locally they fall through to
        // 'unknown' and get corrected by the backend.
        // Prompt-convention artist prefixes are unambiguous without data sets:
        // Anima-style "@name" triggers and SDXL "artist:name".
        if (normalized.length > 1 && (normalized.startsWith('@') || normalized.startsWith('artist:'))) return 'artist';
        if (QUALITY_RE.test(normalized)) return 'quality';
        if (RATING_RE.test(normalized)) return 'rating';
        if (META_RE.test(normalized)) return 'meta';
        if (ANGLE_RE.test(normalized)) return 'angle';
        if (EXPRESSION_RE.test(normalized)) return 'expression';
        if (OUTFIT_RE.test(normalized)) return 'outfit';
        if (BODY_RE.test(normalized)) return 'body';
        if (ACTION_RE.test(normalized)) return 'action';
        if (POSE_RE.test(normalized)) return 'pose';
        if (BACKGROUND_RE.test(normalized)) return 'background';
        if (STYLE_RE.test(normalized)) return 'style';
        return 'unknown';
    };

    // Fill the category cache from the backend's 14-class classifier
    // (POST /api/prompts/categorize). Returns true if the cache gained entries
    // so the caller can re-render. Mirrors the _fetchTagZh cache+guard pattern.
    DM._ensureTagCategories = async function (tags) {
        const seen = new Set();
        const miss = [];
        for (const t of (tags || [])) {
            const raw = String(t || '').trim();
            const norm = raw.toLowerCase().replace(/\s+/g, '_');
            if (!norm || seen.has(norm) || this._tagCategoryCache.has(norm)) continue;
            // Skip multi-word natural-language fragments — not booru tags.
            if (/\s/.test(raw) && raw.split(/\s+/).length > 3) continue;
            seen.add(norm);
            miss.push(norm);
        }
        if (!miss.length) return false;
        let gained = false;
        const CHUNK = 500;
        for (let i = 0; i < miss.length; i += CHUNK) {
            const batch = miss.slice(i, i + CHUNK);
            try {
                const r = await fetch('/api/prompts/categorize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch),
                });
                if (!r.ok) continue;
                const d = await r.json();
                for (const it of (d.results || [])) {
                    const key = String(it.tag || '').toLowerCase().replace(/\s+/g, '_');
                    let cat = String(it.category || 'unknown').toLowerCase();
                    if (!TAG_CATEGORY_SET.has(cat)) cat = 'unknown';
                    if (key) { this._tagCategoryCache.set(key, cat); gained = true; }
                }
            } catch (_e) { /* keep local fallback */ }
        }
        return gained;
    };

    DM._tagCategoryOrder = function () {
        const raw = document.getElementById('dataset-tag-category-order')?.value || '';
        const parsed = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const seen = new Set();
        const order = [];
        for (const name of parsed) {
            if (TAG_CATEGORY_ORDER_DEFAULT.includes(name) && !seen.has(name)) {
                seen.add(name);
                order.push(name);
            }
        }
        for (const name of TAG_CATEGORY_ORDER_DEFAULT) {
            if (!seen.has(name)) order.push(name);
        }
        return order;
    };

    DM._applyTagCategoryOrder = async function () {
        const ids = typeof this._captionScopeIds === 'function' ? this._captionScopeIds() : [Number(this.activeId)];
        if (!ids.length) {
            this._toast(this._t('dataset.noActiveImage', 'Select an image first.'), 'warning', 3000);
            return;
        }
        // Resolve real backend categories for every tag in scope first, so the
        // group reorder uses the true danbooru group of each tag (not just the
        // synchronous first-paint guess).
        const scopeTags = new Set();
        for (const id of ids) {
            const cap = this.captionEdits.has(id) ? this.captionEdits.get(id) : (this.captions.get(id) || '');
            String(cap || '').split(',').forEach((s) => { const v = s.trim(); if (v) scopeTags.add(v); });
        }
        if (scopeTags.size && typeof this._ensureTagCategories === 'function') {
            try { await this._ensureTagCategories([...scopeTags]); } catch (_e) { /* fall back to local */ }
        }
        const order = this._tagCategoryOrder();
        const rank = new Map(order.map((name, idx) => [name, idx]));
        let changed = 0;
        for (const id of ids) {
            const caption = this.captionEdits.has(id) ? this.captionEdits.get(id) : (this.captions.get(id) || '');
            const parts = String(caption || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (parts.length <= 1) continue;
            const sorted = parts
                .map((tag, index) => ({ tag, index, category: this._classifyTagCategory(tag) }))
                .sort((a, b) => (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99) || a.index - b.index)
                .map((item) => item.tag);
            const next = sorted.join(', ');
            if (next !== caption) {
                this.captionEdits.set(id, next);
                this._refreshQueueItem?.(id);
                changed += 1;
            }
        }
        if (this.activeId != null) this._setActive(this.activeId);
        this._renderTagPills();
        this._refreshExportPreview?.();
        this._toast(this._t('dataset.tagCategoryOrderApplied',
            'Reordered tags in {count} captions.', { count: changed }),
            changed ? 'success' : 'info', 3000);
    };

    DM._renderTagPills = function () {
        const section = document.getElementById('dataset-tag-pills-section');
        const wrap = document.getElementById('dataset-tag-pills-wrap');
        if (!section || !wrap) return;

        if (this.activeId == null) {
            section.hidden = true;
            return;
        }

        const caption = this.captionEdits.has(this.activeId)
            ? this.captionEdits.get(this.activeId)
            : (this.captions.get(this.activeId) || '');
        const tags = caption.split(',').map(t => t.trim()).filter(Boolean);

        // Pull authoritative backend categories so pills recolor to their true
        // danbooru group once resolved (first paint shows the local regex
        // fallback). The re-render is a no-op fetch-wise since every tag is now
        // cached, so there is no recolor loop.
        if (tags.length && typeof this._ensureTagCategories === 'function') {
            this._ensureTagCategories(tags).then((gained) => {
                if (gained && this.activeId != null) this._renderTagPills();
            }).catch(() => { /* keep local fallback colors */ });
        }

        if (tags.length === 0) {
            wrap.innerHTML = '<span class="dataset-tag-pills-empty">No tags</span>';
            section.hidden = false;
            return;
        }

        wrap.innerHTML = '';
        for (const tag of tags) {
            // Pills are real buttons so they're keyboard-focusable and
            // operable. Previously they were <span>s with only a click
            // handler — mouse-only, no Tab/Enter/Space path, no role.
            const pill = document.createElement('button');
            pill.type = 'button';
            const category = this._classifyTagCategory(tag);
            pill.className = `dataset-tag-pill dataset-tag-pill-category-${category}`;
            const label = document.createElement('span');
            label.textContent = tag;
            const x = document.createElement('span');
            x.className = 'dataset-tag-pill-x';
            x.textContent = 'x';
            x.setAttribute('aria-hidden', 'true');
            pill.append(label, x);
            pill.title = this._t('dataset.tagPillRemove', 'Remove "{tag}"', { tag })
                || `Remove "${tag}"`;
            pill.setAttribute('aria-label', pill.title);
            pill.addEventListener('click', () => this._removeTag(tag));
            wrap.appendChild(pill);
        }
        section.hidden = false;
    };

    DM._removeTag = function (tag) {
        if (this.activeId == null) return;
        const ta = document.getElementById('dataset-editor-textarea');
        if (!ta) return;
        const tags = ta.value.split(',').map(t => t.trim()).filter(Boolean);
        const filtered = tags.filter(t => t !== tag);
        ta.value = filtered.join(', ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        this._renderTagPills();
    };

    // ---------- Zoom event bindings ----------
    (function initZoomBindings() {
        document.getElementById('btn-dataset-zoom-in')
            ?.addEventListener('click', () => DM._zoomIn());
        document.getElementById('btn-dataset-zoom-out')
            ?.addEventListener('click', () => DM._zoomOut());
        document.getElementById('btn-dataset-zoom-reset')
            ?.addEventListener('click', () => DM._zoomReset());

        const wrap = document.getElementById('dataset-editor-image-wrap');
        if (wrap) {
            wrap.addEventListener('wheel', (e) => {
                if (!e.ctrlKey) return;
                e.preventDefault();
                if (e.deltaY < 0) DM._zoomIn();
                else DM._zoomOut();
            }, { passive: false });
        }
    })();

    // ---------- Batch Find/Replace ----------
    DM._batchFindReplace = async function () {
        const findEl = document.getElementById('dataset-find-input');
        const replaceEl = document.getElementById('dataset-replace-input');
        if (!findEl || !replaceEl) return;
        const find = findEl.value;
        if (!find) return;
        const btn = document.getElementById('btn-dataset-find-replace');
        const previousText = btn?.textContent;
        if (btn) {
            btn.disabled = true;
            btn.textContent = this._t('dataset.replaceLoading', 'Loading captions...');
        }
        const replace = replaceEl.value;
        // Default is whole-tag: a caption is comma-separated tags, so the user
        // means "rename this tag", not "edit this substring wherever it lands".
        // The opt-in checkbox restores the raw substring behavior.
        const substringMode = !!document.getElementById('dataset-find-substring')?.checked;
        // trim + collapse whitespace + fold _<->space + case-insensitive, so
        // "long_hair" matches "long hair" / "Long  Hair".
        const normalizeTag = (s) => String(s || '').replace(/[\s_]+/g, ' ').trim().toLowerCase();
        const findKey = normalizeTag(find);
        let count = 0;
        try {
            const scopeIds = typeof this._captionScopeIds === 'function' ? this._captionScopeIds() : this.imageIds;
            if (!scopeIds.length) {
                this._toast(this._t('dataset.noCaptionScopeImages',
                    'No images match the current caption action scope.'), 'warning', 3000);
                return;
            }
            const missing = scopeIds
                .filter(id => !(this.isLocalId?.(id)))
                .filter(id => !this.captions.has(id) && !this.captionEdits.has(id));
            if (missing.length) {
                await this._fetchCaptionsFor(missing);
            }
            for (const id of scopeIds) {
                const caption = this.captionEdits.has(id)
                    ? this.captionEdits.get(id)
                    : (this.captions.get(id) || '');
                let updated;
                if (substringMode) {
                    if (!caption.includes(find)) continue;
                    updated = caption.split(find).join(replace);
                } else {
                    // Whole-tag: split on commas, match tokens whose normalized
                    // form equals the find term, and swap the replacement in
                    // verbatim while keeping each token's surrounding spacing.
                    let changed = false;
                    updated = caption.split(',').map((part) => {
                        if (!findKey || normalizeTag(part) !== findKey) return part;
                        changed = true;
                        const m = part.match(/^(\s*)[\s\S]*?(\s*)$/);
                        return `${m ? m[1] : ''}${replace}${m ? m[2] : ''}`;
                    }).join(',');
                    if (!changed) continue;
                }
                this.captionEdits.set(id, updated);
                count++;
            }
            if (count > 0 && this.activeId != null) {
                this._setActive(this.activeId);
            }
            const msg = this._t('dataset.replaceResult', '{count} captions updated')
                .replace('{count}', count);
            if (window.showToast) window.showToast(msg, count > 0 ? 'success' : 'info');
        } finally {
            if (btn) {
                btn.disabled = false;
                if (previousText) btn.textContent = previousText;
            }
        }
    };

    document.getElementById('btn-dataset-find-replace')
        ?.addEventListener('click', () => DM._batchFindReplace());

    document.getElementById('btn-dataset-apply-tag-category-order')
        ?.addEventListener('click', () => DM._applyTagCategoryOrder());

    // ---------- Caption diff indicator ----------
    DM._updateCaptionDiff = function (id) {
        const el = document.getElementById('dataset-caption-diff');
        if (!el) return;
        if (!this.captionEdits.has(id)) {
            el.hidden = true;
            return;
        }
        const original = (this.captions.get(id) || '').split(', ').filter(Boolean);
        const edited = (this.captionEdits.get(id) || '').split(', ').filter(Boolean);
        const origSet = new Set(original);
        const editSet = new Set(edited);
        const added = edited.filter(t => !origSet.has(t)).length;
        const removed = original.filter(t => !editSet.has(t)).length;
        if (added === 0 && removed === 0) {
            el.hidden = true;
            return;
        }
        const parts = [];
        if (added > 0) parts.push(`<span class="dataset-diff-added">+${added} tag${added > 1 ? 's' : ''}</span>`);
        if (removed > 0) parts.push(`<span class="dataset-diff-removed">-${removed} tag${removed > 1 ? 's' : ''}</span>`);
        el.innerHTML = parts.join(', ');
        el.hidden = false;
    };

    // Patch _setActive to also update diff
    const _origSetActiveDiff = DM._setActive;
    DM._setActive = function (imageId) {
        _origSetActiveDiff.call(this, imageId);
        if (this.activeId != null) this._updateCaptionDiff(Number(this.activeId));
    };

    // ---------- Keyboard shortcuts for workbench ----------
    document.addEventListener('keydown', function (e) {
        const view = document.getElementById('view-dataset');
        if (!view || view.hidden) return;
        const maker = view.querySelector('.dataset-maker');
        if (!maker || maker.dataset.activeTab !== 'workbench') return;
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        switch (e.key) {
            case 'a':
            case 'A':
            case 'ArrowLeft':
                e.preventDefault();
                DM._stepActive(-1);
                break;
            case 'd':
            case 'D':
            case 'ArrowRight':
                e.preventDefault();
                DM._stepActive(1);
                break;
            case 'Delete':
                e.preventDefault();
                DM._removeActive();
                break;
        }
    });
})();
