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

    // ``unknown`` counts only local items with no file path: the export payload
    // cannot include them. Library items always resolve their path on the
    // backend, so a missing capability hint does not make them unknown.
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
            if (this.isLocalId?.(id) && !this.localItemPaths?.get?.(Number(id))) {
                unknown += 1;
                continue;
            }
            const capability = String(meta.sidecar_capability || '').trim();
            if (capability === 'cache_only') cacheOnly += 1;
            else besideReady += 1;
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

    DM._baseExportDisabledReason = function () {
        if ((this.imageIds || []).length === 0) {
            return this._t('dataset.exportNeedImages', 'Add at least one image to enable export.');
        }
        const trainerReason = this._trainerContractDisabledReason?.() || '';
        if (trainerReason) return trainerReason;
        const outputMode = this._outputMode();
        if (outputMode === 'beside_image') {
            const stats = this._sidecarCapabilityStats();
            if (stats.total <= 0) {
                return this._t('dataset.exportNeedBesideSource',
                    'Use Gallery or folder path scan images before writing .txt beside originals.');
            }
            // Items with no known path are left out (the confirm dialog and
            // the output-mode note say how many); they never block the rest.
            return '';
        }
        if (!(document.getElementById('dataset-output-folder')?.value || '').trim()) {
            return this._t('dataset.exportNeedFolder', 'Pick an output folder to enable folder export.');
        }
        return '';
    };

    DM._exportDisabledReason = function () {
        const baseReason = this._baseExportDisabledReason();
        if (baseReason) return baseReason;
        const subjectCropReason = this._subjectCropDisabledReason?.();
        if (subjectCropReason) return subjectCropReason;
        const bucketResizeReason = this._bucketResizeDisabledReason?.();
        if (bucketResizeReason) return bucketResizeReason;
        const watermarkRemovalReason = this._watermarkRemovalDisabledReason?.();
        if (watermarkRemovalReason) return watermarkRemovalReason;
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
        this._syncTrainerOutputControls?.();
        const outputMode = this._outputMode();
        const stats = this._sidecarCapabilityStats();
        const warning = document.getElementById('dataset-beside-image-warning');
        const besideRadio = document.querySelector('input[name="dataset-output-mode"][value="beside_image"]');
        const folderRadio = document.querySelector('input[name="dataset-output-mode"][value="folder"]');
        // Items with no known path never disable this mode: they are left
        // out and the note below says how many. cache_only items write beside
        // their imported app-data copy (the import notice promises this).
        const trainerPackageSelected = this._hasSelectedTrainerPackage?.() === true;
        if (besideRadio) {
            besideRadio.disabled = trainerPackageSelected;
        }
        const effectiveMode = this._outputMode();
        document.querySelectorAll('[data-export-folder-only]').forEach((el) => {
            el.hidden = effectiveMode === 'beside_image';
        });
        if (warning) {
            if (effectiveMode === 'beside_image' && stats.unknown > 0) {
                warning.hidden = false;
                warning.textContent = this._t('dataset.outputModeBesideUnknown',
                    '{count} image(s) have no known file path, so they are left out. The rest get a .txt beside the original.',
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
        const hasTrigger = !!this._canonicalDatasetTrigger(
            document.getElementById('dataset-trigger')?.value || '',
        );
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
        this._markReadinessStale?.();
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
        const trigger = this._canonicalDatasetTrigger(
            document.getElementById('dataset-trigger')?.value || '',
        );
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
            if (!ready) {
                hint.removeAttribute('data-i18n');
                hint.textContent = this._exportDisabledReason();
            }
        }
        this._syncOutputModeUi?.();
        this._refreshExportPreview?.();
    };
})();
