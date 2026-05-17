/**
 * SD Image Sorter - VLM Captioning Module
 * Natural language captioning via Vision Language Models (Ollama, OpenAI, Anthropic, Gemini).
 */

const VLMCaption = {
    isRunning: false,
    pollInterval: null,
    settings: {},

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
        this._setChecked('vlm-include-tags', s.include_tags_as_context ?? true);
    },

    async saveSettings() {
        const data = {
            provider: this._getVal('vlm-provider'),
            endpoint: this._getVal('vlm-endpoint'),
            model: this._getVal('vlm-model'),
            max_retries: parseInt(this._getVal('vlm-max-retries')) || 3,
            timeout_seconds: parseFloat(this._getVal('vlm-timeout')) || 60,
            concurrent_requests: parseInt(this._getVal('vlm-concurrent')) || 2,
            system_prompt: this._getVal('vlm-system-prompt'),
            user_prompt: this._getVal('vlm-user-prompt'),
            include_tags_as_context: this._getChecked('vlm-include-tags'),
        };
        const apiKey = this._getVal('vlm-api-key');
        if (apiKey && !apiKey.includes('***')) data.api_key = apiKey;

        try {
            const resp = await fetch('/api/vlm/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (resp.ok) {
                this.settings = data;
                this._showStatus('vlm-status', 'Settings saved ✓', 'success');
            } else {
                this._showStatus('vlm-status', 'Save failed', 'error');
            }
        } catch (e) {
            this._showStatus('vlm-status', `Error: ${e.message}`, 'error');
        }
    },

    async testConnection() {
        this._showStatus('vlm-status', 'Testing connection...', 'info');
        try {
            const resp = await fetch('/api/vlm/test', { method: 'POST' });
            const data = await resp.json();
            if (data.status === 'ok') {
                const modelCount = data.models?.length || 0;
                this._showStatus('vlm-status', `Connected ✓ ${modelCount ? `(${modelCount} models)` : ''}`, 'success');
            } else {
                this._showStatus('vlm-status', `Failed: ${data.error || 'Unknown'} [${data.error_type || ''}]`, 'error');
            }
        } catch (e) {
            this._showStatus('vlm-status', `Connection error: ${e.message}`, 'error');
        }
    },

    async fetchModels() {
        this._showStatus('vlm-model-list-status', 'Fetching...', 'info');
        try {
            const resp = await fetch('/api/vlm/models', { method: 'POST' });
            const data = await resp.json();
            const list = document.getElementById('vlm-model-list');
            if (!list) return;
            if (data.models?.length) {
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
            // Use the with_tags variant if available and include-tags is checked
            const useTags = this._getChecked('vlm-include-tags');
            const userPrompt = (useTags && preset.user_prompt_with_tags) ? preset.user_prompt_with_tags : preset.user_prompt;
            this._setVal('vlm-user-prompt', userPrompt || '');
            this._showStatus('vlm-status', `Applied preset: ${preset.name}`, 'success');
        } catch (e) {
            this._showStatus('vlm-status', `Error loading presets: ${e.message}`, 'error');
        }
    },

    // --- Batch Captioning ---

    async startBatchCaption() {
        const imageIds = this._getTargetImageIds();
        if (!imageIds.length) {
            this._showStatus('vlm-batch-status', 'No images to caption. Select images or use current view.', 'error');
            return;
        }

        try {
            const resp = await fetch('/api/vlm/caption-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_ids: imageIds }),
            });
            if (resp.status === 409) {
                this._showStatus('vlm-batch-status', 'Already running — wait or cancel first', 'error');
                return;
            }
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this._showStatus('vlm-batch-status', `Failed: ${err.detail || resp.statusText}`, 'error');
                return;
            }
            this.isRunning = true;
            this._showBatchUI(true);
            this.startPolling();
        } catch (e) {
            this._showStatus('vlm-batch-status', `Error: ${e.message}`, 'error');
        }
    },

    async cancelBatch() {
        try {
            await fetch('/api/vlm/caption-batch/cancel', { method: 'POST' });
            this._showStatus('vlm-batch-status', 'Cancelling...', 'info');
        } catch (e) { /* ignore */ }
    },

    startPolling() {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(() => this.pollProgress(), 1500);
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
            this._updateProgressUI(data);

            if (!data.running) {
                this.stopPolling();
                this.isRunning = false;
                this._showBatchUI(false);
                this._showBatchSummary(data);
            }
        } catch (e) { /* continue polling */ }
    },

    _updateProgressUI(data) {
        const total = data.total || 1;
        const done = (data.completed || 0) + (data.failed || 0);
        const pct = Math.round(done / total * 100);

        const fill = document.getElementById('vlm-progress-fill');
        const text = document.getElementById('vlm-progress-text');
        if (fill) fill.style.width = `${pct}%`;
        if (text) {
            text.textContent = `${done}/${total} (${data.completed || 0} ✓ / ${data.failed || 0} ✗) — ${data.tokens_used || 0} tokens`;
            if (data.current_image) text.textContent += ` — ${data.current_image}`;
        }
    },

    _showBatchSummary(data) {
        const msg = `Done! ${data.completed || 0} captioned, ${data.failed || 0} failed, ${data.tokens_used || 0} tokens used.`;
        this._showStatus('vlm-batch-status', msg, data.failed ? 'warning' : 'success');

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

    async loadRecommendedModels() {
        const container = document.getElementById('vlm-local-models');
        if (!container) return;
        try {
            const resp = await fetch('/api/vlm/local-models/recommended');
            const data = await resp.json();

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

    _getTargetImageIds() {
        // Use selected images if available, else all filtered images
        if (window.SelectionStore?.getSelectedIds?.()?.length) {
            return [...window.SelectionStore.getSelectedIds()];
        }
        // Fall back to all images in current view
        const imgs = document.querySelectorAll('.gallery-item[data-id]');
        return Array.from(imgs).map(el => parseInt(el.dataset.id)).filter(n => !isNaN(n));
    },

    _showBatchUI(running) {
        const prog = document.getElementById('vlm-progress-container');
        const cancel = document.getElementById('btn-vlm-cancel');
        const start = document.getElementById('btn-vlm-start');
        if (prog) prog.style.display = running ? 'block' : 'none';
        if (cancel) cancel.style.display = running ? 'inline-flex' : 'none';
        if (start) start.disabled = running;
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
};

// Self-init
document.addEventListener('DOMContentLoaded', () => VLMCaption.init());
