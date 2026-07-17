/**
 * app/scan-progress-poller.js — scan-diagnostics.js decomposition (3/3).
 * Extracted VERBATIM (byte-identical) from frontend/js/app/scan-diagnostics.js
 * pre-cut lines 852-1023 (of 1,023): manual resume UI, attach-for-state,
 * scanIdentityKey, the identity-keyed poller engine (finish/run/start/poll)
 * and the beginManual/AutoRefresh/LibraryRescan + resumeScanProgress entries.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order; _scanPollersByIdentity lives in the
 * sibling tagging-flow.js, the SCAN_* consts in scan-progress-lifecycle.js —
 * both only read inside function bodies at call time). Do NOT wrap in an
 * IIFE/module and do NOT add a strict-mode directive — the top-level function
 * declarations must stay window globals.
 * No behavior change intended.
 */

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

