/**
 * Model Manager opener and bulk download flows.
 * Classic script sharing the app global lexical environment.
 */
async function openModelManager(initialTab) {
    // Remove first-run pulse indicator once user has found the button
    const setupBtn = $('#btn-open-model-manager');
    if (setupBtn && setupBtn.classList.contains('setup-pulse')) {
        setupBtn.classList.remove('setup-pulse');
        localStorage.setItem('sd-image-sorter-setup-clicked', '1');
    }
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (summaryEl) {
        summaryEl.innerHTML = `<div class="model-manager-stat"><strong>${escapeHtml(appT('models.loadingTitle', 'Checking'))}</strong><span>${escapeHtml(appT('models.loadingBody', 'Checking what is ready on this computer...'))}</span></div>`;
    }
    if (gridEl) gridEl.innerHTML = '';
    syncSettingsControls();
    showModal('model-manager-modal');
    // v3.5.0: the modal is tabbed (rule 6). Openers can land on a specific
    // section; the settings gear resets to the first tab.
    if (window.SettingsTabs && typeof window.SettingsTabs.activate === 'function') {
        window.SettingsTabs.activate(typeof initialTab === 'string' ? initialTab : 'general');
    }

    // Disk usage loads independently so a slow model probe doesn't block it.
    loadDiskUsage();

    // Lazily initialize Dataset Audit only when the user expands it. Its data
    // call is heavier than disk usage, so we do not want it to fire on every
    // Setup open.
    bindDatasetAuditLazyInit();

    try {
        const result = await API.getModelStatus();
        renderModelManager(result.models || []);
    } catch (error) {
        if (summaryEl) {
            summaryEl.innerHTML = `<div class="model-manager-stat"><strong>${escapeHtml(appT('models.failedTitle', 'Load failed'))}</strong><span>${escapeHtml(error.message || appT('models.failedBody', 'Could not read local feature status right now.'))}</span></div>`;
        }
    }

    // Wire the "Download all" button. Idempotent — re-binding on each
    // openModelManager() call is fine because the previous handler was
    // removed when the DOM survived (the button is static markup).
    const bulkBtn = $('#btn-bulk-download-models');
    if (bulkBtn && !bulkBtn.dataset.bulkBound) {
        bulkBtn.dataset.bulkBound = '1';
        bulkBtn.addEventListener('click', () => {
            promptBulkDownloadModels().catch((err) => {
                console.error('Bulk download flow failed', err);
                showToast(formatUserError(err, appT('models.bulkFailed', 'Bulk download failed')), 'error');
            });
        });
    }
}

function _formatBulkBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function _parseModelPrepareStart(payload, requestedModelId) {
    if (typeof requestedModelId !== 'string' || !requestedModelId.trim()) {
        throw new TypeError('requestedModelId must be a non-empty string');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError(`Model prepare response for '${requestedModelId}' must be an object`);
    }
    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    const activeModelId = typeof payload.model_id === 'string' ? payload.model_id.trim() : '';
    if (!status || !activeModelId) {
        throw new TypeError(
            `Model prepare response for '${requestedModelId}' must include status and model_id`,
        );
    }
    return { status, activeModelId };
}

function _modelPrepareConflictMessage(requestedModelId, activeModelId) {
    return appT(
        'models.prepareConflict',
        'Cannot prepare {requested}: {active} is already being prepared. Wait for it to finish, then try again.',
        { requested: requestedModelId, active: activeModelId },
    );
}

