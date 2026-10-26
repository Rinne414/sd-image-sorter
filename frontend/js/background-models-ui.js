/**
 * SD Image Sorter - "Background" line in Settings > General.
 *
 * Shows which AI models are loaded right now (CPU or GPU, idle or in use),
 * lets the user pick how long an unused model stays loaded (5 / 10 / 30
 * minutes / never; backend/model_residency.py releases it) and frees them at
 * once with "Unload now". The line refreshes every few seconds while it is on
 * screen and stops when Settings is closed.
 *
 * API: GET/PATCH /api/background-models, POST /api/background-models/unload.
 */
(function () {
    'use strict';

    // Checked every second so the line fills as soon as Settings opens; read
    // from the server every 5 s while it stays on screen.
    const TICK_MS = 1000;
    const REFRESH_EVERY_TICKS = 5;
    const STANDARD_MINUTES = ['5', '10', '30', '0'];
    const MODEL_NAMES = {
        tagger: ['settings.bgModelTagger', 'Tagger'],
        'cl-tagger': ['settings.bgModelClTagger', 'CL Tagger'],
        'oppai-tagger': ['settings.bgModelOppai', 'OppaiOracle tagger'],
        clip: ['settings.bgModelClip', 'CLIP search'],
        aesthetic: ['settings.bgModelAesthetic', 'Aesthetic score'],
        artist: ['settings.bgModelArtist', 'Artist ID'],
        style: ['settings.bgModelStyle', 'Style vectors (CSD)'],
        censor: ['settings.bgModelCensor', 'Censor detection'],
        nudenet: ['settings.bgModelNudenet', 'NudeNet'],
        toriigate: ['settings.bgModelToriigate', 'ToriiGate captions'],
        florence2: ['settings.bgModelFlorence', 'Florence-2 captions'],
    };

    function t(key, fallback, params) {
        const value = window.I18n.t(key, params);
        return value && value !== key ? value : window.I18n.format(fallback, params);
    }

    function api() {
        return window.App?.API;
    }

    function toast(message, type) {
        window.App?.showToast?.(message, type);
    }

    function modelName(key) {
        const entry = MODEL_NAMES[key];
        return entry ? t(entry[0], entry[1]) : key;
    }

    function clockTime(epochSeconds) {
        return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function describeModel(model) {
        const device = model.device === 'gpu' ? 'GPU' : 'CPU';
        const state = model.in_use
            ? t('settings.backgroundInUse', 'in use')
            : t('settings.backgroundIdleFor', 'idle {minutes} min', { minutes: Math.floor(model.idle_seconds / 60) });
        return `${modelName(model.key)} (${device}, ${state})`;
    }

    function describeNote(data) {
        const fallback = (data.gpu_busy_fallbacks || [])[0];
        if (fallback) {
            return t('settings.backgroundGpuBusy', 'At {time} the GPU was busy, so {model} ran on the CPU.', {
                time: clockTime(fallback.at),
                model: String(fallback.label || '').replace(/^tagger:/, ''),
            });
        }
        const last = data.last_release;
        if (!last) return '';
        return t('settings.backgroundLastRelease', 'Freed at {time}: {list}', {
            time: clockTime(last.at),
            list: last.keys.map(modelName).join(', '),
        });
    }

    const BackgroundModels = {
        _timer: null,
        _data: null,
        _wasVisible: false,
        _ticks: 0,

        init() {
            const select = document.getElementById('settings-background-idle');
            const unload = document.getElementById('btn-settings-background-unload');
            if (!select || !unload) return;
            select.addEventListener('change', () => this.saveIdle(select.value));
            unload.addEventListener('click', () => this.unloadNow());
            document.addEventListener('languageChanged', () => this.render());
            this._timer = window.setInterval(() => this.refreshIfVisible(), TICK_MS);
        },

        isVisible() {
            const row = document.getElementById('settings-background-row');
            return Boolean(row && row.offsetParent !== null && !document.hidden);
        },

        refreshIfVisible() {
            const visible = this.isVisible();
            const shownNow = visible && !this._wasVisible;
            this._wasVisible = visible;
            if (!visible) return;
            this._ticks = shownNow ? 0 : (this._ticks || 0) + 1;
            if (this._ticks % REFRESH_EVERY_TICKS === 0) this.refresh();
        },

        async refresh() {
            try {
                this._data = await api().get('/api/background-models');
            } catch (error) {
                this._data = null;
                this.setStatus(t('settings.backgroundLoadFailed', 'Could not read which models are loaded.'), '');
                return;
            }
            this.render();
        },

        setStatus(text, note) {
            const status = document.getElementById('settings-background-status');
            const noteNode = document.getElementById('settings-background-note');
            if (status) status.textContent = text;
            if (noteNode) {
                noteNode.textContent = note;
                noteNode.hidden = !note;
            }
        },

        render() {
            const data = this._data;
            if (!data) return;
            this.syncSelect(data.idle_unload_minutes);
            const models = data.models || [];
            const text = models.length
                ? t('settings.backgroundLoaded', 'Loaded now: {list}', { list: models.map(describeModel).join(', ') })
                : t('settings.backgroundNone', 'No AI model is loaded right now.');
            this.setStatus(text, describeNote(data));
            const unload = document.getElementById('btn-settings-background-unload');
            if (unload) unload.disabled = models.length === 0;
        },

        syncSelect(minutes) {
            const select = document.getElementById('settings-background-idle');
            if (!select || document.activeElement === select) return;
            const value = String(Number(minutes));
            let custom = select.querySelector('option[data-custom]');
            if (!STANDARD_MINUTES.includes(value)) {
                if (!custom) {
                    custom = document.createElement('option');
                    custom.dataset.custom = '1';
                    select.appendChild(custom);
                }
                custom.value = value;
                custom.textContent = t('settings.backgroundIdleCustom', '{minutes} minutes', { minutes: value });
            } else if (custom) {
                custom.remove();
            }
            select.value = value;
        },

        async saveIdle(value) {
            try {
                this._data = await api().patch('/api/background-models', { minutes: Number(value) });
                this.render();
            } catch (error) {
                toast(typeof window.formatUserError === 'function' ? window.formatUserError(error) : (error?.message || String(error)), 'error');
                await this.refresh();
            }
        },

        async unloadNow() {
            const unload = document.getElementById('btn-settings-background-unload');
            if (unload) unload.disabled = true;
            try {
                const result = await api().post('/api/background-models/unload', {});
                this._data = result;
                this.render();
                this.reportUnload(result);
            } catch (error) {
                toast(typeof window.formatUserError === 'function' ? window.formatUserError(error) : (error?.message || String(error)), 'error');
                await this.refresh();
            }
        },

        reportUnload(result) {
            const released = (result.released || []).map(modelName);
            const busy = (result.busy || []).map(modelName);
            if (released.length) {
                toast(t('settings.backgroundUnloaded', 'Freed: {list}', { list: released.join(', ') }), 'success');
            }
            if (busy.length) {
                toast(t('settings.backgroundBusyKept', 'Kept {list}: a running job is using it.', { list: busy.join(', ') }), 'info');
            }
            if (!released.length && !busy.length) {
                toast(t('settings.backgroundNothing', 'Nothing to free: no model is loaded.'), 'info');
            }
        },
    };

    window.BackgroundModels = BackgroundModels;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => BackgroundModels.init());
    } else {
        BackgroundModels.init();
    }
})();
