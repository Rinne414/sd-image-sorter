/**
 * artist/preferences.js — artist-ident.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/artist-ident.js
 * pre-cut lines 62-133 + 350-361 (of 1,171): getThresholdValue,
 * syncThresholdDisplay, capturePreferences, savePreferences,
 * applySavedPreferences, resetPreferenceControls, resetSavedPreferences
 * and _syncControls (App.Prefs artist defaults + threshold/local-model
 * control sync). savePreferences/resetSavedPreferences are the
 * app/settings.js seams; getThresholdValue is a gallery/modal-analysis.js
 * seam. Classic non-strict script: joins the ONE unsealed
 * window.ArtistIdent object declared in artist/core.js, which loads
 * FIRST; artist/boot.js runs the DOMContentLoaded tail LAST.
 */
Object.assign(window.ArtistIdent, {
    getThresholdValue() {
        const rawValue = parseFloat(document.getElementById('artist-threshold')?.value || this.thresholdDefaults.value);
        return Number.isFinite(rawValue) ? rawValue : this.thresholdDefaults.value;
    },

    syncThresholdDisplay() {
        const thresholdSlider = document.getElementById('artist-threshold');
        const thresholdValue = document.getElementById('artist-threshold-value');
        if (!thresholdSlider || !thresholdValue) return;
        thresholdValue.textContent = this.getThresholdValue().toFixed(2);
    },

    capturePreferences() {
        const source = document.getElementById('artist-model-source')?.value || 'huggingface';
        return {
            modelSource: String(source || 'huggingface').trim() || 'huggingface',
            modelPath: String(document.getElementById('artist-model-path')?.value || '').trim(),
            threshold: this.getThresholdValue(),
            useGpu: document.getElementById('artist-use-gpu') ? !!document.getElementById('artist-use-gpu').checked : true,
        };
    },

    savePreferences() {
        const saved = window.App?.Prefs?.setArtistDefaults?.(this.capturePreferences()) || false;
        window.App?.syncSettingsPreferenceStatus?.();
        return saved;
    },

    applySavedPreferences() {
        const prefs = window.App?.Prefs?.getArtistDefaults?.();
        if (!prefs || typeof prefs !== 'object') return false;

        const source = document.getElementById('artist-model-source');
        const path = document.getElementById('artist-model-path');
        const threshold = document.getElementById('artist-threshold');
        const useGpu = document.getElementById('artist-use-gpu');

        if (source && prefs.modelSource) source.value = prefs.modelSource;
        if (path && prefs.modelPath != null) path.value = String(prefs.modelPath || '');
        const savedThreshold = Number(prefs.threshold);
        if (threshold && Number.isFinite(savedThreshold) && savedThreshold >= 0 && savedThreshold <= 0.25) {
            threshold.value = String(savedThreshold);
        }
        if (useGpu && typeof prefs.useGpu === 'boolean') {
            useGpu.checked = prefs.useGpu;
        }
        this._syncControls();
        window.App?.syncSettingsPreferenceStatus?.();
        return true;
    },

    resetPreferenceControls() {
        const source = document.getElementById('artist-model-source');
        const path = document.getElementById('artist-model-path');
        const threshold = document.getElementById('artist-threshold');
        const useGpu = document.getElementById('artist-use-gpu');

        if (source) source.value = 'huggingface';
        if (path) path.value = '';
        if (threshold) threshold.value = String(this.thresholdDefaults.value);
        if (useGpu) useGpu.checked = true;
        this._syncControls();
    },

    resetSavedPreferences(options = {}) {
        window.App?.Prefs?.clearArtistDefaults?.();
        if (options.apply) {
            this.resetPreferenceControls();
        }
        window.App?.syncSettingsPreferenceStatus?.();
    },

    _syncControls() {
        this.syncThresholdDisplay();

        const modelSource = document.getElementById('artist-model-source');
        const localModelGroup = document.getElementById('artist-local-model-group');
        if (modelSource && localModelGroup) {
            localModelGroup.style.display = modelSource.value === 'local' ? 'block' : 'none';
        }

        this.refreshAvailabilityState();
    },

});
