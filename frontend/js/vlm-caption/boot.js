/**
 * vlm-caption/boot.js — vlm-caption.js decomposition (verbatim mixin + boot tail; LOADS LAST).
 * Moved BYTE-IDENTICAL from frontend/js/vlm-caption.js pre-cut lines 19-99 +
 * 1069-1071 (of 1,073): init, resumeActiveBatch (F5 reload-resume + queued
 * resume) and bindEvents (button wiring, delegated debug-chat click,
 * output-format/provider/proxy/vertex reactivity, modal close), plus the EOF
 * `DOMContentLoaded -> VLMCaption.init()` self-boot tail. `VLMCaption`
 * resolves to the script-global const declared in vlm-caption/core.js
 * (artist/boot.js precedent). Must be the LAST family tag in index.html:
 * init/bindEvents reach methods from every other family file at call time.
 * The `window.VLMCaption = VLMCaption;` publish (pre-cut line 1073) lives in
 * vlm-caption/core.js. Classic non-strict script.
 */
Object.assign(window.VLMCaption, {
    async init() {
        this.bindEvents();
        await this.loadSettings();
        // Reload-resume: a batch started before an F5 keeps running on the
        // backend. Re-attach the progress UI + polling so it stays visible
        // and cancellable instead of only surfacing as a 409 on re-start.
        await this.resumeActiveBatch();
    },

    async resumeActiveBatch() {
        try {
            const resp = await fetch('/api/vlm/caption-batch/progress');
            if (!resp.ok) return;
            const data = await resp.json();
            // v3.4.1 AI job queue: also resume when a batch of ours is
            // still waiting in the unified pipeline queue after an F5.
            const queuedEntries = data?.pipeline_queue?.queued || [];
            if (!data?.running && queuedEntries.length === 0) return;
            this.isRunning = true;
            this.lastProgress = data;
            this._showBatchUI(true);
            if (!data.running) {
                this._queuedSince = Date.now();
                this._showStatus('vlm-batch-status',
                    this._t('aiQueue.queuedProgress', 'Queued #{position} — waiting for the current AI job to finish')
                        .replace('{position}', String(queuedEntries[0].position || 1)), 'info');
            } else {
                this._updateProgressUI(data);
                this._showStatus('vlm-batch-status', this._t('vlm.captionRunning', 'Captioning images...'), 'info');
            }
            this.startPolling();
        } catch (e) { /* no active job or backend unreachable */ }
    },

    bindEvents() {
        document.getElementById('btn-vlm-settings')?.addEventListener('click', () => this.openSettingsModal());
        document.getElementById('btn-vlm-start')?.addEventListener('click', () => this.startBatchCaption());
        document.getElementById('btn-vlm-cancel')?.addEventListener('click', () => this.cancelBatch());
        document.getElementById('btn-vlm-test')?.addEventListener('click', () => this.testConnection());
        document.getElementById('btn-vlm-fetch-models')?.addEventListener('click', () => this.fetchModels());
        document.getElementById('btn-vlm-save-settings')?.addEventListener('click', () => this.saveSettings());
        document.getElementById('vlm-preset-select')?.addEventListener('change', (e) => this.applyPreset(e.target.value));
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
        // WS6 (VLM auto-detect): the /api/vlm/detect-provider endpoint existed but
        // nothing called it. When the endpoint URL changes, ask the backend to
        // guess the provider from the URL pattern and update the select. Blank
        // endpoints are left alone so a deliberate Anthropic/Gemini pick (which
        // often has no endpoint) is not clobbered back to openai_compat.
        document.getElementById('vlm-endpoint')?.addEventListener('change', () => this._autoDetectProvider());
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

});

// Self-init
document.addEventListener('DOMContentLoaded', () => VLMCaption.init());

