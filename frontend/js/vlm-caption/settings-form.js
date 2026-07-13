/**
 * vlm-caption/settings-form.js — vlm-caption.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/vlm-caption.js pre-cut
 * lines 100-289 (of 1,073): loadSettings, _autoDetectProvider (WS6 endpoint
 * -> provider classification), openSettingsModal (the app/toasts-modals.js
 * openVlmSettings inbound seam), populateSettingsForm, _setOutputFormat /
 * _getOutputFormat / _bindOutputFormat (segmented control),
 * _refreshAdvancedSectionsVisibility (vertex reveal + proxy/vertex badges),
 * _collectSettingsForm (temperature-0 / NaN guards, masked-value omission),
 * saveSettings (V321Integration.refreshVLMBannerStatus outbound) and
 * _saveBeforeAction. Classic non-strict script: joins the ONE unsealed
 * window.VLMCaption object declared in vlm-caption/core.js, which loads
 * FIRST; vlm-caption/boot.js registers the DOMContentLoaded init LAST.
 */
Object.assign(window.VLMCaption, {
    async loadSettings() {
        try {
            const resp = await fetch('/api/vlm/settings');
            if (resp.ok) this.settings = await resp.json();
        } catch (e) { /* ignore */ }
    },

    // WS6: classify the endpoint URL via the backend and sync the provider
    // select. Best-effort + silent (the select visibly updating is the feedback).
    async _autoDetectProvider() {
        const endpoint = (this._getVal('vlm-endpoint') || '').trim();
        if (!endpoint) return;
        try {
            const resp = await fetch('/api/vlm/detect-provider', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint }),
            });
            if (!resp.ok) return;
            const data = await resp.json();
            const provider = data?.provider;
            const select = document.getElementById('vlm-provider');
            if (!provider || !select) return;
            const hasOption = Array.from(select.options).some((o) => o.value === provider);
            if (hasOption && select.value !== provider) {
                select.value = provider;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (_e) {
            /* best-effort: a detection failure leaves the manual selection intact */
        }
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
        // v3.4.3: caption generation parameters (previously hardcoded 1024/0.3)
        // plus backend-supported fields that never had UI.
        this._setVal('vlm-caption-max-tokens', s.caption_max_tokens ?? 1024);
        this._setVal('vlm-caption-temperature', s.caption_temperature ?? 0.3);
        this._setVal('vlm-retry-delay', s.retry_delay_seconds ?? 2);
        this._setVal('vlm-max-image-size', s.max_image_size ?? 1024);
        this._setVal('vlm-nsfw-retry-prompt', s.nsfw_retry_prompt || '');
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
            caption_max_tokens: parseInt(this._getVal('vlm-caption-max-tokens')) || 1024,
            // temperature 0 is a legitimate value — only fall back on NaN.
            caption_temperature: (() => {
                const v = parseFloat(this._getVal('vlm-caption-temperature'));
                return Number.isFinite(v) ? v : 0.3;
            })(),
            retry_delay_seconds: (() => {
                const v = parseFloat(this._getVal('vlm-retry-delay'));
                return Number.isFinite(v) ? v : 2;
            })(),
            max_image_size: parseInt(this._getVal('vlm-max-image-size')) || 1024,
            nsfw_retry_prompt: this._getVal('vlm-nsfw-retry-prompt'),
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

});
