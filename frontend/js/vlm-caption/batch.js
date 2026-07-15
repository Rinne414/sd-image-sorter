/**
 * vlm-caption/batch.js — vlm-caption.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/vlm-caption.js pre-cut
 * lines 362-572 + 811-880 (of 1,073): the "Batch Captioning" section —
 * startBatchCaption (the v321/tagger-picker.js inbound seam; double-click
 * guard, 409 conflict, queued-200 pipeline), cancelBatch, retryFailedImages,
 * startPolling / stopPolling, pollProgress (queued state, start-error
 * window, completion refresh + vlmBatchCompleted event), _updateProgressUI
 * and _showBatchSummary — plus the "Helpers" batch-target block:
 * _buildImageIdsBatchTarget, _getBatchTarget (selection-scope contract:
 * token, then selected ids, then filters), _extractFailedImageIds and
 * _getFailedImageIds. Classic non-strict script: joins the ONE unsealed
 * window.VLMCaption object declared in vlm-caption/core.js, which loads
 * FIRST; vlm-caption/boot.js registers the DOMContentLoaded init LAST.
 */
Object.assign(window.VLMCaption, {
    // --- Batch Captioning ---

    async startBatchCaption(imageIdsOverride = null) {
        // Double-click guard: isRunning only flips after the POST resolves,
        // so a second click in that window would fire a duplicate request
        // (and bounce off the backend's 409 with a confusing error).
        if (this.isRunning || this._startInFlight) return;
        this._startInFlight = true;
        try {
            const batchTarget = Array.isArray(imageIdsOverride)
                ? this._buildImageIdsBatchTarget(imageIdsOverride)
                : this._getBatchTarget();
            if (batchTarget?.blockedReason) {
                this._showBatchUI(false, { keepPanel: true });
                this._showStatus('vlm-batch-status', batchTarget.blockedReason, 'warning');
                return;
            }
            if (!batchTarget || !batchTarget.count) {
                this._showBatchUI(false, { keepPanel: true });
                this._showStatus('vlm-batch-status', 'No images to caption. Select images or use current view.', 'error');
                return;
            }

            const resp = await fetch('/api/vlm/caption-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batchTarget.payload),
            });
            if (resp.status === 409) {
                this._showBatchUI(false, { keepPanel: true });
                this._showStatus('vlm-batch-status', 'Already running — wait or cancel first', 'error');
                return;
            }
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this._showBatchUI(false, { keepPanel: true });
                this._showStatus('vlm-batch-status', `Failed: ${err.detail || resp.statusText}`, 'error');
                return;
            }
            const startData = await resp.json().catch(() => ({}));
            if (startData && startData.status === 'queued' && startData.pipeline_queued === true) {
                // v3.4.1 AI job queue: another AI job is running, so this
                // batch was queued (200) instead of rejected with 409. The
                // poll loop renders the queued state until it auto-starts.
                this._queuedSince = Date.now();
                this.isRunning = true;
                this.lastFailedImageIds = [];
                this._showBatchUI(true);
                this._showStatus('vlm-batch-status', startData.duplicate
                    ? this._t('aiQueue.duplicateToast', 'An identical job is already queued')
                    : this._t('aiQueue.queuedToast', 'Queued — starts automatically after the current AI job finishes'), 'info');
                this.startPolling();
                return;
            }
            this._queuedSince = 0;
            this.isRunning = true;
            this.lastFailedImageIds = [];
            this._showBatchUI(true);
            this._showStatus('vlm-batch-status', this._t('vlm.captionRunning', 'Captioning images...'), 'info');
            this.startPolling();
        } catch (e) {
            this._showBatchUI(false, { keepPanel: true });
            this._showStatus('vlm-batch-status', `Error: ${e.message}`, 'error');
        } finally {
            this._startInFlight = false;
        }
    },

    async cancelBatch() {
        try {
            await fetch('/api/vlm/caption-batch/cancel', { method: 'POST' });
            this._showStatus('vlm-batch-status', 'Cancelling...', 'info');
            this._syncTaggerActionState(true, { cancelling: true });
        } catch (e) { /* ignore */ }
    },

    async retryFailedImages() {
        const failedIds = this._getFailedImageIds();
        if (!failedIds.length || this.isRunning) return;
        await this.startBatchCaption(failedIds);
    },

    startPolling() {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(() => this.pollProgress(), 1500);
        this.pollProgress();
    },

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    async pollProgress() {
        try {
            const resp = await fetch('/api/vlm/caption-batch/progress');
            const data = await resp.json();
            this.lastProgress = data;
            this._updateProgressUI(data);
            if (document.getElementById('vlm-debug-chat-modal')?.classList.contains('visible')) {
                this.loadDebugChat({ silent: true });
            }

            if (!data.running) {
                // v3.4.1 AI job queue: not running but still waiting in the
                // unified pipeline queue — render the queued state and keep
                // polling until the dispatcher starts the batch.
                const queuedEntries = data.pipeline_queue?.queued || [];
                if (queuedEntries.length > 0) {
                    this._showBatchUI(true);
                    this._showStatus('vlm-batch-status',
                        this._t('aiQueue.queuedProgress', 'Queued #{position} — waiting for the current AI job to finish')
                            .replace('{position}', String(queuedEntries[0].position || 1)), 'info');
                    return;
                }
                // Queued entry left the queue without ever running: surface
                // a failed queued start (recorded per kind by the backend).
                const startError = data.pipeline_queue?.last_start_error;
                const startErrorAt = startError ? Date.parse(startError.at || '') : NaN;
                if (this._queuedSince && startError && Number.isFinite(startErrorAt)
                    && startErrorAt >= (this._queuedSince - 2000)) {
                    this._queuedSince = 0;
                    this.stopPolling();
                    this.isRunning = false;
                    this._showBatchUI(false, { keepPanel: true });
                    this._showStatus('vlm-batch-status',
                        this._t('aiQueue.startFailed', 'Queued job failed to start: {error}')
                            .replace('{error}', String(startError.error || '')), 'error');
                    return;
                }
                this._queuedSince = 0;
                this.stopPolling();
                this.isRunning = false;
                this._showBatchSummary(data);
                // v3.2.1: refresh gallery and analytics so freshly-captioned
                // images surface their new VLM caption / tag chips without
                // the user having to switch views or hit Refresh manually.
                try {
                    if (typeof window.loadImages === 'function') window.loadImages();
                    if (typeof window.loadStats === 'function') window.loadStats();
                    // v3.2.2: if the image detail modal is open, re-fetch so
                    // the user sees the new ai_caption immediately without
                    // having to close and reopen the modal.
                    // Note: check the modal's actual DOM state, NOT
                    // currentPreviewRequestId — that is a monotonically
                    // increasing counter that is never reset on close, so
                    // using it as an "is open" signal reopened the modal by
                    // itself after the user had closed it.
                    const previewModalOpen = document.getElementById('image-modal')
                        ?.classList.contains('visible');
                    if (previewModalOpen && window.Gallery?.openPreview) {
                        const currentId = window.Gallery.images?.[window.Gallery.currentPreviewIndex]?.id;
                        if (currentId) window.Gallery.openPreview(currentId);
                    }
                    document.dispatchEvent(new CustomEvent('vlmBatchCompleted', {
                        detail: {
                            completed: data.completed || 0,
                            failed: data.failed || 0,
                            tokens_used: data.tokens_used || 0,
                        },
                    }));
                } catch (e) {
                    /* refresh hook is best-effort */
                }
            }
        } catch (e) { /* continue polling */ }
    },

    _updateProgressUI(data) {
        const total = Number(data.total || 0);
        const completed = Number(data.completed || 0);
        const failed = Number(data.failed || 0);
        const done = completed + failed;
        const pct = total > 0 ? Math.round(done / total * 100) : (data.running ? 0 : 100);
        if (data.running) this._showBatchUI(true);

        const fill = document.getElementById('vlm-progress-fill');
        const text = document.getElementById('vlm-progress-text');
        if (fill) fill.style.width = `${pct}%`;
        if (text) {
            const parts = [
                `${this._t('vlm.progressDone', 'Done')} ${completed}/${total || done}`,
                `${this._t('vlm.progressFailed', 'Failed')} ${failed}`,
                `${this._t('vlm.progressApi', 'API')}: ${this._formatApiStatus(data)}`,
            ];
            if (Number(data.tokens_used || 0) > 0) {
                parts.push(`${data.tokens_used} tokens`);
            }
            if (data.current_image) {
                parts.push(data.current_image);
            }
            text.textContent = parts.join(' · ');
        }
    },

    _showBatchSummary(data) {
        this._showBatchUI(false, { keepPanel: true });
        this.lastProgress = data;
        this.lastFailedImageIds = this._extractFailedImageIds(data);
        const msg = `${this._t('vlm.summaryDone', 'Done')}! ${data.completed || 0} ${this._t('vlm.summaryCaptioned', 'captioned')}, ${data.failed || 0} ${this._t('vlm.summaryFailed', 'failed')}, ${data.tokens_used || 0} tokens. ${this._t('vlm.progressApi', 'API')}: ${this._formatApiStatus(data)}`;
        this._showStatus('vlm-batch-status', msg, data.failed ? 'warning' : 'success');

        this._syncRetryFailedButton(data);
        if (data.errors?.length) {
            const errorList = document.getElementById('vlm-error-list');
            if (errorList) {
                errorList.innerHTML = data.errors.map(e =>
                    `<div class="vlm-error-row">Image #${e.image_id}: <code>${escapeHtml(e.error)}</code> <span class="vlm-error-type">[${e.error_type}]</span></div>`
                ).join('');
                errorList.style.display = 'block';
            }
        }
    },

    // --- Helpers ---

    _buildImageIdsBatchTarget(imageIds) {
        const normalized = (Array.isArray(imageIds) ? imageIds : [])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .slice(0, 1000000);
        return {
            count: normalized.length,
            payload: { image_ids: normalized },
        };
    },

    _getBatchTarget() {
        const selectionState = window.AppFilterAccess?.getSelectionState?.();
        if (selectionState?.selectionTokenPending === true) {
            return {
                count: 0,
                payload: null,
                blockedReason: this._t(
                    'selection.scopeFilteredUpdating',
                    'Updating filtered selection...'
                ),
            };
        }
        const tokenScoped = selectionState?.scope === 'filtered'
            && Boolean(selectionState?.selectionToken);
        const scopedTotal = Number(selectionState?.selectionTotal);
        if (tokenScoped && (!Number.isFinite(scopedTotal) || scopedTotal <= 0)) {
            return this._buildImageIdsBatchTarget([]);
        }

        const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
        if (selectionToken) {
            const total = Number(window.AppFilterAccess?.getSelectionTotal?.());
            return {
                count: Number.isFinite(total) && total > 0 ? total : 0,
                payload: { selection_token: selectionToken },
            };
        }

        const selected = window.AppFilterAccess?.getSelectedImageIds?.() || [];
        if (selected.length) return this._buildImageIdsBatchTarget(selected);

        const state = window.App?.AppState || window.AppState || {};
        const loaded = Array.isArray(state.images) ? state.images : [];
        const loadedIds = loaded
            .map((item) => Number(item?.id))
            .filter((id) => Number.isFinite(id) && id > 0)
            .slice(0, 1000000);

        // "Current view" must mean the whole filtered set — the same scope the
        // WD14 path behind this button uses — not just the page the gallery
        // happens to have loaded (e.g. 60 of 5000). Send the active filters
        // and let the backend expand them server-side.
        const buildFilters = window.App?.buildSelectionFilterRequest;
        if (loadedIds.length && typeof buildFilters === 'function') {
            // pagination.total can be the -1 "count skipped" sentinel; only
            // trust positive values, otherwise fall back to the loaded count
            // (count just gates the empty check — the backend computes the
            // real total when it expands the filters).
            const reportedTotal = Number(state.pagination?.total || 0);
            return {
                count: reportedTotal > 0 ? reportedTotal : loadedIds.length,
                payload: { filters: buildFilters() },
            };
        }
        return this._buildImageIdsBatchTarget(loadedIds);
    },

    _extractFailedImageIds(data) {
        const errors = Array.isArray(data?.errors) ? data.errors : [];
        const ids = [];
        const seen = new Set();
        for (const err of errors) {
            const id = Number(err?.image_id);
            if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }
        return ids;
    },

    _getFailedImageIds() {
        const ids = this._extractFailedImageIds(this.lastProgress);
        return ids.length ? ids : Array.from(this.lastFailedImageIds || []);
    },

});
