/**
 * app/scan-flow.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 4150-4597 (of 10,152): scan validation/start/stop + metrics + bg scan progress.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
// ============== Scanning ==============

function resetScanFolderValidation() {
    const input = $('#scan-folder-path');
    const feedback = $('#scan-folder-feedback');
    if (input) {
        input.classList.remove('input-valid', 'input-invalid', 'input-checking');
    }
    if (feedback) {
        feedback.className = 'validation-feedback';
        feedback.textContent = '';
    }
}

function setScanFolderValidation(state, message = '') {
    const input = $('#scan-folder-path');
    const feedback = $('#scan-folder-feedback');
    if (!input || !feedback) return;

    input.classList.remove('input-valid', 'input-invalid', 'input-checking');
    feedback.className = 'validation-feedback';

    if (state === 'success') {
        input.classList.add('input-valid');
        feedback.classList.add('success');
    } else if (state === 'error') {
        input.classList.add('input-invalid');
        feedback.classList.add('error');
    } else if (state === 'checking') {
        input.classList.add('input-checking');
        feedback.classList.add('checking');
    }

    feedback.textContent = message;
}

function mapScanPathError(error) {
    const rawMessage = (error instanceof Error ? error.message : String(error || '')).trim();
    const message = rawMessage.toLowerCase();

    if (!rawMessage) {
        return appT('scan.invalidPath', 'Path format is invalid');
    }
    if (message.includes('invalid filename characters')) {
        return appT('scan.invalidFolderName', 'Folder name contains unsupported characters');
    }
    if (message.includes('invalid or suspicious characters')) {
        return appT('scan.invalidPathChars', 'Path contains invalid characters');
    }
    if (message.includes('does not exist') || message.includes('not exist') || message.includes('not found')) {
        return appT('scan.folderNotFound', 'Folder not found');
    }
    if (message.includes('not a directory')) {
        return appT('scan.pathNotFolder', 'This path is not a folder');
    }
    if (message.includes('maximum length')) {
        return appT('scan.pathTooLong', 'Path is too long');
    }
    if (message.includes('cannot resolve path') || message.includes('invalid path format')) {
        return appT('scan.invalidPath', 'Path format is invalid');
    }

    return rawMessage;
}

function isScanPathError(error) {
    const rawMessage = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
    return rawMessage.includes('path')
        || rawMessage.includes('directory')
        || rawMessage.includes('folder')
        || rawMessage.includes('filename');
}

// UI-02: Validate scan folder path with inline feedback
function validateScanFolderPath() {
    const input = $('#scan-folder-path');
    if (!input) return true;
    const value = input.value.trim();

    resetScanFolderValidation();

    if (!value) {
        return; // Empty is neutral state
    }

    // Basic path validation — exclude `:` so Windows drive letters (C:\) are allowed
    const invalidChars = /[<>"|?*]/;
    if (invalidChars.test(value)) {
        setScanFolderValidation('error', appT('scan.invalidPathChars', 'Path contains invalid characters'));
        return false;
    }

    // Show checking state
    setScanFolderValidation('checking', appT('scan.pathChecking', 'Checking path...'));
    const requestValue = value;

    // Use API to validate (server-side)
    API.post('/api/validate-path', { path: value })
        .then(result => {
            if (input.value.trim() !== requestValue) return;
            if (result.valid) {
                setScanFolderValidation('success', appT('scan.folderFound', 'Folder found'));
            } else {
                setScanFolderValidation('error', mapScanPathError(result.error || appT('scan.invalidPath', 'Path format is invalid')));
            }
        })
        .catch((error) => {
            if (input.value.trim() !== requestValue) return;
            // If validation endpoint doesn't exist, just clear checking state
            setScanFolderValidation('', isScanPathError(error) ? mapScanPathError(error) : '');
        });

    return true;
}

// v3.4.3: "one collection per imported dataset" CTA. Creates a collection
// named after the scanned folder and bulk-adds every image under that folder
// (selection token + bulk membership — handles tens of thousands of images
// without shipping ID lists through the browser).
async function createCollectionFromScanFolder(folderPath) {
    const cleanPath = String(folderPath || '').trim();
    if (!cleanPath) return;
    const name = cleanPath.split(/[\\/]/).filter(Boolean).pop() || cleanPath;
    try {
        const created = await API.createCollection(name, cleanPath);
        const collectionId = Number(created?.id);
        if (!Number.isFinite(collectionId) || collectionId <= 0) {
            throw new Error(created?.detail || 'collection id missing from response');
        }
        const tokenResponse = await API.createSelectionToken({
            ...createDefaultFilterState(),
            folder: cleanPath,
        });
        const selectionToken = tokenResponse?.selection_token || null;
        let added = 0;
        if (selectionToken) {
            const result = await API.setCollectionMembershipBulk(collectionId, {
                selectionToken,
                member: true,
            });
            added = Number(result?.added || 0);
        }
        showToast(
            appT('flow.collectionCreatedToast', 'Collection "{name}" created with {count} images.')
                .replace('{name}', name)
                .replace('{count}', String(added)),
            'success'
        );
        try { window.CollectionsUI?.refresh?.(); } catch (_e) { /* sidebar refresh is best-effort */ }
    } catch (err) {
        showToast(
            appT('flow.collectionCreateFailedToast', 'Could not create the collection: {error}')
                .replace('{error}', err?.message || String(err)),
            'error'
        );
    }
}

