/**
 * vlm-caption/debug-chat.js — vlm-caption.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/vlm-caption.js pre-cut
 * lines 956-1024 (of 1,073): openDebugChat, closeDebugChat, loadDebugChat
 * and _renderDebugChatEvent (the VLM API debug-chat modal). Classic
 * non-strict script: joins the ONE unsealed window.VLMCaption object
 * declared in vlm-caption/core.js, which loads FIRST; vlm-caption/boot.js
 * registers the DOMContentLoaded init LAST.
 */
Object.assign(window.VLMCaption, {
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

});
