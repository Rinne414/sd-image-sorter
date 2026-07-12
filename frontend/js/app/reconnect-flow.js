/**
 * app/reconnect-flow.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 3666-4149 (of 10,152): modal facet search + missing-file reconnect flow.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
function filterCollapsibleList(type, query) {
    const list = document.getElementById(`${type}-list`);
    const items = list.querySelectorAll('.checkbox-label');
    query = query.toLowerCase();

    items.forEach(item => {
        const text = item.querySelector('.checkbox-text').textContent.toLowerCase();
        item.style.display = text.includes(query) ? 'flex' : 'none';
    });
}

function filterModalList(listId, query) {
    const list = document.getElementById(listId);
    if (!list) return;

    const items = list.querySelectorAll('.checkbox-label');
    query = query.toLowerCase();

    items.forEach(item => {
        const textEl = item.querySelector('.checkbox-text');
        if (textEl) {
            const text = textEl.textContent.toLowerCase();
            item.style.display = text.includes(query) ? '' : 'none';
        }
    });
}

async function searchModalFilterFacet(facet, query) {
    const normalizedQuery = String(query || '').trim();
    const targetListId = facet === 'checkpoints' ? 'modal-checkpoint-list' : 'modal-lora-list';
    const list = document.getElementById(targetListId);
    if (!list) return;

    try {
        if (!normalizedQuery) {
            const data = FilterModalController.optionData || AppState.analytics || await API.getStats();
            if (facet === 'checkpoints') {
                renderCheckpointFilterList(data.checkpoints || []);
            } else {
                renderLoraFilterList(data.loras || []);
            }
            updateFilterModalSummary();
            return;
        }

        const result = await API.getAnalyticsFacet(facet, {
            query: normalizedQuery,
            limit: FACET_FILTER_SEARCH_LIMIT,
        });
        if (facet === 'checkpoints') {
            renderCheckpointFilterList(result.checkpoints || []);
        } else {
            renderLoraFilterList(result.loras || []);
        }
        updateFilterModalSummary();
    } catch (error) {
        Logger.error('Filter facet search failed:', error);
        filterModalList(targetListId, normalizedQuery);
    }
}


// ============== Missing File Reconnect ==============

function resetReconnectFolderValidation() {
    const input = $('#reconnect-folder-path');
    const feedback = $('#reconnect-folder-feedback');
    if (input) {
        input.classList.remove('input-valid', 'input-invalid', 'input-checking');
    }
    if (feedback) {
        feedback.className = 'validation-feedback';
        feedback.textContent = '';
    }
}

function setReconnectFolderValidation(state, message = '') {
    const input = $('#reconnect-folder-path');
    const feedback = $('#reconnect-folder-feedback');
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

function validateReconnectFolderPath() {
    const input = $('#reconnect-folder-path');
    if (!input) return true;
    const value = input.value.trim();
    resetReconnectFolderValidation();
    if (!value) return true;

    const invalidChars = /[<>"|?*]/;
    if (invalidChars.test(value)) {
        setReconnectFolderValidation('error', appT('scan.invalidPathChars', 'Path contains invalid characters'));
        return false;
    }

    setReconnectFolderValidation('checking', appT('scan.pathChecking', 'Checking path...'));
    const requestValue = value;
    API.post('/api/validate-path', { path: value })
        .then(result => {
            if (input.value.trim() !== requestValue) return;
            if (result.valid) {
                setReconnectFolderValidation('success', appT('scan.folderFound', 'Folder found'));
            } else {
                setReconnectFolderValidation('error', mapScanPathError(result.error || appT('scan.invalidPath', 'Path format is invalid')));
            }
        })
        .catch((error) => {
            if (input.value.trim() !== requestValue) return;
            setReconnectFolderValidation('', isScanPathError(error) ? mapScanPathError(error) : '');
        });
    return true;
}

function _setReconnectRunningUi(isRunning) {
    const startBtn = $('#btn-start-reconnect');
    const cancelBtn = $('#btn-cancel-reconnect');
    if (startBtn) startBtn.disabled = Boolean(isRunning);
    if (cancelBtn) {
        if (isRunning) {
            cancelBtn.removeAttribute('data-i18n');
            cancelBtn.textContent = appT('reconnect.stopButton', 'Stop Search');
        } else {
            cancelBtn.setAttribute('data-i18n', 'modal.cancel');
            cancelBtn.textContent = appT('modal.cancel', 'Cancel');
        }
    }
}

function _formatReconnectStatus(progress) {
    const checked = Number(progress?.checked_files ?? progress?.processed ?? progress?.current ?? 0);
    const matched = Number(progress?.matched || 0);
    const missingTotal = Number(progress?.missing_total || 0);
    const ambiguous = Number(progress?.ambiguous || 0);
    const conflicts = Number(progress?.conflicts || 0);
    const errors = Number(progress?.errors || 0);
    const base = missingTotal > 0
        ? appT('reconnect.progressText', 'Checked {checked} files · found {matched}/{missing} missing')
            .replace('{checked}', String(checked))
            .replace('{matched}', String(matched))
            .replace('{missing}', String(missingTotal))
        : appT('reconnect.progressNoMissing', 'Checking files... {checked} checked')
            .replace('{checked}', String(checked));
    const extras = [];
    if (ambiguous) {
        extras.push(appT('reconnect.ambiguousShort', '{count} need review').replace('{count}', String(ambiguous)));
    }
    if (conflicts) {
        extras.push(appT('reconnect.conflictsShort', '{count} already in gallery').replace('{count}', String(conflicts)));
    }
    if (errors) {
        extras.push(appT('reconnect.errorsShort', '{count} errors').replace('{count}', String(errors)));
    }
    return extras.length ? `${base} · ${extras.join(' · ')}` : base;
}

function _renderReconnectResultPanel(progress) {
    const panel = $('#reconnect-result-panel');
    if (!panel) return;

    if (progress?.status !== 'done' || !progress?.result) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    const result = progress.result || {};
    const updated = Array.isArray(result.updated) ? result.updated : [];
    const needsReview = Array.isArray(result.needs_review) ? result.needs_review : [];
    const conflicts = Array.isArray(result.conflict_samples) ? result.conflict_samples : [];
    const stillMissing = Array.isArray(result.still_missing_samples) ? result.still_missing_samples : [];
    const errors = Array.isArray(result.recent_errors) ? result.recent_errors : [];
    const matched = Number(result.matched || progress.matched || 0);
    const missingTotal = Number(result.missing_total || progress.missing_total || 0);
    const libraryMissingTotal = Number(result.library_missing_total || progress.library_missing_total || 0);
    const missing = Number(result.still_missing || 0);
    const resultSummaryKey = missingTotal === 0 && libraryMissingTotal > 0
        ? 'reconnect.resultNoMatches'
        : 'reconnect.resultSummary';

    const pathLine = (label, value) => value
        ? `<div class="reconnect-result-path"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`
        : '';
    const emptyText = appT('reconnect.resultEmpty', 'Nothing to show here.');
    const renderItems = (items, renderItem) => items.length
        ? items.slice(0, 5).map(renderItem).join('')
        : `<div class="reconnect-result-empty">${escapeHtml(emptyText)}</div>`;

    panel.innerHTML = `
        <div class="reconnect-result-summary">
            <strong>${escapeHtml(appT('reconnect.resultTitle', 'Search result'))}</strong>
            <span>${escapeHtml(appT(resultSummaryKey, '{matched} reconnected · {missing} still missing')
                .replace('{matched}', String(matched))
                .replace('{missing}', String(missing))
                .replace('{libraryMissing}', String(libraryMissingTotal)))}</span>
        </div>
        <details class="reconnect-result-group" open>
            <summary>${escapeHtml(appT('reconnect.resultUpdated', 'Reconnected'))} <span>${updated.length}</span></summary>
            ${renderItems(updated, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || `#${item.image_id}`)}</strong>
                    ${pathLine(appT('reconnect.oldPathLabel', 'Old'), item.old_path)}
                    ${pathLine(appT('reconnect.newPathLabel', 'New'), item.new_path)}
                </div>
            `)}
        </details>
        <details class="reconnect-result-group" ${needsReview.length ? 'open' : ''}>
            <summary>${escapeHtml(appT('reconnect.resultNeedsReview', 'Need your choice'))} <span>${Number(result.review_pending_total || needsReview.length || 0)}</span></summary>
            ${Number(result.review_pending_total || needsReview.length || 0) > 0 ? `
                <button type="button" class="btn btn-primary btn-small reconnect-open-repair-review" id="btn-open-repair-review">
                    ${escapeHtml(appT('repairReview.openButton', 'Review & fix these matches ({count})').replace('{count}', String(Number(result.review_pending_total || needsReview.length || 0))))}
                </button>` : ''}
            ${renderItems(needsReview, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || '')}</strong>
                    <p>${escapeHtml(appT('reconnect.needsReviewHelp', 'Several old records could match this file. Choose a smaller folder and run Find Moved Images again, or review the paths manually.'))}</p>
                    ${pathLine(appT('reconnect.foundPathLabel', 'Found'), item.found_path)}
                    ${(Array.isArray(item.old_paths) ? item.old_paths : []).map((path) => pathLine(appT('reconnect.possibleOldPathLabel', 'Possible old'), path)).join('')}
                </div>
            `)}
        </details>
        <details class="reconnect-result-group" ${conflicts.length ? 'open' : ''}>
            <summary>${escapeHtml(appT('reconnect.resultConflicts', 'Already in gallery'))} <span>${conflicts.length}</span></summary>
            ${renderItems(conflicts, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || '')}</strong>
                    <p>${escapeHtml(appT('reconnect.conflictHelp', 'The new file path is already another gallery item. If the old missing record is only a duplicate, remove the old record from the gallery.'))}</p>
                    ${pathLine(appT('reconnect.oldPathLabel', 'Old'), item.old_path)}
                    ${pathLine(appT('reconnect.existingPathLabel', 'Already indexed'), item.existing_path)}
                    ${item.old_image_id ? `<button type="button" class="btn btn-ghost btn-small reconnect-remove-old" data-reconnect-remove-id="${escapeHtml(item.old_image_id)}">${escapeHtml(appT('reconnect.removeOldRecord', 'Remove old gallery record'))}</button>` : ''}
                </div>
            `)}
        </details>
        <details class="reconnect-result-group" ${stillMissing.length ? '' : ''}>
            <summary>${escapeHtml(appT('reconnect.resultStillMissing', 'Still missing'))} <span>${stillMissing.length}</span></summary>
            ${renderItems(stillMissing, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || `#${item.image_id}`)}</strong>
                    <p>${escapeHtml(appT('reconnect.stillMissingHelp', 'The file was not found in the folder you chose. Try a wider folder or reconnect the drive.'))}</p>
                    ${pathLine(appT('reconnect.oldPathLabel', 'Old'), item.old_path)}
                </div>
            `)}
        </details>
        ${errors.length ? `<details class="reconnect-result-group" open>
            <summary>${escapeHtml(appT('reconnect.resultErrors', 'Errors'))} <span>${errors.length}</span></summary>
            ${renderItems(errors, (item) => `
                <div class="reconnect-result-item">
                    <strong>${escapeHtml(item.filename || '')}</strong>
                    <p>${escapeHtml(item.error || '')}</p>
                </div>
            `)}
        </details>` : ''}
    `;

    panel.querySelectorAll('[data-reconnect-remove-id]').forEach((button) => {
        button.addEventListener('click', () => {
            const imageId = Number(button.getAttribute('data-reconnect-remove-id'));
            if (Number.isFinite(imageId) && imageId > 0) {
                removeGalleryImagesByIds([imageId]);
            }
        });
    });
    // Aurora Phase 3 / Roadmap-C: hand ambiguous matches to the review modal.
    panel.querySelector('#btn-open-repair-review')?.addEventListener('click', () => {
        if (window.RepairReview && typeof window.RepairReview.open === 'function') {
            window.RepairReview.open();
        }
    });
    panel.style.display = 'grid';
}

function _updateReconnectProgressUi(progress) {
    const container = $('#reconnect-progress-container');
    const fill = $('#reconnect-progress-fill');
    const textEl = $('#reconnect-progress-text');
    const running = ['running', 'cancelling'].includes(progress?.status);
    if (container) container.style.display = running || ['done', 'error', 'cancelled'].includes(progress?.status) ? 'block' : 'none';
    if (fill) {
        fill.classList.toggle('is-indeterminate', running);
        fill.style.width = running ? '' : (progress?.status === 'done' ? '100%' : '0%');
    }
    if (textEl) {
        if (progress?.status === 'cancelling') {
            textEl.textContent = appT('reconnect.cancelling', 'Stopping search...');
        } else if (progress?.status === 'done') {
            textEl.textContent = progress.message || appT('reconnect.done', 'Search complete.');
        } else if (progress?.status === 'error') {
            textEl.textContent = progress.message || appT('reconnect.failedStatus', 'Search failed');
        } else if (progress?.status === 'cancelled') {
            textEl.textContent = progress.message || appT('reconnect.cancelled', 'Search stopped');
        } else {
            textEl.textContent = _formatReconnectStatus(progress);
        }
    }
    _setReconnectRunningUi(running);
    _renderReconnectResultPanel(progress);
}

function _updateBgReconnectProgress(progress) {
    const bar = $('#bg-reconnect-progress');
    if (!bar) return;
    if (!['running', 'cancelling'].includes(progress?.status)) {
        bar.style.display = 'none';
        return;
    }
    const modal = $('#reconnect-modal');
    const modalOpen = modal && modal.classList.contains('visible');
    bar.style.display = modalOpen ? 'none' : 'flex';
    const fill = $('#bg-reconnect-progress-fill');
    if (fill) {
        fill.classList.add('is-indeterminate');
        fill.style.width = '';
    }
    const textEl = $('#bg-reconnect-progress-text');
    if (textEl) {
        textEl.textContent = progress?.status === 'cancelling'
            ? appT('reconnect.cancelling', 'Stopping search...')
            : _formatReconnectStatus(progress);
    }
}

function _hideBgReconnectProgress() {
    const bar = $('#bg-reconnect-progress');
    if (bar) bar.style.display = 'none';
}

function _clearReconnectPollTimer() {
    if (_reconnectPollTimer) {
        clearTimeout(_reconnectPollTimer);
        _reconnectPollTimer = null;
    }
}

function _initBgReconnectProgressButtons() {
    $('#bg-reconnect-cancel')?.addEventListener('click', async () => {
        await requestStopReconnectMissing();
    });
    $('#bg-reconnect-open')?.addEventListener('click', () => {
        showModal('reconnect-modal');
    });
}

async function startReconnectMissing() {
    const folderPath = $('#reconnect-folder-path')?.value?.trim() || '';
    if (!folderPath) {
        showToast(appT('reconnect.enterFolder', 'Choose where the moved images may be now.'), 'error');
        return;
    }
    const recursive = $('#reconnect-recursive')?.checked ?? true;
    const verifyUncertain = $('#reconnect-verify-uncertain')?.checked ?? true;

    try {
        await API.startReconnectMissing(folderPath, { recursive, verifyUncertain });
        const initialProgress = {
            status: 'running',
            checked_files: 0,
            matched: 0,
            missing_total: 0,
            ambiguous: 0,
            errors: 0,
        };
        _updateReconnectProgressUi(initialProgress);
        hideModal('reconnect-modal');
        _updateBgReconnectProgress(initialProgress);
        showToast(appT('reconnect.startedToast', 'Search started in the background. You can keep using the gallery.'), 'info');
        pollReconnectProgress();
    } catch (error) {
        const userMessage = mapScanPathError(error);
        if (isScanPathError(error)) {
            setReconnectFolderValidation('error', userMessage);
        }
        showToast(formatUserError(error, appT('reconnect.failedStart', 'Failed to start finding moved files')), 'error');
    }
}

async function requestStopReconnectMissing() {
    const progress = await API.getReconnectProgress().catch(() => null);
    if (!progress || !['running', 'cancelling'].includes(progress.status)) {
        hideModal('reconnect-modal');
        _setReconnectRunningUi(false);
        return;
    }
    try {
        const result = await API.cancelReconnectMissing();
        _updateReconnectProgressUi(result);
        _updateBgReconnectProgress(result);
        showToast(appT('reconnect.cancelling', 'Stopping search...'), 'info');
        pollReconnectProgress();
    } catch (error) {
        showToast(formatUserError(error, appT('reconnect.failedCancel', 'Failed to stop finding moved files')), 'error');
    }
}

async function pollReconnectProgress(retryCount = 0) {
    _clearReconnectPollTimer();
    try {
        const progress = await API.getReconnectProgress();
        _updateReconnectProgressUi(progress);
        _updateBgReconnectProgress(progress);

        if (progress.status === 'running' || progress.status === 'cancelling') {
            _reconnectPollTimer = setTimeout(() => pollReconnectProgress(0), progress.status === 'cancelling' ? 250 : 700);
            return;
        }

        if (progress.status === 'done') {
            const result = progress.result || {};
            const matched = Number(progress.matched || result.matched || 0);
            const stillMissing = Number(result.still_missing || 0);
            const missingTotal = Number(progress.missing_total || result.missing_total || 0);
            const libraryMissingTotal = Number(progress.library_missing_total || result.library_missing_total || 0);
            const ambiguous = Number(progress.ambiguous || result.ambiguous || 0);
            const conflicts = Number(progress.conflicts || result.conflicts || 0);
            const doneKey = missingTotal === 0 && libraryMissingTotal > 0
                ? 'reconnect.doneNoMatchesToast'
                : 'reconnect.doneToast';
            showToast(
                appT(doneKey, 'Found {matched} moved images. {missing} still missing. {ambiguous} need review. {conflicts} already in gallery.')
                    .replace('{matched}', String(matched))
                    .replace('{missing}', String(stillMissing))
                    .replace('{libraryMissing}', String(libraryMissingTotal))
                    .replace('{ambiguous}', String(ambiguous))
                    .replace('{conflicts}', String(conflicts)),
                ambiguous > 0 || stillMissing > 0 || conflicts > 0 || (missingTotal === 0 && libraryMissingTotal > 0) ? 'warning' : 'success'
            );
            _hideBgReconnectProgress();
            _setReconnectRunningUi(false);
            _refreshScanDrivenViews(true, { refreshGallery: true });
            window.UnreadableBanner?.refresh(true);
            return;
        }

        if (progress.status === 'cancelled') {
            showToast(progress.message || appT('reconnect.cancelled', 'Search stopped'), 'info');
            _hideBgReconnectProgress();
            _setReconnectRunningUi(false);
            window.UnreadableBanner?.refresh(true);
            return;
        }

        if (progress.status === 'error') {
            showToast(progress.message || appT('reconnect.failedStatus', 'Search failed'), 'error');
            _hideBgReconnectProgress();
            _setReconnectRunningUi(false);
        }
    } catch (error) {
        if (retryCount < 3) {
            _reconnectPollTimer = setTimeout(() => pollReconnectProgress(retryCount + 1), 1000);
            return;
        }
        showToast(formatUserError(error, appT('reconnect.failedProgress', 'Could not update moved-file search progress')), 'error');
        _hideBgReconnectProgress();
        _setReconnectRunningUi(false);
    }
}

async function resumeReconnectProgress() {
    try {
        const progress = await API.getReconnectProgress();
        if (!['running', 'cancelling'].includes(progress?.status)) {
            _hideBgReconnectProgress();
            return;
        }
        _updateReconnectProgressUi(progress);
        _updateBgReconnectProgress(progress);
        pollReconnectProgress();
    } catch (error) {
        Logger.warn('Failed to resume moved-file search progress:', error);
    }
}