async function startScan() {
    const folderPath = $('#scan-folder-path')?.value?.trim() || '';
    if (!folderPath) {
        showToast(appT('scan.enterFolder', 'Please choose a folder first'), 'error');
        return;
    }

    const recursive = $('#scan-recursive')?.checked ?? true;
    const quickImport = $('#scan-quick-import')?.checked ?? true;
    const forceReparse = $('#scan-force-reparse')?.checked ?? false;
    const cleanupMissing = $('#scan-cleanup-missing')?.checked ?? false;

    try {
        addRecentFolder(folderPath);
        _scanLastFolderPath = folderPath;
        const scanStart = await API.startScan(folderPath, {
            recursive,
            quickImport,
            forceReparse,
            cleanupMissing,
        });

        const progressContainer = $('#scan-progress-container');
        const startBtn = $('#btn-start-scan');
        if (progressContainer) progressContainer.style.display = 'block';
        if (startBtn) startBtn.disabled = true;
        setScanCancelButtonState('running');
        lockLiveProgressText('#scan-progress-text');
        resetProgressTracker(_scanProgressTracker);
        resetProgressTracker(_scanBackgroundProgressTracker);
        _scanLibraryReadyHandled = false;
        _scanLastAutoRefreshAt = 0;
        $('#scan-progress-text').textContent = appT('progress.countingImages', 'Counting images... {count} found').replace('{count}', '0');
        _scanStartToastAt = Date.now();
        showToast(
            appT('scan.startedToast', 'Import started. The first images will appear soon, and the rest of the details will keep filling in.'),
            'info'
        );

        // Attach one source-specific poller to the accepted backend run.
        beginManualScanProgress(scanStart);
    } catch (error) {
        // v3.3.0 USR-2: a 409 means a scan is already running — the leftover
        // loop (if any) keeps owning the UI. Tell the user plainly instead of
        // leaking the raw "Scan already in progress" string, which reads like
        // the scan silently reverted to the previous folder.
        const rawMessage = error instanceof Error ? error.message : String(error || '');
        if (error?.apiStatus === 409 || /already in progress|in progress/i.test(rawMessage)) {
            showToast(
                appT('scan.alreadyRunning', 'A scan is already running. Please wait for it to finish or stop it first.'),
                'warning'
            );
            return;
        }
        const userMessage = mapScanPathError(error);
        if (isScanPathError(error)) {
            setScanFolderValidation('error', userMessage);
        }
        const toastMessage = userMessage !== rawMessage
            ? userMessage
            : formatUserError(error, appT('scan.failedStart', 'Failed to start import'));
        showToast(toastMessage, "error");
    }
}

