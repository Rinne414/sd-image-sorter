/**
 * Dataset Maker — Phase 2C (noob-friendly redesign).
 *
 * Drives the focused LoRA dataset workflow exposed by the 📦 Dataset
 * tab. Talks to /api/dataset/export, /api/tag/start,
 * /api/tags/export-preview, /api/image-thumbnail, and the gallery's
 * selection-token APIs.
 */
(function () {
    'use strict';

    const WELCOME_DISMISSED_KEY = 'sd-image-sorter-dataset-welcome-dismissed';

    const DM = {
        // ---- State ----
        imageIds: [],
        meta: new Map(),
        captions: new Map(),
        captionEdits: new Map(),
        activeId: null,
        boundOnce: false,

        // ---- i18n helper ----
        _t(key, fallback, params) {
            if (typeof window.appT === 'function') return window.appT(key, fallback, params);
            return fallback || key;
        },
        _toast(msg, level = 'info', durationMs) {
            if (typeof window.showToast === 'function') {
                window.showToast(msg, level, durationMs);
            } else {
                console.log(`[dataset] ${level}: ${msg}`);
            }
        },

        // ---- Lifecycle ----
        init() {
            if (this.boundOnce) return;
            this.boundOnce = true;
            this._bindEvents();
            this._renderQueue();
            this._renderEmptyEditor();
            this._updateNamingPreview();
            this._updateExportEnabled();
            this._restoreWelcomeVisibility();
        },

        _restoreWelcomeVisibility() {
            const dismissed = (() => {
                try { return localStorage.getItem(WELCOME_DISMISSED_KEY) === '1'; }
                catch { return false; }
            })();
            const banner = document.getElementById('dataset-welcome');
            const helpBtn = document.getElementById('btn-dataset-show-help');
            if (banner) banner.hidden = dismissed;
            if (helpBtn) helpBtn.hidden = !dismissed;
        },

        _bindEvents() {
            // Welcome banner show/hide
            document.getElementById('btn-dataset-dismiss-welcome')?.addEventListener('click', () => {
                document.getElementById('dataset-welcome')?.setAttribute('hidden', '');
                document.getElementById('btn-dataset-show-help')?.removeAttribute('hidden');
                try { localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); } catch {}
            });
            document.getElementById('btn-dataset-show-help')?.addEventListener('click', () => {
                document.getElementById('dataset-welcome')?.removeAttribute('hidden');
                document.getElementById('btn-dataset-show-help')?.setAttribute('hidden', '');
                try { localStorage.removeItem(WELCOME_DISMISSED_KEY); } catch {}
            });

            // Toolbar
            document.getElementById('btn-dataset-import-gallery')?.addEventListener('click', () => this._importFromGallery());
            document.getElementById('btn-dataset-clear')?.addEventListener('click', () => this._clearAll());

            // Tag all
            document.getElementById('btn-dataset-tag-all')?.addEventListener('click', () => this._tagAll());

            // Caption editor actions
            document.getElementById('btn-dataset-prev-image')?.addEventListener('click', () => this._stepActive(-1));
            document.getElementById('btn-dataset-next-image')?.addEventListener('click', () => this._stepActive(1));
            document.getElementById('btn-dataset-revert-caption')?.addEventListener('click', () => this._revertActiveCaption());
            document.getElementById('btn-dataset-remove-image')?.addEventListener('click', () => this._removeActive());

            // Caption textarea
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) {
                let timer = null;
                ta.addEventListener('input', () => {
                    if (this.activeId == null) return;
                    if (timer) clearTimeout(timer);
                    const id = this.activeId;
                    timer = setTimeout(() => {
                        this.captionEdits.set(id, ta.value);
                        this._refreshQueueItem(id);
                    }, 200);
                });
            }

            // Naming preset radios
            document.querySelectorAll('input[name="dataset-naming-preset"]').forEach(radio => {
                radio.addEventListener('change', () => this._onPresetChange());
            });

            // P2 fix: Copy vs Move radios mirror to the (now hidden) select
            // that backend code reads from. The new radios are the visible
            // source of truth; the select acts as a compatibility shim.
            document.querySelectorAll('input[name="dataset-image-op-radio"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    const hidden = document.getElementById('dataset-image-op');
                    if (hidden) hidden.value = radio.value;
                });
            });

            // Trigger + custom pattern -> live preview
            for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
                document.getElementById(id)?.addEventListener('input', () => this._updateNamingPreview());
            }

            // Bulk caption ops -> recompute captions on the fly (debounced)
            for (const id of ['dataset-common-tags', 'dataset-blacklist', 'dataset-underscore-to-space']) {
                const el = document.getElementById(id);
                if (!el) continue;
                let t = null;
                const evt = (el.tagName.toLowerCase() === 'input' && el.type === 'checkbox') ? 'change' : 'input';
                el.addEventListener(evt, () => {
                    if (t) clearTimeout(t);
                    t = setTimeout(() => this._refreshAllCaptions(), 400);
                });
            }

            // Output folder validation + export-button enable
            document.getElementById('dataset-output-folder')?.addEventListener('input', () => {
                this._validateOutputFolder();
                this._updateExportEnabled();
            });

            // Export flow
            document.getElementById('btn-dataset-export')?.addEventListener('click', () => this._showConfirmModal());
            document.getElementById('btn-dataset-confirm-cancel')?.addEventListener('click', () => this._hideConfirmModal());
            document.getElementById('btn-dataset-confirm-go')?.addEventListener('click', () => this._runExport());

            // Result modal
            document.getElementById('btn-dataset-result-close')?.addEventListener('click', () => this._hideResultModal());
            document.getElementById('btn-dataset-open-folder')?.addEventListener('click', () => this._openOutputFolder());
        },

        // ---- Import from Gallery ----
        async _importFromGallery() {
            const ids = this._getGallerySelectedIds();
            if (!ids || ids.length === 0) {
                // P0 fix from issue #5 follow-up noob review: silent failure
                // here is the #1 confusion point. Take the user there
                // explicitly + show a sticky toast that survives the nav.
                this._toast(this._t('dataset.gallerySelectionEmpty',
                    '👈 Open the Gallery tab and select images first, then come back here and click this button again.'),
                    'warning', 8000);
                // Switch to the Gallery tab so the user sees the next step
                // without having to figure out where to click.
                const galleryTab = document.getElementById('nav-tab-gallery');
                if (galleryTab) {
                    setTimeout(() => galleryTab.click(), 600);
                }
                return;
            }
            const before = this.imageIds.length;
            const seen = new Set(this.imageIds);
            for (const id of ids) {
                const n = Number(id);
                if (!seen.has(n)) {
                    this.imageIds.push(n);
                    seen.add(n);
                }
            }
            const added = this.imageIds.length - before;
            await this._fetchMissingMeta();
            await this._fetchMissingCaptions();
            this._renderQueue();
            this._updateCount();
            this._updateExportEnabled();
            if (this.activeId == null && this.imageIds.length) this._setActive(this.imageIds[0]);
            this._toast(this._t('dataset.gallerySelectionAdded',
                'Added {count} images from Gallery selection',
                { count: added }), 'success');
        },

        _getGallerySelectedIds() {
            if (typeof window.getSelectedGalleryIds === 'function') {
                try { return window.getSelectedGalleryIds() || []; } catch {}
            }
            if (window.AppState && window.AppState.selectedIds) {
                try { return Array.from(window.AppState.selectedIds); } catch {}
            }
            return [];
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
            this._renderEmptyEditor();
            this._updateCount();
            this._updateExportEnabled();
        },
    };

    window.DatasetMaker = DM;

    // Wire up later parts (active image, caption fetch, export, modals) via
    // a separate file load to keep this module compact and verifiable.
    const part2 = document.createElement('script');
    part2.src = '/static/js/dataset-maker-part2.js';
    document.head.appendChild(part2);
    const part3 = document.createElement('script');
    part3.src = '/static/js/dataset-maker-part3.js';
    document.head.appendChild(part3);

    // Hook into view activation
    function initWhenViewActivates() {
        const view = document.getElementById('view-dataset');
        if (!view) return;
        const observer = new MutationObserver(() => {
            if (view.classList.contains('active')) DM.init();
        });
        observer.observe(view, { attributes: true, attributeFilter: ['hidden', 'class'] });
        if (view.classList.contains('active')) DM.init();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenViewActivates);
    } else {
        initWhenViewActivates();
    }
})();
