/**
 * Dataset Maker — export flow: confirm modal, busy/progress UI, background job start/poll/cancel/resume, result modal, open-folder.
 * Moved VERBATIM from dataset-maker-part3.js L1-17 + L527-1014.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
/**
 * Dataset Maker - Part 3 (caption rendering via export-preview API,
 * export pre/post-flight modals, naming preset switching).
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // Shared HTML-escape helper for every user-influenced string that gets
    // interpolated into innerHTML via _t(). _t() does NOT escape its
    // params, so callers must escape at the source. Previously this same
    // arrow function was duplicated at two call sites (confirm-modal and
    // result-modal); keeping one definition here removes the drift risk.
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));

    // ---------- Confirm modal ----------
    DM._showConfirmModal = function () {
        if (!this._isReadyToExport()) {
            this._validateOutputFolder();
            const wrap = document.querySelector('.dataset-required-label');
            if (this._outputMode() !== 'beside_image' && wrap && !(document.getElementById('dataset-output-folder')?.value || '').trim()) {
                wrap.classList.add('invalid');
            }
            const reason = this._exportDisabledReason();
            this._toast(reason || this._t('dataset.exportDisabledHint',
                'Add at least one image and pick an output folder to enable.'), 'warning');
            return;
        }

        const modal = document.getElementById('dataset-confirm-modal');
        const list = document.getElementById('dataset-confirm-summary');
        if (!modal || !list) return;

        const imageOp = document.getElementById('dataset-image-op')?.value || 'copy';
        const folder = document.getElementById('dataset-output-folder')?.value?.trim() || '';
        const preset = this._currentPreset();
        const outputMode = this._outputMode();

        // Declared here (before any _t() interpolation) because _t() does NOT
        // HTML-escape its params and the result is written via innerHTML below.
        // User-influenced values (trigger, pattern, folder, naming) must be
        // escaped at the source, not only when the outer label is later escaped.
        // (escapeHtml is the shared helper defined at the top of this IIFE.)

        const actionLabel = outputMode === 'beside_image'
            ? this._t('dataset.confirmActionBeside', 'left in place; only .txt sidecars are written')
            : ((imageOp === 'move')
                ? this._t('dataset.confirmActionMove', 'moved (removed from original location)')
                : this._t('dataset.confirmActionCopy', 'copied (originals stay in place)'));

        let namingLabel = '';
        if (preset === 'keep') {
            namingLabel = this._t('dataset.namingKeepLabel', 'kept as the original filenames');
        } else if (preset === 'renumber') {
            const trigger = document.getElementById('dataset-trigger')?.value?.trim() || 'subject';
            namingLabel = this._t('dataset.namingRenumberLabel',
                'renumbered: {trigger}_001.png, {trigger}_002.png, ...',
                { trigger: escapeHtml(trigger) });
        } else {
            const pattern = document.getElementById('dataset-naming-pattern')?.value || '';
            namingLabel = this._t('dataset.namingCustomLabel',
                'custom pattern: {pattern}', { pattern: escapeHtml(pattern) });
        }

        const logicalCount = this._getLogicalDatasetCount?.() || this.imageIds.length;
        const loadedCount = this.imageIds.length;
        const loadedOnlyChecks = logicalCount !== loadedCount;
        const editedCount = this.captionEdits.size;

        // v3.2.2 (issue #5 follow-up): warn the user if they're about to
        // export images with empty captions. Common knowledge-gap mistake:
        // user adds 50 images, forgets to click "Tag all", exports a folder
        // full of .png + empty .txt that train-on-nothing.
        const untaggedCount = this.imageIds.filter(id => {
            if (this.captionEdits.has(id)) return false;
            const cap = this.captions.get(id);
            return !cap || String(cap).trim().length === 0;
        }).length;

        const items = [
            this._t('dataset.confirmSummaryImages',
                '<strong>{count}</strong> images will be {action}',
                { count: logicalCount, action: escapeHtml(actionLabel) }),
            this._t('dataset.confirmSummaryCaptions',
                '<strong>{count}</strong> .txt caption files will be written',
                { count: logicalCount }),
        ];
        if (outputMode === 'beside_image') {
            items.push(this._t('dataset.confirmSummaryBeside',
                'Caption files will be written beside each original image with the same stem.'));
        } else {
            items.splice(1, 0,
                this._t('dataset.confirmSummaryFolder',
                    'Output folder: <code>{folder}</code>',
                    { folder: escapeHtml(folder) }),
                this._t('dataset.confirmSummaryNaming',
                    'Naming: <strong>{naming}</strong>',
                    { naming: escapeHtml(namingLabel) }),
            );
        }
        if (loadedOnlyChecks) {
            items.push(`<span class="dataset-confirm-warn">${this._t('dataset.confirmSummaryManifestPreview',
                'Only {loaded} previews are loaded in the browser; export will still include all {total} manifest images. Caption/size warnings below only cover loaded previews.',
                { loaded: loadedCount, total: logicalCount })}</span>`);
        }
        if (editedCount > 0) {
            items.push(this._t('dataset.confirmSummaryEdited',
                '<strong>{count}</strong> have your manually-edited captions',
                { count: editedCount }));
        }
        if (untaggedCount > 0) {
            items.push(`<span class="dataset-confirm-warn">${this._t('dataset.confirmSummaryUntagged',
                '⚠️ <strong>{count}</strong> have empty captions — their .txt files will be blank. Run "Tag all" first or write captions in Workbench.',
                { count: untaggedCount })}</span>`);
        }

        // LoRA-trainer guidance: warn when the dataset is below the
        // size most trainers consider workable (~15-50 images for a
        // character LoRA). Empty / tiny datasets are the most common
        // reason a noob's first LoRA comes out broken.
        if (logicalCount > 0 && logicalCount < 10) {
            items.push(`<span class="dataset-confirm-warn">${this._t('dataset.confirmSummaryFewImages',
                '⚠️ Only <strong>{count}</strong> images. Most LoRA trainers want 15-50 images for a stable character/style; below 10 the model may not generalize.',
                { count: logicalCount })}</span>`);
        }

        // Dimension warning - count images with a side under 512 px,
        // which is the floor below which any base model has to upscale
        // (and that quality loss tends to bleed into the trained LoRA).
        let smallCount = 0;
        for (const id of this.imageIds) {
            const meta = this.meta.get(id);
            const w = Number((meta && meta.width) || 0);
            const h = Number((meta && meta.height) || 0);
            if (w > 0 && h > 0 && Math.min(w, h) < 512) smallCount++;
        }
        if (smallCount > 0) {
            items.push(`<span class="dataset-confirm-warn">${this._t('dataset.confirmSummarySmallImages',
                '⚠️ <strong>{count}</strong> images have a side under 512 px — most trainers will upscale them, which hurts quality. Replace with higher-resolution sources if possible.',
                { count: smallCount })}</span>`);
        }

        // innerHTML sink: `items` is trusted markup. Every entry interpolates
        // only numeric counts or escapeHtml()-wrapped strings (action label,
        // folder, naming). Any new item that embeds user-influenced text MUST
        // escapeHtml it before pushing — _t() does not escape its params.
        list.innerHTML = items.map(s => `<li>${s}</li>`).join('');
        modal.hidden = false;
    };

    DM._hideConfirmModal = function () {
        const modal = document.getElementById('dataset-confirm-modal');
        if (modal) modal.hidden = true;
    };

    // ---------- Run export ----------
    // NOTE (FE-1 2b): _buildExportPayload lives in
    // dataset-maker-local-import.js — the single implementation that
    // handles both gallery ids and local-source items. A part3 copy used
    // to exist here but was wholesale redefined by local-import at load
    // time (dead code), so it was removed. The wire-format key set is
    // pinned by tests/e2e/specs/dataset-payload-contract.spec.ts.

    DM._setExportBusy = function (busy, options = {}) {
        const btn = document.getElementById('btn-dataset-export');
        const progressEl = document.getElementById('dataset-export-progress');
        const cancelBtn = document.getElementById('btn-dataset-export-cancel');
        if (btn) {
            btn.disabled = !!busy;
            btn.dataset.busy = busy ? '1' : '';
        }
        if (progressEl) progressEl.hidden = !busy && !options.keepProgressVisible;
        if (cancelBtn) {
            cancelBtn.hidden = !busy;
            cancelBtn.disabled = !!options.cancelling;
            cancelBtn.textContent = options.cancelling
                ? this._t('dataset.exportCancelling', 'Cancelling...')
                : this._t('common.cancel', 'Cancel');
        }
        if (!busy) this._updateExportEnabled();
    };

    DM._renderExportProgress = function (progress = {}) {
        const progressEl = document.getElementById('dataset-export-progress');
        const fill = document.getElementById('dataset-export-progress-fill');
        const text = document.getElementById('dataset-export-progress-text');
        const cancelBtn = document.getElementById('btn-dataset-export-cancel');
        if (progressEl) progressEl.hidden = false;

        const current = Number(progress.current || 0);
        const total = Number(progress.total || 0);
        const exported = Number(progress.exported || 0);
        const errors = Number(progress.errors || 0);
        const skipped = Number(progress.skipped || 0);
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;

        if (fill) {
            fill.classList.toggle('indeterminate', total <= 0);
            if (total > 0) fill.style.width = `${percent}%`;
            else fill.style.width = '';
        }

        if (text) {
            const msg = progress.message || this._t('dataset.exportPreparing', 'Preparing export...');
            const counts = total > 0
                ? `${current}/${total} • ${exported} exported${errors ? ` • ${errors} failed` : ''}${skipped ? ` • ${skipped} skipped` : ''}`
                : `${exported} exported${errors ? ` • ${errors} failed` : ''}`;
            text.textContent = `${msg} ${counts}`;
        }

        if (cancelBtn) {
            const cancelling = progress.status === 'cancelling';
            cancelBtn.hidden = !['starting', 'running', 'cancelling'].includes(progress.status);
            cancelBtn.disabled = cancelling;
            cancelBtn.textContent = cancelling
                ? this._t('dataset.exportCancelling', 'Cancelling...')
                : this._t('common.cancel', 'Cancel');
        }
    };

    DM._pollExportJob = async function (jobId) {
        let fetchFailures = 0;   // consecutive network / HTTP errors
        let lostJobCount = 0;    // consecutive idle / 404 "no such job" reads
        // Hard safety bounds so a stuck backend job can't spin this loop
        // forever. The previous implementation was ``while (true)`` with
        // no overall timeout and no backoff, which meant a job stuck in
        // ``status: 'running'`` polled at 350ms for the page lifetime.
        const startedAt = Date.now();
        const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1000; // 6h wall clock
        const MAX_POLL_ITERATIONS = 100_000;             // generous hard cap
        let iterations = 0;
        let delayMs = 350;                               // current backoff
        const MAX_DELAY_MS = 5000;                       // cap after idle
        const IDLE_BACKOFF_THRESHOLD_MS = 60 * 1000;     // back off after 60s idle

        while (true) {
            iterations += 1;
            if (iterations > MAX_POLL_ITERATIONS ||
                (Date.now() - startedAt) > MAX_POLL_DURATION_MS) {
                return {
                    status: 'failed',
                    recent_errors: [this._t('dataset.exportJobTimeout',
                        'The export job did not finish within the polling timeout. Check the output folder, then re-run the export if files are missing.')],
                };
            }
            let progress;
            try {
                const qs = jobId ? `?job_id=${encodeURIComponent(jobId)}` : '';
                const r = await fetch(`/api/dataset/export/progress${qs}`);
                if (r.status === 404) {
                    // No such job — e.g. the backend restarted mid-export.
                    // Allow a short grace window before declaring it lost.
                    lostJobCount += 1;
                    if (lostJobCount >= 3) {
                        return {
                            status: 'failed',
                            recent_errors: [this._t('dataset.exportJobLost',
                                'The export job no longer exists on the backend (it may have restarted). Check the output folder, then re-run the export if files are missing.')],
                        };
                    }
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                if (!r.ok) {
                    const body = await r.text();
                    throw new Error(body.slice(0, 300) || `Progress failed: ${r.status}`);
                }
                progress = await r.json();
                fetchFailures = 0;
            } catch (e) {
                // Transient fetch errors must not produce a fake "export
                // failed" modal — the backend job usually keeps running.
                // Retry, then give up after 3 consecutive failures.
                fetchFailures += 1;
                if (fetchFailures >= 3) throw e;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }
            this._renderExportProgress(progress);

            if (['done', 'failed', 'cancelled'].includes(progress.status)) {
                return progress;
            }
            if (progress.status === 'idle') {
                // Idle is the backend's "no job" state (e.g. after a restart).
                // Treat it as terminal after a short grace window so the loop
                // can't spin at 350ms forever.
                lostJobCount += 1;
                if (lostJobCount >= 3) {
                    return {
                        status: 'failed',
                        recent_errors: [this._t('dataset.exportJobLost',
                            'The export job no longer exists on the backend (it may have restarted). Check the output folder, then re-run the export if files are missing.')],
                    };
                }
            } else {
                lostJobCount = 0;
            }
            // Exponential backoff: a long-running export doesn't need 350ms
            // polling; after 60s of running we stretch toward 5s, which is
            // still snappy enough to feel live on a multi-thousand-image job.
            const elapsed = Date.now() - startedAt;
            if (elapsed > IDLE_BACKOFF_THRESHOLD_MS && progress.status === 'running') {
                delayMs = Math.min(MAX_DELAY_MS, Math.round(delayMs * 1.5));
            } else {
                delayMs = 350;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    };

    DM._startExportJob = async function (payload) {
        const folder = payload.output_folder || '';
        this._setExportBusy(true);
        this._renderExportProgress({
            status: 'starting',
            current: 0,
            total: this._getLogicalDatasetCount?.() || (payload.image_ids?.length || 0) + (payload.image_paths?.length || 0),
            exported: 0,
            skipped: 0,
            errors: 0,
            message: this._t('dataset.exportStarting', 'Starting export...'),
        });

        try {
            const r = await fetch('/api/dataset/export/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!r.ok) {
                const body = await r.text();
                this._showResultModal('failed', { errorMessages: [body.slice(0, 400)], output_folder: folder });
                return;
            }
            const started = await r.json();
            this._activeExportJobId = started.job_id || null;
            this._renderExportProgress({
                status: 'running',
                current: 0,
                total: started.total || 0,
                exported: 0,
                skipped: 0,
                errors: 0,
                message: started.message || this._t('dataset.exportRunning', 'Export running...'),
            });
            const progress = await this._pollExportJob(this._activeExportJobId);
            const result = progress.result || {
                status: progress.status === 'cancelled' ? 'cancelled' : 'failed',
                exported: progress.exported || 0,
                skipped: progress.skipped || 0,
                error_count: progress.errors || 0,
                output_folder: progress.output_folder || folder,
                error_messages: progress.recent_errors || [],
            };
            this._showResultModal(result.status || (progress.status === 'cancelled' ? 'cancelled' : 'ok'), result);
        } catch (e) {
            this._showResultModal('failed', { errorMessages: [e.message], output_folder: folder });
        } finally {
            this._activeExportJobId = null;
            this._setExportBusy(false);
            const progressEl = document.getElementById('dataset-export-progress');
            if (progressEl) progressEl.hidden = true;
        }
    };

    DM._cancelExportJob = async function () {
        const jobId = this._activeExportJobId || null;
        this._setExportBusy(true, { cancelling: true, keepProgressVisible: true });
        try {
            await fetch('/api/dataset/export/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jobId ? { job_id: jobId } : {}),
            });
        } catch (e) {
            this._toast(`Cancel failed: ${e.message}`, 'error', 4000);
            this._setExportBusy(true, { keepProgressVisible: true });
        }
    };

    DM._resumeExportProgress = async function () {
        if (this._exportResumeChecked) return;
        this._exportResumeChecked = true;
        try {
            const r = await fetch('/api/dataset/export/progress');
            if (!r.ok) return;
            const progress = await r.json();
            if (!['starting', 'running', 'cancelling'].includes(progress.status)) return;
            this._activeExportJobId = progress.job_id || null;
            this._setExportBusy(true, { cancelling: progress.status === 'cancelling', keepProgressVisible: true });
            this._renderExportProgress(progress);
            const finalProgress = await this._pollExportJob(this._activeExportJobId);
            if (finalProgress.result) {
                this._showResultModal(finalProgress.result.status || 'ok', finalProgress.result);
            }
        } catch (e) {
            this._toast(`Could not resume export progress: ${e.message}`, 'warning', 5000);
        } finally {
            this._activeExportJobId = null;
            this._setExportBusy(false);
            const progressEl = document.getElementById('dataset-export-progress');
            if (progressEl) progressEl.hidden = true;
        }
    };

    DM._runExport = async function () {
        this._hideConfirmModal();
        const payload = this._buildExportPayload();
        await this._startExportJob(payload);
    };

    // ---------- Result modal ----------
    DM._showResultModal = function (status, data) {
        const modal = document.getElementById('dataset-result-modal');
        const statusEl = document.getElementById('dataset-result-status');
        const titleEl = document.getElementById('dataset-result-title');
        const detailEl = document.getElementById('dataset-result-detail');
        const errorsBox = document.getElementById('dataset-result-errors');
        const errorsList = document.getElementById('dataset-result-error-list');
        const openFolderBtn = document.getElementById('btn-dataset-open-folder');
        if (!modal) return;

        const resolved = ['ok', 'partial', 'failed', 'cancelled'].includes(status) ? status : 'failed';
        const folder = data.output_folder || '';
        const exported = Number(data.exported || 0);
        const errors = Number(data.error_count || (data.errorMessages?.length || 0));
        const skipped = Number(data.skipped || 0);
        const errorMessages = data.error_messages || data.errorMessages || [];

        if (statusEl) {
            statusEl.className = `dataset-result-status ${resolved}`;
            statusEl.textContent = resolved === 'ok' ? '✓' : (resolved === 'partial' ? '⚠' : (resolved === 'cancelled' ? '!' : '✕'));
        }
        if (titleEl) {
            const map = { ok: 'dataset.resultOk', partial: 'dataset.resultPartial', failed: 'dataset.resultFailed', cancelled: 'dataset.resultCancelled' };
            const def = { ok: 'Done!', partial: 'Partial success', failed: 'Export failed', cancelled: 'Export cancelled' };
            titleEl.textContent = this._t(map[resolved], def[resolved]);
        }
        if (detailEl) {
            // escapeHtml is the shared helper defined at the top of this IIFE.
            let html = '';
            if (resolved === 'ok') {
                html = this._t('dataset.resultDetailOk',
                    '<strong>{count}</strong> image+caption pairs exported to <code>{folder}</code>',
                    { count: exported, folder: escapeHtml(folder) });
            } else if (resolved === 'partial') {
                html = this._t('dataset.resultDetailPartial',
                    '<strong>{exported}</strong> exported, <strong>{errors}</strong> failed, <strong>{skipped}</strong> skipped. Files are in <code>{folder}</code>',
                    { exported, errors, skipped, folder: escapeHtml(folder) });
            } else if (resolved === 'cancelled') {
                html = this._t('dataset.resultDetailCancelled',
                    'Export stopped. <strong>{exported}</strong> image+caption pairs were written before cancellation. Files are in <code>{folder}</code>',
                    { exported, folder: escapeHtml(folder) });
            } else {
                html = this._t('dataset.resultDetailFailed',
                    'No files were written. Check the error details below.');
            }
            // innerHTML sink: `html` is trusted markup. The only user-influenced
            // value (folder) is escapeHtml()-wrapped in every branch above and
            // counts are numeric. _t() does not escape params, so any future
            // param carrying user text must be escapeHtml()'d before this point.
            detailEl.innerHTML = html;
        }
        if (errorsBox && errorsList) {
            if (errorMessages.length === 0) {
                errorsBox.hidden = true;
                errorsList.innerHTML = '';
            } else {
                errorsBox.hidden = false;
                errorsList.innerHTML = errorMessages.map(m => `<li>${String(m).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</li>`).join('');
            }
        }
        if (openFolderBtn) {
            openFolderBtn.dataset.folder = folder;
            openFolderBtn.disabled = !folder;
        }
        modal.hidden = false;

        // Reload captions if export succeeded — DB tags may have updated via sidecars
        // (no-op for now; placeholder for future automatic refresh).
    };

    DM._hideResultModal = function () {
        const modal = document.getElementById('dataset-result-modal');
        if (modal) modal.hidden = true;
    };

    DM._openOutputFolder = async function () {
        const btn = document.getElementById('btn-dataset-open-folder');
        const folder = btn?.dataset?.folder || '';
        if (!folder) return;
        try {
            await fetch('/api/open-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: folder }),
            });
        } catch {
            this._toast(`Folder: ${folder}`, 'info', 6000);
        }
    };
})();
