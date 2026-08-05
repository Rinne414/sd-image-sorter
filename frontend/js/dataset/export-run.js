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
    const EXPORT_JOB_STORAGE_KEY = 'sd-image-sorter-dataset-export-job';
    const EXPORT_JOB_ACTIVE_STATUSES = new Set(['queued', 'running']);
    const EXPORT_JOB_TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);
    const DATASET_EXPORT_RESULT_STATUSES = new Set(['ok', 'partial', 'failed', 'cancelled']);
    const EXPORT_JOB_ID_MAX_LENGTH = 64;
    const READINESS_CONFLICT_CODES = new Set([
        'readiness_report_required',
        'readiness_report_not_found',
        'readiness_report_expired',
        'readiness_report_wrong_kind',
        'readiness_report_cancelled',
        'readiness_report_not_ready',
        'readiness_report_unavailable',
        'readiness_rule_mismatch',
        'readiness_request_mismatch',
        'readiness_fingerprint_mismatch',
        'readiness_input_mismatch',
        'readiness_blocked',
    ]);

    const invalidExportResponse = message => new Error(`Invalid dataset export API response: ${message}`);

    const requireRecord = (value, path) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw invalidExportResponse(`${path} must be an object`);
        }
        return value;
    };

    const requireString = (value, path) => {
        if (typeof value !== 'string') {
            throw invalidExportResponse(`${path} must be a string`);
        }
        return value;
    };

    const requireNullableString = (value, path) => {
        if (value !== null && typeof value !== 'string') {
            throw invalidExportResponse(`${path} must be a string or null`);
        }
        return value;
    };

    const requireNonNegativeSafeInteger = (value, path) => {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw invalidExportResponse(`${path} must be a non-negative safe integer`);
        }
        return value;
    };

    const requireBoolean = (value, path) => {
        if (typeof value !== 'boolean') {
            throw invalidExportResponse(`${path} must be a boolean`);
        }
        return value;
    };

    const requireStringArray = (value, path) => {
        if (!Array.isArray(value)) {
            throw invalidExportResponse(`${path} must be an array`);
        }
        return value.map((item, index) => requireString(item, `${path}[${index}]`));
    };

    const parseExportJobId = (value, path) => {
        const jobId = requireString(value, path);
        if (!jobId.trim() || jobId.length > EXPORT_JOB_ID_MAX_LENGTH) {
            throw invalidExportResponse(`${path} must be non-empty and at most ${EXPORT_JOB_ID_MAX_LENGTH} characters`);
        }
        return jobId;
    };

    const parseExportStartResponse = value => {
        const data = requireRecord(value, 'start response');
        if (data.status !== 'started') {
            throw invalidExportResponse("start response.status must be 'started'");
        }
        return {
            status: 'started',
            job_id: parseExportJobId(data.job_id, 'start response.job_id'),
            total: requireNonNegativeSafeInteger(data.total, 'start response.total'),
            output_folder: requireString(data.output_folder, 'start response.output_folder'),
            message: requireString(data.message, 'start response.message'),
        };
    };

    const parseReadinessConflict = value => {
        const detail = requireRecord(value, 'readiness conflict');
        const code = requireString(detail.code, 'readiness conflict.code');
        if (!READINESS_CONFLICT_CODES.has(code)) {
            throw invalidExportResponse(`readiness conflict.code is not supported: ${code}`);
        }
        if (!Array.isArray(detail.issues)) {
            throw invalidExportResponse('readiness conflict.issues must be an array');
        }
        return {
            code,
            message: requireString(detail.message, 'readiness conflict.message'),
            action: requireString(detail.action, 'readiness conflict.action'),
            reportId: requireNullableString(detail.report_id, 'readiness conflict.report_id'),
            expectedInputFingerprint: requireNullableString(
                detail.expected_input_fingerprint,
                'readiness conflict.expected_input_fingerprint',
            ),
            observedInputFingerprint: requireNullableString(
                detail.observed_input_fingerprint,
                'readiness conflict.observed_input_fingerprint',
            ),
            ruleVersion: requireString(detail.rule_version, 'readiness conflict.rule_version'),
        };
    };

    const readOptionalExportProgress = value => {
        const data = requireRecord(value, 'job result.progress');
        const progress = {};
        const integerFields = ['current', 'total', 'exported', 'skipped', 'errors'];
        const stringFields = ['step', 'message', 'output_folder', 'output_mode'];
        integerFields.forEach(field => {
            if (Object.hasOwn(data, field)) {
                progress[field] = requireNonNegativeSafeInteger(data[field], `job result.progress.${field}`);
            }
        });
        stringFields.forEach(field => {
            if (Object.hasOwn(data, field)) {
                progress[field] = requireString(data[field], `job result.progress.${field}`);
            }
        });
        if (Object.hasOwn(data, 'current_item')) {
            progress.current_item = requireNullableString(data.current_item, 'job result.progress.current_item');
        }
        if (Object.hasOwn(data, 'recent_errors')) {
            progress.recent_errors = requireStringArray(data.recent_errors, 'job result.progress.recent_errors');
        }
        if (Object.hasOwn(data, 'items_truncated')) {
            progress.items_truncated = requireBoolean(data.items_truncated, 'job result.progress.items_truncated');
        }
        return progress;
    };

    const parseExportResultItem = (value, index) => {
        const path = `job result.items[${index}]`;
        const data = requireRecord(value, path);
        return {
            image_id: requireNonNegativeSafeInteger(data.image_id, `${path}.image_id`),
            src_image_path: requireNullableString(data.src_image_path, `${path}.src_image_path`),
            dst_image_path: requireNullableString(data.dst_image_path, `${path}.dst_image_path`),
            dst_caption_path: requireNullableString(data.dst_caption_path, `${path}.dst_caption_path`),
            skipped_reason: requireNullableString(data.skipped_reason, `${path}.skipped_reason`),
            error: requireNullableString(data.error, `${path}.error`),
        };
    };

    const parseExportWarning = (value, index) => {
        const path = `job result.warnings[${index}]`;
        const data = requireRecord(value, path);
        if (data.code !== 'backup_cleanup_failed') {
            throw invalidExportResponse(`${path}.code is not supported`);
        }
        return {
            code: data.code,
            message: requireString(data.message, `${path}.message`),
            backup_path: requireString(data.backup_path, `${path}.backup_path`),
            error_type: requireString(data.error_type, `${path}.error_type`),
            error: requireString(data.error, `${path}.error`),
        };
    };

    const parseExportResult = value => {
        const data = requireRecord(value, 'job result');
        if (!DATASET_EXPORT_RESULT_STATUSES.has(data.status)) {
            throw invalidExportResponse('job result.status is not supported');
        }
        if (!Array.isArray(data.items)) {
            throw invalidExportResponse('job result.items must be an array');
        }
        if (!Array.isArray(data.warnings)) {
            throw invalidExportResponse('job result.warnings must be an array');
        }
        return {
            status: data.status,
            exported: requireNonNegativeSafeInteger(data.exported, 'job result.exported'),
            skipped: requireNonNegativeSafeInteger(data.skipped, 'job result.skipped'),
            error_count: requireNonNegativeSafeInteger(data.error_count, 'job result.error_count'),
            masks_written: requireNonNegativeSafeInteger(data.masks_written, 'job result.masks_written'),
            masks_missing: requireNonNegativeSafeInteger(data.masks_missing, 'job result.masks_missing'),
            trainer_config_path: requireNullableString(data.trainer_config_path, 'job result.trainer_config_path'),
            output_folder: requireString(data.output_folder, 'job result.output_folder'),
            output_mode: requireString(data.output_mode, 'job result.output_mode'),
            items: data.items.map(parseExportResultItem),
            total_items: requireNonNegativeSafeInteger(data.total_items, 'job result.total_items'),
            items_truncated: requireBoolean(data.items_truncated, 'job result.items_truncated'),
            error_messages: requireStringArray(data.error_messages, 'job result.error_messages'),
            warnings: data.warnings.map(parseExportWarning),
        };
    };

    const parseExportJobResponse = (value, expectedJobId) => {
        const data = requireRecord(value, 'job response');
        const id = parseExportJobId(data.id, 'job response.id');
        const jobId = parseExportJobId(data.job_id, 'job response.job_id');
        if (id !== expectedJobId || jobId !== expectedJobId) {
            throw invalidExportResponse('job_id must match the requested job');
        }
        if (data.kind !== 'dataset_export') {
            throw invalidExportResponse("job response.kind must be 'dataset_export'");
        }
        const statuses = new Set([...EXPORT_JOB_ACTIVE_STATUSES, ...EXPORT_JOB_TERMINAL_STATUSES]);
        if (!statuses.has(data.status)) {
            throw invalidExportResponse('job response.status is not supported');
        }
        const rawResult = requireRecord(data.result, 'job response.result');
        let result = {};
        if (EXPORT_JOB_ACTIVE_STATUSES.has(data.status)) {
            if (Object.hasOwn(rawResult, 'progress')) {
                result = { progress: readOptionalExportProgress(rawResult.progress) };
            }
        } else if (Object.keys(rawResult).length > 0) {
            result = parseExportResult(rawResult);
            if (data.status === 'cancelled' && result.status !== 'cancelled') {
                throw invalidExportResponse("cancelled job result.status must be 'cancelled'");
            }
            if (data.status === 'done' && result.status === 'cancelled') {
                throw invalidExportResponse("done job result.status must not be 'cancelled'");
            }
            if (data.status === 'error' && result.status !== 'failed') {
                throw invalidExportResponse("error job result.status must be 'failed'");
            }
        } else if (data.status === 'done' || data.status === 'cancelled') {
            throw invalidExportResponse(`${data.status} job response must include a complete result`);
        }
        return {
            id,
            job_id: jobId,
            kind: 'dataset_export',
            status: data.status,
            total: requireNonNegativeSafeInteger(data.total, 'job response.total'),
            processed: requireNonNegativeSafeInteger(data.processed, 'job response.processed'),
            error_count: requireNonNegativeSafeInteger(data.error_count, 'job response.error_count'),
            error_samples: requireStringArray(data.error_samples, 'job response.error_samples'),
            message: requireString(data.message, 'job response.message'),
            result,
        };
    };

    const exportResultChangesReadinessEvidence = result => (
        result?.status === 'ok'
        || result?.status === 'partial'
        || Number(result?.exported || 0) > 0
        || Number(result?.masks_written || 0) > 0
        || typeof result?.trainer_config_path === 'string'
        || result?.items_truncated === true
        || (Array.isArray(result?.items) && result.items.some(item => (
            typeof item?.dst_image_path === 'string' && item.dst_image_path.trim().length > 0
        )))
    );

    const invalidateReadinessAfterExport = (datasetMaker, progress, result) => {
        if (progress?.stale_job_id || exportResultChangesReadinessEvidence(result)) {
            datasetMaker._markReadinessStale?.();
        }
    };

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
        this._refreshReadinessStaleness?.();
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
            const trigger = this._canonicalDatasetTrigger(
                document.getElementById('dataset-trigger')?.value || '',
            ) || 'subject';
            namingLabel = this._t('dataset.namingRenumberLabel',
                'renumbered: {trigger}_001.png, {trigger}_002.png, ...',
                { trigger: escapeHtml(trigger) });
        } else {
            const pattern = document.getElementById('dataset-naming-pattern')?.value || '';
            namingLabel = this._t('dataset.namingCustomLabel',
                'custom pattern: {pattern}', { pattern: escapeHtml(pattern) });
        }

        const logicalCount = this._getLogicalDatasetCount?.() || this.imageIds.length;
        const editedCount = this.captionEdits.size;

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
        if (editedCount > 0) {
            items.push(this._t('dataset.confirmSummaryEdited',
                '<strong>{count}</strong> have your manually-edited captions',
                { count: editedCount }));
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

    DM._reportExportStorageError = function (operation, error) {
        const details = {
            operation,
            message: error instanceof Error ? error.message : String(error),
        };
        console.error('dataset_export_session_storage_failed', details);
        this._toast(
            this._t('dataset.exportJobStorageFailed',
                'Export progress could not be saved for refresh recovery: {message}',
                { message: details.message }),
            'error',
            6000,
        );
    };

    DM._storeExportJobId = function (jobId) {
        try {
            sessionStorage.setItem(
                EXPORT_JOB_STORAGE_KEY,
                parseExportJobId(jobId, 'stored job_id'),
            );
        } catch (error) {
            this._reportExportStorageError('write', error);
        }
    };

    DM._readStoredExportJobId = function () {
        try {
            const jobId = sessionStorage.getItem(EXPORT_JOB_STORAGE_KEY);
            return jobId === null ? null : parseExportJobId(jobId, 'stored job_id');
        } catch (error) {
            this._reportExportStorageError('read', error);
            return null;
        }
    };

    DM._clearStoredExportJobId = function () {
        try {
            sessionStorage.removeItem(EXPORT_JOB_STORAGE_KEY);
        } catch (error) {
            this._reportExportStorageError('clear', error);
        }
    };

    DM._normalizeExportProgress = function (job = {}) {
        const hasResult = job.result && typeof job.result === 'object' && Object.keys(job.result).length > 0;
        const rawResult = hasResult ? job.result : {};
        const activeProgress = rawResult.progress && typeof rawResult.progress === 'object'
            ? rawResult.progress
            : {};
        const terminalResult = hasResult && !rawResult.progress ? rawResult : null;
        return {
            ...job,
            current: Number(job.processed ?? activeProgress.current ?? 0),
            total: Number(job.total ?? activeProgress.total ?? 0),
            exported: Number(activeProgress.exported ?? terminalResult?.exported ?? 0),
            skipped: Number(activeProgress.skipped ?? terminalResult?.skipped ?? 0),
            errors: Number(job.error_count ?? activeProgress.errors ?? terminalResult?.error_count ?? 0),
            recent_errors: Array.isArray(job.error_samples) && job.error_samples.length > 0
                ? job.error_samples
                : (activeProgress.recent_errors || terminalResult?.error_messages || []),
            output_folder: activeProgress.output_folder || terminalResult?.output_folder || '',
            result: terminalResult,
        };
    };

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

        const view = this._normalizeExportProgress(progress);
        const current = view.current;
        const total = view.total;
        const exported = view.exported;
        const errors = view.errors;
        const skipped = view.skipped;
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;

        if (fill) {
            fill.classList.toggle('indeterminate', total <= 0);
            if (total > 0) fill.style.width = `${percent}%`;
            else fill.style.width = '';
        }

        if (text) {
            const msg = view.message || this._t('dataset.exportPreparing', 'Preparing export...');
            const counts = total > 0
                ? `${current}/${total} • ${exported} exported${errors ? ` • ${errors} failed` : ''}${skipped ? ` • ${skipped} skipped` : ''}`
                : `${exported} exported${errors ? ` • ${errors} failed` : ''}`;
            text.textContent = `${msg} ${counts}`;
        }

        if (cancelBtn) {
            const cancelling = this._exportCancelRequested === true;
            cancelBtn.hidden = !['starting', 'queued', 'running'].includes(view.status) && !cancelling;
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
                    stale_job_id: false,
                    error_samples: [this._t('dataset.exportJobTimeout',
                        'The export job did not finish within the polling timeout. Check the output folder, then re-run the export if files are missing.')],
                };
            }
            let progress;
            try {
                const r = await fetch(`/api/bulk-jobs/${encodeURIComponent(jobId)}`);
                if (r.status === 404) {
                    // No such job — e.g. the backend restarted mid-export.
                    // Allow a short grace window before declaring it lost.
                    lostJobCount += 1;
                    if (lostJobCount >= 3) {
                        return {
                            status: 'failed',
                            stale_job_id: true,
                            error_samples: [this._t('dataset.exportJobLost',
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
                progress = parseExportJobResponse(await r.json(), jobId);
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

            if (EXPORT_JOB_TERMINAL_STATUSES.has(progress.status)) {
                return progress;
            }
            lostJobCount = 0;
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
                if (r.status === 409) {
                    let conflictPayload = null;
                    try {
                        conflictPayload = await r.json();
                    } catch (_) {
                        conflictPayload = null;
                    }
                    const hasStructuredCode = conflictPayload
                        && typeof conflictPayload === 'object'
                        && !Array.isArray(conflictPayload)
                        && Object.hasOwn(conflictPayload, 'code');
                    if (hasStructuredCode) {
                        this._readinessAcceptedSignature = null;
                        try {
                            const conflict = parseReadinessConflict(conflictPayload);
                            const view = this._readinessView || {};
                            this._setReadinessView?.({
                                ...view,
                                state: 'stale',
                                message: `${conflict.message} ${conflict.action}`.trim(),
                                activeJobId: null,
                                report: null,
                            });
                        } catch (error) {
                            const view = this._readinessView || {};
                            this._setReadinessView?.({
                                ...view,
                                state: 'error',
                                message: error.message,
                                activeJobId: null,
                                report: null,
                            });
                        }
                        this._updateExportEnabled?.();
                        return;
                    }
                    const body = JSON.stringify(conflictPayload ?? {});
                    this._showResultModal('failed', { errorMessages: [body.slice(0, 400)], output_folder: folder });
                    return;
                }
                const body = await r.text();
                this._showResultModal('failed', { errorMessages: [body.slice(0, 400)], output_folder: folder });
                return;
            }
            const started = parseExportStartResponse(await r.json());
            this._activeExportJobId = started.job_id;
            this._storeExportJobId(this._activeExportJobId);
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
            const view = this._normalizeExportProgress(progress);
            if (EXPORT_JOB_TERMINAL_STATUSES.has(progress.status) || progress.stale_job_id) {
                this._clearStoredExportJobId();
            }
            const result = view.result || {
                status: progress.status === 'cancelled' ? 'cancelled' : 'failed',
                exported: view.exported,
                skipped: view.skipped,
                error_count: view.errors,
                output_folder: view.output_folder || folder,
                error_messages: view.recent_errors,
            };
            invalidateReadinessAfterExport(this, progress, result);
            this._showResultModal(result.status || (progress.status === 'cancelled' ? 'cancelled' : 'ok'), result);
        } catch (e) {
            this._showResultModal('failed', { errorMessages: [e.message], output_folder: folder });
        } finally {
            this._activeExportJobId = null;
            this._exportCancelRequested = false;
            this._setExportBusy(false);
            const progressEl = document.getElementById('dataset-export-progress');
            if (progressEl) progressEl.hidden = true;
        }
    };

    DM._cancelExportJob = async function () {
        const jobId = this._activeExportJobId || null;
        if (!jobId) {
            this._toast(this._t('dataset.exportJobLost',
                'The export job no longer exists on the backend (it may have restarted). Check the output folder, then re-run the export if files are missing.'), 'error', 5000);
            return;
        }
        this._exportCancelRequested = true;
        this._setExportBusy(true, { cancelling: true, keepProgressVisible: true });
        try {
            const response = await fetch(`/api/bulk-jobs/${encodeURIComponent(jobId)}/cancel`, {
                method: 'POST',
            });
            if (!response.ok) {
                const body = await response.text();
                throw new Error(body.slice(0, 300) || `Cancel failed: ${response.status}`);
            }
            this._renderExportProgress(parseExportJobResponse(await response.json(), jobId));
        } catch (e) {
            this._toast(`Cancel failed: ${e.message}`, 'error', 4000);
            this._exportCancelRequested = false;
            this._setExportBusy(true, { keepProgressVisible: true });
        }
    };

    DM._resumeExportProgress = async function () {
        if (this._exportResumeChecked) return;
        this._exportResumeChecked = true;
        const jobId = this._readStoredExportJobId();
        if (!jobId) return;
        this._activeExportJobId = jobId;
        this._setExportBusy(true, { keepProgressVisible: true });
        try {
            const finalProgress = await this._pollExportJob(jobId);
            const view = this._normalizeExportProgress(finalProgress);
            if (EXPORT_JOB_TERMINAL_STATUSES.has(finalProgress.status) || finalProgress.stale_job_id) {
                this._clearStoredExportJobId();
            }
            const result = view.result || {
                status: finalProgress.status === 'cancelled' ? 'cancelled' : 'failed',
                exported: view.exported,
                skipped: view.skipped,
                error_count: view.errors,
                output_folder: view.output_folder,
                error_messages: view.recent_errors,
            };
            invalidateReadinessAfterExport(this, finalProgress, result);
            this._showResultModal(result.status || 'failed', result);
        } catch (e) {
            this._toast(`Could not resume export progress: ${e.message}`, 'warning', 5000);
        } finally {
            this._activeExportJobId = null;
            this._exportCancelRequested = false;
            this._setExportBusy(false);
            const progressEl = document.getElementById('dataset-export-progress');
            if (progressEl) progressEl.hidden = true;
        }
    };

    DM._runExport = async function () {
        this._refreshReadinessStaleness?.();
        if (!this._isReadyToExport()) {
            this._hideConfirmModal();
            this._toast(this._exportDisabledReason(), 'warning');
            return;
        }
        this._hideConfirmModal();
        const report = this._readinessView?.report;
        if (!report || typeof report.report_id !== 'string' || typeof report.input_fingerprint !== 'string') {
            this._readinessAcceptedSignature = null;
            this._setReadinessView?.({
                ...(this._readinessView || {}),
                state: 'error',
                message: 'The accepted Readiness report is missing its export proof.',
                activeJobId: null,
                report: null,
            });
            this._updateExportEnabled?.();
            return;
        }
        const payload = {
            ...this._buildExportPayload(),
            readiness_report_id: report.report_id,
            readiness_input_fingerprint: report.input_fingerprint,
        };
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
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];
        const detailMessages = [
            ...warnings.map(warning => (
                `Warning: ${warning.message} Backup: ${warning.backup_path}`
            )),
            ...errorMessages,
        ];

        if (statusEl) {
            statusEl.className = `dataset-result-status ${resolved}`;
            statusEl.textContent = resolved === 'ok' && warnings.length > 0
                ? '!'
                : (resolved === 'ok' ? '✓' : (resolved === 'partial' ? '⚠' : (resolved === 'cancelled' ? '!' : '✕')));
        }
        if (titleEl) {
            const map = { ok: 'dataset.resultOk', partial: 'dataset.resultPartial', failed: 'dataset.resultFailed', cancelled: 'dataset.resultCancelled' };
            const def = { ok: 'Done!', partial: 'Partial success', failed: 'Export failed', cancelled: 'Export cancelled' };
            titleEl.textContent = resolved === 'ok' && warnings.length > 0
                ? this._t('dataset.resultOkWarnings', 'Done with warnings')
                : this._t(map[resolved], def[resolved]);
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
            if (detailMessages.length === 0) {
                errorsBox.hidden = true;
                errorsList.innerHTML = '';
            } else {
                errorsBox.hidden = false;
                errorsList.innerHTML = detailMessages.map(m => `<li>${String(m).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</li>`).join('');
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
