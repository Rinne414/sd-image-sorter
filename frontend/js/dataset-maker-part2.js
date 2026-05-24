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

    DM._setActive = function (imageId) {
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
            img.src = `/api/image-thumbnail/${id}?size=512`;
            img.alt = filename;
            img.hidden = false;
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
        this._renderTagPills();
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
        const msg = this._t('dataset.confirmRemove', 'Remove this image from the dataset?');
        if (!window.confirm(msg)) return;
        const id = Number(this.activeId);
        const idx = this.imageIds.indexOf(id);
        if (idx < 0) return;
        this.imageIds.splice(idx, 1);
        this.captions.delete(id);
        this.captionEdits.delete(id);
        this.activeId = null;
        this._renderQueue();
        this._updateCount();
        this._updateExportEnabled();
        if (this.imageIds.length === 0) {
            this._renderEmptyEditor();
        } else {
            this._setActive(this.imageIds[Math.min(idx, this.imageIds.length - 1)]);
        }
    };

    DM._revertActiveCaption = function () {
        if (this.activeId == null) return;
        const id = Number(this.activeId);
        this.captionEdits.delete(id);
        const ta = document.getElementById('dataset-editor-textarea');
        if (ta) ta.value = this.captions.get(id) || '';
        this._refreshQueueItem(id);
    };

    DM._renderEmptyEditor = function () {
        const img = document.getElementById('dataset-editor-image');
        const empty = document.getElementById('dataset-editor-empty');
        const ta = document.getElementById('dataset-editor-textarea');
        const actions = document.getElementById('dataset-editor-actions');
        const filenameEl = document.getElementById('dataset-editor-filename');
        if (img) img.hidden = true;
        if (empty) empty.hidden = false;
        if (ta) ta.hidden = true;
        if (actions) actions.hidden = true;
        if (filenameEl) filenameEl.textContent = '';
    };

    // ---------- Queue rendering ----------
    DM._renderQueue = function () {
        const list = document.getElementById('dataset-queue-list');
        if (!list) return;
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
            return;
        }
        list.innerHTML = '';
        for (const id of this.imageIds) {
            list.appendChild(this._buildQueueItem(id));
        }
        this._highlightActiveQueueItem();
    };

    DM._buildQueueItem = function (id) {
        const meta = this.meta.get(id) || {};
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dataset-queue-item';
        item.dataset.imageId = String(id);

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
        img.src = `/api/image-thumbnail/${id}?size=96`;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';

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
        badge.innerHTML = `<span aria-hidden="true">${b.icon}</span><span>${this._t(b.key, b.fallback)}</span>`;

        item.append(img, metaWrap, badge);
        item.addEventListener('click', () => this._setActive(id));
        return item;
    };

    DM._refreshQueueItem = function (id) {
        const list = document.getElementById('dataset-queue-list');
        if (!list) return;
        const existing = list.querySelector(`.dataset-queue-item[data-image-id="${id}"]`);
        if (!existing) return;
        existing.replaceWith(this._buildQueueItem(id));
        this._highlightActiveQueueItem();
    };

    DM._highlightActiveQueueItem = function () {
        const list = document.getElementById('dataset-queue-list');
        if (!list) return;
        for (const el of list.querySelectorAll('.dataset-queue-item')) {
            el.classList.toggle('active', Number(el.dataset.imageId) === Number(this.activeId));
        }
    };

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
            return;
        }

        container.hidden = false;
        if (countEl) {
            countEl.textContent = this._t('dataset.importGalleryCount',
                '{count} images imported', { count: this.imageIds.length });
        }

        grid.innerHTML = '';
        for (const id of this.imageIds) {
            const thumb = document.createElement('div');
            thumb.className = 'import-thumb';
            thumb.dataset.imageId = String(id);
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.alt = '';

            if (this.isLocalId && this.isLocalId(id)) {
                const meta = this.meta.get(id) || {};
                img.src = meta.thumb_b64
                    ? `data:image/jpeg;base64,${meta.thumb_b64}`
                    : '';
            } else {
                img.src = `/api/image-thumbnail/${id}?size=96`;
            }

            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            thumb.appendChild(img);
            thumb.addEventListener('click', () => this._setActive(id));
            grid.appendChild(thumb);
        }
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

        if (tags.length === 0) {
            wrap.innerHTML = '<span class="dataset-tag-pills-empty">No tags</span>';
            section.hidden = false;
            return;
        }

        wrap.innerHTML = '';
        for (const tag of tags) {
            const pill = document.createElement('span');
            pill.className = 'dataset-tag-pill';
            pill.innerHTML = `${tag} <span class="dataset-tag-pill-x">x</span>`;
            pill.title = `Remove "${tag}"`;
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
    DM._batchFindReplace = function () {
        const findEl = document.getElementById('dataset-find-input');
        const replaceEl = document.getElementById('dataset-replace-input');
        if (!findEl || !replaceEl) return;
        const find = findEl.value;
        if (!find) return;
        const replace = replaceEl.value;
        let count = 0;
        for (const id of this.imageIds) {
            const caption = this.captionEdits.has(id)
                ? this.captionEdits.get(id)
                : (this.captions.get(id) || '');
            if (!caption.includes(find)) continue;
            const updated = caption.split(find).join(replace);
            this.captionEdits.set(id, updated);
            count++;
        }
        if (count > 0 && this.activeId != null) {
            this._setActive(this.activeId);
        }
        const msg = this._t('dataset.replaceResult', '{count} captions updated')
            .replace('{count}', count);
        if (window.showToast) window.showToast(msg, count > 0 ? 'success' : 'info');
    };

    document.getElementById('btn-dataset-find-replace')
        ?.addEventListener('click', () => DM._batchFindReplace());

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
    const _origSetActive = DM._setActive;
    DM._setActive = function (imageId) {
        _origSetActive.call(this, imageId);
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