async function promptBulkDownloadModels() {
    let bundle;
    try {
        bundle = await API.getModelBulkBundle();
    } catch (err) {
        showToast(formatUserError(err, appT('models.bulkFetchFailed', 'Could not load the bulk download list. Please restart the app and try again.')), 'error');
        return;
    }

    const items = Array.isArray(bundle?.items) ? bundle.items : [];
    if (items.length === 0) {
        showToast(appT('models.bulkEmpty', 'No models are configured for bulk download.'), 'warning');
        return;
    }
    const pendingItems = items.filter((it) => it.status !== 'ready');
    if (pendingItems.length === 0) {
        showToast(appT('models.bulkAllReady', 'All recommended models are already downloaded.'), 'success');
        return;
    }
    const pendingTotalBytes = Number(bundle.pending_total_bytes) || pendingItems.reduce((s, it) => s + (Number(it.size_bytes) || 0), 0);

    // Build the confirmation HTML. We can't use showConfirm() directly
    // because it only takes plain text — we want a checklist with sizes.
    const listHtml = items.map((it) => {
        const isReady = it.status === 'ready';
        const cls = isReady ? 'is-ready' : 'is-pending';
        const sizeText = _formatBulkBytes(it.size_bytes);
        const pillText = isReady
            ? appT('models.bulkAlreadyReady', 'already ready')
            : appT('models.bulkWillDownload', 'will download');
        const safeLabel = escapeHtml(it.label || it.name || it.id);
        return `
            <div class="bulk-download-row ${cls}">
                <span class="bulk-download-name">${safeLabel}</span>
                <span class="bulk-download-pill">${escapeHtml(pillText)}</span>
                <span class="bulk-download-size">~${escapeHtml(sizeText)}</span>
            </div>
        `;
    }).join('');

    const totalText = _formatBulkBytes(pendingTotalBytes);
    const excludedItems = Array.isArray(bundle.excluded) ? bundle.excluded : [];
    const excludedHtml = excludedItems.length ? `
        <p class="model-card-hint" style="margin-top:8px;">
            ${escapeHtml(appT('models.bulkExcludedNote', 'Skipped:'))} ${
                excludedItems.map(e => escapeHtml(e.id)).join(', ')
            }
        </p>
    ` : '';

    const bodyHtml = `
        <p>${escapeHtml(appT(
            'models.bulkConfirmIntro',
            'About to download {count} model(s). Estimated disk space needed: {size}.',
            { count: pendingItems.length, size: totalText }
        ))}</p>
        <div class="bulk-download-list" role="list">${listHtml}</div>
        <div class="bulk-download-summary">
            <span>${escapeHtml(appT('models.bulkConfirmTotalLabel', 'Total to download'))}</span>
            <span>${escapeHtml(totalText)}</span>
        </div>
        ${excludedHtml}
        <p class="model-card-hint" style="margin-top:10px;">${escapeHtml(appT(
            'models.bulkConfirmNote',
            'Sizes are estimates. Some models also install Python packages on first run; restart the app if the progress text mentions a Python install. Downloads run sequentially and you can close this dialog to leave them running in the background.'
        ))}</p>
    `;

    // Re-use the existing #confirm-modal but inject HTML message. Bypass
    // showConfirm()'s plain-text content path — its lock means we have
    // to set message innerHTML manually after it opens.
    showConfirm(
        appT('models.bulkConfirmTitle', 'Are you sure? Download all recommended models'),
        '',
        async () => {
            unlockDynamicI18nText('#btn-confirm-ok', 'modal.yes', 'Yes, proceed');
            await runBulkDownload(pendingItems);
        },
        () => {
            // Cancel: restore the OK button to its default "Yes" text so
            // the next showConfirm() user gets the right wording.
            unlockDynamicI18nText('#btn-confirm-ok', 'modal.yes', 'Yes, proceed');
            const messageEl = document.getElementById('confirm-message');
            if (messageEl) {
                messageEl.style.maxHeight = '';
                messageEl.style.overflowY = '';
                messageEl.style.textAlign = '';
            }
        }
    );

    const messageEl = document.getElementById('confirm-message');
    if (messageEl) {
        // innerHTML sink: callers MUST pass pre-escaped/safe HTML. `bodyHtml`
        // is built above with escapeHtml() around every interpolated value
        // (model labels, sizes, excluded ids, and all appT() strings); appT()
        // does NOT escape its params, so unescaped user text here would be XSS.
        messageEl.innerHTML = bodyHtml;
        messageEl.style.maxHeight = '60vh';
        messageEl.style.overflowY = 'auto';
        messageEl.style.textAlign = 'left';
    }
    // Lock the OK button text so the global i18n auto-retranslate
    // (which honours data-i18n="modal.yes") doesn't overwrite our
    // dynamic "Download N model(s) (~X GB)" label.
    lockDynamicI18nText('#btn-confirm-ok', 'modal.yes');
    const okBtn = document.getElementById('btn-confirm-ok');
    if (okBtn) {
        okBtn.textContent = appT('models.bulkConfirmOk', 'Download {count} model(s) (~{size})', {
            count: pendingItems.length,
            size: totalText,
        });
    }
}

