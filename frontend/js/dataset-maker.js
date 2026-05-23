/**
 * Dataset Maker - v3.2.2 follow-up to issue #5 points 5 / 6.
 *
 * A focused workflow for LoRA training dataset preparation:
 *   import from gallery -> tag -> edit captions -> rename -> export
 *
 * Reuses existing infrastructure rather than reimplementing it:
 *   - Gallery selection-token API for "Add from Gallery selection"
 *   - /api/tag/start for AI tagging the dataset
 *   - /api/tags/export-preview for live caption rendering
 *   - The new /api/dataset/export endpoint for combined image+caption rename-export
 *
 * Trimmed compared to the existing Caption Editor:
 *   - No queue rearrange (datasets are unordered for trainers)
 *   - No content-mode tab switching (locked to LoRA caption mode)
 *   - One single export workflow
 */
(function () {
    'use strict';

    const DatasetMaker = {
        // Internal state
        imageIds: [],            // ordered list of image_ids in this dataset
        meta: new Map(),         // image_id -> {filename, path, thumbnail_path}
        captions: new Map(),     // image_id -> rendered caption (from preview API)
        captionEdits: new Map(), // image_id -> user-edited caption (overrides rendered)
        activeId: null,
        boundOnce: false,

        // ---- i18n helper ------------------------------------------------
        _t(key, fallback, params) {
            if (typeof window.appT === 'function') return window.appT(key, fallback, params);
            return fallback || key;
        },

        // ---- Lifecycle --------------------------------------------------
        init() {
            if (this.boundOnce) return;
            this.boundOnce = true;
            this._bindEvents();
            this._renderEmpty();
            this._updateNamingPreview();
        },

        _bindEvents() {
            document.getElementById('btn-dataset-import-gallery')?.addEventListener('click', () => this._importFromGallery());
            document.getElementById('btn-dataset-import-folder')?.addEventListener('click', () => this._importFromFolder());
            document.getElementById('btn-dataset-clear')?.addEventListener('click', () => this._clearAll());
            document.getElementById('btn-dataset-tag-all')?.addEventListener('click', () => this._tagAll());
            document.getElementById('btn-dataset-export')?.addEventListener('click', () => this._exportDataset());
            document.getElementById('btn-dataset-revert-caption')?.addEventListener('click', () => this._revertActiveCaption());
            document.getElementById('btn-dataset-prev-image')?.addEventListener('click', () => this._stepActive(-1));
            document.getElementById('btn-dataset-next-image')?.addEventListener('click', () => this._stepActive(1));
            document.getElementById('btn-dataset-remove-image')?.addEventListener('click', () => this._removeActive());
            document.getElementById('btn-dataset-browse-output')?.addEventListener('click', () => this._browseOutputFolder());

            // Caption textarea — debounced save to captionEdits
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) {
                let timer = null;
                ta.addEventListener('input', () => {
                    if (this.activeId == null) return;
                    if (timer) clearTimeout(timer);
                    const id = this.activeId;
                    timer = setTimeout(() => {
                        this.captionEdits.set(id, ta.value);
                        this._refreshQueueItem(id);  // show 'edited' badge
                    }, 200);
                });
            }

            // Live naming preview
            for (const id of ['dataset-naming-pattern', 'dataset-trigger']) {
                document.getElementById(id)?.addEventListener('input', () => this._updateNamingPreview());
            }
        },

        // ---- Import from Gallery ---------------------------------------
        async _importFromGallery() {
            // Use the same flow that the gallery's batch operations use:
            // get the current selection's image IDs.
            const selectedIds = this._getGallerySelectedIds();
            if (!selectedIds || selectedIds.length === 0) {
                this._toast(this._t('dataset.gallerySelectionEmpty',
                    'Select images in Gallery first, then come back here.'), 'warning');
                return;
            }
            const before = this.imageIds.length;
            const seen = new Set(this.imageIds);
            for (const id of selectedIds) {
                if (!seen.has(id)) {
                    this.imageIds.push(id);
                    seen.add(id);
                }
            }
            const added = this.imageIds.length - before;
            await this._fetchMissingMeta();
            await this._fetchMissingCaptions();
            this._renderQueue();
            this._updateCount();
            if (this.activeId == null && this.imageIds.length) {
                this._setActive(this.imageIds[0]);
            }
            this._toast(
                this._t('dataset.gallerySelectionAdded',
                    'Added {count} images from Gallery selection',
                    { count: added }),
                'success'
            );
        },

        _getGallerySelectedIds() {
            // Multiple paths the Gallery exposes selected IDs through.
            if (typeof window.getSelectedGalleryIds === 'function') {
                try { return window.getSelectedGalleryIds() || []; } catch { /* */ }
            }
            if (window.AppState && window.AppState.selectedIds) {
                try { return Array.from(window.AppState.selectedIds); } catch { /* */ }
            }
            return [];
        },

        async _importFromFolder() {
            // For the MVP, point users to the existing scan flow rather than
            // reimplement folder picking. Once the import lands in the gallery,
            // they select and use "Add from Gallery selection".
            this._toast(
                this._t('dataset.importFromFolderHint',
                    'Use the main "Import Images" button to scan a folder, then select the images in Gallery and come back here to add them.'),
                'info', 6000
            );
        },

        _clearAll() {
            if (this.imageIds.length === 0) return;
            const msg = this._t('dataset.confirmClear',
                'Remove all {count} images from the dataset? (Original files in your library are not affected.)',
                { count: this.imageIds.length });
            if (!window.confirm(msg)) return;
            this.imageIds = [];
            this.captions.clear();
            this.captionEdits.clear();
            this.activeId = null;
            this._renderQueue();
            this._renderEmpty();
            this._updateCount();
        },

        // ---- Active image + caption editor -----------------------------
        _setActive(imageId) {
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

            if (img) {
                img.src = `/api/image-thumbnail/${id}?size=512`;
                img.alt = filename;
                img.hidden = false;
            }
            if (empty) empty.hidden = true;
            if (filenameEl) filenameEl.textContent = filename;

            const caption = this.captionEdits.has(id)
                ? this.captionEdits.get(id)
                : (this.captions.get(id) || '');
            if (ta) {
                ta.value = caption;
                ta.hidden = false;
            }
            if (actions) actions.hidden = false;

            this._highlightActiveQueueItem();
        },

        _stepActive(delta) {
            if (this.activeId == null || this.imageIds.length === 0) return;
            const idx = this.imageIds.indexOf(Number(this.activeId));
            if (idx < 0) return;
            const next = (idx + delta + this.imageIds.length) % this.imageIds.length;
            this._setActive(this.imageIds[next]);
        },

        _removeActive() {
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
            if (this.imageIds.length === 0) {
                this._renderEmpty();
            } else {
                this._setActive(this.imageIds[Math.min(idx, this.imageIds.length - 1)]);
            }
        },

        _revertActiveCaption() {
            if (this.activeId == null) return;
            const id = Number(this.activeId);
            this.captionEdits.delete(id);
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) ta.value = this.captions.get(id) || '';
            this._refreshQueueItem(id);
        },

        // ---- Caption rendering via the existing preview API -----------
        async _fetchMissingMeta() {
            const missing = this.imageIds.filter(id => !this.meta.has(id));
            if (missing.length === 0) return;
            try {
                // Reuse the export-preview endpoint to get filename + thumbnail_path
                // for each image without making one round-trip per image.
                const r = await fetch('/api/tags/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: missing.slice(0, 500), preset_id: 'custom' }),
                });
                if (!r.ok) return;
                const data = await r.json();
                for (const item of (data.results || [])) {
                    this.meta.set(Number(item.image_id), {
                        filename: item.filename || '',
                        thumbnail_path: item.thumbnail_path || '',
                    });
                    if (item.rendered) this.captions.set(Number(item.image_id), item.rendered);
                }
            } catch (e) { /* swallow - queue will just show fallback labels */ }
        },

        async _fetchMissingCaptions() {
            const missing = this.imageIds.filter(id => !this.captions.has(id));
            if (missing.length === 0) return;
            const opts = this._captionOptions();
            try {
                const r = await fetch('/api/tags/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_ids: missing.slice(0, 500), ...opts }),
                });
                if (!r.ok) return;
                const data = await r.json();
                for (const item of (data.results || [])) {
                    if (item.rendered != null) this.captions.set(Number(item.image_id), item.rendered);
                    if (!this.meta.has(Number(item.image_id))) {
                        this.meta.set(Number(item.image_id), {
                            filename: item.filename || '',
                            thumbnail_path: item.thumbnail_path || '',
                        });
                    }
                }
            } catch (e) { /* */ }
        },

        _captionOptions() {
            const trigger = document.getElementById('dataset-trigger')?.value?.trim() || '';
            const blacklistText = document.getElementById('dataset-blacklist')?.value || '';
            const blacklist = blacklistText.split(',').map(s => s.trim()).filter(Boolean);
            const commonText = document.getElementById('dataset-common-tags')?.value || '';
            const append = commonText.split(',').map(s => s.trim()).filter(Boolean);
            const normalize = !!document.getElementById('dataset-underscore-to-space')?.checked;
            const opts = {
                preset_id: 'custom',
                template_override: '{trigger}, {tags:filtered}, {append}',
                trigger,
                blacklist,
                replace_rules: {},
                max_tags: 0,
                append,
            };
            if (normalize) {
                opts.underscore_to_space_override = true;
                opts.preserve_underscore_prefixes_override = ['score_'];
            } else {
                opts.underscore_to_space_override = false;
                opts.preserve_underscore_prefixes_override = ['score_'];
            }
            return opts;
        },

        // ---- Tag all images via existing /api/tag/start ----------------
        async _tagAll() {
            if (this.imageIds.length === 0) return;
            try {
                const r = await fetch('/api/tag/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image_ids: this.imageIds,
                        retag_all: true,
                    }),
                });
                if (!r.ok) {
                    const body = await r.text();
                    this._toast(`Tagging failed: ${body.slice(0, 120)}`, 'error');
                    return;
                }
                this._toast(this._t('dataset.tagAllStarted',
                    'Tagging started in the background. The progress bar at the top of the screen tracks it.'),
                    'success');
            } catch (e) {
                this._toast(`Tagging failed: ${e.message}`, 'error');
            }
        },

        // ---- Export dataset via the new /api/dataset/export endpoint ---
        async _exportDataset() {
            if (this.imageIds.length === 0) return;
            const outputFolder = document.getElementById('dataset-output-folder')?.value?.trim();
            if (!outputFolder) {
                this._toast('Please choose an output folder first.', 'warning');
                return;
            }

            // Build per-image overrides map for edited captions
            const image_overrides = {};
            for (const [id, val] of this.captionEdits.entries()) {
                image_overrides[String(id)] = val;
            }

            const payload = {
                image_ids: this.imageIds,
                output_folder: outputFolder,
                naming_pattern: document.getElementById('dataset-naming-pattern')?.value || '{filename}',
                trigger: document.getElementById('dataset-trigger')?.value || '',
                image_op: document.getElementById('dataset-image-op')?.value || 'copy',
                overwrite_policy: document.getElementById('dataset-overwrite')?.value || 'unique',
                normalize_tag_underscores: !!document.getElementById('dataset-underscore-to-space')?.checked,
                blacklist: (document.getElementById('dataset-blacklist')?.value || '')
                    .split(',').map(s => s.trim()).filter(Boolean),
                common_tags: (document.getElementById('dataset-common-tags')?.value || '')
                    .split(',').map(s => s.trim()).filter(Boolean),
                image_overrides,
            };

            const exportBtn = document.getElementById('btn-dataset-export');
            const progress = document.getElementById('dataset-export-progress');
            const progressText = document.getElementById('dataset-export-text');
            try {
                if (exportBtn) exportBtn.disabled = true;
                if (progress) progress.hidden = false;
                if (progressText) progressText.textContent = this._t('dataset.exportInProgress', 'Exporting…');

                const r = await fetch('/api/dataset/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!r.ok) {
                    const body = await r.text();
                    this._toast(this._t('dataset.exportError',
                        'Export failed: {message}', { message: body.slice(0, 200) }), 'error');
                    return;
                }
                const data = await r.json();
                this._toast(this._t('dataset.exportDone',
                    'Exported {count} image+caption pairs to {folder}',
                    { count: data.exported || 0, folder: data.output_folder || outputFolder }),
                    'success');
            } catch (e) {
                this._toast(this._t('dataset.exportError',
                    'Export failed: {message}', { message: e.message }), 'error');
            } finally {
                if (exportBtn) exportBtn.disabled = false;
                if (progress) progress.hidden = true;
            }
        },

        async _browseOutputFolder() {
            // Reuse the same folder picker the other modals use. If unavailable
            // the user can paste a path directly; we don't replicate the picker.
            this._toast('Type or paste the output folder path. (Browser folder picker not available in localhost.)', 'info', 4000);
        },

        // ---- UI rendering ----------------------------------------------
        _renderEmpty() {
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
        },

        _renderQueue() {
            const list = document.getElementById('dataset-queue-list');
            if (!list) return;
            if (this.imageIds.length === 0) {
                list.innerHTML = `<p class="dataset-empty-hint">${this._t('dataset.emptyHint',
                    'Select images in Gallery, then click "Add from Gallery selection" above.')}</p>`;
                return;
            }
            list.innerHTML = '';
            for (const id of this.imageIds) {
                list.appendChild(this._buildQueueItem(id));
            }
            this._highlightActiveQueueItem();
        },

        _buildQueueItem(id) {
            const meta = this.meta.get(id) || {};
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'dataset-queue-item';
            item.dataset.imageId = String(id);
            if (this.captionEdits.has(id)) item.classList.add('edited');
            item.innerHTML = `
                <img class="dataset-queue-thumb" src="/api/image-thumbnail/${id}?size=96" alt="" loading="lazy" decoding="async">
                <div class="dataset-queue-meta">
                    <strong class="dataset-queue-filename"></strong>
                    <small class="dataset-queue-id">#${id}${this.captionEdits.has(id) ? ' · edited' : ''}</small>
                </div>
            `;
            item.querySelector('.dataset-queue-filename').textContent = meta.filename || `image_${id}`;
            item.addEventListener('click', () => this._setActive(id));
            return item;
        },

        _refreshQueueItem(id) {
            const list = document.getElementById('dataset-queue-list');
            if (!list) return;
            const existing = list.querySelector(`.dataset-queue-item[data-image-id="${id}"]`);
            if (!existing) return;
            const replacement = this._buildQueueItem(id);
            existing.replaceWith(replacement);
            this._highlightActiveQueueItem();
        },

        _highlightActiveQueueItem() {
            const list = document.getElementById('dataset-queue-list');
            if (!list) return;
            for (const el of list.querySelectorAll('.dataset-queue-item')) {
                el.classList.toggle('active', Number(el.dataset.imageId) === Number(this.activeId));
            }
        },

        _updateCount() {
            const num = document.getElementById('dataset-count-num');
            if (num) num.textContent = String(this.imageIds.length);
        },

        _updateNamingPreview() {
            const previewEl = document.getElementById('dataset-naming-preview');
            if (!previewEl) return;
            const pattern = document.getElementById('dataset-naming-pattern')?.value || '{filename}';
            const trigger = document.getElementById('dataset-trigger')?.value?.trim() || 'subject';
            // Use a representative example for the preview — first image in queue, or a stub
            const sampleStem = (() => {
                if (this.imageIds.length > 0) {
                    const id = this.imageIds[0];
                    const meta = this.meta.get(id) || {};
                    if (meta.filename) {
                        const dot = meta.filename.lastIndexOf('.');
                        return dot > 0 ? meta.filename.slice(0, dot) : meta.filename;
                    }
                }
                return 'example_image';
            })();

            const rendered = pattern
                .replace(/\{filename\}/g, sampleStem)
                .replace(/\{trigger\}/g, trigger)
                .replace(/\{generator\}/g, 'webui')
                .replace(/\{index:0?(\d+)d\}/g, (_m, w) => '1'.padStart(parseInt(w, 10) || 1, '0'))
                .replace(/\{index\}/g, '1');

            const label = this._t('dataset.namingPreview', 'Preview: ');
            previewEl.textContent = `${label}${rendered}.png  +  ${rendered}.txt`;
        },

        _toast(message, level = 'info', durationMs) {
            if (typeof window.showToast === 'function') {
                window.showToast(message, level, durationMs);
                return;
            }
            console.log(`[dataset] ${level}: ${message}`);
        },
    };

    // Hook into the app's view-switching: initialise on first show
    function initWhenViewActivates() {
        const view = document.getElementById('view-dataset');
        if (!view) return;
        const observer = new MutationObserver(() => {
            if (!view.hasAttribute('hidden') && view.classList.contains('active')) {
                DatasetMaker.init();
            }
        });
        observer.observe(view, { attributes: true, attributeFilter: ['hidden', 'class'] });
        // Also init eagerly if the view is already active when this script runs
        if (view.classList.contains('active')) DatasetMaker.init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenViewActivates);
    } else {
        initWhenViewActivates();
    }

    window.DatasetMaker = DatasetMaker;
})();
