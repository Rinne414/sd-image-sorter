/**
 * vlm-caption/workflow-ui.js — vlm-caption.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/vlm-caption.js pre-cut
 * lines 881-955 + 1025-1053 (of 1,073): _isVlmWorkflowVisibleContext (reads
 * V321Integration.activeTaggerTab, outbound), syncWorkflowVisibility (the
 * v321/tagger-tabs.js + tagger-picker.js inbound seam), _showBatchUI,
 * _syncRetryFailedButton, _syncTaggerActionState (Start-Tag button copy +
 * i18nLocked handling) and _formatApiStatus. Classic non-strict script:
 * joins the ONE unsealed window.VLMCaption object declared in
 * vlm-caption/core.js, which loads FIRST; vlm-caption/boot.js registers the
 * DOMContentLoaded init LAST.
 */
Object.assign(window.VLMCaption, {
    _isVlmWorkflowVisibleContext() {
        const activeTab = window.V321Integration?.activeTaggerTab || 'local';
        const selectedVlm = document.getElementById('tag-model-select')?.value === 'vlm';
        const nlSource = document.querySelector('input[name="tagger-nl-source"]:checked')?.value || '';
        return activeTab === 'nl' && (selectedVlm || nlSource === 'vlm');
    },

    syncWorkflowVisibility() {
        const workflow = document.getElementById('tagger-nl-workflow-card');
        if (!workflow) return;
        const hasStatus = Boolean(this.isRunning || this.lastProgress || workflow.querySelector('#vlm-batch-status')?.style.display !== 'none');
        const visible = this._isVlmWorkflowVisibleContext() && hasStatus;
        workflow.style.display = visible ? 'grid' : 'none';
    },

    _showBatchUI(running, options = {}) {
        const workflow = document.getElementById('tagger-nl-workflow-card');
        const prog = document.getElementById('vlm-progress-container');
        const cancel = document.getElementById('btn-vlm-cancel');
        const start = document.getElementById('btn-vlm-start');
        const errorList = document.getElementById('vlm-error-list');
        const canShowWorkflow = this._isVlmWorkflowVisibleContext();
        if (workflow) workflow.style.display = (canShowWorkflow && (running || options.keepPanel)) ? 'grid' : 'none';
        if (prog) prog.style.display = running ? 'block' : 'none';
        if (cancel) cancel.style.display = running ? 'inline-flex' : 'none';
        if (start) start.disabled = running;
        this._syncRetryFailedButton(running ? null : this.lastProgress);
        if (errorList && running) {
            errorList.innerHTML = '';
            errorList.style.display = 'none';
        }
        this._syncTaggerActionState(running);
    },

    _syncRetryFailedButton(data = this.lastProgress) {
        const retry = document.getElementById('btn-vlm-retry-failed');
        if (!retry) return;
        const failedIds = this._extractFailedImageIds(data);
        if (failedIds.length) this.lastFailedImageIds = failedIds;
        const visible = !this.isRunning && this._isVlmWorkflowVisibleContext() && this._getFailedImageIds().length > 0;
        retry.style.display = visible ? 'inline-flex' : 'none';
        retry.disabled = this.isRunning || !this._getFailedImageIds().length;
        const count = this._getFailedImageIds().length;
        retry.textContent = count > 0
            ? this._t('vlm.retryFailed', 'Retry failed') + ` (${count})`
            : this._t('vlm.retryFailed', 'Retry failed');
    },

    _syncTaggerActionState(running, options = {}) {
        const selectedVlm = document.getElementById('tag-model-select')?.value === 'vlm';
        if (!selectedVlm) return;
        const start = document.getElementById('btn-start-tag');
        const cancel = document.getElementById('btn-cancel-tag');
        if (start) {
            start.disabled = running;
            start.textContent = running
                ? this._t('vlm.captionRunning', 'Captioning...')
                : this._t('vlm.utilityStart', 'Caption');
            start.dataset.i18nLocked = '1';
        }
        if (cancel) {
            cancel.textContent = running
                ? (options.cancelling ? this._t('vlm.cancelling', 'Cancelling...') : this._t('vlm.utilityStop', 'Stop'))
                : this._t('modal.tagCancel', 'Cancel');
            if (running) {
                cancel.dataset.i18nLocked = '1';
            } else {
                delete cancel.dataset.i18nLocked;
            }
        }
        if (!running) {
            try { window.V321Integration?.syncVisibleTaggerCopy?.(); } catch (_e) {}
        }
    },

    _formatApiStatus(data) {
        const status = String(data?.api_status || (data?.running ? 'waiting' : 'idle'));
        const active = Number(data?.active_requests || 0);
        const latency = Number(data?.last_api_latency_ms || 0);
        const lastError = String(data?.last_api_error || '').trim();
        const labels = {
            queued: this._t('vlm.apiQueued', 'queued'),
            waiting: this._t('vlm.apiWaiting', 'waiting response'),
            responded: this._t('vlm.apiResponded', 'responded'),
            error: this._t('vlm.apiError', 'error'),
            cancelling: this._t('vlm.apiCancelling', 'cancelling'),
            cancelled: this._t('vlm.apiCancelled', 'cancelled'),
            done: this._t('vlm.apiDone', 'done'),
            done_with_errors: this._t('vlm.apiDoneWithErrors', 'done with errors'),
            idle: this._t('vlm.apiIdle', 'idle'),
        };
        const parts = [labels[status] || status];
        if (active > 0) {
            parts.push(`${active} ${this._t('vlm.apiActive', 'active')}`);
        }
        if (latency > 0) {
            parts.push(`${latency} ms`);
        }
        if (lastError && ['error', 'done_with_errors'].includes(status)) {
            parts.push(lastError.length > 80 ? `${lastError.slice(0, 77)}...` : lastError);
        }
        return parts.join(' / ');
    },

});
