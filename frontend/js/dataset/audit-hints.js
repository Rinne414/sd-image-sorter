/**
 * Dataset Maker — the two hint checks of the Quality Audit that need more than
 * one request: possibly blurry / very flat pictures and captions over the token
 * limit.
 *
 * Blur and flat: POST /api/dataset/quality scores the pictures on the CPU as one
 * background bulk job (poll GET /api/bulk-jobs/{id}, then ask again) and
 * remembers the numbers per file. Long captions: every final caption is counted
 * (exactly for Anima once its two tokenizer files are downloaded, otherwise with
 * the labelled estimate).
 *
 * Both only list pictures: they join the audit report as extra badges that
 * filter the queue, and removing is the same "remove from dataset" step every
 * other badge offers (the files stay). Runs after the main audit, inside
 * runAudit (audit-run.js), and adds its findings to the same report.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    const QUALITY_API = '/api/dataset/quality';
    const JOBS_API = '/api/bulk-jobs';
    const POLL_MS = 700;
    // Polls that may fail in a row before the check says it failed.
    const MAX_POLL_ERRORS = 5;
    // Jobs started one after another for one check (another check's job may be running first).
    const MAX_ROUNDS = 20;
    // Must equal BLUR_REVIEW_BELOW in backend/services/image_quality_scores.py
    // (backend/tests/test_frontend_contract.py pins the two together).
    const DEFAULT_BLUR_BELOW = 60;
    const TERMINAL = new Set(['done', 'error', 'cancelled']);

    const running = { jobId: null, stopped: false };

    const $ = (id) => document.getElementById(id);
    const t = (key, fallback, params) => DM._t(key, fallback, params);
    const tokens = () => DM._captionTokens;

    function setStatus(text) {
        const el = $('dataset-audit-status');
        if (el) el.textContent = text || '';
    }

    function setProgress(done, total, active) {
        const bar = $('dataset-audit-hints-progress');
        const fill = $('dataset-audit-hints-progress-fill');
        const stop = $('btn-dataset-audit-quality-stop');
        if (bar) {
            bar.hidden = !active;
            bar.setAttribute('aria-valuemax', String(total));
            bar.setAttribute('aria-valuenow', String(done));
        }
        if (fill) fill.style.width = `${total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}%`;
        if (stop) stop.hidden = !active;
    }

    function withSummary(report, extra) {
        report.summary = { ...(report.summary || {}), ...extra };
    }

    async function readJson(response) {
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        return JSON.parse(body);
    }

    // ---- possibly blurry / very flat ---------------------------------------

    function blurBelowFromInput() {
        const raw = String($('dataset-audit-blur-below')?.value ?? '').trim();
        const value = Number(raw);
        return raw !== '' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_BLUR_BELOW;
    }

    async function askQuality(imageIds, imagePaths, blurBelow, start) {
        return readJson(await fetch(QUALITY_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_ids: imageIds, image_paths: imagePaths, start, blur_below: blurBelow }),
        }));
    }

    /** Polls one bulk job until it ends. Resolves with its last status. */
    async function waitForJob(jobId) {
        let errors = 0;
        for (;;) {
            let job = null;
            try {
                job = await readJson(await fetch(`${JOBS_API}/${encodeURIComponent(jobId)}`));
                errors = 0;
            } catch (error) {
                errors += 1;
                if (errors >= MAX_POLL_ERRORS) throw error;
            }
            if (job) {
                setProgress(job.processed || 0, job.total || 0, true);
                setStatus(t('dataset.auditQualityProgress', 'Scoring pictures… {done} of {total}',
                    { done: job.processed || 0, total: job.total || 0 }));
                if (job.status === 'error') throw new Error((job.error_samples || [])[0] || job.message || 'failed');
                if (TERMINAL.has(job.status)) return job.status;
            }
            await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
        }
    }

    /** Scores what is not scored yet (waiting for the job) and returns the final answer. */
    async function scoreAll(imageIds, imagePaths, blurBelow) {
        let answer = await askQuality(imageIds, imagePaths, blurBelow, true);
        for (let round = 0; answer.pending > 0 && answer.job_id && round < MAX_ROUNDS && !running.stopped; round += 1) {
            running.jobId = answer.job_id;
            const status = await waitForJob(answer.job_id);
            running.jobId = null;
            if (status === 'cancelled') running.stopped = true;
            // After a stop only read what is scored; do not start another job.
            answer = await askQuality(imageIds, imagePaths, blurBelow, !running.stopped);
        }
        return answer;
    }

    async function qualityPhase(imageIds, imagePaths, report, notes) {
        if (imageIds.length + imagePaths.length === 0) return;
        running.stopped = false;
        setProgress(0, 0, true);
        try {
            const answer = await scoreAll(imageIds, imagePaths, blurBelowFromInput());
            const items = Array.isArray(answer.items) ? answer.items : [];
            report.quality_items = items;
            const count = (flag) => items.filter((it) => (it.flags || []).includes(flag)).length;
            withSummary(report, { blurry_count: count('blurry'), flat_count: count('flat') });
            notes.push(running.stopped
                ? t('dataset.auditQualityStopped',
                    'Stopped: {done} of {total} pictures scored. Run again to continue; scored pictures are remembered.',
                    { done: answer.scored, total: answer.total })
                : t('dataset.auditQualityDone',
                    'Blur check: {scored} pictures scored, {blurry} possibly blurry, {flat} very flat.',
                    { scored: answer.scored, blurry: count('blurry'), flat: count('flat') }));
            const lost = (answer.unreadable || 0) + (answer.missing || 0);
            if (lost > 0) {
                notes.push(t('dataset.auditQualityLost', '{count} pictures could not be read or are gone.', { count: lost }));
            }
        } catch (error) {
            notes.push(t('dataset.auditQualityFailed', 'Blur check failed: {reason}',
                { reason: error instanceof Error ? error.message : String(error) }));
        } finally {
            running.jobId = null;
            setProgress(0, 0, false);
        }
    }

    async function stopScoring() {
        running.stopped = true;
        if (!running.jobId) return;
        try {
            await fetch(`${JOBS_API}/${encodeURIComponent(running.jobId)}/cancel`, { method: 'POST' });
        } catch (_) {
            /* the poll loop ends the check */
        }
    }

    // ---- captions over the token limit -------------------------------------

    function estimateTokens(text) {
        const estimate = window.SeparationConsole?.estimateTokens;
        return typeof estimate === 'function' ? estimate.call(window.SeparationConsole, text) : Math.ceil(text.length / 4);
    }

    /** Pictures whose caption is over the limit. Counts exactly when Anima's tokenizers are ready. */
    async function tokensPhase(report, notes) {
        const ids = (DM.imageIds || []).map(Number)
            .filter((id) => !(DM.isLocalId?.(id) && DM._localIdUsesManifest?.(id)));
        if (ids.length === 0) return;
        const tok = tokens();
        const limit = tok.budget();
        const texts = ids.map((id) => tok.finalCaption(id));
        let exact = null;
        let failure = '';
        if (tok.isAnima()) {
            await tok.refreshStatus();
            if (tok.ready()) {
                try {
                    exact = await tok.countExact(texts);
                } catch (error) {
                    failure = error instanceof Error ? error.message : String(error);
                }
            }
        }
        const items = [];
        ids.forEach((id, i) => {
            const counted = exact ? exact[i] : null;
            const used = counted ? Math.max(counted.qwen, counted.t5) : estimateTokens(texts[i]);
            if (used <= limit) return;
            items.push({
                image_id: id > 0 ? id : 0,
                abs_path: id < 0 ? String(DM.localItemPaths?.get?.(id) || '') : '',
                flags: ['too_long'],
                tokens: used,
                ...(counted ? { qwen: counted.qwen, t5: counted.t5 } : {}),
            });
        });
        report.token_items = items;
        withSummary(report, { too_long_count: items.length });
        notes.push(exact
            ? t('dataset.auditTokensExact',
                'Long captions: {count} of {total} captions are over {budget} tokens (exact counts with Qwen3-0.6B and T5 v1.1 XXL).',
                { count: items.length, total: ids.length, budget: limit })
            : t('dataset.auditTokensEstimate',
                'Long captions: {count} of {total} captions look over {budget} tokens (estimated: about one token per four letters, wrong for Chinese and long words).',
                { count: items.length, total: ids.length, budget: limit }));
        if (failure) {
            notes.push(t('dataset.auditTokensFailed', 'Exact counts failed: {reason}', { reason: failure }));
        }
    }

    // ---- the audit calls this ------------------------------------------------

    /**
     * Runs the ticked hint checks and adds what they find to `report`, redrawing the
     * badges after each one. Returns the sentences to put after the audit's own status.
     */
    async function runHints({ imageIds, imagePaths, report }) {
        const notes = [];
        const redraw = () => DM._renderAuditResults(report);
        if ($('dataset-audit-check-tokens')?.checked) {
            await tokensPhase(report, notes);
            redraw();
        }
        if ($('dataset-audit-check-blur')?.checked) {
            await qualityPhase(imageIds, imagePaths, report, notes);
            redraw();
        }
        return notes;
    }

    // ---- the modal's controls ------------------------------------------------

    /** The limit next to the checkbox and the download prompt for Anima's tokenizers. */
    function renderTokenPrompt() {
        const tok = tokens();
        if (!tok) return;
        const limit = $('dataset-audit-tokens-limit');
        if (limit) limit.textContent = t('dataset.auditTokensLimit', 'over {budget} tokens', { budget: tok.budget() });
        const wrap = $('dataset-audit-tokens-prepare');
        const note = $('dataset-audit-tokens-note');
        const button = $('btn-dataset-audit-tokens-prepare');
        if (!wrap || !note || !button) return;
        const status = tok.status;
        wrap.hidden = !(tok.isAnima() && status);
        if (wrap.hidden) return;
        if (status.available) {
            note.textContent = t('dataset.auditTokensReady',
                'Exact token counts are ready: every caption is counted with Qwen3-0.6B and T5 v1.1 XXL, the two tokenizers Anima reads it with.');
            button.hidden = true;
            return;
        }
        const mb = tok.sizeMb();
        const failure = status.error || tok.statusError;
        note.textContent = [
            t('dataset.auditTokensDownloadNote',
                'Token counts for Anima are only estimates until its two tokenizer files are here: about {mb} MB, downloaded once.', { mb }),
            status.tokenizers_package === false
                ? t('dataset.auditTokensPackage', 'The small tokenizers package is installed first.') : '',
            failure ? t('dataset.auditTokensFailed', 'Exact counts failed: {reason}', { reason: failure }) : '',
        ].filter(Boolean).join(' ');
        button.hidden = false;
        button.disabled = tok.preparing;
        button.textContent = tok.preparing
            ? t('dataset.auditTokensBusy', 'Downloading…')
            : failure ? t('common.retry', 'Retry')
                : t('dataset.auditTokensPrepare', 'Download for exact counts ({mb} MB)', { mb });
    }

    function init() {
        $('btn-dataset-audit-quality-stop')?.addEventListener('click', () => void stopScoring());
        $('btn-dataset-audit-tokens-prepare')?.addEventListener('click', () => void tokens().prepare());
        window.addEventListener('captiontokens:changed', renderTokenPrompt);
        document.addEventListener('languageChanged', renderTokenPrompt);
        // Opening the audit looks at the tokenizer files, so the prompt can say what is missing.
        const showModal = DM._showAuditModal;
        DM._showAuditModal = function () {
            showModal.call(this);
            renderTokenPrompt();
            if (tokens().isAnima()) void tokens().refreshStatus();
        };
        renderTokenPrompt();
    }

    DM._runAuditHints = runHints;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
