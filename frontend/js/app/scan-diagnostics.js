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
