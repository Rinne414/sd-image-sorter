/**
 * app/gallery-bulk-jobs.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 2081-2311 (of 10,152): durable bulk-job runner + collection picker + dataset sends.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
// ============== Debt-22: durable bulk-job runner ==============
// Token-scoped (and large explicit) delete / remove / export gallery actions
// opt into the shared /api/bulk-jobs registry. This generic poller drives an
// existing progress bubble, forwards Stop clicks to
// POST /api/bulk-jobs/{id}/cancel, and resolves with the terminal job snapshot.
// Small explicit selections keep the Phase-1 singleton path above, so they
// behave exactly as before.
const BULK_JOB_TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);
// Route to the durable job when the operation is token-scoped (an unbounded
// filtered "select all") or the explicit id count reaches one backend chunk.
const BULK_JOB_ITEM_THRESHOLD = 500;
const _activeBulkJobIds = { delete: null, remove: null, export: null };
const _bulkJobCancelRequested = { delete: false, remove: false, export: false };

function shouldUseBulkJob(selectionToken, idCount) {
    return Boolean(selectionToken) || Number(idCount || 0) >= BULK_JOB_ITEM_THRESHOLD;
}

async function requestBulkJobCancel(operation) {
    const jobId = _activeBulkJobIds[operation];
    if (!jobId) return false;
    _bulkJobCancelRequested[operation] = true;
    try {
        await API.cancelBulkJob(jobId);
        return true;
    } catch (error) {
        Logger?.warn?.('Failed to request bulk job cancellation:', error);
        // Don't leave the cancel button looking dead: tell the user the request
        // didn't land (the job may still be running).
        showToast(
            formatUserError(error, appT('bulk.cancelRequestFailed', 'Could not send the cancel request — the job may still be running')),
            'error'
        );
        return false;
    }
}

async function pollBulkJobUntilDone(envelope, operation, handlers = {}) {
    const { show, update, hide } = handlers;
    const jobId = envelope?.id || envelope?.job_id;
    if (!jobId) {
        // Defensive: a classic synchronous result came back (no background job).
        // Nothing to poll — hand it straight to the caller's terminal handling.
        return envelope;
    }
    _activeBulkJobIds[operation] = jobId;
    _bulkJobCancelRequested[operation] = false;
    if (typeof show === 'function') show();
    let fetchFailures = 0;
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let job;
            try {
                job = await API.getBulkJob(jobId);
                fetchFailures = 0;
            } catch (error) {
                // Tolerate transient fetch errors, but give up after 3 in a row
                // so the caller's catch can surface a visible error toast.
                fetchFailures += 1;
                if (fetchFailures >= 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 300));
                continue;
            }
            if (typeof update === 'function') {
                update({
                    total: Number(job?.total || 0),
                    current: Number(job?.processed || 0),
                    status: _bulkJobCancelRequested[operation] ? 'cancelling' : job?.status,
                });
            }
            if (BULK_JOB_TERMINAL_STATUSES.has(job?.status)) {
                return job;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    } finally {
        if (typeof hide === 'function') hide();
        _activeBulkJobIds[operation] = null;
        _bulkJobCancelRequested[operation] = false;
    }
}

// Map a durable /api/bulk-jobs snapshot onto the terminal shape each gallery
// action already consumes. The durable job reports aggregate counters (result +
// bounded error_count), not the Phase-1 per-id `failed` list, so `failed` stays
// empty and callers read `error_count` for the failure count.
function normalizeBulkJobResult(job, operation) {
    const status = job?.status || 'error';
    const result = job?.result || {};
    const errorCount = Number(job?.error_count || 0);
    if (operation === 'remove') {
        return {
            status,
            removed: Number(result.removed || 0),
            missingCount: Number(result.missing || 0),
            missing_ids: [],
            error_count: errorCount,
        };
    }
    return {
        status,
        deleted: Number(result.deleted || 0),
        failed: [],
        error_count: errorCount,
    };
}

// Debt-22: the durable sidecar export reuses the batch-export modal's own
// progress bar; these helpers drive its per-image fill/text and toggle the
// Stop button that cancels the job by id.
function _showBatchExportCancel() {
    const btn = $('#btn-batch-export-cancel-job');
    if (btn) btn.style.display = '';
}

function _hideBatchExportCancel() {
    const btn = $('#btn-batch-export-cancel-job');
    if (btn) btn.style.display = 'none';
}

function _updateBatchExportJobProgress(progress) {
    const fill = $('#batch-export-progress-fill');
    const textEl = $('#batch-export-progress-text');
    const total = Number(progress?.total || 0);
    const current = Number(progress?.current || 0);
    if (fill) {
        const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        fill.style.width = pct + '%';
    }
    if (textEl) {
        if (progress?.status === 'cancelling') {
            textEl.textContent = appT('batchExport.stopping', 'Stopping...');
            return;
        }
        textEl.textContent = total > 0
            ? `${appT('batchExport.exporting', 'Exporting...')} ${current}/${total}`
            : appT('batchExport.exporting', 'Exporting...');
    }
}

async function moveOrCopySelectedGalleryImages(operation = 'move') {
    return moveOrCopyGalleryImages(getSelectedGalleryIds(), operation, { source: 'selection' });
}

// v3.2.2 task #4: push the gallery selection into the Dataset Maker
// queue and switch the user to that view.
function addSelectionToCollectionPicker() {
    const selectionToken = getActiveSelectionTokenForActions();
    const ids = getSelectedGalleryIds();
    if (!selectionToken && ids.length === 0) {
        showToast(
            appT('selection.emptyHint',
                 'Select images, or choose all current filter matches.'),
            'info'
        );
        return;
    }
    if (typeof window.CollectionsUI?.openAddToCollectionPicker !== 'function') {
        showToast(
            appT('collections.unavailable', 'Collections are still loading. Please try again.'),
            'error'
        );
        return;
    }
    window.CollectionsUI.openAddToCollectionPicker(ids, { selectionToken }).catch((error) => {
        Logger?.warn?.('Failed to open collection picker', error);
        showToast(appT('collections.openFailed', 'Failed to open collections'), 'error');
    });
}

async function sendSelectionToDatasetMaker() {
    const ids = getSelectedGalleryIds();
    const hasFilteredToken = Boolean(getActiveSelectionTokenForActions());
    if ((!ids || ids.length === 0) && !hasFilteredToken) {
        showToast(
            appT('selection.emptyHint',
                 'Select images, or choose all current filter matches.'),
            'info'
        );
        return;
    }
    if (!window.DatasetMaker || typeof window.DatasetMaker.addImageIds !== 'function') {
        showToast(
            appT('selection.sendToDatasetMakerUnavailable',
                 'Dataset Maker module not loaded yet — try again in a moment.'),
            'error'
        );
        return;
    }
    try {
        // Route through DatasetMaker so filtered-selection tokens resolve
        // into real image IDs and the user lands on Dataset tab 1.
        const resolvedIds = typeof window.DatasetMaker._resolveGallerySelectionIds === 'function'
            ? await window.DatasetMaker._resolveGallerySelectionIds()
            : ids;
        await addToDatasetMaker(resolvedIds, { switchView: true, showToast: true });
        // FLOW-08: clear the gallery selection after the handoff so it does not
        // linger stale when the user returns to the Gallery tab.
        clearGallerySelectionAfterBulkAction();
    } catch (exc) {
        showToast(
            appT('selection.sendToDatasetMakerFailed',
                 'Failed to send selection to Dataset Maker: {error}',
                 { error: exc?.message || String(exc) }),
            'error'
        );
    }
}

async function addToDatasetMaker(imageIds = [], options = {}) {
    const ids = normalizeSelectionImageIds(imageIds);
    if (ids.length === 0) {
        showToast(appT('selection.emptyHint', 'Select images, or choose all current filter matches.'), 'info');
        return false;
    }
    if (!window.DatasetMaker || typeof window.DatasetMaker.addImageIds !== 'function') {
        showToast(
            appT('selection.sendToDatasetMakerUnavailable',
                 'Dataset Maker module not loaded yet — try again in a moment.'),
            'error'
        );
        return false;
    }
    await window.DatasetMaker.addImageIds(ids, {
        switchView: options.switchView !== false,
        showToast: options.showToast !== false,
    });
    return true;
}

