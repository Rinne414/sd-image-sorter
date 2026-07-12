/**
 * app/disk-usage.js — app.js decomposition, stage 5 (feature flows).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js, stage-5
 * pre-cut lines 8549-8716 (of 10,152): disk usage panel.
 * Classic script: shares ONE global lexical environment with app.js and
 * the other app/ parts; index.html loads every app/ file BEFORE app.js
 * (tag order = original line order). No behavior change intended.
 */
async function loadDiskUsage() {
    const bodyEl = $('#disk-usage-body');
    if (!bodyEl) return;
    bodyEl.innerHTML = `<div class="disk-usage-loading">${escapeHtml(appT('disk.loading', 'Reading disk usage…'))}</div>`;
    try {
        const data = await API.getCacheStatus();
        renderDiskUsage(data);
    } catch (error) {
        bodyEl.innerHTML = `<div class="disk-usage-error">${escapeHtml(formatUserError(error, appT('disk.loadFailed', 'Failed to read disk usage')))}</div>`;
    }
}

function renderDiskUsage(data) {
    const bodyEl = $('#disk-usage-body');
    if (!bodyEl) return;
    const safe = Array.isArray(data?.safe_to_clean) ? data.safe_to_clean : [];
    const preserved = Array.isArray(data?.preserved) ? data.preserved : [];

    const safeRows = safe.map((entry) => {
        const checked = entry.size_bytes > 0 ? 'checked' : '';
        const sizeBytes = Number(entry.size_bytes || 0);
        const sizeText = _formatBytes(sizeBytes);
        return `
            <label class="disk-cache-row" data-key="${escapeHtml(entry.key)}">
                <input type="checkbox" class="disk-cache-checkbox" data-key="${escapeHtml(entry.key)}" ${checked}>
                <span class="disk-cache-name">${escapeHtml(appT(entry.label_key, entry.key))}</span>
                <span class="disk-cache-size">${escapeHtml(sizeText)}</span>
                <span class="disk-cache-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>
            </label>
        `;
    }).join('');

    const preservedRows = preserved.map((entry) => {
        const sizeBytes = Number(entry.size_bytes || 0);
        const sizeLabel = _formatBytes(sizeBytes);
        const pathHtml = entry.path
            ? `<span class="disk-preserved-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>`
            : '';
        return `
            <div class="disk-preserved-row">
                <span class="disk-preserved-name">${escapeHtml(appT(entry.label_key, entry.key))}</span>
                <span class="disk-preserved-size">${escapeHtml(sizeLabel)}</span>
                ${pathHtml}
            </div>
        `;
    }).join('');

    const totalSafe = safe.reduce((sum, e) => sum + Number(e.size_bytes || 0), 0);
    const totalSafeText = _formatBytes(totalSafe);
    const hasCleanableSafe = safe.some(e => e.exists && Number(e.size_bytes || 0) > 0);
    const totalPreserved = preserved.reduce((sum, e) => sum + Number(e.size_bytes || 0), 0);
    const totalPreservedText = _formatBytes(totalPreserved);
    const thumbnailLimit = getThumbnailCacheSettings(data);
    const thumbnailStats = data?.thumbnail_cache || {};
    const runtime = data?.runtime_environment || {};
    const thumbnailSafeEntry = safe.find(entry => entry.key === 'thumbnails');
    const thumbnailCurrent = Number(thumbnailStats.total_size_bytes ?? thumbnailSafeEntry?.size_bytes ?? 0);
    const thumbnailCurrentText = _formatBytes(thumbnailCurrent);
    const thumbnailLimitText = thumbnailLimit > 0
        ? appT('disk.thumbnailLimitStatus', '{current} used / {limit} limit', { current: thumbnailCurrentText, limit: `${thumbnailLimit} MB` })
        : appT('disk.thumbnailLimitDisabled', 'Persistent thumbnail cache is disabled.');
    const runtimeSize = Number(runtime.venv_size_bytes || 0);
    const rebuildPending = Boolean(runtime.rebuild_core_pending);
    const runtimeStatusText = rebuildPending
        ? appT('disk.rebuildPending', 'Rebuild scheduled for next start')
        : appT('disk.runtimeSizeStatus', '{size} currently used', { size: _formatBytes(runtimeSize) });

    bodyEl.innerHTML = `
        <div class="disk-section disk-settings-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.thumbnailLimitTitle', 'Thumbnail cache limit'))}</strong>
                <span class="disk-section-total">${escapeHtml(thumbnailLimitText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.thumbnailLimitHint', 'Default is 500 MB. Lower values save disk space but may regenerate thumbnails more often. 0 disables persistent thumbnail caching. Original images are never deleted.'))}</p>
            <p class="disk-section-hint disk-tradeoff-hint">${escapeHtml(appT('disk.thumbnailTradeoffHint', 'Storage vs speed: lowering this limit saves disk, but scrolling large galleries can use more CPU/IO because thumbnails must be recreated.'))}</p>
            <div class="disk-setting-row">
                <label for="thumbnail-cache-limit-input">${escapeHtml(appT('disk.thumbnailLimitLabel', 'Max thumbnail cache'))}</label>
                <input id="thumbnail-cache-limit-input" class="input-field" type="number" min="0" max="102400" step="50" value="${escapeHtml(String(thumbnailLimit))}">
                <span class="disk-setting-unit">MB</span>
                <button class="btn btn-primary btn-small" id="btn-save-cache-settings">${escapeHtml(appT('disk.saveSettings', 'Save'))}</button>
            </div>
        </div>
        <div class="disk-section disk-runtime-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.runtimeTitle', 'Python runtime environment'))}</strong>
                <span class="disk-section-total">${escapeHtml(runtimeStatusText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.runtimeHint', 'If an old install already pulled heavy AI Python packages, schedule a lightweight rebuild. The next launcher start rebuilds only the Python runtime and reinstalls core dependencies; data, images.db, settings, models, and caches are kept.'))}</p>
            <div class="disk-actions">
                <button class="btn btn-ghost btn-small" id="btn-rebuild-core-runtime" ${rebuildPending ? 'disabled' : ''}>${escapeHtml(rebuildPending ? appT('disk.rebuildPendingButton', 'Rebuild scheduled') : appT('disk.rebuildCoreRuntime', 'Rebuild lightweight runtime on next start'))}</button>
            </div>
        </div>
        <div class="disk-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.safeToClean', 'Safe to clean'))}</strong>
                <span class="disk-section-total">${escapeHtml(totalSafeText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.safeHint', 'These caches will be regenerated as needed if you delete them.'))}</p>
            <div class="disk-cache-list">${safeRows || `<div class="disk-empty">${escapeHtml(appT('disk.nothingToClean', 'Nothing to clean.'))}</div>`}</div>
            <div class="disk-actions">
                <button class="btn btn-primary btn-small" id="btn-clean-caches" ${hasCleanableSafe ? '' : 'disabled'}>${escapeHtml(appT('disk.cleanSelected', 'Clean Selected'))}</button>
                <button class="btn btn-ghost btn-small" id="btn-refresh-disk-usage">${escapeHtml(appT('disk.refresh', 'Refresh'))}</button>
            </div>
        </div>
        <div class="disk-section">
            <div class="disk-section-header">
                <strong>${escapeHtml(appT('disk.preserved', 'Preserved (do not delete)'))}</strong>
                <span class="disk-section-total">${escapeHtml(totalPreservedText)}</span>
            </div>
            <p class="disk-section-hint">${escapeHtml(appT('disk.preservedHint', 'These contain models, settings, or your personal data. The app will not delete them from this screen.'))}</p>
            <div class="disk-preserved-list">${preservedRows}</div>
        </div>
    `;

    $('#btn-refresh-disk-usage')?.addEventListener('click', () => {
        loadDiskUsage();
    });
    $('#btn-save-cache-settings')?.addEventListener('click', saveDiskSettings);
    $('#btn-rebuild-core-runtime')?.addEventListener('click', requestCoreRuntimeRebuild);
    $('#thumbnail-cache-limit-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveDiskSettings();
    });
    $('#btn-clean-caches')?.addEventListener('click', async () => {
        const checked = Array.from(bodyEl.querySelectorAll('.disk-cache-checkbox:checked')).map((el) => el.dataset.key);
        if (checked.length === 0) {
            showToast(appT('disk.selectAtLeastOne', 'Select at least one cache to clean.'), 'warning');
            return;
        }
        const runClean = async () => {
            const btn = $('#btn-clean-caches');
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = appT('disk.cleaning', 'Cleaning…');
            try {
                const result = await API.cleanCaches(checked);
                const cleaned = Array.isArray(result?.cleaned) ? result.cleaned : [];
                const errors = Array.isArray(result?.errors) ? result.errors : [];
                const totalFreed = cleaned.reduce((sum, e) => sum + Number(e.freed_bytes || 0), 0);
                if (errors.length > 0) {
                    showToast(appT('disk.cleanedWithErrors', 'Cleaned {freed}, but {count} item(s) had problems.', { freed: _formatBytes(totalFreed), count: errors.length }), 'warning');
                } else {
                    showToast(appT('disk.cleanedSuccess', 'Freed {freed} of disk space.', { freed: _formatBytes(totalFreed) }), 'success');
                }
                loadDiskUsage();
            } catch (error) {
                showToast(formatUserError(error, appT('disk.cleanFailed', 'Failed to clean caches')), 'error');
                btn.disabled = false;
                btn.textContent = original;
            }
        };
        const unknownEntries = checked
            .map((key) => safe.find((entry) => entry.key === key))
            .filter((entry) => entry?.size_complete === false);
        if (unknownEntries.length > 0) {
            const names = unknownEntries
                .map((entry) => appT(entry.label_key, entry.key))
                .join(', ');
            showConfirm(
                appT('disk.cleanUnknownConfirmTitle', 'Clean cache with unknown size?'),
                appT('disk.cleanUnknownConfirmBody', 'The app could not fully scan the size for: {items}. Clean anyway? Only selected app-owned caches will be emptied; images.db, settings, models, and original images are not deleted.', { items: names }),
                runClean
            );
            return;
        }
        await runClean();
    });
}

