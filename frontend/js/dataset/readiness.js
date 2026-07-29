/**
 * Dataset Maker readiness: exact-payload preflight, shared bulk-job polling,
 * current-payload gating, and actionable issue rendering.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const STORAGE_KEY = 'sd-image-sorter-dataset-readiness-job';
    const JOB_KIND = 'dataset_readiness';
    const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
    const JOB_STATUSES = new Set(['queued', 'running', 'done', 'error', 'cancelled']);
    const REPORT_STATUSES = new Set(['ready', 'warnings', 'blocked']);
    const EXPORTABLE_STATES = new Set(['ready', 'warnings']);
    const POLL_DELAY_MS = 300;
    const POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
    const POLL_RETRY_DELAYS_MS = Object.freeze([150, 450]);

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function requireRecord(value, label) {
        if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
        return value;
    }

    function requireString(record, key, label) {
        const value = record[key];
        if (typeof value !== 'string') throw new TypeError(`${label}.${key} must be a string`);
        return value;
    }

    function requireNullableString(record, key, label) {
        const value = record[key];
        if (value !== null && typeof value !== 'string') {
            throw new TypeError(`${label}.${key} must be a string or null`);
        }
        return value;
    }

    function requireInteger(record, key, label) {
        const value = record[key];
        if (!Number.isInteger(value)) throw new TypeError(`${label}.${key} must be an integer`);
        return value;
    }

    function requireNonNegativeInteger(record, key, label) {
        const value = requireInteger(record, key, label);
        if (value < 0) throw new RangeError(`${label}.${key} must be non-negative`);
        return value;
    }

    function requireBoolean(record, key, label) {
        const value = record[key];
        if (typeof value !== 'boolean') throw new TypeError(`${label}.${key} must be a boolean`);
        return value;
    }

    function requireStringArray(record, key, label) {
        const value = record[key];
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new TypeError(`${label}.${key} must be an array of strings`);
        }
        return [...value];
    }

    function requireNullableNumber(record, key, label) {
        const value = record[key];
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
            throw new TypeError(`${label}.${key} must be a finite number or null`);
        }
        return value;
    }

    function parseIssue(value, index) {
        const label = `readiness report.issues[${index}]`;
        const record = requireRecord(value, label);
        const severity = requireString(record, 'severity', label);
        if (severity !== 'blocker' && severity !== 'warning') {
            throw new RangeError(`${label}.severity is not supported: ${severity}`);
        }
        const evidenceRecord = requireRecord(record.evidence, `${label}.evidence`);
        const imageId = record.image_id;
        if (imageId !== null && !Number.isInteger(imageId)) {
            throw new TypeError(`${label}.image_id must be an integer or null`);
        }
        return {
            severity,
            code: requireString(record, 'code', label),
            message: requireString(record, 'message', label),
            issue_id: requireString(record, 'issue_id', label),
            rule_version: requireString(record, 'rule_version', label),
            evidence: {
                observed: requireString(evidenceRecord, 'observed', `${label}.evidence`),
                expected: requireString(evidenceRecord, 'expected', `${label}.evidence`),
            },
            action: requireString(record, 'action', label),
            destination: requireNullableString(record, 'destination', label),
            image_id: imageId,
            source_path: requireNullableString(record, 'source_path', label),
        };
    }

    function parsePair(value, index) {
        const label = `readiness report.sample_pairs[${index}]`;
        const record = requireRecord(value, label);
        return {
            image_id: requireInteger(record, 'image_id', label),
            source_path: requireString(record, 'source_path', label),
            output_image_path: requireNullableString(record, 'output_image_path', label),
            output_caption_path: requireString(record, 'output_caption_path', label),
        };
    }

    function parseReport(value) {
        const label = 'readiness report';
        const record = requireRecord(value, label);
        const summaryRecord = requireRecord(record.summary, `${label}.summary`);
        const status = requireString(summaryRecord, 'status', `${label}.summary`);
        if (!REPORT_STATUSES.has(status)) {
            throw new RangeError(`${label}.summary.status is not supported: ${status}`);
        }
        if (!Array.isArray(record.issues)) throw new TypeError(`${label}.issues must be an array`);
        if (!Array.isArray(record.sample_pairs)) throw new TypeError(`${label}.sample_pairs must be an array`);
        const issues = record.issues.map((issue, index) => parseIssue(issue, index));
        const samplePairs = record.sample_pairs.map((pair, index) => parsePair(pair, index));
        const totalIssues = requireNonNegativeInteger(record, 'total_issues', label);
        if (totalIssues < issues.length) {
            throw new RangeError(`${label}.total_issues cannot be smaller than issues.length`);
        }
        const summary = {
            status,
            total_requested: requireNonNegativeInteger(summaryRecord, 'total_requested', `${label}.summary`),
            processed: requireNonNegativeInteger(summaryRecord, 'processed', `${label}.summary`),
            trainable_pairs: requireNonNegativeInteger(summaryRecord, 'trainable_pairs', `${label}.summary`),
            blocker_count: requireNonNegativeInteger(summaryRecord, 'blocker_count', `${label}.summary`),
            warning_count: requireNonNegativeInteger(summaryRecord, 'warning_count', `${label}.summary`),
        };
        if (summary.status === 'ready' && (summary.blocker_count > 0 || summary.warning_count > 0)) {
            throw new RangeError(`${label}.summary ready status cannot include blockers or warnings`);
        }
        if (summary.status === 'warnings' && (summary.blocker_count > 0 || summary.warning_count === 0)) {
            throw new RangeError(`${label}.summary warnings status requires warnings and no blockers`);
        }
        if (summary.status === 'blocked' && summary.blocker_count === 0) {
            throw new RangeError(`${label}.summary blocked status requires at least one blocker`);
        }
        return {
            report_id: requireString(record, 'report_id', label),
            input_fingerprint: requireString(record, 'input_fingerprint', label),
            rule_version: requireString(record, 'rule_version', label),
            summary,
            issues,
            total_issues: totalIssues,
            issues_truncated: requireBoolean(record, 'issues_truncated', label),
            sample_pairs: samplePairs,
            sample_pairs_truncated: requireBoolean(record, 'sample_pairs_truncated', label),
        };
    }

    function parseStartResponse(value) {
        const label = 'readiness start response';
        const record = requireRecord(value, label);
        const id = requireString(record, 'id', label);
        const jobId = requireString(record, 'job_id', label);
        const kind = requireString(record, 'kind', label);
        const status = requireString(record, 'status', label);
        if (!id || id !== jobId) throw new RangeError(`${label} id and job_id must match`);
        if (kind !== JOB_KIND) throw new RangeError(`${label}.kind must be ${JOB_KIND}`);
        if (status !== 'queued') throw new RangeError(`${label}.status must be queued`);
        return {
            id,
            job_id: jobId,
            kind,
            status,
            total: requireNonNegativeInteger(record, 'total', label),
            processed: requireNonNegativeInteger(record, 'processed', label),
            message: requireString(record, 'message', label),
        };
    }

    function parseJobResponse(value, expectedJobId) {
        const label = 'readiness job response';
        const record = requireRecord(value, label);
        const id = requireString(record, 'id', label);
        const jobId = requireString(record, 'job_id', label);
        const kind = requireString(record, 'kind', label);
        const status = requireString(record, 'status', label);
        if (id !== expectedJobId || jobId !== expectedJobId) {
            throw new RangeError(`${label} id does not match requested job ${expectedJobId}`);
        }
        if (kind !== JOB_KIND) throw new RangeError(`${label}.kind must be ${JOB_KIND}`);
        if (!JOB_STATUSES.has(status)) throw new RangeError(`${label}.status is not supported: ${status}`);
        const total = requireNonNegativeInteger(record, 'total', label);
        const processed = requireNonNegativeInteger(record, 'processed', label);
        if (processed > total) throw new RangeError(`${label}.processed cannot exceed total`);
        const resultRecord = requireRecord(record.result, `${label}.result`);
        const result = status === 'done' ? parseReport(resultRecord) : {};
        if (status === 'done') {
            if (result.report_id !== expectedJobId) {
                throw new RangeError(`${label}.result.report_id does not match requested job ${expectedJobId}`);
            }
            if (result.summary.processed !== result.summary.total_requested) {
                throw new RangeError(`${label}.result must inspect every requested item`);
            }
            if (result.summary.trainable_pairs > result.summary.processed) {
                throw new RangeError(`${label}.result trainable pairs cannot exceed processed items`);
            }
            if (result.summary.processed !== processed || result.summary.total_requested !== total) {
                throw new RangeError(`${label}.result counts must match the bulk job counts`);
            }
            if (EXPORTABLE_STATES.has(result.summary.status)
                    && (result.summary.total_requested === 0 || result.summary.trainable_pairs === 0)) {
                throw new RangeError(`${label}.result exportable status requires at least one trainable pair`);
            }
        }
        return {
            id,
            job_id: jobId,
            kind,
            status,
            total,
            processed,
            error_count: requireNonNegativeInteger(record, 'error_count', label),
            error_samples: requireStringArray(record, 'error_samples', label),
            message: requireString(record, 'message', label),
            result,
            created_at: requireNullableNumber(record, 'created_at', label),
            started_at: requireNullableNumber(record, 'started_at', label),
            finished_at: requireNullableNumber(record, 'finished_at', label),
        };
    }

    function stableSerialize(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') {
            return JSON.stringify(value);
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new TypeError('Readiness payload numbers must be finite');
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
        }
        if (isRecord(value)) {
            return `{${Object.keys(value).sort().map((key) => (
                `${JSON.stringify(key)}:${stableSerialize(value[key])}`
            )).join(',')}}`;
        }
        throw new TypeError(`Readiness payload contains an unsupported value: ${typeof value}`);
    }

    async function readJsonResponse(response, operation) {
        const responseBody = await response.text();
        if (!response.ok) {
            const error = new Error(`${operation} failed: status=${response.status}, body=${responseBody.slice(0, 800)}`);
            error.status = response.status;
            throw error;
        }
        try {
            return JSON.parse(responseBody);
        } catch (error) {
            throw new SyntaxError(`${operation} returned malformed JSON: ${error.message}; body=${responseBody.slice(0, 800)}`);
        }
    }

    function wait(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    async function fetchPollJson(jobId) {
        const url = `/api/bulk-jobs/${encodeURIComponent(jobId)}`;
        let lastError = null;
        for (let attempt = 0; attempt <= POLL_RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                const response = await fetch(url);
                if (response.status === 404) return { missing: true, value: null };
                return {
                    missing: false,
                    value: await readJsonResponse(response, 'Readiness job status'),
                };
            } catch (error) {
                lastError = error;
                if (attempt === POLL_RETRY_DELAYS_MS.length) break;
                window.Logger?.warn?.('dataset_readiness_poll_retry', {
                    job_id: jobId,
                    attempt: attempt + 1,
                    error: error.message,
                });
                await wait(POLL_RETRY_DELAYS_MS[attempt]);
            }
        }
        throw lastError;
    }

    function findIssueImageId(issue, imageIds, localItemPaths) {
        const reportedId = Number(issue.image_id);
        if (Number.isInteger(reportedId) && imageIds.includes(reportedId)) return reportedId;
        if (!issue.source_path || !(localItemPaths instanceof Map)) return null;
        for (const [imageId, sourcePath] of localItemPaths.entries()) {
            const numericId = Number(imageId);
            if (sourcePath === issue.source_path && imageIds.includes(numericId)) return numericId;
        }
        return null;
    }

    function initialView() {
        return {
            state: 'idle',
            message: '',
            activeJobId: null,
            processed: 0,
            total: 0,
            report: null,
        };
    }

    function stateTranslation(state) {
        const translations = {
            idle: ['dataset.readinessIdle', 'Idle'],
            checking: ['dataset.readinessChecking', 'Checking'],
            ready: ['dataset.readinessReady', 'Ready'],
            warnings: ['dataset.readinessWarnings', 'Warnings'],
            blocked: ['dataset.readinessBlocked', 'Blocked'],
            stale: ['dataset.readinessStale', 'Stale'],
            error: ['dataset.readinessError', 'Error'],
            cancelled: ['dataset.readinessCancelled', 'Cancelled'],
            lost: ['dataset.readinessLost', 'Lost job'],
        };
        return translations[state] || translations.error;
    }

    DM._readinessPayloadSnapshot = function () {
        if (typeof this._buildExportPayload !== 'function') {
            throw new TypeError('Dataset readiness requires DatasetMaker._buildExportPayload');
        }
        const payload = this._buildExportPayload();
        return { payload, signature: stableSerialize(payload) };
    };

    DM._setReadinessView = function (nextView) {
        this._readinessView = Object.freeze({ ...nextView });
        this._renderReadiness();
    };

    DM._renderReadiness = function () {
        const view = this._readinessView || initialView();
        const stateElement = document.getElementById('dataset-readiness-state');
        const messageElement = document.getElementById('dataset-readiness-message');
        const progressElement = document.getElementById('dataset-readiness-progress');
        const progressFill = document.getElementById('dataset-readiness-progress-fill');
        const countsElement = document.getElementById('dataset-readiness-counts');
        const issuesElement = document.getElementById('dataset-readiness-issues');
        const checkButton = document.getElementById('btn-dataset-readiness-check');
        const cancelButton = document.getElementById('btn-dataset-readiness-cancel');
        const [stateKey, stateFallback] = stateTranslation(view.state);

        if (stateElement) {
            stateElement.dataset.state = view.state;
            stateElement.className = `dataset-readiness-state state-${view.state}`;
            stateElement.textContent = this._t(stateKey, stateFallback);
        }
        if (messageElement) {
            const idleMessage = this._t('dataset.readinessIdleDetail', 'Run the complete check for the current export settings.');
            const staleMessage = this._t('dataset.readinessStaleDetail', 'Export settings changed. Check again before exporting.');
            messageElement.textContent = view.message || (view.state === 'idle' ? idleMessage : (view.state === 'stale' ? staleMessage : ''));
        }

        const active = typeof view.activeJobId === 'string' && view.activeJobId.length > 0;
        const resumable = active && view.state === 'error';
        const polling = view.state === 'checking' || (active && view.state === 'stale');
        const total = Number(view.total || 0);
        const processed = Number(view.processed || 0);
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((processed / total) * 100))) : 0;
        if (progressElement) {
            progressElement.hidden = !polling;
            progressElement.setAttribute('aria-valuemax', String(total));
            progressElement.setAttribute('aria-valuenow', String(processed));
        }
        if (progressFill) progressFill.style.width = `${percent}%`;
        if (checkButton) {
            const baseReason = this._baseExportDisabledReason?.() || '';
            const checkKey = resumable ? 'dataset.readinessResume' : 'dataset.readinessCheck';
            const checkFallback = resumable ? 'Resume' : 'Check';
            checkButton.dataset.i18n = checkKey;
            checkButton.textContent = this._t(checkKey, checkFallback);
            checkButton.disabled = polling || (active && !resumable) || !!baseReason;
            checkButton.title = baseReason;
        }
        if (cancelButton) cancelButton.hidden = !active;

        const report = view.report;
        if (countsElement) {
            if (report) {
                const summary = report.summary;
                countsElement.hidden = false;
                countsElement.textContent = this._t('dataset.readinessCounts',
                    '{processed}/{total} checked · {pairs} pairs · {blockers} blockers · {warnings} warnings', {
                        processed: summary.processed,
                        total: summary.total_requested,
                        pairs: summary.trainable_pairs,
                        blockers: summary.blocker_count,
                        warnings: summary.warning_count,
                    });
            } else if (active) {
                countsElement.hidden = false;
                countsElement.textContent = `${processed}/${total}`;
            } else {
                countsElement.hidden = true;
                countsElement.textContent = '';
            }
        }

        if (!issuesElement) return;
        issuesElement.replaceChildren();
        if (!report) return;
        for (const issue of report.issues) {
            const linkedImageId = findIssueImageId(issue, this.imageIds, this.localItemPaths);
            const linked = linkedImageId !== null;
            const item = document.createElement(linked ? 'button' : 'div');
            item.className = `dataset-readiness-issue severity-${issue.severity}`;
            item.dataset.testid = 'dataset-readiness-issue';
            item.dataset.imageId = linked ? String(linkedImageId) : '';
            item.setAttribute('role', 'listitem');
            if (linked) {
                item.type = 'button';
                item.dataset.readinessImageId = String(linkedImageId);
            }
            const message = document.createElement('strong');
            message.textContent = issue.message;
            const action = document.createElement('span');
            action.textContent = issue.action;
            item.append(message, action);
            if (issue.source_path) {
                const source = document.createElement('span');
                source.textContent = this._t('dataset.readinessIssueSource', 'Source: {path}', { path: issue.source_path });
                item.appendChild(source);
            }
            if (issue.destination) {
                const destination = document.createElement('span');
                destination.textContent = this._t('dataset.readinessIssueDestination', 'Output: {path}', { path: issue.destination });
                item.appendChild(destination);
            }
            issuesElement.appendChild(item);
        }
    };

    DM._readinessExportDisabledReason = function () {
        this._refreshReadinessStaleness();
        const state = this._readinessView?.state || 'idle';
        if (EXPORTABLE_STATES.has(state)) return '';
        const reasons = {
            idle: ['dataset.readinessExportIdle', 'Run Readiness Check before exporting.'],
            checking: ['dataset.readinessExportChecking', 'Wait for the Readiness Check to finish.'],
            blocked: ['dataset.readinessExportBlocked', 'Resolve the readiness blockers before exporting.'],
            stale: ['dataset.readinessExportStale', 'Export settings changed. Check readiness again.'],
            error: ['dataset.readinessExportError', 'Readiness Check failed. Fix the error and run it again.'],
            cancelled: ['dataset.readinessExportCancelled', 'Readiness Check was cancelled. Run it again before exporting.'],
            lost: ['dataset.readinessExportLost', 'The readiness job was lost. Run the check again.'],
        };
        const [key, fallback] = reasons[state] || reasons.error;
        return this._t(key, fallback);
    };

    DM._refreshReadinessStaleness = function () {
        const view = this._readinessView;
        if (!view?.report || !this._readinessAcceptedSignature) return false;
        let currentSignature;
        try {
            currentSignature = this._readinessPayloadSnapshot().signature;
        } catch (error) {
            this._setReadinessView({ ...view, state: 'error', message: error.message, report: null });
            return true;
        }
        if (currentSignature === this._readinessAcceptedSignature) return false;
        this._readinessAcceptedSignature = null;
        this._setReadinessView({ ...view, state: 'stale', message: '', report: null });
        return true;
    };

    DM._markReadinessStale = function () {
        const view = this._readinessView;
        if (!view || (!view.report && !view.activeJobId)) return;
        this._readinessAcceptedSignature = null;
        if (view.state === 'error' && view.activeJobId) {
            this._updateExportEnabled?.();
            return;
        }
        this._setReadinessView({ ...view, state: 'stale', message: '', report: null });
        this._updateExportEnabled?.();
    };

    DM._storeReadinessJob = function (jobId, signature) {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId, signature }));
        } catch (error) {
            window.Logger?.warn?.('dataset_readiness_session_store_failed', { message: error.message });
        }
    };

    DM._clearStoredReadinessJob = function () {
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch (error) {
            window.Logger?.warn?.('dataset_readiness_session_clear_failed', { message: error.message });
        }
    };

    DM._readStoredReadinessJob = function () {
        const stored = sessionStorage.getItem(STORAGE_KEY);
        if (!stored) return null;
        let value;
        try {
            value = JSON.parse(stored);
        } catch (error) {
            throw new SyntaxError(`Stored readiness job is malformed JSON: ${error.message}`);
        }
        const record = requireRecord(value, 'stored readiness job');
        const jobId = requireString(record, 'jobId', 'stored readiness job');
        const signature = requireString(record, 'signature', 'stored readiness job');
        if (!jobId || !signature) throw new RangeError('Stored readiness job fields must be non-empty');
        return { jobId, signature };
    };

    DM._settleReadinessJob = function (job, signature) {
        this._invalidateReadinessPoll();
        this._clearStoredReadinessJob();
        this._readinessSubmittedSignature = null;
        if (job.status === 'cancelled') {
            this._setReadinessView({
                state: 'cancelled', message: job.message, activeJobId: null,
                processed: job.processed, total: job.total, report: null,
            });
            this._updateExportEnabled?.();
            return;
        }
        if (job.status === 'error') {
            const detail = job.error_samples[0] || job.message;
            this._setReadinessView({
                state: 'error', message: detail, activeJobId: null,
                processed: job.processed, total: job.total, report: null,
            });
            this._updateExportEnabled?.();
            return;
        }
        const currentSignature = this._readinessPayloadSnapshot().signature;
        if (currentSignature !== signature) {
            this._readinessAcceptedSignature = null;
            this._setReadinessView({
                state: 'stale', message: '', activeJobId: null,
                processed: job.processed, total: job.total, report: null,
            });
            this._updateExportEnabled?.();
            return;
        }
        this._readinessAcceptedSignature = signature;
        this._setReadinessView({
            state: job.result.summary.status,
            message: job.message,
            activeJobId: null,
            processed: job.processed,
            total: job.total,
            report: job.result,
        });
        this._updateExportEnabled?.();
    };

    DM._invalidateReadinessPoll = function () {
        const current = Number.isSafeInteger(this._readinessPollGeneration)
            ? this._readinessPollGeneration
            : 0;
        this._readinessPollGeneration = current + 1;
        return this._readinessPollGeneration;
    };

    DM._beginReadinessPoll = function (jobId, signature) {
        const generation = this._invalidateReadinessPoll();
        return this._pollReadinessJob(jobId, signature, generation);
    };

    DM._pollReadinessJob = async function (jobId, signature, generation) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
            if (generation !== this._readinessPollGeneration) return;
            let pollResult;
            try {
                pollResult = await fetchPollJson(jobId);
            } catch (error) {
                if (generation !== this._readinessPollGeneration) return;
                const currentView = this._readinessView || initialView();
                this._setReadinessView({
                    ...currentView,
                    state: 'error',
                    message: error.message,
                    activeJobId: jobId,
                    report: null,
                });
                this._updateExportEnabled?.();
                return;
            }
            if (generation !== this._readinessPollGeneration) return;
            if (pollResult.missing) {
                this._clearStoredReadinessJob();
                this._readinessSubmittedSignature = null;
                this._setReadinessView({
                    state: 'lost',
                    message: this._t('dataset.readinessLostDetail', 'The backend no longer has this readiness job. Run the check again.'),
                    activeJobId: null, processed: 0, total: 0, report: null,
                });
                this._updateExportEnabled?.();
                return;
            }
            const job = parseJobResponse(pollResult.value, jobId);
            if (!ACTIVE_JOB_STATUSES.has(job.status)) {
                this._settleReadinessJob(job, signature);
                return;
            }
            const currentView = this._readinessView || initialView();
            this._setReadinessView({
                ...currentView,
                state: currentView.state === 'stale' ? 'stale' : 'checking',
                message: job.message,
                activeJobId: jobId,
                processed: job.processed,
                total: job.total,
                report: null,
            });
            await wait(POLL_DELAY_MS);
        }
        throw new Error(`Readiness job ${jobId} exceeded the ${POLL_TIMEOUT_MS} ms polling limit`);
    };

    DM._startReadinessCheck = async function () {
        if (this._readinessView?.state === 'checking' || this._readinessView?.activeJobId) return;
        const baseReason = this._baseExportDisabledReason?.() || '';
        if (baseReason) {
            this._toast(baseReason, 'warning');
            return;
        }
        let snapshot;
        try {
            snapshot = this._readinessPayloadSnapshot();
            this._readinessAcceptedSignature = null;
            this._readinessSubmittedSignature = snapshot.signature;
            this._setReadinessView({
                state: 'checking',
                message: this._t('dataset.readinessStarting', 'Starting readiness check...'),
                activeJobId: null, processed: 0, total: 0, report: null,
            });
            this._updateExportEnabled?.();
            const response = await fetch('/api/dataset/readiness/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(snapshot.payload),
            });
            const started = parseStartResponse(await readJsonResponse(response, 'Readiness check start'));
            this._storeReadinessJob(started.job_id, snapshot.signature);
            this._setReadinessView({
                state: 'checking', message: started.message, activeJobId: started.job_id,
                processed: started.processed, total: started.total, report: null,
            });
            await this._beginReadinessPoll(started.job_id, snapshot.signature);
        } catch (error) {
            this._clearStoredReadinessJob();
            this._readinessSubmittedSignature = null;
            this._setReadinessView({
                state: 'error', message: error.message, activeJobId: null,
                processed: 0, total: 0, report: null,
            });
            this._updateExportEnabled?.();
        }
    };

    DM._resumeReadinessCheck = async function () {
        const view = this._readinessView || initialView();
        const jobId = view.activeJobId;
        if (view.state !== 'error' || typeof jobId !== 'string' || !jobId) {
            throw new RangeError('Dataset readiness can only resume an active job in the error state');
        }
        try {
            let signature = this._readinessSubmittedSignature;
            if (!signature) {
                const stored = this._readStoredReadinessJob();
                if (!stored || stored.jobId !== jobId) {
                    throw new RangeError(`Stored readiness job does not match active job ${jobId}`);
                }
                signature = stored.signature;
                this._readinessSubmittedSignature = signature;
            }
            this._setReadinessView({
                ...view,
                state: 'checking',
                message: this._t('dataset.readinessResuming', 'Resuming readiness check...'),
                report: null,
            });
            await this._beginReadinessPoll(jobId, signature);
        } catch (error) {
            this._invalidateReadinessPoll();
            this._clearStoredReadinessJob();
            this._readinessSubmittedSignature = null;
            this._setReadinessView({
                ...view,
                state: 'error',
                message: error.message,
                activeJobId: null,
                report: null,
            });
            this._updateExportEnabled?.();
        }
    };

    DM._cancelReadinessCheck = async function () {
        const view = this._readinessView || initialView();
        const jobId = view.activeJobId;
        if (!jobId) return;
        this._invalidateReadinessPoll();
        try {
            const response = await fetch(`/api/bulk-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
            const job = parseJobResponse(await readJsonResponse(response, 'Readiness job cancel'), jobId);
            if (!ACTIVE_JOB_STATUSES.has(job.status)) {
                this._settleReadinessJob(job, this._readinessSubmittedSignature || '');
                return;
            }
            this._setReadinessView({
                ...view,
                state: 'error',
                message: job.message,
                processed: job.processed,
                total: job.total,
            });
            await this._resumeReadinessCheck();
        } catch (error) {
            this._setReadinessView({
                ...view,
                state: 'error',
                message: error.message,
                activeJobId: jobId,
                report: null,
            });
            this._updateExportEnabled?.();
        }
    };

    DM._openReadinessIssue = function (imageId) {
        const id = Number(imageId);
        if (!Number.isInteger(id) || !this.imageIds.includes(id)) {
            throw new RangeError(`Readiness issue image is not in the current Dataset Maker queue: ${imageId}`);
        }
        this._setPipelineTab('workbench');
        this._setActive(id);
    };

    DM._resumeStoredReadinessJob = async function (stored) {
        const contractLoad = this._trainerContractLoadPromise;
        if (!contractLoad || typeof contractLoad.then !== 'function') {
            throw new TypeError('Dataset readiness resume requires trainer contract initialization');
        }
        await contractLoad;
        if (this._trainerContractState?.status !== 'ready') {
            const message = this._trainerContractDisabledReason?.() ||
                'Trainer contracts are unavailable; retry loading them before resuming Readiness.';
            this._setReadinessView({
                state: 'error', message, activeJobId: stored.jobId,
                processed: 0, total: 0, report: null,
            });
            this._updateExportEnabled?.();
            return;
        }
        await this._beginReadinessPoll(stored.jobId, stored.signature);
    };

    DM._initReadiness = function () {
        this._readinessPollGeneration = 0;
        this._readinessView = initialView();
        this._readinessAcceptedSignature = null;
        this._renderReadiness();
        let stored;
        try {
            stored = this._readStoredReadinessJob();
        } catch (error) {
            this._clearStoredReadinessJob();
            this._readinessSubmittedSignature = null;
            this._setReadinessView({
                state: 'error', message: error.message, activeJobId: null,
                processed: 0, total: 0, report: null,
            });
            return;
        }
        if (!stored) return;
        this._readinessSubmittedSignature = stored.signature;
        this._setReadinessView({
            state: 'checking',
            message: this._t('dataset.readinessResuming', 'Resuming readiness check...'),
            activeJobId: stored.jobId, processed: 0, total: 0, report: null,
        });
        this._resumeStoredReadinessJob(stored).catch((error) => {
            this._invalidateReadinessPoll();
            this._setReadinessView({
                state: 'error', message: error.message, activeJobId: stored.jobId,
                processed: 0, total: 0, report: null,
            });
            this._updateExportEnabled?.();
        });
    };
})();
