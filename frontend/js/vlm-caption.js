/**
 * SD Image Sorter - VLM Captioning Module
 * Natural language captioning via Vision Language Models (Ollama, OpenAI, Anthropic, Gemini).
 */

const VLMCaption = {
    isRunning: false,
    pollInterval: null,
    settings: {},
    lastProgress: null,
    lastFailedImageIds: [],

    tText(en, zh) {
        return window.I18n?.getLang?.() === 'zh-CN' ? zh : en;
    },

    async init() {
        this.bindEvents();
        await this.loadSettings();
    },

    bindEvents() {
        document.getElementById('btn-vlm-settings')?.addEventListener('click', () => this.openSettingsModal());
        document.getElementById('btn-vlm-start')?.addEventListener('click', () => this.startBatchCaption());
        document.getElementById('btn-vlm-cancel')?.addEventListener('click', () => this.cancelBatch());
        document.getElementById('btn-vlm-test')?.addEventListener('click', () => this.testConnection());
        document.getElementById('btn-vlm-fetch-models')?.addEventListener('click', () => this.fetchModels());
        document.getElementById('btn-vlm-save-settings')?.addEventListener('click', () => this.saveSettings());
        document.getElementById('vlm-preset-select')?.addEventListener('change', (e) => this.applyPreset(e.target.value));
        document.getElementById('btn-vlm-pull-model')?.addEventListener('click', () => this.pullModel());
        document.getElementById('btn-vlm-retry-failed')?.addEventListener('click', () => this.retryFailedImages());
        document.addEventListener('click', (event) => {
            const trigger = event.target?.closest?.('[data-vlm-debug-chat]');
            if (!trigger) return;
            event.preventDefault();
            event.stopPropagation();
            this.openDebugChat();
        });
        document.getElementById('btn-vlm-debug-chat-refresh')?.addEventListener('click', () => this.loadDebugChat());
        document.getElementById('btn-vlm-debug-chat-close')?.addEventListener('click', () => this.closeDebugChat());
        document.querySelector('#vlm-debug-chat-modal .modal-backdrop')?.addEventListener('click', () => this.closeDebugChat());
        document.getElementById('btn-cancel-tag')?.addEventListener('click', (event) => {
            if (!this.isRunning) return;
            event.preventDefault();
            event.stopPropagation();
            this.cancelBatch();
        }, true);

        // v3.2.1 — output-format segmented + provider/proxy/vertex reactivity
        this._bindOutputFormat();
        document.getElementById('vlm-provider')?.addEventListener('change', () => this._refreshAdvancedSectionsVisibility());
        ['vlm-http-proxy', 'vlm-https-proxy', 'vlm-socks-proxy', 'vlm-use-vertex'].forEach(id => {
            const el = document.getElementById(id);
            const evt = el?.type === 'checkbox' ? 'change' : 'input';
            el?.addEventListener(evt, () => this._refreshAdvancedSectionsVisibility());
        });

        // Close modal
        document.getElementById('vlm-settings-modal')?.querySelector('.modal-close')?.addEventListener('click', () => {
            document.getElementById('vlm-settings-modal').classList.remove('visible');
        });
    },

    async loadSettings() {
        try {
            const resp = await fetch('/api/vlm/settings');
            if (resp.ok) this.settings = await resp.json();
        } catch (e) { /* ignore */ }
    },

    openSettingsModal() {
        const modal = document.getElementById('vlm-settings-modal');
        if (!modal) return;
        this.populateSettingsForm();
        modal.classList.add('visible');
        this.loadRecommendedModels();
    },

    populateSettingsForm() {
        const s = this.settings;
        this._setVal('vlm-provider', s.provider || 'openai_compat');
        this._setVal('vlm-endpoint', s.endpoint || '');
        this._setVal('vlm-api-key', s.api_key_display || '');
        this._setVal('vlm-model', s.model || '');
        this._setVal('vlm-max-retries', s.max_retries ?? 3);
        this._setVal('vlm-timeout', s.timeout_seconds ?? 60);
        this._setVal('vlm-concurrent', s.concurrent_requests ?? 2);
        this._setVal('vlm-system-prompt', s.system_prompt || '');
        this._setVal('vlm-user-prompt', s.user_prompt || '');
        this._currentPresetWithTags = s.user_prompt_with_tags || '';
        this._setChecked('vlm-include-tags', s.include_tags_as_context ?? true);
        // v3.2.1 fields
        this._setOutputFormat(s.output_format || 'nl_caption');
        this._setVal('vlm-http-proxy', s.http_proxy || '');
        this._setVal('vlm-https-proxy', s.https_proxy || '');
        this._setVal('vlm-socks-proxy', s.socks_proxy || '');
        this._setChecked('vlm-use-vertex', !!s.use_vertex);
        this._setVal('vlm-vertex-project', s.vertex_project || '');
        this._setVal('vlm-vertex-location', s.vertex_location || 'us-central1');
        // service_account_json is masked as "*** (configured)" on the GET side;
        // clear the textarea so the user only sends a new value if they type one.
        this._setVal('vlm-vertex-sa-json', s.service_account_json_display ? '' : (s.service_account_json || ''));
        this._refreshAdvancedSectionsVisibility();
    },

    _setOutputFormat(value) {
        const valid = ['nl_caption', 'danbooru_tags', 'both'];
        const v = valid.includes(value) ? value : 'nl_caption';
        document.querySelectorAll('#vlm-output-format .vlm-segmented-btn').forEach(btn => {
            const isActive = btn.dataset.outputFormat === v;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-checked', String(isActive));
        });
    },

    _getOutputFormat() {
        const active = document.querySelector('#vlm-output-format .vlm-segmented-btn.active');
        return active?.dataset.outputFormat || 'nl_caption';
    },

    _bindOutputFormat() {
        document.querySelectorAll('#vlm-output-format .vlm-segmented-btn').forEach(btn => {
            btn.addEventListener('click', () => this._setOutputFormat(btn.dataset.outputFormat));
        });
    },

    _refreshAdvancedSectionsVisibility() {
        // Vertex AI section is only meaningful when provider = gemini.
        const provider = this._getVal('vlm-provider');
        const vertexDetails = document.getElementById('vlm-vertex-details');
        if (vertexDetails) {
            vertexDetails.hidden = provider !== 'gemini';
        }
        // Show "active" badges so the user can see at a glance which collapsed
        // sections currently hold non-default values.
        const proxyActive = !!(this._getVal('vlm-http-proxy') || this._getVal('vlm-https-proxy') || this._getVal('vlm-socks-proxy'));
        const proxyBadge = document.getElementById('vlm-proxy-active-badge');
        if (proxyBadge) proxyBadge.hidden = !proxyActive;
        const vertexActive = this._getChecked('vlm-use-vertex');
        const vertexBadge = document.getElementById('vlm-vertex-active-badge');
        if (vertexBadge) vertexBadge.hidden = !vertexActive;
    },

    _collectSettingsForm() {
        const data = {
            provider: this._getVal('vlm-provider'),
            endpoint: this._getVal('vlm-endpoint'),
            model: this._getVal('vlm-model'),
            max_retries: parseInt(this._getVal('vlm-max-retries')) || 3,
            timeout_seconds: parseFloat(this._getVal('vlm-timeout')) || 60,
            concurrent_requests: parseInt(this._getVal('vlm-concurrent')) || 2,
            system_prompt: this._getVal('vlm-system-prompt'),
            user_prompt: this._getVal('vlm-user-prompt'),
            user_prompt_with_tags: this._currentPresetWithTags || '',
            include_tags_as_context: this._getChecked('vlm-include-tags'),
            output_format: this._getOutputFormat(),
            http_proxy: this._getVal('vlm-http-proxy'),
            https_proxy: this._getVal('vlm-https-proxy'),
            socks_proxy: this._getVal('vlm-socks-proxy'),
            use_vertex: this._getChecked('vlm-use-vertex'),
            vertex_project: this._getVal('vlm-vertex-project'),
            vertex_location: this._getVal('vlm-vertex-location') || 'us-central1',
        };
        const apiKey = this._getVal('vlm-api-key');
        if (apiKey && !apiKey.includes('***')) data.api_key = apiKey;
        const saJson = this._getVal('vlm-vertex-sa-json');
        // Only send service_account_json if the user typed something new.
        // GET masks the stored value as "*** (configured)", so empty / unchanged means "leave alone".
        if (saJson && !saJson.includes('***')) data.service_account_json = saJson;
        return data;
    },

    async saveSettings(options = {}) {
        const { silent = false, statusEl = 'vlm-status' } = options;
        const data = this._collectSettingsForm();
        try {
            const resp = await fetch('/api/vlm/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (resp.ok) {
                this.settings = { ...this.settings, ...data };
                delete this.settings.api_key;
                if (!silent) this._showStatus(statusEl, this._t('vlmSettings.saved', 'Settings saved ✓'), 'success');
                try { window.V321Integration?.refreshVLMBannerStatus?.(); } catch (_e) {}
                return true;
            }
            const err = await resp.json().catch(() => ({}));
            const message = err.detail || err.error || resp.statusText || this._t('vlmSettings.saveFailed', 'Save failed');
            if (!silent) this._showStatus(statusEl, message, 'error');
            return false;
        } catch (e) {
            if (!silent) this._showStatus(statusEl, `Error: ${e.message}`, 'error');
            return false;
        }
    },

    async _saveBeforeAction(statusEl, workingMessage) {
        this._showStatus(statusEl, workingMessage, 'info');
        const saved = await this.saveSettings({ silent: true, statusEl });
        if (!saved) {
            this._showStatus(statusEl, this._t('vlmSettings.autoSaveFailed', 'Could not save the current settings. Fix the form and try again.'), 'error');
            return false;
        }
        return true;
    },

    async testConnection() {
        if (!await this._saveBeforeAction('vlm-status', this._t('vlmSettings.savingThenTesting', 'Saving settings, then testing connection...'))) return;
        try {
            const resp = await fetch('/api/vlm/test', { method: 'POST' });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok && data.status === 'ok') {
                const modelCount = data.models?.length || 0;
                this._showStatus('vlm-status', `${this._t('vlmSettings.connected', 'Connected ✓')} ${modelCount ? `(${modelCount} models)` : ''}`, 'success');
            } else {
                const reason = data.error || data.detail || resp.statusText || 'Unknown';
                this._showStatus('vlm-status', `Failed: ${reason} ${data.error_type ? `[${data.error_type}]` : ''}`, 'error');
            }
        } catch (e) {
            this._showStatus('vlm-status', `Connection error: ${e.message}`, 'error');
        }
    },

    async fetchModels() {
        if (!await this._saveBeforeAction('vlm-model-list-status', this._t('vlmSettings.savingThenFetching', 'Saving settings, then fetching models...'))) return;
        try {
            const resp = await fetch('/api/vlm/models', { method: 'POST' });
            const data = await resp.json().catch(() => ({}));
            const list = document.getElementById('vlm-model-list');
            if (!list) return;
            if (!resp.ok) {
                const reason = data.error || data.detail || resp.statusText || 'Unknown';
                list.innerHTML = `<span class="helper-text">${escapeHtml(reason)}</span>`;
                this._showStatus('vlm-model-list-status', `Failed: ${reason}`, 'error');
            } else if (data.models?.length) {
                list.innerHTML = data.models.map(m =>
                    `<button class="vlm-model-item" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`
                ).join('');
                list.querySelectorAll('.vlm-model-item').forEach(btn => {
                    btn.addEventListener('click', () => {
                        this._setVal('vlm-model', btn.dataset.model);
                        this._showStatus('vlm-model-list-status', `Selected: ${btn.dataset.model}`, 'success');
                    });
                });
                this._showStatus('vlm-model-list-status', `${data.models.length} models found`, 'success');
            } else {
                list.innerHTML = '<span class="helper-text">No models found. Type model name manually above.</span>';
                this._showStatus('vlm-model-list-status', 'No models returned', 'info');
            }
        } catch (e) {
            this._showStatus('vlm-model-list-status', `Error: ${e.message}`, 'error');
        }
    },

    async applyPreset(presetId) {
        if (!presetId) return;
        try {
            const resp = await fetch('/api/vlm/presets');
            const data = await resp.json();
            const preset = data.presets?.[presetId];
            if (!preset) return;
            this._setVal('vlm-system-prompt', preset.system_prompt || '');
            // Always show the regular user_prompt in the textarea.
            // The with_tags variant is stored separately and used by the
            // backend when the image has existing tags.
            this._setVal('vlm-user-prompt', preset.user_prompt || '');
            // Store the with_tags prompt in a hidden field so it gets saved
            this._currentPresetWithTags = preset.user_prompt_with_tags || '';
            // Auto-set output_format to match the preset
            if (preset.output_format) {
                this._setOutputFormat(preset.output_format);
            }
            this._showStatus('vlm-status', `Applied preset: ${preset.name}`, 'success');
        } catch (e) {
            this._showStatus('vlm-status', `Error loading presets: ${e.message}`, 'error');
        }
    },

    // --- Batch Captioning ---

    async startBatchCaption(imageIdsOverride = null) {
        const batchTarget = Array.isArray(imageIdsOverride)
            ? this._buildImageIdsBatchTarget(imageIdsOverride)
            : this._getBatchTarget();
        if (!batchTarget || !batchTarget.count) {
            this._showBatchUI(false, { keepPanel: true });
            this._showStatus('vlm-batch-status', 'No images to caption. Select images or use current view.', 'error');
            return;
        }

        try {
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
            this.isRunning = true;
            this.lastFailedImageIds = [];
            this._showBatchUI(true);
            this._showStatus('vlm-batch-status', this._t('vlm.captionRunning', 'Captioning images...'), 'info');
            this.startPolling();
        } catch (e) {
            this._showBatchUI(false, { keepPanel: true });
            this._showStatus('vlm-batch-status', `Error: ${e.message}`, 'error');
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
                    if (window.Gallery?.currentPreviewRequestId && window.Gallery?.openPreview) {
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

    // --- Local Model Management ---

    _populateModelSuggestions(models) {
        const datalist = document.getElementById('vlm-model-suggestions');
        if (!datalist) return;
        datalist.innerHTML = models.map((m) => {
            const id = String(m?.id || '').trim();
            if (!id) return '';
            const hintParts = [];
            if (m?.name) hintParts.push(String(m.name));
            if (m?.size_gb) hintParts.push(`${m.size_gb} GB`);
            const hint = hintParts.join(' · ');
            return `<option value="${escapeHtml(id)}">${escapeHtml(hint)}</option>`;
        }).join('');
    },

    async loadRecommendedModels() {
        const container = document.getElementById('vlm-local-models');
        if (!container) return;
        try {
            const resp = await fetch('/api/vlm/local-models/recommended');
            const data = await resp.json();

            // MODELS-03: feed the #vlm-model input's typeahead datalist from the
            // recommended set so the free-text box offers a dropdown of known
            // models (id + short hint) without removing the ability to type any
            // model name. Populated regardless of Ollama state — useful for both
            // local and cloud endpoints.
            this._populateModelSuggestions(Array.isArray(data.models) ? data.models : []);

            if (!data.ollama_installed) {
                container.innerHTML = `<div class="vlm-ollama-install">
                    <p>Ollama not installed. Required for local VLM models.</p>
                    <p class="helper-text">${escapeHtml(data.install_instructions || '')}</p>
                </div>`;
                return;
            }

            let html = '';
            if (!data.ollama_running) {
                html += `<div class="vlm-ollama-start">
                    <span>Ollama is not running.</span>
                    <button class="btn btn-small btn-primary" id="btn-vlm-start-ollama">Start Ollama</button>
                </div>`;
            }

            html += '<div class="vlm-model-cards">';
            for (const m of data.models) {
                const installed = m.installed ? ' installed' : '';
                html += `<div class="vlm-model-card${installed}">
                    <div class="vlm-model-card-header">
                        <strong>${escapeHtml(m.name)}</strong>
                        ${m.nsfw_ok ? '<span class="vlm-badge-nsfw">NSFW OK</span>' : ''}
                        ${m.installed ? '<span class="vlm-badge-installed">✓ Installed</span>' : ''}
                    </div>
                    <p class="helper-text">${escapeHtml(m.description)}</p>
                    <div class="vlm-model-card-meta">
                        <span>${m.size_gb} GB</span> · <span>Min ${m.vram_min_gb} GB VRAM</span>
                    </div>
                    <div class="vlm-model-card-actions">
                        ${m.installed
                            ? `<button class="btn btn-small btn-ghost" data-vlm-use="${escapeHtml(m.id)}">Use This</button>`
                            : `<button class="btn btn-small btn-primary" data-vlm-pull="${escapeHtml(m.id)}">Download</button>`
                        }
                    </div>
                </div>`;
            }
            html += '</div>';
            container.innerHTML = html;

            // Bind events
            document.getElementById('btn-vlm-start-ollama')?.addEventListener('click', () => this.startOllama());
            container.querySelectorAll('[data-vlm-pull]').forEach(btn => {
                btn.addEventListener('click', () => this.pullModel(btn.dataset.vlmPull));
            });
            container.querySelectorAll('[data-vlm-use]').forEach(btn => {
                btn.addEventListener('click', () => {
                    this._setVal('vlm-model', btn.dataset.vlmUse);
                    this._setVal('vlm-endpoint', 'http://localhost:11434/v1');
                    this._setVal('vlm-provider', 'openai_compat');
                    this._showStatus('vlm-status', `Selected ${btn.dataset.vlmUse} — endpoint set to Ollama`, 'success');
                });
            });
        } catch (e) {
            container.innerHTML = `<p class="helper-text">Failed to load models: ${escapeHtml(e.message)}</p>`;
        }
    },

    async pullModel(modelName) {
        if (!modelName) modelName = this._getVal('vlm-model');
        if (!modelName) {
            this._showStatus('vlm-status', 'Enter a model name first', 'error');
            return;
        }

        try {
            const resp = await fetch('/api/vlm/local-models/pull', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this._showStatus('vlm-status', `Pull failed: ${err.detail || resp.statusText}`, 'error');
                return;
            }
            this._showStatus('vlm-status', `Downloading ${modelName}...`, 'info');
            this._startPullPolling();
        } catch (e) {
            this._showStatus('vlm-status', `Error: ${e.message}`, 'error');
        }
    },

    _pullPollInterval: null,
    _startPullPolling() {
        if (this._pullPollInterval) return;
        this._pullPollInterval = setInterval(async () => {
            try {
                const resp = await fetch('/api/vlm/local-models/pull/progress');
                const data = await resp.json();
                if (data.pulling) {
                    this._showStatus('vlm-status', `Downloading: ${data.percent}% — ${data.status}`, 'info');
                } else {
                    clearInterval(this._pullPollInterval);
                    this._pullPollInterval = null;
                    if (data.status?.startsWith('error')) {
                        this._showStatus('vlm-status', `Download failed: ${data.status}`, 'error');
                    } else {
                        this._showStatus('vlm-status', `Download complete ✓`, 'success');
                        this.loadRecommendedModels();
                    }
                }
            } catch (e) {
                clearInterval(this._pullPollInterval);
                this._pullPollInterval = null;
            }
        }, 2000);
    },

    async startOllama() {
        try {
            const resp = await fetch('/api/vlm/local-models/start-ollama', { method: 'POST' });
            if (resp.ok) {
                this._showStatus('vlm-status', 'Ollama started ✓', 'success');
                setTimeout(() => this.loadRecommendedModels(), 2000);
            } else {
                const err = await resp.json().catch(() => ({}));
                this._showStatus('vlm-status', `Cannot start Ollama: ${err.detail || ''}`, 'error');
            }
        } catch (e) {
            this._showStatus('vlm-status', `Error: ${e.message}`, 'error');
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
        const selectionToken = window.AppFilterAccess?.getActiveSelectionToken?.();
        if (selectionToken) {
            const total = Number(window.AppFilterAccess?.getSelectionTotal?.() || 0);
            return {
                count: total > 0 ? total : 1,
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

    async openDebugChat() {
        const modal = document.getElementById('vlm-debug-chat-modal');
        if (!modal) return;
        modal.classList.add('visible');
        await this.loadDebugChat();
    },

    closeDebugChat() {
        document.getElementById('vlm-debug-chat-modal')?.classList.remove('visible');
    },

    async loadDebugChat(options = {}) {
        const list = document.getElementById('vlm-debug-chat-list');
        if (!list) return;
        if (!options.silent) {
            list.innerHTML = `<div class="empty-state-small">${escapeHtml(this._t('common.loading', 'Loading...'))}</div>`;
        }
        try {
            const resp = await fetch('/api/vlm/caption-batch/debug-chat', { cache: 'no-store' });
            const data = await resp.json();
            const events = Array.isArray(data.events) ? data.events : [];
            if (!events.length) {
                list.innerHTML = `<div class="empty-state-small">${escapeHtml(this._t('vlm.debugChatEmpty', 'No VLM API messages yet.'))}</div>`;
                return;
            }
            list.innerHTML = events.map((event) => this._renderDebugChatEvent(event)).join('');
            list.scrollTop = list.scrollHeight;
        } catch (e) {
            list.innerHTML = `<div class="empty-state-small">${escapeHtml(e.message || 'Error')}</div>`;
        }
    },

    _renderDebugChatEvent(event) {
        const phase = String(event.phase || 'event');
        const image = event.image_name || (event.image_id ? `#${event.image_id}` : '');
        const meta = [
            event.provider,
            event.model,
            image,
            event.latency_ms ? `${event.latency_ms} ms` : '',
            event.tokens_used ? `${event.tokens_used} tokens` : '',
        ].filter(Boolean).join(' · ');
        const fields = [];
        if (event.system_prompt) fields.push(['System', event.system_prompt]);
        if (event.user_prompt) fields.push(['User', event.user_prompt]);
        if (Array.isArray(event.tags) && event.tags.length) fields.push(['Tags', event.tags.join(', ')]);
        if (event.caption) fields.push(['Assistant', event.caption]);
        if (Array.isArray(event.tags) && event.phase !== 'request' && event.tags.length) fields.push(['Assistant tags', event.tags.join(', ')]);
        if (event.raw_text && event.raw_text !== event.caption) fields.push(['Raw response', event.raw_text]);
        if (event.error) fields.push([event.error_type ? `Error (${event.error_type})` : 'Error', event.error]);
        if (event.note) fields.push(['Note', event.note]);
        return `
            <div class="vlm-debug-message ${escapeHtml(phase)}">
                <div class="vlm-debug-message-head">
                    <span class="vlm-debug-message-phase">${escapeHtml(phase)}</span>
                    <span class="vlm-debug-message-meta">${escapeHtml(meta || event.at || '')}</span>
                </div>
                <div class="vlm-debug-message-body">
                    ${fields.map(([label, value]) => `
                        <div class="vlm-debug-field">
                            <span class="vlm-debug-field-label">${escapeHtml(label)}</span>
                            <pre>${escapeHtml(value)}</pre>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
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

    _showStatus(elId, message, type) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.textContent = message;
        el.className = `vlm-status vlm-status-${type}`;
        el.style.display = 'block';
    },

    _setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; },
    _getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; },
    _setChecked(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; },
    _getChecked(id) { const el = document.getElementById(id); return el ? el.checked : false; },
    _t(key, fallback) { const v = window.I18n?.t?.(key); return (v && v !== key) ? v : fallback; },
};

// Self-init
document.addEventListener('DOMContentLoaded', () => VLMCaption.init());

// Expose globally so other modules (e.g., v321-ui) can call methods like openSettingsModal()
window.VLMCaption = VLMCaption;
