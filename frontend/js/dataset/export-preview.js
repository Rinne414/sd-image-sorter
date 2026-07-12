/**
 * Dataset Maker — server export preview (POST /api/dataset/export-preview): caption review rows, translate, FE-4 no-offline-fallback error.
 * Moved VERBATIM from dataset-maker-pipeline.js L1222-1488 (+ documented
 * non-verbatim: the per-module init split replacing pipeline L1489-1503).
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---- Export preview (Phase 4) ----
    let previewRequestSeq = 0;
    let previewAbortController = null;

    function renderPreviewError(list, message) {
        list.innerHTML = '';
        const error = document.createElement('div');
        error.className = 'dataset-export-preview-warning';
        error.textContent = message || (DM._t?.('dataset.exportPreviewFailed', 'Preview failed. Fix the settings and retry.') || 'Preview failed.');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-ghost btn-small';
        retry.textContent = DM._t?.('common.retry', 'Retry') || 'Retry';
        retry.addEventListener('click', () => DM._refreshExportPreview?.());
        list.append(error, retry);
    }

    async function refreshExportPreview() {
        const requestSeq = ++previewRequestSeq;
        if (previewAbortController) previewAbortController.abort();
        previewAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const list = document.getElementById('dataset-export-preview-list');
        if (!list) return;
        const outputMode = DM._outputMode?.() || 'folder';
        const items = DM.imageIds || [];
        const logicalCount = DM._getLogicalDatasetCount?.() || items.length;
        if (logicalCount === 0) {
            list.innerHTML = `<span class="dataset-export-preview-empty">${DM._t?.('dataset.exportPreviewEmpty', 'Add images and set naming to see preview') || 'Add images and set naming to see preview'}</span>`;
            return;
        }
        if (items.length === 0) {
            list.innerHTML = `<span class="dataset-export-preview-empty">${DM._t?.(
                'dataset.exportPreviewNoLoadedItems',
                '{count} images are in the dataset manifest, but no previews are loaded in the browser yet.',
                { count: logicalCount }
            ) || `${logicalCount} images are in the dataset manifest, but no previews are loaded in the browser yet.`}</span>`;
            return;
        }
        list.innerHTML = `<span class="dataset-export-preview-empty">${DM._t?.('dataset.exportPreviewLoading', 'Refreshing preview...') || 'Refreshing preview...'}</span>`;

        const renderCaptionReview = (data) => {
            if (requestSeq !== previewRequestSeq) return;
            list.innerHTML = '';
            const summary = document.createElement('div');
            summary.className = 'dataset-export-preview-summary';
            summary.innerHTML = `
                <strong>${Number(data.total || logicalCount).toLocaleString()} ${DM._t?.('dataset.exportPreviewPairs', 'image + caption pairs') || 'image + caption pairs'}</strong>
                <span>${DM._t?.('dataset.exportPreviewShowing', 'Showing') || 'Showing'} ${Number(data.returned || 0).toLocaleString()}</span>
                <button type="button" class="btn btn-ghost btn-small" id="btn-dataset-translation-settings">${DM._t?.('dataset.translationSettings', 'VLM translation settings') || 'VLM translation settings'}</button>
            `;
            list.appendChild(summary);
            summary.querySelector('#btn-dataset-translation-settings')?.addEventListener('click', () => {
                if (typeof window.App?.openVlmSettings === 'function') {
                    window.App.openVlmSettings();
                } else {
                    document.getElementById('btn-vlm-settings')?.click();
                }
            });
            if (data.items_truncated) {
                const note = document.createElement('div');
                note.className = 'dataset-export-preview-summary';
                note.textContent = DM._t?.(
                    'dataset.exportPreviewManifestNote',
                    'Export will include every manifest image. File-name preview, duplicate checks, caption status, and thumbnail rows below cover loaded previews only.'
                ) || 'Export will include every manifest image. Preview rows below cover loaded previews only.';
                list.appendChild(note);
            }
            for (const item of (data.items || [])) {
                const row = document.createElement('div');
                row.className = 'dataset-export-caption-row';
                if (item.error) row.classList.add('has-error');
                const top = document.createElement('button');
                top.type = 'button';
                top.className = 'dataset-export-caption-top';
                const thumb = document.createElement('img');
                thumb.className = 'dataset-export-preview-thumb';
                thumb.alt = '';
                thumb.loading = 'lazy';
                thumb.decoding = 'async';
                if (item.thumbnail_url) thumb.src = item.thumbnail_url;
                thumb.onerror = () => thumb.classList.add('is-missing');
                const meta = document.createElement('span');
                meta.className = 'dataset-export-caption-meta';
                const imageName = document.createElement('strong');
                imageName.textContent = `#${String(item.index || 0).padStart(4, '0')} ${item.output_image_name || item.filename || ''}`;
                const captionName = document.createElement('small');
                captionName.textContent = item.output_caption_name || '';
                meta.append(imageName, captionName);
                if (item.error) {
                    const error = document.createElement('small');
                    error.className = 'dataset-export-preview-warning';
                    error.textContent = String(item.error);
                    meta.appendChild(error);
                }
                top.append(thumb, meta);
                top.addEventListener('click', () => {
                    const id = Number(item.image_id || 0);
                    if (id > 0) DM._setActive?.(id);
                    else if (item.abs_path && DM.localItemPaths) {
                        for (const [localId, path] of DM.localItemPaths.entries()) {
                            if (String(path) === String(item.abs_path)) {
                                DM._setActive?.(Number(localId));
                                break;
                            }
                        }
                    }
                });
                const textarea = document.createElement('textarea');
                textarea.className = 'dataset-export-caption-textarea';
                textarea.value = item.caption || '';
                textarea.rows = 4;
                let editId = Number(item.image_id || 0);
                if (!editId && item.abs_path && DM.localItemPaths) {
                    for (const [localId, path] of DM.localItemPaths.entries()) {
                        if (String(path) === String(item.abs_path)) {
                            editId = Number(localId);
                            break;
                        }
                    }
                }
                if (!editId) {
                    textarea.disabled = true;
                    textarea.placeholder = DM._t?.('dataset.exportPreviewLoadedOnlyEdit', 'Load this preview in Step 1 before editing it here.') || 'Load this preview before editing.';
                } else {
                    textarea.addEventListener('input', () => {
                        DM.captionEdits?.set?.(editId, textarea.value);
                        DM._refreshQueueItem?.(editId);
                        if (Number(DM.activeId) === editId) {
                            const activeTa = document.getElementById('dataset-editor-textarea');
                            if (activeTa) activeTa.value = textarea.value;
                            DM._renderTagPills?.();
                        }
                    });
                }
                const actions = document.createElement('div');
                actions.className = 'dataset-export-caption-actions';
                const translateBtn = document.createElement('button');
                translateBtn.type = 'button';
                translateBtn.className = 'btn btn-ghost btn-small';
                translateBtn.textContent = DM._t?.('dataset.translateToChinese', 'Translate to Chinese') || 'Translate to Chinese';
                const translation = document.createElement('div');
                translation.className = 'dataset-export-translation';
                translation.hidden = true;
                translateBtn.addEventListener('click', async () => {
                    translateBtn.disabled = true;
                    translation.hidden = false;
                    translation.textContent = DM._t?.('dataset.translationRunning', 'Translating...') || 'Translating...';
                    try {
                        const r = await fetch('/api/dataset/translate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                texts: [textarea.value || ''],
                                mode: (textarea.value || '').includes(',') ? 'tags' : 'caption',
                                target_lang: 'zh-CN',
                                provider_mode: document.getElementById('dataset-translation-provider-mode')?.value || 'vlm',
                                external_provider: document.getElementById('dataset-translation-external-provider')?.value || '',
                                prompt: document.getElementById('dataset-translation-prompt')?.value || '',
                            }),
                        });
                        const body = await r.json().catch(() => ({}));
                        if (!r.ok) {
                            const detail = body?.detail ?? body;
                            let message = `HTTP ${r.status}`;
                            if (detail && typeof detail === 'object') {
                                const provider = detail.provider ? `${detail.provider}` : '';
                                const errorType = detail.error_type ? `${detail.error_type}` : '';
                                const prefix = [provider, errorType].filter(Boolean).join(' / ');
                                message = `${prefix ? `${prefix}: ` : ''}${detail.error || detail.message || message}`;
                            } else if (typeof detail === 'string' && detail.trim()) {
                                message = detail;
                            }
                            throw new Error(message);
                        }
                        const text = (body.translations || [])[0] || '';
                        if (!String(text).trim()) {
                            throw new Error(DM._t?.('dataset.translationEmpty', 'The provider returned an empty translation. Try again or check VLM settings.') || 'The provider returned an empty translation.');
                        }
                        translation.innerHTML = '';
                        const copy = document.createElement('div');
                        copy.textContent = text;
                        const useBtn = document.createElement('button');
                        useBtn.type = 'button';
                        useBtn.className = 'btn btn-ghost btn-small';
                        useBtn.textContent = DM._t?.('dataset.useTranslation', 'Replace caption with translation') || 'Replace caption with translation';
                        useBtn.addEventListener('click', () => {
                            textarea.value = text;
                            textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        });
                        translation.append(copy, useBtn);
                    } catch (e) {
                        translation.textContent = e.message || String(e);
                    } finally {
                        translateBtn.disabled = false;
                    }
                });
                actions.appendChild(translateBtn);
                row.append(top, textarea, actions, translation);
                list.appendChild(row);
            }
        };

        try {
            const payload = DM._buildExportPayload ? DM._buildExportPayload() : null;
            if (payload) {
                payload.output_mode = outputMode;
                payload.limit = 72;
                const r = await fetch('/api/dataset/export-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: previewAbortController?.signal,
                    body: JSON.stringify(payload),
                });
                if (requestSeq !== previewRequestSeq) return;
                if (r.ok) {
                    renderCaptionReview(await r.json());
                    return;
                }
                const body = await r.json().catch(async () => ({ detail: await r.text().catch(() => '') }));
                const detail = body?.detail ?? body;
                const message = typeof detail === 'string'
                    ? detail
                    : (detail?.error || detail?.message || `HTTP ${r.status}`);
                renderPreviewError(list, `${DM._t?.('dataset.exportPreviewFailed', 'Preview failed') || 'Preview failed'}: ${message}`);
                return;
            }
        } catch (e) {
            if (e?.name === 'AbortError') return;
            if (requestSeq !== previewRequestSeq) return;
            renderPreviewError(list, e.message || String(e));
            return;
        }

        // FE-4 (decision #11, owner-approved 2026-07-12): the offline
        // fallback that used to re-implement services/dataset_naming.render_stem
        // in JS is gone -- two stem grammars WILL drift apart. The server
        // preview above is the only rendering path; reaching this line means
        // the export payload builder did not load, which is a bug, not a
        // supported offline mode.
        renderPreviewError(
            list,
            DM._t?.(
                'dataset.exportPreviewBuilderMissing',
                'Preview unavailable: the export payload builder did not load. Hard-refresh the page (Ctrl+F5); if it persists this is a bug.'
            ) || 'Preview unavailable: the export payload builder did not load.'
        );
    }

    function bindExportPreview() {
        let previewTimer = null;
        const schedule = () => {
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = setTimeout(() => {
                previewTimer = null;
                refreshExportPreview();
            }, 250);
        };
        for (const id of ['dataset-trigger', 'dataset-naming-pattern']) {
            document.getElementById(id)?.addEventListener('input', schedule);
        }
        document.querySelectorAll('input[name="dataset-naming-preset"]').forEach((r) => {
            r.addEventListener('change', schedule);
        });
    }

    DM._refreshExportPreview = refreshExportPreview;

    // Split of dataset-maker-pipeline.js's single init() (forced
    // non-verbatim) — this module keeps only its own binder. See
    // dataset/audit.js for the full note.
    function init() {
        bindExportPreview();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
