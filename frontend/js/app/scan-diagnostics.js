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

async function pollScanProgress(retryCount = 0, generation = _scanPollGeneration) {
    // v3.3.0 USR-2: bail if a newer scan/resume superseded this loop.
    if (generation !== _scanPollGeneration) return;
    try {
        const progress = await API.getScanProgress();
        // Re-check after the await: a new scan may have started mid-flight.
        if (generation !== _scanPollGeneration) return;

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
            setTimeout(() => pollScanProgress(0, generation), 500);
        } else if (progress.status === 'cancelling') {
            setScanCancelButtonState('cancelling');
            setTimeout(() => pollScanProgress(0, generation), 250);
        } else if (progress.status === 'idle' && retryCount < 10) {
            // Allow a brief idle window when attaching to an in-flight background task.
            setTimeout(() => pollScanProgress(retryCount + 1, generation), 500);
        } else if (progress.status === 'idle') {
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
            // Unknown / transitional status: keep polling instead of silently
            // dropping the loop. This future-proofs the poller against any new
            // backend statuses — the terminal branches above still win.
            setTimeout(() => pollScanProgress(0, generation), 500);
        }
    } catch (error) {
        if (generation !== _scanPollGeneration) return;
        Logger.error('Poll error:', error);
        if (retryCount < 3) {
            setTimeout(() => pollScanProgress(retryCount + 1, generation), 1000);
        } else {
            showToast(appT('scan.failedProgress', 'Could not update import progress'), 'error');
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
}

async function resumeScanProgress() {
    try {
        const progress = await API.getScanProgress();
        const hasMeaningfulProgress = Number(progress?.current || 0) > 0 || Number(progress?.total || 0) > 0;
        if (progress?.status !== 'running' && !(progress?.status === 'idle' && hasMeaningfulProgress)) {
            _hideBgScanProgress();
            return;
        }

        if (progress?.library_ready && progress?.status === 'running') {
            _scanLibraryReadyHandled = true;
            _updateBgScanProgress(progress);
            // v3.3.0 USR-2: supersede any stale loop before re-attaching.
            _scanPollGeneration += 1;
            pollScanProgress(0, _scanPollGeneration);
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
        // v3.3.0 USR-2: supersede any stale loop before re-attaching.
        _scanPollGeneration += 1;
        pollScanProgress(0, _scanPollGeneration);
    } catch (error) {
        Logger.warn('Failed to resume scan progress:', error);
    }
}

