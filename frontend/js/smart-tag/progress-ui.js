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
            // Only this tab's own run is cancelled later (kept across a
            // reload); a running job on screen may be stopped as shown.
            const own = readOwnSmartTagRun();
            activeJobId = own.jobId || activeJobId || (isLive ? snap.job_id || null : null);
            activeQueueId = own.queueId || activeQueueId;
            showProgress(true);
            if (!isLive && queuedEntries.length > 0) {
                pipelineQueuedSince = Date.now();
                setProgressUI({
                    percent: 0,
                    text: smartTagT('aiQueue.queuedProgress', 'Queued #{position}, waiting for the current AI job to finish')
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
                    text: smartTagT('aiQueue.queuedProgress', 'Queued #{position}, waiting for the current AI job to finish')
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

    // The backend still sends an English `message` for API compatibility; the UI
    // builds its own sentence from message_key + message_args + the counters so
    // it follows the language. An unknown key falls back to a generic localized
    // line. Raw provider errors (`detail`) are shown as received.
    function smartTagStatusText(snap) {
        const key = snap && snap.message_key;
        if (!key) return '';
        const args = snap.message_args || {};
        const fill = (i18nKey, fallback, values = {}) => Object.keys(values).reduce(
            (text, name) => text.split(`{${name}}`).join(String(values[name])),
            smartTagT(i18nKey, fallback),
        );
        const withDetail = (text, detail) => (detail ? `${text}: ${detail}` : text);
        const ok = snap.succeeded || 0;
        const failed = snap.failed || 0;
        const skipped = snap.skipped || 0;
        const countsText = () => {
            let text = fill('smartTag.msg.counts', 'Succeeded: {ok}, failed: {failed}', { ok, failed });
            if (skipped > 0) {
                text += fill('smartTag.msg.countsSkipped', ', skipped (already tagged): {skipped}', { skipped });
            }
            return text;
        };
        switch (key) {
            case 'cancel_requested': return smartTagT('smartTag.cancelRequested', 'Smart Tag cancellation requested');
            case 'smart_tagging_vlm': return fill('smartTag.msg.workingVlm', 'Smart Tag is working on {total} images (VLM workers: {workers})...', { total: snap.total || 0, workers: args.workers || 1 });
            case 'smart_tagging': return fill('smartTag.msg.working', 'Smart Tag is working on {total} images...', { total: snap.total || 0 });
            case 'tagging_batch': return fill('smartTag.msg.taggingBatch', 'Tagging a batch of {count} images...', { count: args.count || 0 });
            case 'phase1': return fill('smartTag.msg.phase1', 'Phase 1 of 2: booru tags ({total} images)...', { total: snap.total || 0 });
            case 'phase1_progress': return fill('smartTag.msg.phase1Progress', 'Phase 1 of 2: tagged {done}/{total}', { done: args.done || 0, total: args.total || 0 });
            case 'phase2': return fill('smartTag.msg.phase2', 'Phase 2 of 2: captioning {count} images with {captioner}...', { count: args.count || 0, captioner: args.captioner || '' });
            case 'cancelled': return smartTagT('smartTag.msg.cancelled', 'Cancelled.');
            case 'booru_saved_caption_failed': return withDetail(fill('smartTag.msg.booruSavedCaptionFailed', 'Booru tags were saved, but the {captioner} caption phase could not start', { captioner: args.captioner || '' }), args.detail);
            case 'resolving': return smartTagT('smartTag.msg.resolving', 'Resolving images...');
            case 'no_images': return smartTagT('smartTag.msg.noImages', 'No matching images found.');
            case 'taggers_sequential': return smartTagT('smartTag.msg.taggersSequential', 'The local booru taggers will run one at a time...');
            case 'loading_tagger': return smartTagT('smartTag.msg.loadingTagger', 'Loading the local booru tagger...');
            case 'captioner_after_booru': return fill('smartTag.msg.captionerAfterBooru', '{captioner} will load after the booru tagging phase...', { captioner: args.captioner || '' });
            case 'loading_vlm': return smartTagT('smartTag.msg.loadingVlm', 'Loading the VLM provider...');
            case 'loading_tagger_n': return fill('smartTag.msg.loadingTaggerN', 'Loading tagger {index}/{count}: {model}...', { index: args.index || 1, count: args.count || 1, model: args.model || '' });
            case 'tagging_model': return fill('smartTag.msg.taggingModel', 'Tagging ({model}) {done}/{total}', { model: args.model || '', done: args.done || 0, total: args.total || 0 });
            case 'consensus_vlm': return smartTagT('smartTag.msg.consensusVlm', 'Running consensus and VLM...');
            case 'consensus': return smartTagT('smartTag.msg.consensus', 'Running consensus...');
            case 'captioning_progress': return smartTagT('smartTag.stageVlm', 'VLM captioning');
            case 'processing_progress': return smartTagT('smartTag.msg.processing', 'Processing');
            case 'vram_refresh': return smartTagT('smartTag.msg.vramRefresh', 'VRAM pressure: the runtime session was refreshed.');
            case 'memory_critical': return fill('smartTag.msg.memoryCritical', 'Memory pressure is high. Pausing briefly and reducing the batch to {chunk}.', { chunk: args.chunk || 1 });
            case 'ram_high': return fill('smartTag.msg.ramHigh', 'High RAM usage. Reducing the batch to {chunk}.', { chunk: args.chunk || 1 });
            case 'loading_captioner': return fill('smartTag.msg.loadingCaptioner', 'Loading the {captioner} natural-language model...', { captioner: args.captioner || '' });
            case 'done': return smartTagT('smartTag.msg.done', 'Done.') + ' ' + countsText();
            case 'done_warning': return smartTagT('smartTag.msg.doneWarning', 'Completed with warnings.') + ' ' + countsText()
                + (args.degraded ? ' ' + smartTagT('smartTag.msg.degraded', 'Some of the selected tagger models could not be loaded.') : '');
            case 'failed_all': return withDetail(fill('smartTag.msg.failedAll', 'Smart Tag failed for all {count} images', { count: failed }), args.detail);
            case 'failed_caption_profile': return withDetail(fill('smartTag.msg.failedCaptionProfile', 'Caption profile {profile} failed for all {count} images', { profile: args.profile || '', count: failed }), args.detail);
            case 'failed': return withDetail(smartTagT('smartTag.msg.failed', 'Smart Tag failed'), args.detail);
            case 'queued_unknown': return smartTagT('smartTag.msg.queuedUnknown', 'This queued Smart Tag run is no longer known (the program restarted or its result was dropped).');
            case 'queued_start_failed': return fill('aiQueue.startFailed', 'Queued job failed to start: {error}', { error: args.detail || '' });
            default: return smartTagT('smartTag.msg.generic', 'Smart Tag is working...');
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

        const keyedText = smartTagStatusText(snap);
        const counts = smartTagT('smartTag.msg.progressCounts', 'succeeded {ok}, failed {failed}')
            .replace('{ok}', String(snap.succeeded || 0)).replace('{failed}', String(snap.failed || 0));
        let text = keyedText || snap.message || status;
        if (total > 0) {
            let stagePrefix = '';
            if (stage === 'tagging') {
                stagePrefix = smartTagT('smartTag.stageTagging', 'Tagging');
            } else if (stage === 'vlm') {
                stagePrefix = smartTagT('smartTag.stageVlm', 'VLM captioning');
            }
            if (stagePrefix) {
                text = `${stagePrefix} ${processed}/${total} — ${counts}`;
            } else {
                text = `${keyedText || snap.message || status} — ${processed}/${total} (${counts})`;
            }
        }
        setProgressUI({
            percent,
            text,
            preview: snap.last_caption_preview || '',
        });
    }

