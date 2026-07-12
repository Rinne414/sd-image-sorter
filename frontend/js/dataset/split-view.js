/**
 * Dataset Maker — compare-captions split view (+ its _activeChangedHooks push and the shared DOMContentLoaded init of split/queue-mode/filter/selection controls).
 * Moved VERBATIM from dataset-maker-part2.js L835-1023.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

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

    // Refresh the split view on image change (former _setActive wrapper).
    // Gallery-only: the local-import branch never re-rendered the split view.
    DM._activeChangedHooks.push(function (id) {
        if (this.isLocalId?.(id)) return;
        if (this._splitActive) this._applySplitView();
    });

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
})();
