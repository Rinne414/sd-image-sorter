/**
 * Undo for a move or copy started from the gallery selection.
 *
 * The move job names its run (`run_token` in its final progress); the toast
 * that reports the move gets an Undo button that asks the server to put every
 * moved file back where it was, or to remove the copies it made. Files that
 * changed since are left alone and counted in the report.
 */

const MOVE_UNDO_TOAST_MS = 12000;
const MOVE_UNDO_POLL_MS = 300;

/** Options for the move's result toast: an Undo button when the run can be undone. */
function moveUndoToastOptions(finalProgress) {
    const runToken = finalProgress?.run_token;
    if (!runToken) return {};
    return {
        duration: MOVE_UNDO_TOAST_MS,
        actionLabel: appT('modal.undo', 'Undo'),
        onAction: () => { undoGalleryMove(runToken, finalProgress.operation === 'copy'); },
    };
}

async function _pollMoveUndoUntilDone(runToken) {
    const TERMINAL = new Set(['done', 'cancelled', 'error', 'idle']);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const progress = await API.get('/api/batch-move/progress');
        // Another run took the slot (or the program restarted): nothing more to wait for.
        if (progress?.run_token !== runToken || TERMINAL.has(progress?.status)) {
            return progress;
        }
        await new Promise((resolve) => setTimeout(resolve, MOVE_UNDO_POLL_MS));
    }
}

async function _refreshAfterMoveUndo() {
    resetSelectionDataCache();
    await loadImages(false, { keepPosition: true });
    await loadStats();
    window.FolderTreeUI?.refresh?.();
}

function _reportMoveUndo(progress, runToken, wasCopy) {
    const sameRun = progress?.run_token === runToken;
    const restored = sameRun ? Number(progress.moved || 0) : 0;
    const kept = sameRun ? Number(progress.errors || 0) : 0;
    if (!sameRun || progress.status === 'idle') {
        showToast(appT('selection.moveUndoUnknown', 'The undo ended without a report. Check the folders.'), 'warning');
        return;
    }
    if (kept > 0 || progress.status !== 'done') {
        const firstReason = progress.recent_errors?.[0]?.error || '';
        showToast(
            I18n.format(appT('selection.moveUndoPartial', 'Undone for {restored} images. {kept} left as they are. {reason}'), {
                restored,
                kept,
                reason: firstReason,
            }).trim(),
            'warning',
            { duration: MOVE_UNDO_TOAST_MS }
        );
        return;
    }
    showToast(
        I18n.format(wasCopy
            ? appT('selection.copyUndoDone', 'Undone: the {count} copies were removed.')
            : appT('selection.moveUndoDone', 'Undone: {count} images are back where they were.'), { count: restored }),
        'success'
    );
}

async function undoGalleryMove(runToken, wasCopy) {
    try {
        await API.post('/api/batch-move/undo', { run_token: runToken });
        const progress = await _pollMoveUndoUntilDone(runToken);
        await _refreshAfterMoveUndo();
        _reportMoveUndo(progress, runToken, wasCopy);
    } catch (error) {
        showToast(formatUserError(error, appT('selection.moveUndoFailed', 'Could not undo the move')), 'error');
    }
}
