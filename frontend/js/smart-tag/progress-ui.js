/**
 * smart-tag/progress-ui.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines
 * 175-199 + 730-896: setProgressUI/showProgress (bar + run/cancel button
 * state), stopProgressPolling, resumeActiveSmartTagJob (reload-resume on
 * modal open), startProgressPolling, pollProgressOnce (v3.4.1 AI-queue
 * rendering + 3-strike transient-failure retry) and renderSnapshot
 * (two-phase percent math). Classic script: cross-file callees
 * (smartTagT, getJson, onJobFinished) resolve at event time after the
 * whole family has executed; family renames applied.
 */
'use strict';
    function setProgressUI({ percent, text, preview }) {
        const fill = smartTag$('#smart-tag-progress-fill');
        const txt = smartTag$('#smart-tag-progress-text');
        const prev = smartTag$('#smart-tag-progress-preview');
        if (fill && Number.isFinite(percent)) {
            fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        }
        if (txt && typeof text === 'string') txt.textContent = text;
        if (prev && typeof preview === 'string') prev.textContent = preview;
    }

    function showProgress(show) {
        const wrap = smartTag$('#smart-tag-progress');
        if (wrap) wrap.hidden = !show;
        const runBtn = smartTag$('#btn-smart-tag-run');
        const cancelBtn = smartTag$('#btn-smart-tag-cancel-job');
        if (runBtn) runBtn.disabled = show;
        if (cancelBtn) {
            cancelBtn.hidden = !show;
            // Reset the disabled state so a fresh job can be cancelled
            // even if a previous cancel left the button disabled.
            if (show) cancelBtn.disabled = false;
        }
    }

    function stopProgressPolling() {
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
    }

    /**
     * Probe the backend once for an in-flight Smart Tag job and, if one is
     * active, rebuild the progress UI (bar + cancel button) and resume the
     * poll loop. Used on modal open so a page reload doesn't strand a
     * running job with no visible progress and no way to cancel it.
     */
    async function resumeActiveSmartTagJob() {
        if (progressTimer) return; // already attached to a live poll loop
        try {
            const snap = await getJson('/api/smart-tag/progress');
            const queuedEntries = snap?.pipeline_queue?.queued || [];
            const isLive = snap?.active === true
                || snap?.status === 'queued'
                || snap?.status === 'running';
            // v3.4.1 AI job queue: also resume when our start is still
            // waiting in the unified pipeline queue (e.g. after an F5).
            if (!isLive && queuedEntries.length === 0) return;
            activeJobId = snap.job_id || activeJobId;
            showProgress(true);
            if (!isLive && queuedEntries.length > 0) {
                pipelineQueuedSince = Date.now();
                setProgressUI({
                    percent: 0,
                    text: smartTagT('aiQueue.queuedProgress', 'Queued #{position} — waiting for the current AI job to finish')
                        .replace('{position}', String(queuedEntries[0].position || 1)),
                    preview: '',
                });
            } else {
                renderSnapshot(snap);
            }
            startProgressPolling();
        } catch (_err) {
            // idle / 404 / unreachable backend — nothing to resume.
        }
    }

    function startProgressPolling() {
        stopProgressPolling();
        pollFailureCount = 0;
        progressTimer = setInterval(pollProgressOnce, 1000);
    }

    async function pollProgressOnce() {
        try {
            const url = activeJobId
                ? `/api/smart-tag/progress?job_id=${encodeURIComponent(activeJobId)}`
                : '/api/smart-tag/progress';
            const snap = await getJson(url);
            pollFailureCount = 0;
            const isLive = snap.active === true || snap.status === 'queued' || snap.status === 'running';
            const queuedEntries = snap?.pipeline_queue?.queued || [];
            // v3.4.1 AI job queue: no live Smart Tag job yet, but ours is
            // still waiting in the unified pipeline queue — render the
            // queued state and keep polling.
            if (!isLive && queuedEntries.length > 0) {
                setProgressUI({
                    percent: 0,
                    text: smartTagT('aiQueue.queuedProgress', 'Queued #{position} — waiting for the current AI job to finish')
                        .replace('{position}', String(queuedEntries[0].position || 1)),
                    preview: '',
                });
                return;
            }
            if (isLive) pipelineQueuedSince = 0;
            renderSnapshot(snap);
            if (!snap.active && snap.status !== 'queued' && snap.status !== 'running') {
                // Queued entry left the queue without going live: surface a
                // failed queued start (recorded per kind by the backend).
                const startError = snap?.pipeline_queue?.last_start_error;
                const startErrorAt = startError ? Date.parse(startError.at || '') : NaN;
                if (pipelineQueuedSince && startError && Number.isFinite(startErrorAt)
                    && startErrorAt >= (pipelineQueuedSince - 2000)) {
                    pipelineQueuedSince = 0;
                    stopProgressPolling();
                    showProgress(false);
                    if (typeof window.showToast === 'function') {
                        window.showToast(
                            smartTagT('aiQueue.startFailed', 'Queued job failed to start: {error}')
                                .replace('{error}', String(startError.error || '')),
                            'error'
                        );
                    }
                    return;
                }
                pipelineQueuedSince = 0;
                stopProgressPolling();
                await onJobFinished(snap);
            }
        } catch (err) {
            // A transient fetch failure (server busy, network blip) must not
            // kill the poll loop — the backend job keeps running either way.
            // Mirror the scan poller: retry, and only stop + surface an error
            // after 3 consecutive failures.
            pollFailureCount += 1;
            if (pollFailureCount < 3) return;
            pollFailureCount = 0;
            stopProgressPolling();
            showProgress(false);
            const msg = err?.message || String(err);
            if (typeof window.showToast === 'function') {
                window.showToast(
                    `${smartTagT('smartTag.progressCheckFailed', 'Smart Tag progress check failed')}: ${msg}`,
                    'error'
                );
            }
        }
    }

    function renderSnapshot(snap) {
        if (!snap) return;
        const total = snap.total || 0;
        const processed = snap.processed || 0;
        const status = snap.status || 'idle';
        const stage = snap.stage || '';

        // v3.2.2: prefer phase_completion (0-1 within current phase) over raw
        // processed/total so a multi-tagger + VLM run shows a single smooth bar
        // instead of jumping back to 0% between phases.
        const phaseCompletion = typeof snap.phase_completion === 'number' ? snap.phase_completion : null;
        let percent;
        if (phaseCompletion != null) {
            const settings = snap.settings || {};
            const hasVlm = settings.enable_vlm === true && settings.natural_language_mode !== 'off';
            const hasTagging = (settings.taggers && settings.taggers.length > 0)
                || settings.enable_wd14 === true;
            const bothPhases = hasTagging && hasVlm;
            if (!bothPhases) {
                percent = Math.max(0, Math.min(1, phaseCompletion)) * 100;
            } else if (stage === 'tagging' || stage === 'consensus') {
                percent = Math.max(0, Math.min(1, phaseCompletion)) * 50;
            } else if (stage === 'vlm') {
                percent = 50 + Math.max(0, Math.min(1, phaseCompletion)) * 50;
            } else {
                percent = total > 0 ? (processed / total) * 100 : 0;
            }
        } else {
            percent = total > 0 ? (processed / total) * 100 : 0;
        }

        let text = snap.message || status;
        if (total > 0) {
            let stagePrefix = '';
            if (stage === 'tagging') {
                stagePrefix = smartTagT('smartTag.stageTagging', 'Tagging');
            } else if (stage === 'vlm') {
                stagePrefix = smartTagT('smartTag.stageVlm', 'VLM captioning');
            }
            if (stagePrefix) {
                text = `${stagePrefix} ${processed}/${total} — ${snap.succeeded || 0} ok, ${snap.failed || 0} failed`;
            } else {
                text = `${snap.message || status} — ${processed}/${total} (${snap.succeeded || 0} ok, ${snap.failed || 0} failed)`;
            }
        }
        setProgressUI({
            percent,
            text,
            preview: snap.last_caption_preview || '',
        });
    }