async function requestStopScan() {
    let progress;
    try {
        progress = await API.getScanProgress();
    } catch (error) {
        Logger.error('Could not read scan progress before cancellation', { error });
        showToast(
            formatUserError(
                error,
                appT('scan.failedCancelProgress', 'Could not read import progress before stopping it')
            ),
            'error'
        );
        return;
    }

    const status = typeof progress?.status === 'string' ? progress.status : '';
    if (status === 'idle' || SCAN_TERMINAL_STATUSES.has(status)) {
        hideModal('scan-modal');
        unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
        return;
    }
    if (!['starting', 'running', 'cancelling'].includes(status)) {
        showToast(
            appT(
                'scan.cancelUnavailableStatus',
                'Import cannot be stopped because the server returned status "{status}". Reload the app and try again.'
            ).replace('{status}', status || '<missing>'),
            'error'
        );
        return;
    }

    try {
        const identity = requireScanIdentity(progress, 'Scan cancellation');
        const result = await API.cancelScan(identity);
        const resultIdentity = requireScanIdentity(result, 'Scan cancellation response');
        if (!scanIdentitiesMatch(identity, resultIdentity)) {
            throw new Error(
                `Scan cancellation changed identity from ${scanIdentityKey(identity)} `
                + `to ${scanIdentityKey(resultIdentity)}`
            );
        }
        if (!['cancelled', 'cancelling'].includes(result?.status)) {
            throw new Error(
                `Scan cancellation returned unexpected status ${result?.status ?? '<missing>'}`
            );
        }
        const processed = Number(progress.processed ?? progress.current ?? 0);
        const total = Number(progress.total || 0);
        const totalFinal = progress?.total_final === true;
        setScanCancelButtonState(result?.status === 'cancelled' ? 'idle' : 'cancelling');
        $('#scan-progress-text').textContent = (result?.status === 'cancelled')
            ? appT('scan.cancelled', 'Scan cancelled')
            : totalFinal
                ? appT('scan.cancelling', 'Cancelling scan... {current}/{total}')
                    .replace('{current}', String(processed))
                    .replace('{total}', String(total || '?'))
                : appT('scan.backgroundCancelling', 'Stopping scan...');
        showToast(
            result?.status === 'cancelled'
                ? appT('scan.cancelled', 'Scan cancelled')
                : appT('scan.cancellingAfterCurrent', 'Stopping scan after the current file...'),
            'info'
        );
        if (result?.status === 'cancelled') {
            hideModal('scan-modal');
            $('#scan-progress-container').style.display = 'none';
            $('#btn-start-scan').disabled = false;
            setScanCancelButtonState('idle');
            unlockLiveProgressText('#scan-progress-text', 'modal.scanStarting', 'Starting...');
            resetProgressTracker(_scanProgressTracker);
            _hideBgScanProgress();
            updateScanDiagnosticsCard(null);
        }
    } catch (error) {
        showToast(formatUserError(error, appT('scan.failedCancel', 'Failed to stop import')), 'error');
    }
}

function _refreshScanDrivenViews(force = false, options = {}) {
    const {
        refreshGallery = true,
        pageSizeOverride = null,
    } = options;
    const now = Date.now();
    if (!force && now - _scanLastAutoRefreshAt < 2500) {
        return;
    }
    _scanLastAutoRefreshAt = now;
    if (refreshGallery) {
        if (AppState.currentView === 'gallery') {
            const loadOptions = {
                silent: true,
                preserveExisting: true,
                coalesce: true,
                suppressAutoLoadMore: true,
            };
            if (Number.isFinite(pageSizeOverride) && pageSizeOverride > 0) {
                loadOptions.pageSizeOverride = pageSizeOverride;
            }
            loadImages(false, loadOptions);
            AppState.galleryNeedsRefresh = false;
        } else {
            AppState.galleryNeedsRefresh = true;
            AppState.gallerySuppressNextAutoLoadMore = true;
        }
    }
    loadStats();
    // Library state changed (scan / reconnect / clear). Drop any cached
    // unreadable count so the banner reflects the new reality next time
    // gallery is the active view.
    window.UnreadableBanner?.invalidate?.();
    if (AppState.currentView === 'gallery') {
        window.UnreadableBanner?.refresh?.(true);
    }
    // P17: Refresh Folders tree after scan completes
    window.FolderTreeUI?.refresh?.();
}

function getScanProgressMetrics(progress) {
    const processed = Number(progress?.processed ?? progress?.current ?? 0);
    const total = Number(progress?.total || 0);
    const totalFinal = progress?.total_final === true;
    const counted = Number(progress?.counted || total || 0);
    const metadataProcessed = Number(progress?.metadata_processed || 0);
    const metadataTotal = Number(progress?.metadata_total || 0);
    const importComplete = progress?.import_complete === true || (totalFinal && total > 0 && processed >= total);
    const metadataTotalFinal = progress?.metadata_total_final === true;
    const isCounting = progress?.step === 'counting' || !totalFinal;
    const showingMetadata = progress?.step === 'metadata' && importComplete;
    const completed = showingMetadata ? metadataProcessed : processed;
    const stableTotal = showingMetadata
        ? (metadataTotalFinal ? metadataTotal : 0)
        : (totalFinal ? total : 0);
    const showEta = showingMetadata
        ? (metadataTotalFinal && metadataTotal > 0 && metadataProcessed > 0)
        : (totalFinal && total > 0 && processed > 0 && !isCounting);
    const percent = showingMetadata
        ? (metadataTotal > 0 ? Math.min(100, (metadataProcessed / metadataTotal) * 100) : 0)
        : (totalFinal && total > 0 ? Math.min(100, (processed / total) * 100) : 0);
    const progressKey = showingMetadata
        ? `scan-metadata:${metadataTotalFinal ? metadataTotal : 'growing'}`
        : `scan-import:${totalFinal ? total : 'counting'}`;

    return {
        processed,
        total,
        totalFinal,
        counted,
        metadataProcessed,
        metadataTotal,
        metadataTotalFinal,
        importComplete,
        isCounting,
        showingMetadata,
        completed,
        stableTotal,
        showEta,
        percent,
        progressKey,
    };
}

