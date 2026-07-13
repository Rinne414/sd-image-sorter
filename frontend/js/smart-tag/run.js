/**
 * smart-tag/run.js — smart-tag.js decomposition.
 * Extracted VERBATIM from frontend/js/smart-tag.js pre-split lines
 * 897-1098: applyPathCaptions (hosts the `/api/smart-tag/results`
 * literal pinned by backend/tests/test_frontend_contract.py),
 * onJobFinished (toasts + Dataset Maker caption reseed/refresh),
 * runSmartTag (empty-source guard, pick-one-mode guard,
 * destructive-replace confirm, pipeline-queued branch) and
 * cancelSmartTag (404-already-finished swallow). Classic script;
 * family renames applied.
 */
'use strict';
    async function applyPathCaptions(jobId, mergeStrategy) {
        const dm = window.DatasetMaker;
        if (!jobId || !dm?.localItemPaths || !dm?.captionEdits) return 0;
        const idByPath = new Map();
        for (const [id, path] of dm.localItemPaths.entries()) {
            idByPath.set(String(path), Number(id));
        }
        let offset = 0;
        let applied = 0;
        while (true) {
            const page = await getJson(`/api/smart-tag/results?job_id=${encodeURIComponent(jobId)}&offset=${offset}&limit=1000`);
            for (const item of (page.results || [])) {
                const id = idByPath.get(String(item.path || ''));
                const caption = String(item.caption || '').trim();
                if (!id || !caption) continue;
                const existing = dm.captionEdits.get(id) || dm.captions?.get?.(id) || '';
                const next = mergeStrategy === 'append' && existing && existing !== caption
                    ? `${existing}, ${caption}`.replace(/^,\s*/, '').replace(/,\s*$/, '')
                    : caption;
                dm.captionEdits.set(id, next);
                applied += 1;
            }
            offset += page.results?.length || 0;
            if (!page.has_more || !page.results?.length) break;
        }
        if (applied > 0) {
            dm._renderQueue?.();
            if (dm.activeId != null) dm._setActive?.(dm.activeId);
            dm._refreshVocab?.();
        }
        return applied;
    }

    async function onJobFinished(snap) {
        const status = snap.status || 'completed';
        const ok = (snap.succeeded || 0);
        const fail = (snap.failed || 0);
        const total = snap.total || 0;
        showProgress(false);
        if (status === 'completed' && (snap.caption_result_count || 0) > 0) {
            try {
                await applyPathCaptions(snap.job_id, snap.settings?.merge_strategy || 'replace');
            } catch (err) {
                if (typeof window.showToast === 'function') {
                    window.showToast(`Smart Tag captions were generated but could not be applied: ${err.message || err}`, 'error');
                }
            }
        }

        // Reuse the existing toast helper if available; fall back to alert.
        const noiseStripped = snap.noise_stripped_count || 0;
        const noiseSuffix = noiseStripped > 0 ? ` · ${noiseStripped} noise tags removed` : '';
        const message = status === 'cancelled'
            ? `Smart Tag cancelled at ${ok + fail}/${total}${noiseSuffix}`
            : status === 'failed'
                ? `Smart Tag failed: ${snap.message || 'unknown error'}`
                : `Smart Tag finished: ${ok} ok, ${fail} failed${noiseSuffix}.`;

        if (typeof window.showToast === 'function') {
            window.showToast(message, status === 'failed' ? 'error' : 'success');
        } else {
            (window.Logger?.info || console.log)('[smart-tag]', message);
        }

        // Surface the new captions in Dataset Maker so they show up in the
        // editor + queue without requiring a re-import (Bug: gallery-source
        // images previously needed a manual re-import from the gallery before
        // Smart Tag results appeared here).
        const dm = window.DatasetMaker;
        if (dm) {
            try {
                // When the run produced natural-language captions, seed them
                // from the DB ai_caption into the editor — the booru-tags
                // template the editor renders omits {nl_caption}, so VLM/API
                // captions were only visible in the gallery before.
                const usedVlm = snap.settings?.enable_vlm === true
                    && (snap.settings?.natural_language_mode || 'vlm') !== 'off';
                if (usedVlm && typeof dm._seedAiCaptions === 'function' && Array.isArray(dm.imageIds)) {
                    const galleryIds = dm.imageIds.filter((id) => !(dm.isLocalId?.(id)));
                    if (galleryIds.length) await dm._seedAiCaptions(galleryIds);
                }
            } catch (_e) { /* non-fatal: gallery still shows ai_caption */ }
            // Re-render queue tiles + export preview + active editor from the
            // refreshed caption state (this is what a re-import used to force).
            if (typeof dm._refreshAllCaptions === 'function') {
                try { await dm._refreshAllCaptions(); } catch (_e) { /* ignore */ }
            }
        }
        activeJobId = null;
    }

    async function runSmartTag() {
        const form = readForm();
        if (
            !form.image_ids.length
            && !form.image_paths.length
            && !form.selection_token
            && !form.dataset_scan_token
        ) {
            const noImagesMsg = smartTagT('smartTag.noImages', 'No images in Dataset Maker. Add images first.');
            if (typeof window.showToast === 'function') {
                window.showToast(noImagesMsg, 'warning');
            } else {
                alert(noImagesMsg);
            }
            return;
        }
        if ((form.image_ids.length + form.image_paths.length) > LARGE_EXPLICIT_SOURCE_LIMIT
            && !form.selection_token
            && !form.dataset_scan_token) {
            console.warn(
                '[smart-tag] large explicit source list; selection_token or dataset_scan_token would be more efficient.',
                form.image_ids.length + form.image_paths.length
            );
        }
        if (!form.enable_wd14 && !form.enable_vlm) {
            if (typeof window.showToast === 'function') {
                window.showToast(smartTagT('smartTag.pickOneMode', 'Pick booru tags, natural-language captioning, or both.'), 'warning');
            }
            return;
        }

        // Destructive-replace guard: replace mode overwrites existing
        // captions and DB images don't get a backup, so confirm before
        // we commit a large overwrite the user can't undo.
        if (form.merge_strategy === 'replace') {
            const explicitTotal = (form.image_ids?.length || 0) + (form.image_paths?.length || 0);
            const tokenTotal = Number(form.selection_token ? (getDatasetSources().selectionTotal || 0) : 0)
                + Number(form.dataset_scan_token ? (getDatasetSources().datasetScanTotal || 0) : 0);
            const total = explicitTotal + tokenTotal;
            if (total > 100) {
                const proceed = window.confirm(
                    `This will overwrite existing captions on ${total} images. Continue?`
                );
                if (!proceed) return;
            }
        }

        showProgress(true);
        setProgressUI({ percent: 0, text: 'Starting...', preview: '' });
        try {
            const snap = await postJson('/api/smart-tag/start', form);
            if (snap && snap.pipeline_queued === true) {
                // v3.4.1 AI job queue: another AI job is running, so this
                // run was queued (200) instead of rejected with 409. The
                // poll loop renders the queued state until the dispatcher
                // starts the job.
                pipelineQueuedSince = Date.now();
                activeJobId = null;
                if (typeof window.showToast === 'function') {
                    window.showToast(snap.duplicate
                        ? smartTagT('aiQueue.duplicateToast', 'An identical job is already queued')
                        : smartTagT('aiQueue.queuedToast', 'Queued — starts automatically after the current AI job finishes'), 'info');
                }
                setProgressUI({
                    percent: 0,
                    text: smartTagT('aiQueue.queuedProgress', 'Queued #{position} — waiting for the current AI job to finish')
                        .replace('{position}', String(snap.queue_position || 1)),
                    preview: '',
                });
                startProgressPolling();
                return;
            }
            pipelineQueuedSince = 0;
            activeJobId = snap.job_id || null;
            renderSnapshot(snap);
            startProgressPolling();
        } catch (err) {
            showProgress(false);
            const msg = err.message || String(err);
            if (typeof window.showToast === 'function') {
                window.showToast(`Smart Tag failed to start: ${msg}`, 'error');
            } else {
                alert(`Smart Tag failed to start: ${msg}`);
            }
        }
    }

    async function cancelSmartTag() {
        const cancelBtn = smartTag$('#btn-smart-tag-cancel-job');
        try {
            await postJson('/api/smart-tag/cancel', null);
            // Immediately reflect intent in the UI so the user gets
            // feedback instead of watching the progress bar keep moving
            // for ~1s until the worker checks the cancel flag.
            if (cancelBtn) cancelBtn.disabled = true;
            setProgressUI({ text: smartTagT('smartTag.cancellingKept', 'Cancelling — already-tagged results will be kept') });
            if (typeof window.showToast === 'function') {
                window.showToast(smartTagT('smartTag.cancelRequested', 'Smart Tag cancellation requested'), 'info');
            }
        } catch (err) {
            // 404 means the job already finished between the user
            // clicking Stop and the request landing — surface that
            // explicitly instead of swallowing it silently.
            if (err && err.status === 404) {
                if (typeof window.showToast === 'function') {
                    window.showToast(smartTagT('smartTag.jobAlreadyFinished', 'Job already finished'), 'info');
                }
            }
        }
    }

