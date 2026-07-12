/**
 * Dataset size + training-step estimator (standing optimize directive;
 * competitive benchmark 2026-07: Danbooru-Dataset-Filter ships live size +
 * step planning, no similar tool pairs it with the export button).
 *
 * Steps math follows the kohya sd-scripts convention (repeats come from the
 * `NN_concept` folder prefix; steps per epoch = ceil(images * repeats /
 * batch_size), total = per-epoch * epochs — see kohya-ss/sd-scripts README
 * training docs). The numbers are expectations management, not a trainer
 * contract: exact steps vary with bucketing and gradient accumulation.
 */
(function () {
    'use strict';

    const STORE_KEY = 'sd-image-sorter-dataset-estimator';

    function t(en, zh) {
        try {
            const lang = window.I18n?.getLang?.() || document.documentElement.lang || '';
            return String(lang).toLowerCase().startsWith('zh') ? zh : en;
        } catch (_) { return en; }
    }

    function formatBytes(bytes) {
        if (!bytes) return '';
        if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
    }

    const DatasetEstimator = {
        get dm() { return window.DatasetMaker || null; },

        init() {
            const wrap = document.getElementById('dataset-steps-estimator');
            if (!wrap) return;
            try {
                const stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
                for (const [key, id] of [['repeats', 'dataset-est-repeats'], ['epochs', 'dataset-est-epochs'], ['batch', 'dataset-est-batch']]) {
                    const input = document.getElementById(id);
                    if (input && Number(stored[key]) > 0) input.value = String(stored[key]);
                }
            } catch (_) { /* defaults stand */ }
            for (const id of ['dataset-est-repeats', 'dataset-est-epochs', 'dataset-est-batch']) {
                document.getElementById(id)?.addEventListener('input', () => {
                    this._persist();
                    this.refresh();
                });
            }
            window.addEventListener('dataset:changed', () => this.refresh());
            this.refresh();
        },

        _persist() {
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify({
                    repeats: Number(document.getElementById('dataset-est-repeats')?.value) || 10,
                    epochs: Number(document.getElementById('dataset-est-epochs')?.value) || 10,
                    batch: Number(document.getElementById('dataset-est-batch')?.value) || 2,
                }));
            } catch (_) {}
        },

        refresh() {
            const wrap = document.getElementById('dataset-steps-estimator');
            const line = document.getElementById('dataset-steps-line');
            if (!wrap || !line) return;
            const dm = this.dm;
            // `|| fallback` (not ??): _getLogicalDatasetCount returns 0 when no
            // manifest tokens exist, and the loaded queue is then the truth --
            // the same fallback dataset-maker-pipeline.js uses.
            const images = Number(dm?._getLogicalDatasetCount?.() || dm?.imageIds?.length || 0);
            if (!images) {
                wrap.hidden = true;
                return;
            }
            wrap.hidden = false;
            const repeats = Math.max(1, Number(document.getElementById('dataset-est-repeats')?.value) || 10);
            const epochs = Math.max(1, Number(document.getElementById('dataset-est-epochs')?.value) || 10);
            const batch = Math.max(1, Number(document.getElementById('dataset-est-batch')?.value) || 2);
            const steps = Math.ceil((images * repeats) / batch) * epochs;

            let bytes = 0;
            for (const id of dm?.imageIds || []) {
                bytes += Number(dm?.meta?.get?.(Number(id))?.file_size || 0);
            }
            const sizePart = bytes ? ` · ${formatBytes(bytes)}` : '';
            line.textContent = t(
                `${images} images${sizePart} · ≈ ${steps.toLocaleString()} steps`,
                `${images} 张图${sizePart} · 约 ${steps.toLocaleString()} steps`);
            line.title = t(
                'kohya convention: ceil(images × repeats ÷ batch) × epochs. Actual steps vary with bucketing/gradient accumulation.',
                'kohya 惯例：ceil(图数 × repeats ÷ batch) × epochs。实际步数受 bucketing/梯度累积影响。');
        },
    };

    window.DatasetEstimator = DatasetEstimator;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => DatasetEstimator.init());
    } else {
        DatasetEstimator.init();
    }
})();
