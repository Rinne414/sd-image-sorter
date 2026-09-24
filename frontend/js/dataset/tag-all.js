/**
 * Dataset Maker — Tag all (_tagAll via POST /api/tag/start + AI job queue
 * toasts; datasets with folder-imported images go to Smart Tag).
 * Moved VERBATIM from dataset-maker-part3.js L381-448.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---------- Tag all ----------
    DM._tagAll = async function () {
        if (this.imageIds.length === 0) {
            this._toast(this._t('dataset.queueEmptyHeadline', 'No images yet'), 'warning');
            return;
        }
        // Honour the "re-tag already-tagged" checkbox. Default OFF so the
        // first / repeat click only touches images that lack tags.
        const retagAll = !!document.getElementById('dataset-tag-retag-all')?.checked;
        // Local-source items (negative ids) have no DB row, so the legacy
        // /api/tag/start path cannot tag them. Smart Tag tags Library and
        // folder-imported items alike, so a dataset with any folder images
        // goes there and one run covers everything.
        const galleryIds = this.imageIds.filter((id) => !(this.isLocalId && this.isLocalId(id)));
        if (galleryIds.length < this.imageIds.length) {
            if (this._openDatasetSmartTag()) {
                this._toast(this._t('dataset.tagAllRoutedSmartTag',
                    'Folder images are tagged with Smart Tag. It covers every image in this dataset. Press Run Smart Tag to start.'),
                'info', 6000);
            }
            return;
        }
        try {
            const r = await fetch('/api/tag/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: galleryIds, retag_all: retagAll }),
            });
            if (!r.ok) {
                const body = await r.text();
                this._toast(`Tagging failed: ${body.slice(0, 120)}`, 'error');
                return;
            }
            const startData = await r.json().catch(() => ({}));
            if (startData?.status === 'queued' && startData?.pipeline_queued === true) {
                // v3.4.1 AI job queue: another AI job is running; this one
                // was queued and auto-starts when the current job finishes.
                this._toast(startData.duplicate
                    ? this._t('aiQueue.duplicateToast', 'An identical job is already queued')
                    : this._t('aiQueue.queuedToast', 'Queued — starts automatically after the current AI job finishes'),
                    'info', 6000);
                if (typeof window.App?.beginTaggingProgress === 'function') {
                    window.App.beginTaggingProgress();
                }
                return;
            }
            const startedKey = retagAll ? 'dataset.tagAllStartedRetag' : 'dataset.tagAllStartedSkip';
            const startedFb = retagAll
                ? 'Tagging started (retagging EVERY image). Progress is at the top of the screen.'
                : 'Tagging started (skipping already-tagged images). Progress is at the top of the screen.';
            this._toast(this._t(startedKey, startedFb), 'success', 6000);
            // Attach the shared tagging progress UI (the floating bar at the
            // top of the screen + completion refresh) to the job we just
            // started — the same poll loop the gallery Start-Tag button uses.
            // Without this the toast above points at a progress bar that
            // never appears.
            if (typeof window.App?.beginTaggingProgress === 'function') {
                window.App.beginTaggingProgress();
            }
        } catch (e) {
            this._toast(`Tagging failed: ${e.message}`, 'error');
        }
    };
})();