function _updateBgScanProgress(progress) {
    const bar = $('#bg-scan-progress');
    if (!bar) return;

    if (!['running', 'cancelling'].includes(progress?.status)) {
        bar.style.display = 'none';
        return;
    }

    const scanModal = $('#scan-modal');
    const modalOpen = scanModal && scanModal.classList.contains('visible');
    bar.style.display = modalOpen ? 'none' : 'flex';

    const metrics = getScanProgressMetrics(progress);
    const fill = $('#bg-scan-progress-fill');
    const textEl = $('#bg-scan-progress-text');
    const isIndeterminate = ['running', 'cancelling'].includes(progress?.status) && (
        metrics.isCounting || !metrics.percent || metrics.percent <= 0
    );
    if (fill) {
        fill.classList.toggle('is-indeterminate', isIndeterminate);
        fill.style.width = isIndeterminate ? '' : (Math.min(100, metrics.percent) + '%');
    }

    if (!textEl) return;

    if (progress?.status === 'cancelling') {
        textEl.textContent = appT('scan.backgroundCancelling', 'Stopping scan...');
        return;
    }

    if (progress?.attention_required) {
        textEl.textContent = buildScanAttentionMessage(progress, { compact: true });
        return;
    }

    if (metrics.isCounting) {
        textEl.textContent = appT('progress.countingImages', 'Counting images... {count} found')
            .replace('{count}', String(metrics.counted || metrics.processed || 0));
        return;
    }

    const extraParts = [];
    if (metrics.showingMetadata && metrics.metadataTotal > 0) {
        extraParts.push(
            appT('progress.metadataCount', '{current}/{total} details')
                .replace('{current}', String(metrics.metadataProcessed))
                .replace('{total}', String(metrics.metadataTotal))
        );
        if (!metrics.metadataTotalFinal) {
            extraParts.push(appT('progress.detailsStillCounting', 'details total still being checked'));
        }
    } else if (metrics.totalFinal && metrics.total > 0) {
        extraParts.push(
            appT('progress.left', '{count} left')
                .replace('{count}', String(Math.max(0, metrics.total - metrics.processed)))
        );
    }

    textEl.textContent = buildOperationProgressText({
        completed: metrics.completed,
        total: metrics.stableTotal,
        tracker: _scanBackgroundProgressTracker,
        primaryLabel: appT('scan.progressLabel', 'Import'),
        extraParts,
        detail: progress?.message || (metrics.showingMetadata
            ? appT('scan.backgroundMetadata', 'Filling in image details...')
            : appT('scan.backgroundImporting', 'Bringing images into your library...')),
        defaultMessage: appT('scan.backgroundImporting', 'Bringing images into your library...'),
        showEta: metrics.showEta,
        progressKey: metrics.progressKey,
    });
}

function _hideBgScanProgress() {
    const bar = $('#bg-scan-progress');
    if (bar) bar.style.display = 'none';
    resetProgressTracker(_scanBackgroundProgressTracker);
}

function buildScanAttentionMessage(progress, options = {}) {
    const compact = Boolean(options.compact);
    const stalledSeconds = Number(progress?.stalled_seconds || 0);
    const pending = Number(progress?.metadata_pending || 0);
    const currentItem = progress?.current_item || appT('scan.diagnosticsCurrentUnknown', 'current file');
    const secondsText = stalledSeconds > 0 ? `${Math.round(stalledSeconds)}s` : appT('scan.diagnosticsSomeTime', 'some time');
    const key = compact ? 'scan.backgroundStalledDetailed' : 'scan.diagnosticsDefaultDetailed';
    const fallback = compact
        ? 'Scan needs attention: no visible progress for {seconds}. Open details to copy diagnostics.'
        : 'No visible progress for {seconds}. The app may be waiting on a slow, broken, or network-drive image. If this does not recover in 1-2 minutes, copy diagnostics for support.';
    return appT(key, fallback, {
        seconds: secondsText,
        pending: String(pending),
        current: currentItem,
        step: progress?.step || progress?.status || '-',
    });
}