async function runBulkDownload(items) {
    const button = $('#btn-bulk-download-models');
    const originalLabel = button ? button.innerHTML : '';
    if (button) {
        button.disabled = true;
    }

    const total = items.length;
    let completed = 0;
    const failures = [];
    let needsRestart = false;

    // Pulse the Setup button so user knows something is running even if modal is closed
    const setupBtn = $('#btn-open-model-manager');
    if (setupBtn) setupBtn.classList.add('setup-pulse');

    // Show a persistent progress banner inside the model manager modal
    const gridEl = $('#model-manager-grid');
    let banner = document.getElementById('bulk-download-progress-banner');
    if (!banner && gridEl && gridEl.parentElement) {
        banner = document.createElement('div');
        banner.id = 'bulk-download-progress-banner';
        banner.style.cssText = 'padding:12px 16px;margin-bottom:12px;border-radius:8px;background:var(--bg-elevated);border:1px solid var(--accent-primary);font-size:13px;';
        gridEl.parentElement.insertBefore(banner, gridEl);
    }
    const updateBanner = (text) => { if (banner) banner.textContent = text; };

    for (const [itemIndex, item] of items.entries()) {
        updateBanner(appT('models.bulkProgress', 'Downloading {index}/{total}: {name}', { index: completed + 1, total, name: item.name || item.id }));
        if (button) {
            button.innerHTML = `<span aria-hidden="true">⏳</span> <span>${escapeHtml(appT(
                'models.bulkProgress',
                'Downloading {index}/{total}: {name}',
                { index: completed + 1, total, name: item.name || item.id }
            ))}</span>`;
        }

        let prepareStart;
        try {
            const prepareResponse = await API.prepareModel(item.id, {
                variant: item.variant || null,
            });
            prepareStart = _parseModelPrepareStart(prepareResponse, item.id);
        } catch (err) {
            failures.push({ id: item.id, message: err?.message || String(err) });
            completed += 1;
            continue;
        }
        if (prepareStart.activeModelId !== item.id) {
            const message = _modelPrepareConflictMessage(item.id, prepareStart.activeModelId);
            const blockedItems = items.slice(itemIndex);
            failures.push(...blockedItems.map((blockedItem) => ({
                id: blockedItem.id,
                message,
            })));
            completed += blockedItems.length;
            showToast(message, 'warning');
            break;
        }

        // Poll progress until this model finishes (or another one starts).
        // Re-uses the existing /api/models/download-progress endpoint that
        // the per-card prepare buttons drive.
        let finished = false;
        let safetyTicks = 0;
        while (!finished) {
            await new Promise(r => setTimeout(r, 1500));
            safetyTicks += 1;
            // Hard guard: 1 hour absolute cap per model so the loop can
            // never deadlock if the backend never reports `prepare_result`.
            if (safetyTicks > 2400) {
                failures.push({ id: item.id, message: 'timeout waiting for prepare_result' });
                break;
            }
            try {
                const p = await API.get('/api/models/download-progress');
                const pr = p?.prepare_result;
                if (pr && !pr.active && pr.model_id === item.id && pr.status) {
                    finished = true;
                    if (pr.restart_recommended) needsRestart = true;
                    if (pr.status !== 'done' && pr.status !== 'ready' && pr.status !== 'warning') {
                        failures.push({ id: item.id, message: pr.message || pr.error || pr.status });
                    }
                    break;
                }
                if (button && p?.active && p.total > 0) {
                    const pct = Math.round((p.downloaded / p.total) * 100);
                    const detail = appT('models.bulkProgressDetail', '{index}/{total}: {name} {pct}%', { index: completed + 1, total, name: item.name || item.id, pct });
                    updateBanner(detail);
                    button.innerHTML = `<span aria-hidden="true">⏳</span> <span>${escapeHtml(detail)}</span>`;
                }
            } catch (err) {
                // Network blip — just retry the poll.
            }
        }
        completed += 1;
        // Notify per-model completion so user knows progress even if modal is closed
        if (failures.length === 0 || failures[failures.length - 1]?.id !== item.id) {
            showToast(appT('models.bulkItemDone', '✓ {name} ({index}/{total})', { name: item.name || item.id, index: completed, total }), 'success');
        }
    }

    // Stop the pulse indicator
    if (setupBtn) setupBtn.classList.remove('setup-pulse');

    // Refresh model status to reflect the new "ready" rows.
    try {
        const refreshed = await API.getModelStatus();
        renderModelManager(refreshed.models || []);
    } catch (err) {
        // Non-fatal — the user can re-open the modal.
    }

    if (button) {
        button.disabled = false;
        button.innerHTML = originalLabel
            || `<span aria-hidden="true">⬇️</span> <span>${escapeHtml(appT('models.bulkDownload', 'Download all recommended models'))}</span>`;
    }

    // Update banner with final result
    if (banner) {
        if (needsRestart) {
            banner.style.borderColor = 'var(--color-warning, #f59e0b)';
            banner.style.background = 'rgba(245, 158, 11, 0.1)';
            banner.innerHTML = `<strong>${escapeHtml(appT('models.bulkNeedsRestart', '⚠️ Restart required'))}</strong><br>${escapeHtml(appT('models.bulkRestartExplain', 'Some features installed Python packages. Close and restart the app, then click "Download all" again to finish downloading model files.'))}`;
        } else if (failures.length === 0) {
            banner.style.borderColor = 'var(--color-success, #22c55e)';
            banner.style.background = 'rgba(34, 197, 94, 0.1)';
            banner.textContent = appT('models.bulkDoneAll', 'All {count} model(s) downloaded successfully.', { count: total });
            setTimeout(() => { if (banner.parentNode) banner.remove(); }, 10000);
        } else {
            banner.style.borderColor = 'var(--color-danger, #ef4444)';
            banner.textContent = appT('models.bulkDoneMixed', 'Downloaded {ok}/{total}. Failed: {failed}.', { ok: total - failures.length, total, failed: failures.map(f => f.id).join(', ') });
        }
    }

    if (failures.length === 0 && !needsRestart) {
        showToast(appT('models.bulkDoneAll', 'All {count} model(s) downloaded successfully.', { count: total }), 'success');
    } else if (needsRestart) {
        showToast(appT('models.bulkNeedsRestart', '⚠️ Restart required — close and reopen the app, then click Download again.'), 'warning');
    } else {
        const okCount = total - failures.length;
        const failedIds = failures.map(f => f.id).join(', ');
        showToast(appT(
            'models.bulkDoneMixed',
            'Downloaded {ok}/{total}. Failed: {failed}. Open each model card to retry the failed ones.',
            { ok: okCount, total, failed: failedIds }
        ), 'warning');
    }
}

