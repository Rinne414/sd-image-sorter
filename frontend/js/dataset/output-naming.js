/**
 * Dataset Maker — output-mode gating (folder vs beside_image) + naming preset/preview + export readiness.
 * Moved VERBATIM from dataset-maker-part3.js L18-132 + L449-526.
 * Load order is pinned by the ordered async=false loader in dataset/core.js.
 */
(function () {
    'use strict';
    if (!window.DatasetMaker) return;
    const DM = window.DatasetMaker;

    // ---------- Caption rendering ----------
    DM._outputMode = function () {
        return document.querySelector('input[name="dataset-output-mode"]:checked')?.value || 'folder';
    };

    DM._sidecarCapabilityStats = function () {
        const ids = Array.from(this.imageIds || []);
        let besideReady = 0;
        let cacheOnly = 0;
        let unknown = 0;
        for (const id of ids) {
            const meta = this.meta?.get?.(Number(id)) || {};
            const token = String(meta.folder_scan_token || '').trim();
            if (token) {
                if (this.localManifestTokens?.has?.(token)) continue;
                besideReady += 1;
                continue;
            }
            const capability = String(meta.sidecar_capability || '').trim();
            if (capability === 'beside_image') besideReady += 1;
            else if (capability === 'cache_only') cacheOnly += 1;
            else unknown += 1;
        }
        if (this.localManifestTokens) {
            for (const [token, source] of this.localManifestTokens.entries()) {
                const total = Number(source?.total || 0) || 0;
                const excluded = source?.excludedPaths?.size || 0;
                const count = Math.max(0, total - excluded);
                if (count <= 0) continue;
                besideReady += count;
            }
        }
        return { total: besideReady + cacheOnly + unknown, besideReady, cacheOnly, unknown };
    };

    DM._exportDisabledReason = function () {
        if ((this.imageIds || []).length === 0) {
            return this._t('dataset.exportNeedImages', 'Add at least one image to enable export.');
        }
        const outputMode = this._outputMode();
        if (outputMode === 'beside_image') {
            const stats = this._sidecarCapabilityStats();
            if (stats.total <= 0) {
                return this._t('dataset.exportNeedBesideSource',
                    'Use Gallery or folder path scan images before writing .txt beside originals.');
            }
            // v3.4.4 fix #7: cache-only items (drag/drop, ZIP, RAR) CAN write
            // a same-name .txt beside the imported app-data copy — the import
            // notice in the UI explicitly promises that. Only genuinely UNKNOWN
            // sources (no resolved path at all) actually block the write, so
            // gate on those alone instead of cacheOnly + unknown.
            if (stats.unknown > 0) {
                return this._t('dataset.exportBesideBlocked',
                    '{count} imports have an unknown source path and cannot write beside originals.',
                    { count: stats.unknown });
            }
            return '';
        }
        if (!(document.getElementById('dataset-output-folder')?.value || '').trim()) {
            return this._t('dataset.exportNeedFolder', 'Pick an output folder to enable folder export.');
        }
        return '';
    };

    DM._syncSourceCapabilityStatus = function () {
        const status = document.getElementById('dataset-sidecar-source-status');
        if (!status) return;
        const stats = this._sidecarCapabilityStats();
        if (stats.total <= 0) {
            status.textContent = this._t('dataset.sidecarSourceStatusEmpty',
                'Same-name .txt beside originals: use Gallery or folder path scan.');
            return;
        }
        status.textContent = this._t('dataset.sidecarSourceStatus',
            '{ready} can write beside originals; {cache} cache-only; {unknown} unknown.',
            { ready: stats.besideReady, cache: stats.cacheOnly, unknown: stats.unknown });
    };

    DM._syncOutputModeUi = function () {
        const outputMode = this._outputMode();
        const stats = this._sidecarCapabilityStats();
        const warning = document.getElementById('dataset-beside-image-warning');
        const besideRadio = document.querySelector('input[name="dataset-output-mode"][value="beside_image"]');
        const folderRadio = document.querySelector('input[name="dataset-output-mode"][value="folder"]');
        // v3.4.4 fix #7: only genuinely unknown sources block beside_image.
        // cache_only items write beside their imported app-data copy (the
        // import notice promises this), so they must NOT disable the radio
        // or auto-flip the user's selection back to folder.
        const besideBlocked = stats.total > 0 && stats.unknown > 0;
        if (besideRadio) {
            besideRadio.disabled = besideBlocked;
        }
        const effectiveMode = this._outputMode();
        document.querySelectorAll('[data-export-folder-only]').forEach((el) => {
            el.hidden = effectiveMode === 'beside_image';
        });
        if (warning) {
            if (besideBlocked) {
                warning.hidden = false;
                warning.textContent = this._t('dataset.outputModeBesideBlocked',
                    '{count} imports have an unknown source path and cannot write beside originals. Use folder export, or import via Gallery/folder path scan.',
                    { count: stats.unknown });
            } else if (effectiveMode === 'beside_image') {
                warning.hidden = false;
                warning.textContent = this._t('dataset.outputModeBesideActive',
                    'This will write same-name .txt files next to the original images and will not copy or move image files.');
            } else {
                warning.hidden = true;
                warning.textContent = '';
            }
        }
        this._refreshPairChip?.();
        this._syncSourceCapabilityStatus?.();
    };

    // ---------- Naming preset ----------
    DM._currentPreset = function () {
        const checked = document.querySelector('input[name="dataset-naming-preset"]:checked');
        return checked ? checked.value : 'keep';
    };

    DM._effectivePattern = function () {
        const preset = this._currentPreset();
        if (preset === 'keep') return '{filename}';
        // v3.5.0 audit MED-5: with no trigger word, '{trigger}_{index}'
        // exported files named '_001.png'. Drop the orphaned underscore.
        const hasTrigger = !!(document.getElementById('dataset-trigger')?.value || '').trim();
        const renumberPattern = hasTrigger ? '{trigger}_{index:03d}' : '{index:03d}';
        if (preset === 'renumber') return renumberPattern;
        // custom
        return document.getElementById('dataset-naming-pattern')?.value || renumberPattern;
    };

    DM._onPresetChange = function () {
        const preset = this._currentPreset();
        const customRow = document.getElementById('dataset-custom-row');
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
        // Mirror _effectivePattern exactly: no trigger word -> plain '001',
        // so the preview never promises a name the export won't produce.
        const trigger = document.getElementById('dataset-trigger')?.value?.trim() || '';
        const sampleStem = trigger ? `${trigger}_001` : '001';
        const firstId = (this.imageIds || [])[0];
        const filename = this.meta?.get?.(firstId)?.filename || '';
        const match = String(filename).match(/\.([^.]+)$/);
        const ext = match ? match[1].toLowerCase() : 'png';
        previewEl.textContent = `${sampleStem}.${ext}  +  ${sampleStem}.txt`;
    };

    // ---------- Export readiness ----------
    DM._validateOutputFolder = function () {
        const wrap = document.querySelector('.dataset-required-label');
        if (this._outputMode() === 'beside_image') {
            if (wrap) {
                wrap.classList.toggle('valid', true);
                wrap.classList.toggle('invalid', false);
            }
            return true;
        }
        const value = (document.getElementById('dataset-output-folder')?.value || '').trim();
        if (!wrap) return !!value;
        wrap.classList.toggle('valid', !!value);
        wrap.classList.toggle('invalid', false);  // only mark invalid after blur/submit attempt
        return !!value;
    };

    DM._isReadyToExport = function () {
        return !this._exportDisabledReason();
    };

    DM._updateExportEnabled = function () {
        const btn = document.getElementById('btn-dataset-export');
        const hint = document.getElementById('dataset-export-disabled-hint');
        const ready = this._isReadyToExport();
        if (btn) btn.disabled = !ready;
        if (hint) {
            hint.hidden = ready;
            if (!ready) hint.textContent = this._exportDisabledReason();
        }
        this._syncOutputModeUi?.();
        this._refreshExportPreview?.();
    };
})();
