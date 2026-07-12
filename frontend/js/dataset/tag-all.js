/**
 * Dataset Maker — Tag all (_tagAll via POST /api/tag/start + AI job queue toasts).
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
        // Local-source items (negative ids) cannot be sent to the legacy
        // /api/tag/start path because they have no DB row. Filter them
        // out and tell the user how many were skipped.
        const galleryIds = this.imageIds.filter((id) => !(this.isLocalId && this.isLocalId(id)));
        const localSkipped = this.imageIds.length - galleryIds.length;
        if (galleryIds.length === 0) {
            this._toast(this._t('dataset.tagAllOnlyLocal',
                'Tag all only works on gallery-source items. Use Smart Tag for folder-imported images, or scan the folder into the main library first.'),
                'warning', 6000);
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
            let msg = this._t(startedKey, startedFb);
            if (localSkipped > 0) {
                msg += ' ' + this._t('dataset.tagAllSkippedLocal',
                    '{count} local-source images were skipped (use Smart Tag for those).',
                    { count: localSkipped });
            }
            this._toast(msg, 'success', 6000);
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
