/**
 * v321/combined-export.js - v321-ui.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 3000-3158
 * (of 3,164): the clipboard/download combined-export interceptor + payload.
 * Classic script: joins the ONE unsealed window.V321Integration object
 * declared in v321/base.js (loads FIRST); v321/boot.js registers the
 * DOMContentLoaded init LAST; index.html lists the family in original
 * line order.
 */
Object.assign(window.V321Integration, {

    // Aurora #25c: the export payload injection used to live in an
    // interceptExportSubmit() that monkey-patched window.fetch for every
    // /api/tags/export-batch POST. It now flows through explicit plumbing —
    // executeBatchExport (app.js) collects collectTemplateOptions /
    // collectEditedCaptionOverrides / collectCaptionTransforms /
    // collectCaptionTypes / collectNlOverrides and passes them into
    // API._buildExportBatchPayload as template_options / image_overrides /
    // caption_transforms / image_types / image_nl_overrides (plus the
    // normalize_tag_underscores checkbox). No global fetch override remains.

    /** v3.2.1: short-circuit the Start button when the user picked clipboard
     *  or download as the output destination. Both paths build the combined
     *  text from the in-memory previewCache + editedCaptions and either copy
     *  to clipboard or save as a single file — no backend call to
     *  /api/tags/export-batch is needed in those cases.
     */
    interceptCombinedExportClick() {
        const startBtn = document.getElementById('btn-start-batch-export');
        if (!startBtn) {
            setTimeout(() => this.interceptCombinedExportClick(), 500);
            return;
        }
        startBtn.addEventListener('click', async (e) => {
            const checked = document.querySelector('input[name="batch-export-output-mode"]:checked');
            const value = checked?.value || 'beside_image';
            if (value !== 'clipboard' && value !== 'download') {
                return; // sidecar path: let app.js executeBatchExport handle it
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            try {
                await this._runCombinedExport(value);
            } catch (err) {
                const i18n = (key, fallback) => { const v = window.I18n?.t?.(key); return (v && v !== key) ? v : fallback; };
                if (typeof window.showToast === 'function') {
                    window.showToast(
                        i18n('batchExport.combinedCopyFailed', 'Could not copy combined export.'),
                        'error'
                    );
                } else {
                    window.console?.error?.('combined export failed', err);
                }
            }
        }, true); // capture phase so we run before the existing handler
    },

    /** Build the combined text by re-using the live preview pipeline: ask
     *  the backend to render every selected image, apply user edits, then
     *  concatenate. This guarantees the combined output matches what the
     *  user saw in the right preview pane character-for-character.
     */
    async _runCombinedExport(destination) {
        const i18n = (key, params, fallback) => { const v = window.I18n?.t?.(key, params); return (v && v !== key) ? v : fallback; };
        const payload = await this._buildCombinedExportPayload();
        const requestedTotal = payload.selection_token
            ? (this.queueTotalCount || this._selectionTotalFromState())
            : (payload.image_ids || []).length;
        if (!requestedTotal) {
            if (typeof window.showToast === 'function') {
                window.showToast(i18n('selection.noImagesSelected', null, 'No images selected.'), 'warning');
            }
            return;
        }
        const startBtn = document.getElementById('btn-start-batch-export');
        const previousLabel = startBtn?.innerHTML;
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.innerHTML = '<span>' + i18n('export.inProgress', null, 'Working...') + '</span>';
        }
        try {
            const r = await fetch('/api/tags/export-combined', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!r.ok) throw new Error('combined HTTP ' + r.status);
            const result = await r.json();
            if (!result.download_url) throw new Error('combined export did not return a download URL');

            if (destination === 'clipboard') {
                if (requestedTotal <= 5000) {
                    const textResponse = await fetch(result.download_url);
                    if (!textResponse.ok) throw new Error('download HTTP ' + textResponse.status);
                    await navigator.clipboard.writeText(await textResponse.text());
                    if (typeof window.showToast === 'function') {
                        window.showToast(
                            i18n('batchExport.combinedCopied', null, 'Combined export copied to clipboard.'),
                            'success'
                        );
                    }
                } else {
                    window.location.href = result.download_url;
                    if (typeof window.showToast === 'function') {
                        window.showToast(
                            i18n('batchExport.combinedLargeDownloaded', null, 'Large combined export was generated as a download so the browser does not freeze.'),
                            'info',
                            7000
                        );
                    }
                }
            } else {
                window.location.href = result.download_url;
                if (typeof window.showToast === 'function') {
                    window.showToast(
                        i18n('batchExport.combinedDownloaded', { filename: result.filename || '' }, 'Combined export saved.'),
                        'success'
                    );
                }
            }
            if (typeof window.hideModal === 'function') {
                window.hideModal('batch-export-modal');
            }
        } finally {
            if (startBtn) {
                startBtn.disabled = false;
                if (previousLabel) startBtn.innerHTML = previousLabel;
            }
        }
    },

    async _buildCombinedExportPayload() {
        const contentMode = document.getElementById('batch-export-content-mode')?.value || 'caption_merged';
        const blacklistText = document.getElementById('batch-export-blacklist')?.value || '';
        const blacklist = blacklistText.split(',').map((item) => item.trim()).filter(Boolean);
        const prefix = document.getElementById('batch-export-prefix')?.value || '';
        const overwritePolicy = document.getElementById('batch-export-overwrite')?.value || 'unique';
        const normalizeCheckbox = document.getElementById('batch-export-normalize-underscores');
        const selectionToken = this.queueSelectionToken || this._getActiveSelectionTokenForExport();
        const payload = {
            output_folder: '',
            output_mode: 'folder',
            blacklist,
            prefix,
            content_mode: contentMode,
            overwrite_policy: overwritePolicy,
        };
        if (selectionToken) {
            payload.selection_token = selectionToken;
        } else {
            payload.image_ids = this.queueImageIds.length
                ? this.queueImageIds
                : this._getExplicitSelectedImageIds(Infinity);
        }
        if (contentMode === 'template' && this.collectTemplateOptions) {
            payload.template_options = this.collectTemplateOptions();
        }
        const overrides = this.collectEditedCaptionOverrides();
        if (overrides) payload.image_overrides = overrides;
        const transforms = this.collectCaptionTransforms();
        if (transforms) payload.caption_transforms = transforms;
        const captionTypes = this.collectCaptionTypes();
        if (captionTypes) payload.image_types = captionTypes;
        const nlOverrides = this.collectNlOverrides();
        if (nlOverrides) payload.image_nl_overrides = nlOverrides;
        if (normalizeCheckbox) payload.normalize_tag_underscores = !!normalizeCheckbox.checked;
        this._applyTrainingFilterOptions(payload);
        return payload;
    },
});
