/**
 * app/model-manager.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 7772-8548 (of 10,152): model manager modal + bulk download + setup guide.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
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

    for (const item of items) {
        updateBanner(appT('models.bulkProgress', 'Downloading {index}/{total}: {name}', { index: completed + 1, total, name: item.name || item.id }));
        if (button) {
            button.innerHTML = `<span aria-hidden="true">⏳</span> <span>${escapeHtml(appT(
                'models.bulkProgress',
                'Downloading {index}/{total}: {name}',
                { index: completed + 1, total, name: item.name || item.id }
            ))}</span>`;
        }

        try {
            await API.prepareModel(item.id, {
                variant: item.variant || null,
            });
        } catch (err) {
            failures.push({ id: item.id, message: err?.message || String(err) });
            continue;
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

function renderModelManager(models = []) {
    const summaryEl = $('#model-manager-summary');
    const gridEl = $('#model-manager-grid');
    if (!summaryEl || !gridEl) return;

    const readyCount = models.filter(model => model.status === 'ready').length;
    const missingCount = models.filter(model => model.status === 'missing').length;

    summaryEl.innerHTML = `
        <div class="model-manager-stat">
            <strong>${readyCount}</strong>
            <span>${escapeHtml(appT('models.ready', 'Ready now'))}</span>
        </div>
        <div class="model-manager-stat">
            <strong>${missingCount}</strong>
            <span>${escapeHtml(appT('models.missing', 'Need attention'))}</span>
        </div>
        <div class="model-manager-stat">
            <strong>${models.length}</strong>
            <span>${escapeHtml(appT('models.total', 'Tracked runtimes'))}</span>
        </div>
    `;

    renderFeatureAvailabilityNotice();

    API.getMirror().then((mirrorData) => {
        const current = mirrorData?.mirror || 'auto';
        // Labels are i18n-driven so the dropdown is not English-only in the
        // zh-CN UI. The ModelScope label is deliberately honest: only the
        // Artist/Kaloscope and SAM3 downloaders actually reach modelscope.cn;
        // every other model (WD14, ToriiGate, OppaiOracle, CLIP, Aesthetic)
        // is HuggingFace-only and uses hf-mirror under this setting.
        const labels = {
            auto: appT('models.mirror.auto', 'Auto (HuggingFace → hf-mirror fallback)'),
            'hf-mirror': appT('models.mirror.hfMirror', 'hf-mirror.com (HF mirror)'),
            modelscope: appT('models.mirror.modelscope', 'ModelScope (Artist & SAM3 only; others use hf-mirror)'),
        };
        let mirrorRow = document.getElementById('model-mirror-row');
        if (!mirrorRow) {
            mirrorRow = document.createElement('div');
            mirrorRow.id = 'model-mirror-row';
            mirrorRow.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 14px;margin-bottom:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(191,219,254,0.08);border-radius:12px;';
            gridEl.parentElement.insertBefore(mirrorRow, gridEl);
        }
        const opts = (mirrorData?.options || ['auto', 'hf-mirror', 'modelscope']).map(
            o => `<option value="${escapeHtml(o)}"${o === current ? ' selected' : ''}>${escapeHtml(labels[o] || o)}</option>`
        ).join('');
        const mirrorHint = appT(
            'models.mirror.hint',
            'ModelScope (modelscope.cn) is only used for Artist / Kaloscope and SAM 3. Other models always download from HuggingFace or its hf-mirror.'
        );
        mirrorRow.innerHTML = `
            <label style="font-size:13px;font-weight:600;color:var(--text-secondary);white-space:nowrap;">${escapeHtml(appT('models.mirrorLabel', 'Download Source'))}</label>
            <select class="input-field" id="model-mirror-select" style="flex:1;min-width:220px;font-size:12px;padding:6px 8px;">${opts}</select>
            <div style="flex-basis:100%;font-size:11px;line-height:1.5;color:var(--text-tertiary,#8a94a6);">${escapeHtml(mirrorHint)}</div>
        `;
        document.getElementById('model-mirror-select')?.addEventListener('change', async (e) => {
            try {
                await API.setMirror(e.target.value);
                showToast(appT('models.mirrorSaved', 'Download source saved: {mirror}').replace('{mirror}', labels[e.target.value] || e.target.value), 'success');
            } catch (err) {
                showToast(formatUserError(err, 'Failed to save'), 'error');
            }
        });
    }).catch(() => {});

    const renderModelCard = (model) => {
        const safeId = escapeHtml(model.id);
        const status = model.status || (model.available ? 'ready' : 'missing');
        const statusClass = status === 'ready' ? 'is-ready' : 'is-missing';
        const statusLabel = status === 'ready'
            ? appT('models.readyBadge', 'Ready')
            : appT('models.missingBadge', 'Missing');
        const sourceOptions = Array.isArray(model.sources) ? model.sources.map((source) => `
            <option value="${escapeHtml(source)}">${escapeHtml(source)}</option>
        `).join('') : '';
        // Pre-select the backend-recommended default variant (e.g. wd-swinv2)
        // so the card's Prepare downloads the recommended model, not whichever
        // variant happens to be first in the list (eva02-large is heavy/opt-in).
        const defaultVariant = model.default_variant || '';
        const variantOptions = Array.isArray(model.variants) ? model.variants.map((variant) => `
            <option value="${escapeHtml(variant)}"${variant === defaultVariant ? ' selected' : ''}>${escapeHtml(variant)}</option>
        `).join('') : '';
        const installedVariants = Array.isArray(model.installed_variants) && model.installed_variants.length
            ? `<div class="model-card-hint">${escapeHtml(appT('models.installedVariants', 'Installed variants'))}: ${escapeHtml(model.installed_variants.join(', '))}</div>`
            : '';
        const externalLinks = Array.isArray(model.external_links) ? model.external_links.map((link) => {
            // Defense in depth: only allow http(s) URLs in the model registry. Block javascript:, data:,
            // file:, vbscript: and other surprising schemes even though the registry is backend-controlled.
            const rawUrl = String(link.url || '');
            const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '#';
            return `
            <a class="btn btn-ghost btn-small" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label || appT('models.openSource', 'Open source'))}</a>
        `;
        }).join('') : '';

        return `
            <article class="model-card ${statusClass}${model.recommended ? ' is-recommended' : ''}" data-model-id="${safeId}">
                <div class="model-card-header">
                    <div>
                        <div class="model-card-group">${escapeHtml(model.group_key ? appT(model.group_key, model.group || appT('models.groupFallback', 'Feature')) : (model.group || appT('models.groupFallback', 'Feature')))}${model.recommended ? ` <span class="model-card-badge" title="${escapeHtml(appT('models.recommendedTooltip', 'Included in “Download all recommended models”'))}">${escapeHtml(appT('models.recommended', 'Recommended'))}</span>` : ''}</div>
                        <div class="model-card-title">${escapeHtml(model.name || model.id)}</div>
                    </div>
                    <span class="model-card-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                </div>
                <div class="model-card-message">${escapeHtml(model.message_key ? appT(model.message_key, model.message || '', model.message_params || {}) : (model.message || ''))}</div>
                ${model.path ? `<div class="model-card-path">${escapeHtml(appT('models.path', 'Current path'))}:<code>${escapeHtml(model.path)}</code></div>` : ''}
                ${model.runtime_path ? `<div class="model-card-path">${escapeHtml(appT('models.runtimePath', 'Runtime files'))}:<code>${escapeHtml(model.runtime_path)}</code></div>` : ''}
                ${installedVariants}
                ${sourceOptions ? `
                    <label class="model-card-hint">
                        ${escapeHtml(appT('models.source', 'Source'))}
                        <select class="input-field model-source-select" data-model-id="${safeId}">${sourceOptions}</select>
                    </label>
                ` : ''}
                ${variantOptions ? `
                    <label class="model-card-hint">
                        ${escapeHtml(appT('models.variant', 'Variant'))}
                        <select class="input-field model-variant-select" data-model-id="${safeId}">${variantOptions}</select>
                    </label>
                ` : ''}
                ${Array.isArray(model.setup_steps) && model.setup_steps.length && status !== 'ready' ? `
                    <details class="model-card-setup-steps">
                        <summary>${escapeHtml(appT('models.setupSteps', 'Manual setup steps'))}</summary>
                        <div class="model-card-hint">${model.setup_steps.map((s, i) => `<div>${i + 1}. <code>${escapeHtml(s)}</code></div>`).join('')}</div>
                    </details>
                ` : ''}
                <div class="model-card-actions">
                    ${model.download_supported ? `<button class="btn btn-primary btn-prepare-model" data-model-id="${safeId}">${escapeHtml(status === 'ready' ? appT('models.repair', 'Recheck / Repair') : appT('models.prepare', 'Prepare / Download'))}</button>` : ''}
                    ${!model.download_supported && status !== 'ready' ? `<span class="model-card-hint">${escapeHtml(appT('models.noAutoDownload', 'Automatic download not available — follow manual steps above'))}</span>` : ''}
                    ${externalLinks}
                </div>
            </article>
        `;
    };

    // MODELS-07: essentials-first. Recommended models render in a leading
    // "Essentials" section; optional/advanced ones (ToriiGate, OppaiOracle,
    // Wenaka Privacy YOLO) drop into an "Additional" section so a new user is
    // not faced with a flat, undifferentiated wall of model cards.
    const sectionHeading = (key, fallback) =>
        `<div class="model-manager-section" role="presentation">${escapeHtml(appT(key, fallback))}</div>`;
    const recommendedModels = models.filter((model) => model.recommended);
    const optionalModels = models.filter((model) => !model.recommended);
    gridEl.innerHTML = [
        recommendedModels.length
            ? sectionHeading('models.essentials', 'Essentials · recommended for everyone') + recommendedModels.map(renderModelCard).join('')
            : '',
        optionalModels.length
            ? sectionHeading('models.optionalSection', 'Additional & advanced models') + optionalModels.map(renderModelCard).join('')
            : '',
    ].join('');

    const withRestartReminder = (message, prepareResult) => {
        if (!prepareResult?.restart_recommended) return message;
        const packages = Array.isArray(prepareResult.installed_packages)
            ? prepareResult.installed_packages.join(', ')
            : '';
        const reminder = packages
            ? appT('models.restartAfterInstallWithPackages', 'Installed Python packages: {packages}. Restart the app before using this feature.', { packages })
            : appT('models.restartAfterInstall', 'Restart the app before using this feature.');
        return message ? `${message} ${reminder}` : reminder;
    };

    gridEl.querySelectorAll('.btn-prepare-model').forEach((button) => {
        button.addEventListener('click', async () => {
            const modelId = button.dataset.modelId;
            const source = gridEl.querySelector(`.model-source-select[data-model-id="${CSS.escape(modelId)}"]`)?.value || null;
            const variant = gridEl.querySelector(`.model-variant-select[data-model-id="${CSS.escape(modelId)}"]`)?.value || null;
            const originalLabel = button.textContent;
            button.disabled = true;
            button.textContent = appT('models.working', 'Working...');
            try {
                await API.prepareModel(modelId, { source, variant });
            } catch (error) {
                showToast(formatUserError(error, appT('models.prepareFailed', 'Model setup failed')), 'error');
                button.disabled = false;
                button.textContent = originalLabel;
                return;
            }

            let finished = false;
            let pollErrorStreak = 0;
            const MAX_POLL_ERROR_STREAK = 8; // ~6s of consecutive poll failures before giving up
            // Stall detection is progress-based, not time-capped: a 5GB model
            // legitimately downloads for far longer than any fixed cutoff. Only
            // warn (informationally, polling continues) after this long with no
            // change in downloaded bytes.
            const STALL_WARNING_MS = 3 * 60 * 1000;
            let lastProgressSignature = null;
            let lastProgressAt = Date.now();
            let stallWarned = false;

            // Insert a cancel button next to the prepare button
            let cancelBtn = button.parentElement.querySelector('.btn-cancel-download');
            if (!cancelBtn) {
                cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn btn-ghost btn-small btn-cancel-download';
                cancelBtn.textContent = appT('models.cancelDownload', 'Cancel');
                button.parentElement.insertBefore(cancelBtn, button.nextSibling);
            }
            cancelBtn.style.display = '';
            cancelBtn.onclick = () => {
                finished = true;
                cancelBtn.style.display = 'none';
                button.disabled = false;
                button.textContent = originalLabel;
                showToast(appT('models.downloadCancelled', 'Download cancelled.'), 'info');
            };

            const pollProgress = async () => {
                try {
                    const p = await API.get('/api/models/download-progress');
                    pollErrorStreak = 0; // a successful read clears the transient-failure streak
                    const progressSignature = p?.active ? `${p.filename || ''}:${p.downloaded || 0}` : null;
                    if (progressSignature !== lastProgressSignature) {
                        lastProgressSignature = progressSignature;
                        lastProgressAt = Date.now();
                        stallWarned = false;
                    } else if (!stallWarned && Date.now() - lastProgressAt > STALL_WARNING_MS) {
                        // Informational only — keep polling; large downloads can
                        // pause on slow mirrors and resume on their own.
                        stallWarned = true;
                        showToast(appT('models.downloadStalled', 'Download may have stalled. Check your network connection and try again.'), 'warning');
                    }
                    if (p?.active && p.total > 0) {
                        const pct = Math.round((p.downloaded / p.total) * 100);
                        const mb = (p.downloaded / 1048576).toFixed(0);
                        const totalMb = (p.total / 1048576).toFixed(0);
                        button.textContent = `${p.filename || 'Downloading'}: ${mb}/${totalMb} MB (${pct}%)`;
                    } else if (p?.active) {
                        const mb = (p.downloaded / 1048576).toFixed(0);
                        button.textContent = `${p.filename || 'Downloading'}: ${mb} MB...`;
                    }
                    const pr = p?.prepare_result;
                    if (pr && !pr.active && pr.model_id === modelId && pr.status) {
                        finished = true;
                        cancelBtn.style.display = 'none';
                        if (pr.status === 'done') {
                            showToast(withRestartReminder(pr.message || appT('models.readyToast', '{model} is ready.', { model: modelId }), pr), pr.restart_recommended ? 'warning' : 'success');
                            const refreshed = await API.getModelStatus();
                            renderModelManager(refreshed.models || []);
                            document.dispatchEvent(new CustomEvent('model-status-changed', { detail: { modelId } }));
                            return;
                        }
                        if (pr.status === 'warning') {
                            showToast(withRestartReminder(pr.message || appT('models.needsRuntimeToast', 'Model files are present, but runtime setup is incomplete.'), pr), 'warning');
                            const refreshed = await API.getModelStatus();
                            renderModelManager(refreshed.models || []);
                            document.dispatchEvent(new CustomEvent('model-status-changed', { detail: { modelId } }));
                            return;
                        }
                        if (pr.status === 'error') {
                            // If the backend returned structured guidance
                            // (Civitai login wall on Privacy YOLO, archive
                            // verification failure, etc.), surface it as
                            // an actionable dialog instead of swallowing
                            // the recovery path into a toast.
                            const hasGuidance = Array.isArray(pr.manual_steps) && pr.manual_steps.length > 0;
                            if (hasGuidance) {
                                showModelSetupGuide(pr);
                            } else {
                                showToast(pr.message || appT('models.prepareFailed', 'Model setup failed'), 'error');
                            }
                            try {
                                const refreshed = await API.getModelStatus();
                                renderModelManager(refreshed.models || []);
                            } catch (_refreshErr) {
                                button.disabled = false;
                                button.textContent = originalLabel;
                            }
                            return;
                        }
                    }
                } catch (_pollErr) {
                    // A single poll failure is usually transient (server busy
                    // mid-download). Re-arm below, but bail out after a streak
                    // of consecutive failures so the button can't hang forever
                    // in "Working..." when the backend is truly gone.
                    pollErrorStreak++;
                    if (pollErrorStreak >= MAX_POLL_ERROR_STREAK && !finished) {
                        finished = true;
                        cancelBtn.style.display = 'none';
                        showToast(appT('models.downloadStalled', 'Download may have stalled. Check your network connection and try again.'), 'warning');
                        button.disabled = false;
                        button.textContent = originalLabel;
                        return;
                    }
                }
                if (!finished) {
                    setTimeout(pollProgress, 800);
                }
            };
            pollProgress();
        });
    });
}

function _formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

let _modelSetupGuideCleanup = null;

function showModelSetupGuide(pr) {
    // Build a one-off backdrop+dialog so the structured manual_steps from
    // the backend (Civitai login wall, archive verification failure, ...)
    // become an actionable recovery path instead of a stale toast.
    if (_modelSetupGuideCleanup) {
        _modelSetupGuideCleanup({ restoreFocus: false });
    }

    const provider = String(pr.provider || '').trim();
    const message = String(pr.message || appT('models.prepareFailed', 'Model setup failed'));
    const targetDir = String(pr.target_dir || '').trim();
    const externalUrl = String(pr.external_url || '').trim();
    const steps = Array.isArray(pr.manual_steps) ? pr.manual_steps : [];

    const titleText = appT('models.manualSetupTitle', 'Manual setup required');
    const providerLabel = provider
        ? appT('models.providerLabel', 'Source: {provider}', { provider })
        : '';
    const dirLabel = appT('models.targetDirLabel', 'Save the files into this folder:');
    const openLabel = appT('models.openDownloadPage', 'Open Download Page');
    const copyLabel = appT('models.copyTargetDir', 'Copy folder path');
    const closeLabel = appT('models.guideClose', 'Close');

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = document.createElement('div');
    backdrop.id = 'model-setup-guide-backdrop';
    backdrop.className = 'modal-backdrop visible';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(8,12,24,0.72);backdrop-filter:blur(6px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px;';

    const dialog = document.createElement('div');
    dialog.role = 'dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'model-setup-guide-title');
    dialog.style.cssText = 'background:var(--bg-card-solid,#0e1a2d);color:var(--text-primary,#eef2ff);border:1px solid var(--glass-border,rgba(191,219,254,0.18));border-radius:16px;padding:24px;max-width:560px;width:100%;max-height:calc(100vh - 48px);overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.5);';

    const stepsHtml = steps
        .map((step, i) => `<li style="margin:6px 0;line-height:1.5;">${escapeHtml(String(step))}</li>`)
        .join('');

    const targetDirHtml = targetDir
        ? `
            <div style="margin-top:14px;padding:12px;background:rgba(255,255,255,0.04);border-radius:10px;border:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:12px;color:var(--text-muted,#94a3b8);margin-bottom:6px;">${escapeHtml(dirLabel)}</div>
                <code id="model-setup-guide-dir" style="display:block;word-break:break-all;font-size:12px;line-height:1.4;font-family:ui-monospace,Consolas,monospace;color:var(--text-primary,#eef2ff);">${escapeHtml(targetDir)}</code>
                <button id="model-setup-guide-copy" type="button" class="btn btn-ghost btn-small" style="margin-top:8px;">${escapeHtml(copyLabel)}</button>
            </div>
        ` : '';

    dialog.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;">
            <div style="flex:1;">
                <h3 id="model-setup-guide-title" style="margin:0;font-size:18px;line-height:1.3;">${escapeHtml(titleText)}</h3>
                ${providerLabel ? `<div style="font-size:12px;color:var(--text-muted,#94a3b8);margin-top:4px;">${escapeHtml(providerLabel)}</div>` : ''}
            </div>
            <button id="model-setup-guide-close-x" type="button" aria-label="${escapeHtml(closeLabel)}" style="background:none;border:none;color:var(--text-muted,#94a3b8);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px;">×</button>
        </div>
        <p style="margin:0 0 12px;line-height:1.5;">${escapeHtml(message)}</p>
        ${steps.length ? `<ol style="margin:0;padding-left:22px;">${stepsHtml}</ol>` : ''}
        ${targetDirHtml}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap;">
            ${externalUrl ? `<button id="model-setup-guide-open" type="button" class="btn btn-primary">${escapeHtml(openLabel)}</button>` : ''}
            <button id="model-setup-guide-close" type="button" class="btn btn-secondary">${escapeHtml(closeLabel)}</button>
        </div>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const getFocusableElements = () => Array.from(dialog.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    });

    const close = ({ restoreFocus = true } = {}) => {
        document.removeEventListener('keydown', onKeydown);
        if (_modelSetupGuideCleanup === close) {
            _modelSetupGuideCleanup = null;
        }
        backdrop.remove();
        if (restoreFocus) previousFocus?.focus?.();
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'Tab') {
            const focusable = getFocusableElements();
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };

    // Backdrop click closes; dialog click does not bubble through.
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    dialog.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', onKeydown);
    _modelSetupGuideCleanup = close;

    document.getElementById('model-setup-guide-close-x')?.addEventListener('click', close);
    document.getElementById('model-setup-guide-close')?.addEventListener('click', close);

    if (externalUrl) {
        document.getElementById('model-setup-guide-open')?.addEventListener('click', () => {
            try {
                window.open(externalUrl, '_blank', 'noopener,noreferrer');
            } catch (_err) {
                showToast(appT('models.openDownloadPageFailed', 'Could not open the download page automatically.'), 'error');
            }
        });
    }

    if (targetDir) {
        document.getElementById('model-setup-guide-copy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(targetDir);
                showToast(appT('models.targetDirCopied', 'Folder path copied to clipboard'), 'success');
            } catch (_err) {
                // Fallback: select the code element so the user can Ctrl+C.
                const codeEl = document.getElementById('model-setup-guide-dir');
                if (codeEl) {
                    const range = document.createRange();
                    range.selectNodeContents(codeEl);
                    const sel = window.getSelection();
                    sel?.removeAllRanges();
                    sel?.addRange(range);
                }
                showToast(appT('models.targetDirCopyFailed', 'Could not copy automatically — select and copy manually.'), 'warning');
            }
        });
    }

    // Focus management for accessibility.
    setTimeout(() => {
        document.getElementById('model-setup-guide-open')
            ?? document.getElementById('model-setup-guide-close-x')
            ?? null;
        const focusTarget = document.getElementById('model-setup-guide-open')
            || document.getElementById('model-setup-guide-close');
        focusTarget?.focus();
    }, 50);
}

