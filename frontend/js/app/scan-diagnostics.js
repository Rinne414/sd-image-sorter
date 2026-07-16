/**
 * app/scan-diagnostics.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 4598-5093 (of 10,152): scan diagnostics card + scan poll/resume.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function rememberScanDiagnosticsInteraction() {
    _scanDiagnosticsHoldUntil = Date.now() + SCAN_DIAGNOSTICS_HOLD_MS;
}

function rememberScanLogPath(rawPath = '', redactedPath = '') {
    _scanLastLogPath = rawPath || '';
    _scanLastLogPathRedacted = redactedPath || (rawPath ? '<PATH>' : '');
}

function _formatScanDiagnosticsPayload(payload) {
    const parts = [
        'SD Image Sorter scan diagnostics',
        `App version: ${payload?.app_version || 'unknown'}`,
        `Log file: ${payload?.log_file_path_redacted || (payload?.log_file_path ? '<PATH>' : 'unavailable')}`,
        `Log exists: ${payload?.log_file_exists ? 'yes' : 'no'}`,
        `Access log: ${payload?.access_log_enabled ? 'on' : 'off'}`,
        `Log level: ${payload?.log_level || 'unknown'}`,
        '',
        'Recent backend log:',
        payload?.recent_log_text || '(no log lines available)',
    ];
    return parts.join('\n');
}

async function copyScanDiagnostics() {
    try {
        rememberScanDiagnosticsInteraction();
        const payload = await API.getSupportDiagnostics(200);
        const copied = await copyTextToClipboard(
            _formatScanDiagnosticsPayload(payload),
            appT('scan.diagnosticsCopied', 'Diagnostics copied')
        );
        if (!copied) {
            showToast(appT('scan.diagnosticsCopyFailed', 'Could not copy diagnostics automatically'), 'warning');
        }
    } catch (error) {
        Logger.error('Failed to copy scan diagnostics:', error);
        showToast(appT('scan.diagnosticsFetchFailed', 'Could not load diagnostics'), 'error');
    }
}

async function copyScanLogPath() {
    try {
        rememberScanDiagnosticsInteraction();
        let pathToCopy = _scanLastLogPath;
        if (!pathToCopy) {
            const payload = await API.getSupportDiagnostics(1);
            rememberScanLogPath(payload?.log_file_path || '', payload?.log_file_path_redacted || '');
            const pathEl = $('#scan-diagnostics-path');
            if (pathEl && _scanLastLogPathRedacted) {
                pathEl.textContent = _scanLastLogPathRedacted;
                pathEl.title = _scanLastLogPathRedacted;
            }
            pathToCopy = _scanLastLogPath;
        }
        if (!pathToCopy) {
            showToast(appT('scan.copyLogPathUnavailable', 'Log path is not available'), 'warning');
            return;
        }
        const copied = await copyTextToClipboard(pathToCopy, appT('scan.logPathCopied', 'Log path copied'));
        if (!copied) {
            showToast(appT('scan.logPathCopyFailed', 'Could not copy log path automatically'), 'warning');
        }
    } catch (error) {
        Logger.error('Failed to copy scan log path:', error);
        showToast(appT('scan.logPathCopyFailed', 'Could not copy log path automatically'), 'error');
    }
}

async function openScanLogFile() {
    try {
        const result = await API.openSupportLog();
        const pathEl = $('#scan-diagnostics-path');
        rememberScanDiagnosticsInteraction();
        rememberScanLogPath(result?.path || '', result?.path_redacted || '');
        if (pathEl && result?.path) {
            pathEl.textContent = result.path_redacted || '<PATH>';
            pathEl.title = result.path_redacted || '<PATH>';
        }
        if (result?.opened === false) {
            showToast(appT('scan.openLogUnavailable', 'Could not open automatically; the log path is shown. Copy that path if you need to send the log file to support.'), 'warning');
            return;
        }
        showToast(appT('scan.logOpened', 'Opened support log location'), 'success');
    } catch (error) {
        Logger.error('Failed to open scan log file:', error);
        showToast(formatUserError(error, appT('scan.openLogFailed', 'Could not open support log')), 'error');
    }
}

function updateScanDiagnosticsCard(progress) {
    _scanLastProgress = progress || null;
    const card = $('#scan-diagnostics-card');
    if (!card) return;

    const activeStatus = ['running', 'cancelling'].includes(progress?.status);
    const holdActive = activeStatus && Date.now() < _scanDiagnosticsHoldUntil;
    const shouldShow = Boolean(progress?.attention_required || holdActive);
    card.style.display = shouldShow ? 'flex' : 'none';
    card.classList.toggle('is-visible', shouldShow);
    if (!shouldShow) return;

    const messageEl = $('#scan-diagnostics-message');
    const pathEl = $('#scan-diagnostics-path');
    const stopButton = $('#btn-stop-scan-from-diagnostics');
    const stepEl = $('#scan-diagnostics-step');
    const currentEl = $('#scan-diagnostics-current');
    const pendingEl = $('#scan-diagnostics-pending');
    const completedEl = $('#scan-diagnostics-completed');
    if (messageEl) {
        messageEl.removeAttribute('data-i18n');
        messageEl.textContent = progress?.attention_required
            ? buildScanAttentionMessage(progress)
            : appT('scan.diagnosticsRecentlyActive', 'Progress resumed. Keeping diagnostics visible briefly in case you still need them.');
    }
    if (stepEl) {
        stepEl.removeAttribute('data-i18n');
        stepEl.textContent = progress.step || progress.status || '-';
    }
    if (currentEl) {
        currentEl.removeAttribute('data-i18n');
        currentEl.textContent = progress.current_item || progress.message || '-';
    }
    if (pendingEl) {
        pendingEl.removeAttribute('data-i18n');
        pendingEl.textContent = String(progress.metadata_pending ?? 0);
    }
    if (completedEl) {
        completedEl.removeAttribute('data-i18n');
        const completed = progress.metadata_total
            ? `${progress.metadata_processed || 0}/${progress.metadata_total}`
            : `${progress.processed || progress.current || 0}/${progress.total || '?'}`;
        completedEl.textContent = completed;
    }
    if (pathEl) {
        pathEl.textContent = _scanLastLogPathRedacted || (progress.diagnostics_available
            ? appT('scan.diagnosticsLogReady', 'Support log is ready to copy or open.')
            : '');
        pathEl.title = _scanLastLogPathRedacted || '';
    }
    if (stopButton) {
        stopButton.disabled = progress.status === 'cancelling';
        stopButton.textContent = progress.status === 'cancelling'
            ? appT('scan.stoppingButton', 'Stopping...')
            : appT('scan.stopButton', 'Stop Import');
    }
}

function _initBgScanProgressButtons() {
    const cancelBtn = $('#bg-scan-cancel');
    const openBtn = $('#bg-scan-open');

    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            await requestStopScan();
        });
    }

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            showModal('scan-modal');
        });
    }

    // v3.3.0 USR-1: cancel the background move/copy job.
    const moveCancelBtn = $('#bg-move-cancel');
    if (moveCancelBtn) {
        moveCancelBtn.addEventListener('click', async () => {
            try {
                await API.cancelMove();
            } catch (error) {
                Logger.warn('Failed to request move cancellation:', error);
            }
        });
    }

    // Cancel the background delete-to-trash job. Prefer the Debt-22 durable job
    // when one is active (token-scoped / large selection); otherwise fall back
    // to the Phase-1 singleton cancel for small explicit selections.
    const deleteCancelBtn = $('#bg-delete-cancel');
    if (deleteCancelBtn) {
        deleteCancelBtn.addEventListener('click', async () => {
            if (_activeBulkJobIds.delete) {
                await requestBulkJobCancel('delete');
                return;
            }
            try {
                await API.cancelDelete();
            } catch (error) {
                Logger.warn('Failed to request delete cancellation:', error);
                showToast(formatUserError(error, appT('bulk.cancelRequestFailed', 'Could not send the cancel request — the job may still be running')), 'error');
            }
        });
    }

    // Cancel the background remove-from-gallery job (durable job preferred).
    const removeCancelBtn = $('#bg-remove-cancel');
    if (removeCancelBtn) {
        removeCancelBtn.addEventListener('click', async () => {
            if (_activeBulkJobIds.remove) {
                await requestBulkJobCancel('remove');
                return;
            }
            try {
                await API.cancelRemove();
            } catch (error) {
                Logger.warn('Failed to request remove cancellation:', error);
                showToast(formatUserError(error, appT('bulk.cancelRequestFailed', 'Could not send the cancel request — the job may still be running')), 'error');
            }
        });
    }

    // Debt-22: cancel the durable background sidecar-export job.
    const exportCancelBtn = $('#btn-batch-export-cancel-job');
    if (exportCancelBtn) {
        exportCancelBtn.addEventListener('click', async () => {
            await requestBulkJobCancel('export');
        });
    }
}

const SCAN_SOURCE_MANUAL = 'manual';
const SCAN_SOURCE_LIBRARY_AUTO_REFRESH = 'library_auto_refresh';
const SCAN_SOURCE_LIBRARY_RESCAN = 'library_rescan';
const LIBRARY_BACKGROUND_SCAN_SOURCES = new Set([
    SCAN_SOURCE_LIBRARY_AUTO_REFRESH,
    SCAN_SOURCE_LIBRARY_RESCAN,
]);
const SCAN_TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);

function readScanIdentity(payload) {
    const runId = payload?.run_id;
    const source = typeof payload?.source === 'string' ? payload.source : '';
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return null;
    if (source !== SCAN_SOURCE_MANUAL && !LIBRARY_BACKGROUND_SCAN_SOURCES.has(source)) return null;
    return Object.freeze({ runId, source });
}

function scanIdentitiesMatch(left, right) {
    return Boolean(
        left
        && right
        && left.runId === right.runId
        && left.source === right.source
    );
}

function isCanonicalIdleScanProgress(payload) {
    return Boolean(
        payload
        && payload.status === 'idle'
        && payload.run_id === 0
        && payload.source === null
    );
}

function requireScanIdentity(payload, context) {
    const identity = readScanIdentity(payload);
    if (identity) return identity;
    const status = typeof payload?.status === 'string' ? payload.status : '<missing>';
    const runId = payload?.run_id ?? '<missing>';
    const source = payload?.source ?? '<missing>';
    throw new TypeError(
        `${context} returned an invalid scan identity (status=${status}, run_id=${runId}, source=${source})`
    );
}

function requireSupersedingScanProgress(error, requestedIdentity) {
    const currentProgress = error?.apiData?.current;
    if (isCanonicalIdleScanProgress(currentProgress)) return null;
    const currentIdentity = requireScanIdentity(
        currentProgress,
        'Scan acknowledgement conflict'
    );
    if (scanIdentitiesMatch(requestedIdentity, currentIdentity)) {
        throw new TypeError(
            `Scan acknowledgement conflict repeated identity ${scanIdentityKey(requestedIdentity)}`
        );
    }
    const status = currentProgress?.status;
    const supportedStatuses = new Set([
        'starting',
        'running',
        'cancelling',
        'done',
        'error',
        'cancelled',
    ]);
    if (!supportedStatuses.has(status)) {
        throw new TypeError(
            `Scan acknowledgement conflict returned unsupported status ${status ?? '<missing>'}`
        );
    }
    return Object.freeze({
        run_id: currentIdentity.runId,
        source: currentIdentity.source,
        status,
    });
}

async function acknowledgeManualScanTerminal(identity) {
    try {
        if (identity?.source !== SCAN_SOURCE_MANUAL) {
            throw new TypeError(`Cannot acknowledge non-manual scan source ${identity?.source ?? '<missing>'}`);
        }
        const result = await API.post('/api/scan/acknowledge', {
            run_id: identity.runId,
            source: identity.source,
        });
        if (result?.status !== 'acknowledged') {
            const detail = typeof result?.message === 'string' && result.message.trim()
                ? result.message.trim()
                : 'The scan acknowledgement response did not include a reason';
            throw new Error(
                `Scan acknowledgement returned status ${result?.status ?? '<missing>'}: ${detail}`
            );
        }
        const acknowledgedIdentity = requireScanIdentity(result, 'Manual scan acknowledgement');
        if (!scanIdentitiesMatch(identity, acknowledgedIdentity)) {
            throw new Error(
                `Manual scan acknowledgement changed identity from ${scanIdentityKey(identity)} `
                + `to ${scanIdentityKey(acknowledgedIdentity)}`
            );
        }
        return Object.freeze({ status: 'acknowledged', currentProgress: null });
    } catch (error) {
        if (error?.apiStatus === 409 && error?.apiData?.code === 'scan_identity_mismatch') {
            try {
                const currentProgress = requireSupersedingScanProgress(error, identity);
                Logger.warn('Manual scan terminal claim was already superseded', {
                    runId: identity?.runId,
                    source: identity?.source,
                    currentRunId: currentProgress?.run_id ?? 0,
                    currentSource: currentProgress?.source ?? null,
                    currentStatus: currentProgress?.status ?? 'idle',
                });
                return Object.freeze({ status: 'superseded', currentProgress });
            } catch (contractError) {
                error = contractError;
            }
        }
        const apiMessage = typeof error?.apiData?.message === 'string' && error.apiData.message.trim()
            ? error.apiData.message.trim()
            : '';
        const failure = new Error(
            apiMessage || (error instanceof Error ? error.message : String(error || 'Unknown acknowledgement error')),
            { cause: error }
        );
        failure.name = 'ScanAcknowledgementError';
        Logger.error('Manual scan completion acknowledgement failed', {
            error: failure,
            runId: identity?.runId,
            source: identity?.source,
        });
        throw failure;
    }
}

async function handleManualScanProgress(progress, retryCount, scheduleNext, identity) {
    const metrics = getScanProgressMetrics(progress);
    const scanFillEl = $('#scan-progress-fill');
    const scanIndeterminate = progress.status === 'running' && (
        metrics.isCounting || !metrics.percent || metrics.percent <= 0
    );
    if (scanFillEl) {
        scanFillEl.classList.toggle('is-indeterminate', scanIndeterminate);
        scanFillEl.style.width = scanIndeterminate ? '' : (metrics.percent + '%');
    }

    const errorCount = Number(progress.errors || 0);
    const newCount = Number(progress.new || 0);
    const updatedCount = Number(progress.updated || 0);
    const removedCount = Number(progress.removed || 0);
    const extraParts = [];
    if (metrics.isCounting) {
        extraParts.push(
            appT('progress.discoveredCount', '{count} found')
                .replace('{count}', String(metrics.counted || metrics.processed || 0))
        );
    } else if (metrics.totalFinal && metrics.total > 0 && !metrics.showingMetadata) {
        extraParts.push(
            appT('progress.left', '{count} left')
                .replace('{count}', String(Math.max(0, metrics.total - metrics.processed)))
        );
    }
    if (metrics.metadataTotal > 0) {
        extraParts.push(
            appT('progress.metadataCount', '{current}/{total} metadata')
                .replace('{current}', String(metrics.metadataProcessed))
                .replace('{total}', String(metrics.metadataTotal))
        );
        if (!metrics.metadataTotalFinal && metrics.importComplete) {
            extraParts.push(appT('progress.detailsStillCounting', 'details total still being checked'));
        }
    }
    if (newCount > 0) extraParts.push(appT('progress.newCount', '{count} new').replace('{count}', newCount));
    if (updatedCount > 0) extraParts.push(appT('progress.updatedCount', '{count} updated').replace('{count}', updatedCount));
    if (removedCount > 0) extraParts.push(appT('progress.removedCount', '{count} removed').replace('{count}', removedCount));
    if (errorCount > 0) extraParts.push(appT('progress.failedCount', '{count} failed').replace('{count}', errorCount));

    let scanDetail = progress.current_item || progress.message || 'Importing images...';
    if (metrics.isCounting) {
        scanDetail = appT('progress.countingImages', 'Counting images... {count} found')
            .replace('{count}', String(metrics.counted || metrics.processed || 0));
    } else if (metrics.totalFinal && metrics.processed === 0 && metrics.total > 0) {
        scanDetail = appT('progress.foundStarting', 'Found {total} images. Starting scan...')
            .replace('{total}', String(metrics.total));
    } else if (metrics.showingMetadata && !metrics.metadataTotalFinal) {
        scanDetail = appT('progress.detailsStillCounting', 'details total still being checked');
    }

    $('#scan-progress-text').textContent = buildOperationProgressText({
        completed: metrics.completed,
        total: metrics.stableTotal,
        tracker: _scanProgressTracker,
        primaryLabel: appT('scan.progressLabel', 'Import'),
        extraParts,
        detail: scanDetail,
        defaultMessage: 'Importing images...',
        showEta: metrics.showEta,
        progressKey: metrics.progressKey,
    });

    _updateBgScanProgress(progress);
    updateScanDiagnosticsCard(progress);

    if (progress.library_ready && !_scanLibraryReadyHandled && progress.status === 'running') {
        _scanLibraryReadyHandled = true;
        hideModal('scan-modal');
        _refreshScanDrivenViews(true, {
            refreshGallery: true,
            pageSizeOverride: SCAN_PREVIEW_PAGE_SIZE,
        });
        if (Date.now() - _scanStartToastAt > 3000) {
            showToast(
                appT('scan.libraryReadyToast', 'Library is ready. Metadata is still loading in the background.'),
                'info'
            );
        }
    }

    if (progress.status === 'running' && progress.library_ready) {
        // Keep the gallery stable while import continues in the background.
        // Re-rendering the grid every few seconds made large scans feel like
        // the gallery was stuck loading again.
        if (AppState.currentView !== 'gallery') {
            AppState.galleryNeedsRefresh = true;
            AppState.gallerySuppressNextAutoLoadMore = true;
        }
    }

    if (SCAN_TERMINAL_STATUSES.has(progress.status)) {
        const claimResult = await acknowledgeManualScanTerminal(identity);
        if (claimResult.status === 'superseded') {
            clearManualScanProgressAfterExternalClaim(identity);
            if (claimResult.currentProgress) {
                attachScanProgressForState(claimResult.currentProgress);
            }
            return;
        }
    }

    if (progress.status === 'done') {
        const libraryReadyWasHandled = _scanLibraryReadyHandled;
        const errorCount = Number(progress.errors || progress.result?.errors || 0);
        const completionMessage = libraryReadyWasHandled
            ? appT('scan.completedBackgroundToast', 'The remaining image details are ready now.')
            : (progress.message || appT('scan.completedToast', 'Import complete. Everything is ready now.'));
        // FLOW-05: replace the vanishing success toast with a persistent
        // next-step CTA. Warnings/errors still toast. Skip the banner when
        // auto-tag is on (the tag modal opens itself right after).
        const _scanNewCount = Number(progress.new ?? progress.result?.new ?? progress.processed ?? 0);
        const _scanAutoTagOn = !!document.getElementById('scan-auto-tag')?.checked;
        if (errorCount > 0) {
            showToast(completionMessage, 'warning');
        } else if (_scanAutoTagOn) {
            showToast(completionMessage, 'success');
        } else {
            const _scanCtaActions = [
                { icon: '🏷️', label: appT('flow.ctaTag', 'Tag with AI'), action: 'modal:tag-modal' },
                { icon: '🗂️', label: appT('nav.sorting', 'Organize'), action: 'view:sorting' },
            ];
            // v3.4.3: one-click "collection per imported dataset" so scans
            // of separate datasets don't blur together in the gallery.
            if (_scanNewCount > 0 && _scanLastFolderPath) {
                const ctaFolder = _scanLastFolderPath;
                _scanCtaActions.push({
                    icon: '📚',
                    label: appT('flow.ctaCreateCollection', 'Create collection'),
                    action: () => createCollectionFromScanFolder(ctaFolder),
                });
            }
            showPipelineNextStep({
                icon: '✅',
                title: _scanNewCount > 0
                    ? appT('flow.scanDoneTitle', 'Imported {count} images — what next?').replace('{count}', String(_scanNewCount))
                    : appT('flow.scanDoneTitleZero', 'Import complete — what next?'),
                actions: _scanCtaActions,
            });
        }
        hideModal('scan-modal');
        $('#scan-progress-container').style.display = 'none';
        $('#btn-start-scan').disabled = false;
        setScanCancelButtonState('idle');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        resetProgressTracker(_scanProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        _hideBgScanProgress();
        updateScanDiagnosticsCard(null);
        _refreshScanDrivenViews(true, { refreshGallery: true });
        // Auto-tag: if checkbox was on, trigger tagging with current settings
        const autoTagCheckbox = document.getElementById('scan-auto-tag');
        if (autoTagCheckbox && autoTagCheckbox.checked) {
            setTimeout(() => {
                showModal('tag-modal');
                // Small delay to let modal render, then trigger start
                setTimeout(() => {
                    const startBtn = document.getElementById('btn-start-tag');
                    if (startBtn && !startBtn.disabled) {
                        startBtn.click();
                    }
                }, 300);
            }, 500);
        }
    } else if (progress.status === 'cancelled') {
        const cancelCount = Number(progress.processed ?? progress.current ?? 0);
        const cancelMsg = cancelCount > 0
            ? appT('scan.cancelledAfterCount', 'Import cancelled after {count} scanned.').replace('{count}', String(cancelCount))
            : appT('scan.cancelled', 'Import cancelled');
        showToast(cancelMsg, 'info');
        $('#scan-progress-container').style.display = 'none';
        $('#btn-start-scan').disabled = false;
        setScanCancelButtonState('idle');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        resetProgressTracker(_scanProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        _hideBgScanProgress();
        updateScanDiagnosticsCard(null);
    } else if (progress.status === 'error') {
        showToast(progress.message || appT('scan.failedStatus', 'Import failed'), 'error');
        $('#scan-progress-container').style.display = 'none';
        $('#btn-start-scan').disabled = false;
        setScanCancelButtonState('idle');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        resetProgressTracker(_scanProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        _hideBgScanProgress();
        updateScanDiagnosticsCard(null);
    } else if (progress.status === 'running' || progress.status === 'starting') {
        // The backend sets status='starting' synchronously when the scan is
        // requested and only flips to 'running' once the BackgroundTask
        // actually executes. Treat it like 'running' so a first poll that
        // lands in that window keeps the loop alive instead of silently
        // dying with a frozen progress bar.
        setScanCancelButtonState('running');
        scheduleNext(0, 500);
    } else if (progress.status === 'cancelling') {
        setScanCancelButtonState('cancelling');
        scheduleNext(0, 250);
    } else if (progress.status === 'idle' && retryCount < 10) {
        // Allow a brief idle window when attaching to an in-flight background task.
        scheduleNext(retryCount + 1, 500);
    } else if (progress.status === 'idle') {
        showToast(
            appT(
                'scan.failedResume',
                'Could not restore the active import progress. Reload the app; if this continues, restart SD Image Sorter.'
            ),
            'error'
        );
        $('#scan-progress-container').style.display = 'none';
        $('#btn-start-scan').disabled = false;
        setScanCancelButtonState('idle');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        resetProgressTracker(_scanProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        _hideBgScanProgress();
        updateScanDiagnosticsCard(null);
    } else {
        const statusLabel = typeof progress?.status === 'string' && progress.status
            ? progress.status
            : '<missing>';
        showToast(
            appT(
                'scan.unknownStatus',
                'Import progress stopped because the server returned status "{status}". Reload the app; if this continues, restart SD Image Sorter.'
            ).replace('{status}', statusLabel),
            'error'
        );
        $('#scan-progress-container').style.display = 'none';
        $('#btn-start-scan').disabled = false;
        setScanCancelButtonState('idle');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        resetProgressTracker(_scanProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        _hideBgScanProgress();
        updateScanDiagnosticsCard(null);
    }
}

function handleManualScanPollError(error, retryCount, scheduleNext) {
    if (retryCount < 3) {
        Logger.warn('Manual scan progress operation failed; retrying', { error, retryCount });
        scheduleNext(retryCount + 1, 1000);
        return;
    }
    Logger.error('Manual scan progress operation failed', { error, retryCount });
    const fallback = error?.name === 'ScanAcknowledgementError'
        ? appT(
            'scan.completionAckFailed',
            'Import finished, but its completion state could not be cleared. Reload the app; if idle auto-refresh remains blocked, restart SD Image Sorter.'
        )
        : appT('scan.failedProgress', 'Could not update import progress');
    showToast(formatUserError(error, fallback), 'error');
    $('#scan-progress-container').style.display = 'none';
    $('#btn-start-scan').disabled = false;
    setScanCancelButtonState('idle');
    unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
    resetProgressTracker(_scanProgressTracker);
    _scanLibraryReadyHandled = false;
    _scanLastAutoRefreshAt = 0;
    _hideBgScanProgress();
    updateScanDiagnosticsCard(null);
}

function clearManualScanProgressAfterExternalClaim(identity) {
    Logger.info('Manual scan progress ended after another client claimed its terminal', {
        runId: identity.runId,
        source: identity.source,
    });
    hideModal('scan-modal');
    const progressContainer = $('#scan-progress-container');
    const startButton = $('#btn-start-scan');
    if (progressContainer) progressContainer.style.display = 'none';
    if (startButton) startButton.disabled = false;
    setScanCancelButtonState('idle');
    unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
    resetProgressTracker(_scanProgressTracker);
    _scanLibraryReadyHandled = false;
    _scanLastAutoRefreshAt = 0;
    _hideBgScanProgress();
    updateScanDiagnosticsCard(null);
}

function createManualScanProgressConsumer() {
    return Object.freeze({
        onProgress: handleManualScanProgress,
        onPollError: handleManualScanPollError,
        onIdentityConsumed: clearManualScanProgressAfterExternalClaim,
    });
}

function createAutoRefreshBackgroundScanMessages() {
    return Object.freeze({
        source: SCAN_SOURCE_LIBRARY_AUTO_REFRESH,
        recoveryHint: appT(
            'libraryRoots.autoRefreshRecoveryHint',
            'Open Library Folders and run Rescan.'
        ),
        didNotStart: appT(
            'libraryRoots.autoRefreshDidNotStart',
            'Idle library refresh did not start.'
        ),
        completedWithErrors: appT(
            'libraryRoots.autoRefreshCompletedWithErrors',
            'Idle library refresh finished with {count} scan issue(s).'
        ),
        cancelled: appT(
            'libraryRoots.autoRefreshCancelled',
            'Idle library refresh was cancelled.'
        ),
        failed: appT(
            'libraryRoots.autoRefreshFailed',
            'Idle library refresh failed.'
        ),
        unknownStatus: appT(
            'libraryRoots.autoRefreshUnknownStatus',
            'Idle library refresh stopped because the server returned status "{status}".'
        ),
        progressFailed: appT(
            'libraryRoots.autoRefreshProgressFailed',
            'Could not track idle library refresh'
        ),
    });
}

function createLibraryRescanBackgroundScanMessages() {
    return Object.freeze({
        source: SCAN_SOURCE_LIBRARY_RESCAN,
        recoveryHint: appT(
            'libraryRoots.rescanRecoveryHint',
            'Check Library Folders and run Library Rescan again.'
        ),
        didNotStart: appT(
            'libraryRoots.rescanDidNotStart',
            'Library Rescan did not start.'
        ),
        completedWithErrors: appT(
            'libraryRoots.rescanCompletedWithErrors',
            'Library Rescan finished with {count} scan issue(s).'
        ),
        cancelled: appT(
            'libraryRoots.rescanCancelled',
            'Library Rescan was cancelled.'
        ),
        failed: appT(
            'libraryRoots.rescanScanFailed',
            'Library Rescan failed.'
        ),
        unknownStatus: appT(
            'libraryRoots.rescanUnknownStatus',
            'Library Rescan stopped because the server returned status "{status}".'
        ),
        progressFailed: appT(
            'libraryRoots.rescanProgressFailed',
            'Could not track Library Rescan progress'
        ),
    });
}

function createBackgroundScanProgressConsumer(messages) {
    let libraryReadyHandled = false;

    return Object.freeze({
        onProgress(progress, retryCount, scheduleNext) {
            const status = typeof progress?.status === 'string' ? progress.status : '';
            if (
                !libraryReadyHandled
                && progress?.library_ready === true
                && (status === 'starting' || status === 'running')
            ) {
                libraryReadyHandled = true;
                _refreshScanDrivenViews(true, { refreshGallery: true });
            }

            if (status === 'starting' || status === 'running') {
                scheduleNext(0, 500);
                return;
            }
            if (status === 'cancelling') {
                scheduleNext(0, 250);
                return;
            }
            if (status === 'idle' && retryCount < 10) {
                scheduleNext(retryCount + 1, 500);
                return;
            }
            if (status === 'idle') {
                Logger.error('Background scan stayed idle after start', {
                    retryCount,
                    source: messages.source,
                });
                showToast(
                    `${messages.didNotStart} ${messages.recoveryHint}`,
                    'error'
                );
                return;
            }
            if (status === 'done') {
                _refreshScanDrivenViews(true, { refreshGallery: true });
                const terminalErrorCount = Number(progress.errors || progress.result?.errors || 0);
                if (terminalErrorCount > 0) {
                    showToast(
                        `${messages.completedWithErrors
                            .replace('{count}', String(terminalErrorCount))} ${messages.recoveryHint}`,
                        'warning'
                    );
                }
                return;
            }
            if (status === 'cancelled') {
                const processedCount = Number(progress.processed ?? progress.current ?? 0);
                if (progress.library_ready === true || processedCount > 0) {
                    _refreshScanDrivenViews(true, { refreshGallery: true });
                }
                showToast(messages.cancelled, 'info');
                return;
            }
            if (status === 'error') {
                const errorDetail = typeof progress.message === 'string' && progress.message.trim()
                    ? progress.message.trim()
                    : messages.failed;
                Logger.error('Background scan failed', {
                    error: errorDetail,
                    source: messages.source,
                });
                showToast(`${errorDetail} ${messages.recoveryHint}`, 'error');
                return;
            }

            const statusLabel = status || '<missing>';
            Logger.error('Background scan returned an unsupported status', {
                source: messages.source,
                status: statusLabel,
            });
            showToast(
                `${messages.unknownStatus.replace('{status}', statusLabel)} ${messages.recoveryHint}`,
                'error'
            );
        },

        onPollError(error, retryCount, scheduleNext) {
            Logger.warn('Background scan progress poll failed', {
                error,
                retryCount,
                source: messages.source,
            });
            if (retryCount < 3) {
                scheduleNext(retryCount + 1, 1000);
                return;
            }
            const message = formatUserError(error, messages.progressFailed);
            showToast(`${message} ${messages.recoveryHint}`, 'error');
        },

        onIdentityConsumed(identity) {
            Logger.info('Background scan progress ended after its identity was consumed', {
                runId: identity.runId,
                source: identity.source,
            });
        },
    });
}

function createAutoRefreshScanProgressConsumer() {
    return createBackgroundScanProgressConsumer(createAutoRefreshBackgroundScanMessages());
}

function createLibraryRescanScanProgressConsumer() {
    return createBackgroundScanProgressConsumer(createLibraryRescanBackgroundScanMessages());
}

function consumerForScanIdentity(identity) {
    if (identity.source === SCAN_SOURCE_MANUAL) return createManualScanProgressConsumer();
    if (identity.source === SCAN_SOURCE_LIBRARY_AUTO_REFRESH) return createAutoRefreshScanProgressConsumer();
    if (identity.source === SCAN_SOURCE_LIBRARY_RESCAN) return createLibraryRescanScanProgressConsumer();
    throw new TypeError(`Unsupported scan source: ${identity.source}`);
}

function prepareManualScanResumeUi(progress) {
    if (progress?.library_ready && progress?.status === 'running') {
        _scanLibraryReadyHandled = true;
        _updateBgScanProgress(progress);
        return;
    }

    const progressContainer = $('#scan-progress-container');
    const startBtn = $('#btn-start-scan');
    if (progressContainer) progressContainer.style.display = 'block';
    if (startBtn) startBtn.disabled = true;
    setScanCancelButtonState(progress?.status === 'cancelling' ? 'cancelling' : 'running');
    lockLiveProgressText('#scan-progress-text');
    resetProgressTracker(_scanProgressTracker);
    resetProgressTracker(_scanBackgroundProgressTracker);
    $('#scan-progress-text').textContent = progress.message || 'Resuming scan progress...';
    _updateBgScanProgress(progress);
}

function attachScanProgressForState(progress) {
    const identity = requireScanIdentity(progress, 'Scan progress');
    const pollKey = scanIdentityKey(identity);
    if (_scanPollersByIdentity.has(pollKey)) return;
    if (identity.source === SCAN_SOURCE_MANUAL && !SCAN_TERMINAL_STATUSES.has(progress.status)) {
        prepareManualScanResumeUi(progress);
    } else if (identity.source !== SCAN_SOURCE_MANUAL) {
        _hideBgScanProgress();
    }
    return startScanProgressPoller(
        consumerForScanIdentity(identity),
        0,
        identity,
        true
    );
}

function scanIdentityKey(identity) {
    return `${identity.runId}:${identity.source}`;
}

function finishScanProgressPoller(pollKey, pollToken) {
    if (_scanPollersByIdentity.get(pollKey) === pollToken) {
        _scanPollersByIdentity.delete(pollKey);
    }
}

async function runScanProgressPoll(consumer, retryCount, identity, pollToken, ownedRunObserved) {
    const pollKey = scanIdentityKey(identity);
    if (_scanPollersByIdentity.get(pollKey) !== pollToken) return;
    let nextScheduled = false;
    let observedOwnedRunForNextPoll = ownedRunObserved;
    const scheduleNext = (nextRetryCount, delayMs) => {
        if (_scanPollersByIdentity.get(pollKey) !== pollToken || nextScheduled) return;
        nextScheduled = true;
        setTimeout(
            () => runScanProgressPoll(
                consumer,
                nextRetryCount,
                identity,
                pollToken,
                observedOwnedRunForNextPoll
            ),
            delayMs
        );
    };

    try {
        const progress = await API.getScanProgress();
        if (_scanPollersByIdentity.get(pollKey) !== pollToken) return;
        const currentIdentity = readScanIdentity(progress);
        if (currentIdentity && !scanIdentitiesMatch(identity, currentIdentity)) {
            finishScanProgressPoller(pollKey, pollToken);
            attachScanProgressForState(progress);
            return;
        }
        if (currentIdentity) {
            observedOwnedRunForNextPoll = observedOwnedRunForNextPoll
                || progress?.status !== 'idle';
        } else if (!isCanonicalIdleScanProgress(progress)) {
            requireScanIdentity(progress, 'Scan progress');
        } else if (observedOwnedRunForNextPoll) {
            await consumer.onIdentityConsumed(identity);
            return;
        }
        await consumer.onProgress(progress, retryCount, scheduleNext, identity);
    } catch (error) {
        if (_scanPollersByIdentity.get(pollKey) !== pollToken) return;
        await consumer.onPollError(error, retryCount, scheduleNext, identity);
    } finally {
        if (!nextScheduled) finishScanProgressPoller(pollKey, pollToken);
    }
}

function startScanProgressPoller(consumer, retryCount, identity, ownedRunObserved) {
    const pollKey = scanIdentityKey(identity);
    if (_scanPollersByIdentity.has(pollKey)) return;
    const pollToken = Object.freeze({ pollKey });
    _scanPollersByIdentity.set(pollKey, pollToken);
    return runScanProgressPoll(
        consumer,
        retryCount,
        identity,
        pollToken,
        ownedRunObserved
    );
}

function pollScanProgress(retryCount, identity) {
    return startScanProgressPoller(
        createManualScanProgressConsumer(),
        retryCount,
        identity,
        true
    );
}

function beginManualScanProgress(scanStart) {
    const identity = requireScanIdentity(scanStart, 'Manual scan start');
    if (identity.source !== SCAN_SOURCE_MANUAL) {
        throw new TypeError(`Manual scan start returned source ${identity.source}`);
    }
    return pollScanProgress(0, identity);
}

function beginAutoRefreshScanProgress(scanStart) {
    const identity = requireScanIdentity(scanStart, 'Idle auto-refresh start');
    if (identity.source !== SCAN_SOURCE_LIBRARY_AUTO_REFRESH) {
        throw new TypeError(`Idle auto-refresh start returned source ${identity.source}`);
    }
    return startScanProgressPoller(
        createAutoRefreshScanProgressConsumer(),
        0,
        identity,
        false
    );
}

function beginLibraryRescanScanProgress(scanStart) {
    const identity = requireScanIdentity(scanStart, 'Library rescan start');
    if (identity.source !== SCAN_SOURCE_LIBRARY_RESCAN) {
        throw new TypeError(`Library rescan start returned source ${identity.source}`);
    }
    return startScanProgressPoller(
        createLibraryRescanScanProgressConsumer(),
        0,
        identity,
        false
    );
}

async function resumeScanProgress() {
    try {
        const progress = await API.getScanProgress();
        const status = typeof progress?.status === 'string' ? progress.status : '';
        if (status === 'idle') {
            _hideBgScanProgress();
            return;
        }
        attachScanProgressForState(progress);
    } catch (error) {
        Logger.warn('Failed to resume scan progress', { error });
        showToast(
            formatUserError(
                error,
                appT('scan.failedResume', 'Could not restore the active import progress')
            ),
            'error'
        );
    }
}

