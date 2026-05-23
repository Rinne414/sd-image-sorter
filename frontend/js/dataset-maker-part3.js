/**
 * Dataset Maker - Part 3 (caption rendering via export-preview API,
 * export pre/post-flight modals, naming preset switching).
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---------- Caption rendering ----------
    DM._captionOptions = function () {
        const trigger = document.getElementById('dataset-trigger')?.value?.trim() || '';
        const blacklistText = document.getElementById('dataset-blacklist')?.value || '';
        const blacklist = blacklistText.split(',').map(s => s.trim()).filter(Boolean);
        const commonText = document.getElementById('dataset-common-tags')?.value || '';
        const append = commonText.split(',').map(s => s.trim()).filter(Boolean);
        const normalize = !!document.getElementById('dataset-underscore-to-space')?.checked;
        const opts = {
            preset_id: 'custom',
            template_override: '{trigger}, {tags:filtered}, {append}',
            trigger,
            blacklist,
            replace_rules: {},
            max_tags: 0,
            append,
        };
        opts.underscore_to_space_override = !!normalize;
        opts.preserve_underscore_prefixes_override = ['score_'];
        return opts;
    };

    DM._fetchMissingMeta = async function () {
        const missing = this.imageIds.filter(id => !this.meta.has(id));
        if (missing.length === 0) return;
        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: missing.slice(0, 500), preset_id: 'custom' }),
            });
            if (!r.ok) return;
            const data = await r.json();
            for (const item of (data.results || [])) {
                this.meta.set(Number(item.image_id), {
                    filename: item.filename || '',
                    thumbnail_path: item.thumbnail_path || '',
                });
                if (item.rendered) this.captions.set(Number(item.image_id), item.rendered);
            }
        } catch (e) { /* swallow - queue will just show fallback labels */ }
    };

    DM._fetchMissingCaptions = async function () {
        const missing = this.imageIds.filter(id => !this.captions.has(id));
        if (missing.length === 0) return;
        await this._fetchCaptionsFor(missing);
    };

    DM._refreshAllCaptions = async function () {
        // Re-render captions for the whole queue to reflect updated
        // common-tags / blacklist / underscore settings.
        if (this.imageIds.length === 0) return;
        await this._fetchCaptionsFor(this.imageIds.slice());
        // If the user is editing one, refresh its textarea (unless they
        // already typed an override -- their edits are sticky)
        if (this.activeId != null && !this.captionEdits.has(this.activeId)) {
            const ta = document.getElementById('dataset-editor-textarea');
            if (ta) ta.value = this.captions.get(this.activeId) || '';
        }
    };

    DM._fetchCaptionsFor = async function (ids) {
        if (ids.length === 0) return;
        const opts = this._captionOptions();
        try {
            const r = await fetch('/api/tags/export-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: ids.slice(0, 500), ...opts }),
            });
            if (!r.ok) return;
            const data = await r.json();
            for (const item of (data.results || [])) {
                if (item.rendered != null) this.captions.set(Number(item.image_id), item.rendered);
                if (!this.meta.has(Number(item.image_id))) {
                    this.meta.set(Number(item.image_id), {
                        filename: item.filename || '',
                        thumbnail_path: item.thumbnail_path || '',
                    });
                }
            }
        } catch (e) { /* */ }
    };

    // ---------- Tag all ----------
    DM._tagAll = async function () {
        if (this.imageIds.length === 0) {
            this._toast(this._t('dataset.queueEmptyHeadline', 'No images yet'), 'warning');
            return;
        }
        try {
            const r = await fetch('/api/tag/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: this.imageIds, retag_all: true }),
            });
            if (!r.ok) {
                const body = await r.text();
                this._toast(`Tagging failed: ${body.slice(0, 120)}`, 'error');
                return;
            }
            this._toast(this._t('dataset.tagAllStarted',
                'Tagging started in the background. The progress bar at the top of the screen tracks it.'),
                'success');
        } catch (e) {
            this._toast(`Tagging failed: ${e.message}`, 'error');
        }
    };

    // ---------- Naming preset ----------
    DM._currentPreset = function () {
        const checked = document.querySelector('input[name="dataset-naming-preset"]:checked');
        return checked ? checked.value : 'keep';
    };

    DM._effectivePattern = function () {
        const preset = this._currentPreset();
        if (preset === 'keep') return '{filename}';
        if (preset === 'renumber') return '{trigger}_{index:03d}';
        // custom
        return document.getElementById('dataset-naming-pattern')?.value || '{trigger}_{index:03d}';
    };

    DM._onPresetChange = function () {
        const preset = this._currentPreset();
        const triggerRow = document.getElementById('dataset-trigger-row');
        const customRow = document.getElementById('dataset-custom-row');
        if (triggerRow) triggerRow.hidden = (preset !== 'renumber');
        if (customRow) customRow.hidden = (preset !== 'custom');
        this._updateNamingPreview();
    };

    DM._updateNamingPreview = function () {
        const previewEl = document.getElementById('dataset-naming-preview');
        if (!previewEl) return;
        const preset = this._currentPreset();
        if (preset !== 'renumber') {
            previewEl.textContent = '';
            return;
        }
        const trigger = document.getElementById('dataset-trigger')?.value?.trim() || 'subject';
        const sampleStem = trigger;
        previewEl.textContent = `${sampleStem}_001.png  +  ${sampleStem}_001.txt`;
    };

    // ---------- Export readiness ----------
    DM._validateOutputFolder = function () {
        const wrap = document.querySelector('.dataset-required-label');
        const value = (document.getElementById('dataset-output-folder')?.value || '').trim();
        if (!wrap) return !!value;
        wrap.classList.toggle('valid', !!value);
        wrap.classList.toggle('invalid', false);  // only mark invalid after blur/submit attempt
        return !!value;
    };

    DM._isReadyToExport = function () {
        if (this.imageIds.length === 0) return false;
        if (!(document.getElementById('dataset-output-folder')?.value || '').trim()) return false;
        return true;
    };

    DM._updateExportEnabled = function () {
        const btn = document.getElementById('btn-dataset-export');
        const hint = document.getElementById('dataset-export-disabled-hint');
        const ready = this._isReadyToExport();
        if (btn) btn.disabled = !ready;
        if (hint) hint.hidden = ready;
    };

    // ---------- Confirm modal ----------
    DM._showConfirmModal = function () {
        if (!this._isReadyToExport()) {
            this._validateOutputFolder();
            const wrap = document.querySelector('.dataset-required-label');
            if (wrap && !(document.getElementById('dataset-output-folder')?.value || '').trim()) {
                wrap.classList.add('invalid');
            }
            this._toast(this._t('dataset.exportDisabledHint',
                'Add at least one image and pick an output folder to enable.'), 'warning');
            return;
        }

        const modal = document.getElementById('dataset-confirm-modal');
        const list = document.getElementById('dataset-confirm-summary');
        if (!modal || !list) return;

        const imageOp = document.getElementById('dataset-image-op')?.value || 'copy';
        const folder = document.getElementById('dataset-output-folder')?.value?.trim() || '';
        const preset = this._currentPreset();

        const actionLabel = (imageOp === 'move')
            ? this._t('dataset.confirmActionMove', 'moved (removed from original location)')
            : this._t('dataset.confirmActionCopy', 'copied (originals stay in place)');

        let namingLabel = '';
        if (preset === 'keep') {
            namingLabel = this._t('dataset.namingKeepLabel', 'kept as the original filenames');
        } else if (preset === 'renumber') {
            const trigger = document.getElementById('dataset-trigger')?.value?.trim() || 'subject';
            namingLabel = this._t('dataset.namingRenumberLabel',
                'renumbered: {trigger}_001.png, {trigger}_002.png, ...',
                { trigger });
        } else {
            const pattern = document.getElementById('dataset-naming-pattern')?.value || '';
            namingLabel = this._t('dataset.namingCustomLabel',
                'custom pattern: {pattern}', { pattern });
        }

        const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));

        const editedCount = this.captionEdits.size;
        const items = [
            this._t('dataset.confirmSummaryImages',
                '<strong>{count}</strong> images will be {action}',
                { count: this.imageIds.length, action: escapeHtml(actionLabel) }),
            this._t('dataset.confirmSummaryFolder',
                'Output folder: <code>{folder}</code>',
                { folder: escapeHtml(folder) }),
            this._t('dataset.confirmSummaryNaming',
                'Naming: <strong>{naming}</strong>',
                { naming: escapeHtml(namingLabel) }),
            this._t('dataset.confirmSummaryCaptions',
                '<strong>{count}</strong> .txt caption files will be written',
                { count: this.imageIds.length }),
        ];
        if (editedCount > 0) {
            items.push(this._t('dataset.confirmSummaryEdited',
                '<strong>{count}</strong> have your manually-edited captions',
                { count: editedCount }));
        }

        list.innerHTML = items.map(s => `<li>${s}</li>`).join('');
        modal.hidden = false;
    };

    DM._hideConfirmModal = function () {
        const modal = document.getElementById('dataset-confirm-modal');
        if (modal) modal.hidden = true;
    };

    // ---------- Run export ----------
    DM._runExport = async function () {
        this._hideConfirmModal();

        const folder = document.getElementById('dataset-output-folder')?.value?.trim();
        const pattern = this._effectivePattern();
        const trigger = document.getElementById('dataset-trigger')?.value || '';
        const imageOp = document.getElementById('dataset-image-op')?.value || 'copy';
        const overwrite = document.getElementById('dataset-overwrite')?.value || 'unique';
        const normalize = !!document.getElementById('dataset-underscore-to-space')?.checked;
        const blacklist = (document.getElementById('dataset-blacklist')?.value || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const commonTags = (document.getElementById('dataset-common-tags')?.value || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const image_overrides = {};
        for (const [id, val] of this.captionEdits.entries()) {
            image_overrides[String(id)] = val;
        }

        const btn = document.getElementById('btn-dataset-export');
        if (btn) {
            btn.disabled = true;
            btn.dataset.busy = '1';
        }

        try {
            const r = await fetch('/api/dataset/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_ids: this.imageIds,
                    output_folder: folder,
                    naming_pattern: pattern,
                    trigger,
                    image_op: imageOp,
                    overwrite_policy: overwrite,
                    normalize_tag_underscores: normalize,
                    blacklist,
                    common_tags: commonTags,
                    image_overrides,
                }),
            });
            if (!r.ok) {
                const body = await r.text();
                this._showResultModal('failed', { errorMessages: [body.slice(0, 400)], output_folder: folder });
                return;
            }
            const data = await r.json();
            this._showResultModal(data.status || 'ok', data);
        } catch (e) {
            this._showResultModal('failed', { errorMessages: [e.message], output_folder: folder });
        } finally {
            if (btn) {
                btn.dataset.busy = '';
                this._updateExportEnabled();
            }
        }
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

        const resolved = ['ok', 'partial', 'failed'].includes(status) ? status : 'failed';
        const folder = data.output_folder || '';
        const exported = Number(data.exported || 0);
        const errors = Number(data.error_count || (data.errorMessages?.length || 0));
        const skipped = Number(data.skipped || 0);
        const errorMessages = data.error_messages || data.errorMessages || [];

        if (statusEl) {
            statusEl.className = `dataset-result-status ${resolved}`;
            statusEl.textContent = resolved === 'ok' ? '✓' : (resolved === 'partial' ? '⚠' : '✕');
        }
        if (titleEl) {
            const map = { ok: 'dataset.resultOk', partial: 'dataset.resultPartial', failed: 'dataset.resultFailed' };
            const def = { ok: 'Done!', partial: 'Partial success', failed: 'Export failed' };
            titleEl.textContent = this._t(map[resolved], def[resolved]);
        }
        if (detailEl) {
            const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
                '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
            }[c]));
            let html = '';
            if (resolved === 'ok') {
                html = this._t('dataset.resultDetailOk',
                    '<strong>{count}</strong> image+caption pairs exported to <code>{folder}</code>',
                    { count: exported, folder: escapeHtml(folder) });
            } else if (resolved === 'partial') {
                html = this._t('dataset.resultDetailPartial',
                    '<strong>{exported}</strong> exported, <strong>{errors}</strong> failed, <strong>{skipped}</strong> skipped. Files are in <code>{folder}</code>',
                    { exported, errors, skipped, folder: escapeHtml(folder) });
            } else {
                html = this._t('dataset.resultDetailFailed',
                    'No files were written. Check the error details below.');
            }
            detailEl.innerHTML = html;
        }
        if (errorsBox && errorsList) {
            if (errorMessages.length === 0) {
                errorsBox.hidden = true;
                errorsList.innerHTML = '';
            } else {
                errorsBox.hidden = false;
                errorsList.innerHTML = errorMessages.map(m => `<li>${String(m).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</li>`).join('');
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
