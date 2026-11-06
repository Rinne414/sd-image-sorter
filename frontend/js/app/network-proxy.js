/**
 * Model Center: one proxy for model downloads, package installs and update
 * checks, so people who run Clash or v2rayN enter a port once instead of turning
 * on TUN mode. The setting lives in the backend (/api/network/proxy).
 * Classic script; globals used: API, appT, escapeHtml, showToast, formatUserError.
 */
(function () {
    'use strict';

    const state = { saved: '', system: '', draft: '', results: null, testing: false, saving: false, note: '', bound: false };

    function section() {
        return document.getElementById('network-proxy-section');
    }

    function hostAndPort(proxy) {
        return String(proxy || '').replace(/^\w+:\/\/([^/@]*@)?/, '');
    }

    function resultLine(result) {
        if (result.ok) {
            return appT('network.proxy.resultOk', '{name}: reachable ({ms} ms)', { name: result.name, ms: result.ms });
        }
        const reasons = {
            timeout: ['network.proxy.resultTimeout', '{name}: no answer in time'],
            unreachable: ['network.proxy.resultUnreachable', '{name}: could not connect. Is the proxy running on this port?'],
        };
        const [key, fallback] = reasons[result.error] || ['network.proxy.resultFailed', '{name}: failed'];
        return appT(key, fallback, { name: result.name });
    }

    function resultsHtml() {
        if (!state.results) return '';
        const lines = state.results.map((result) => `
            <li class="network-proxy-result ${result.ok ? 'is-ok' : 'is-off'}">
                <span class="model-sources-dot ${result.ok ? 'is-ok' : 'is-off'}" aria-hidden="true"></span>
                <span>${escapeHtml(resultLine(result))}</span>
            </li>`).join('');
        return `<ul class="network-proxy-results" data-testid="network-proxy-results">${lines}</ul>`;
    }

    function render() {
        const host = section();
        if (!host) return;
        const offerSystem = state.system && state.system !== state.saved;
        host.innerHTML = `
            <article class="model-card model-sources-card" data-testid="network-proxy-card" aria-labelledby="network-proxy-title">
                <div class="model-card-title" id="network-proxy-title">${escapeHtml(appT('network.proxy.title', 'Network proxy'))}</div>
                <div class="model-card-message">${escapeHtml(appT('network.proxy.help', 'Model downloads, package installs and update checks all use this, so you do not need TUN mode. Enter the HTTP or mixed port of Clash, v2rayN or a similar tool. Leave it empty to go without a proxy.'))}</div>
                <form class="model-sources-add" data-np-form>
                    <input type="text" class="input-field" id="network-proxy-input" autocomplete="off" spellcheck="false" aria-labelledby="network-proxy-title" placeholder="${escapeHtml(appT('network.proxy.placeholder', '7890 or 127.0.0.1:7890'))}" value="${escapeHtml(state.draft)}">
                    <button type="submit" class="btn btn-primary btn-small" data-testid="network-proxy-save"${state.saving ? ' disabled' : ''}>${escapeHtml(appT('network.proxy.save', 'Save'))}</button>
                    <button type="button" class="btn btn-ghost btn-small" data-np-action="test" data-testid="network-proxy-test"${state.testing ? ' disabled' : ''}>${escapeHtml(state.testing ? appT('network.proxy.testing', 'Testing…') : appT('network.proxy.test', 'Test connection'))}</button>
                    ${offerSystem ? `<button type="button" class="btn btn-ghost btn-small" data-np-action="use-system" data-testid="network-proxy-system">${escapeHtml(appT('network.proxy.useSystem', 'Use system proxy {address}', { address: hostAndPort(state.system) }))}</button>` : ''}
                </form>
                ${state.note ? `<div class="model-card-message" data-testid="network-proxy-note" role="status">${escapeHtml(state.note)}</div>` : ''}
                ${resultsHtml()}
            </article>`;
    }

    async function load() {
        try {
            const status = await API.get('/api/network/proxy');
            state.saved = status.proxy || '';
            state.system = status.system_proxy || '';
            state.draft = state.saved;
        } catch (_error) {
            state.note = appT('network.proxy.loadFailed', 'Could not read the proxy setting right now.');
        }
        render();
    }

    function readDraft() {
        const input = document.getElementById('network-proxy-input');
        if (input) state.draft = input.value.trim();
        return state.draft;
    }

    async function save(value) {
        state.saving = true;
        state.results = null;
        render();
        try {
            const status = await API.post('/api/network/proxy', { proxy: value });
            state.saved = status.proxy || '';
            state.system = status.system_proxy || '';
            state.draft = state.saved;
            state.note = state.saved
                ? appT('network.proxy.saved', 'Saved. Downloads from now on go through {address}.', { address: hostAndPort(state.saved) })
                : appT('network.proxy.cleared', 'Saved. No proxy is set here now.');
        } catch (error) {
            state.note = '';
            showToast(formatUserError(error, appT('network.proxy.saveFailed', 'Could not save the proxy')), 'error');
        }
        state.saving = false;
        render();
    }

    async function test() {
        state.testing = true;
        state.note = '';
        state.results = null;
        const value = readDraft();
        render();
        try {
            const answer = await API.post('/api/network/proxy/test', { proxy: value });
            state.results = answer.results || [];
        } catch (error) {
            showToast(formatUserError(error, appT('network.proxy.testFailed', 'Could not run the test')), 'error');
        }
        state.testing = false;
        render();
    }

    function bind() {
        const host = section();
        if (!host || state.bound) return;
        state.bound = true;
        host.addEventListener('submit', (event) => {
            event.preventDefault();
            save(readDraft());
        });
        host.addEventListener('click', (event) => {
            const button = event.target.closest('[data-np-action]');
            if (!button) return;
            readDraft();
            if (button.dataset.npAction === 'test') test();
            else if (button.dataset.npAction === 'use-system') save(state.system);
        });
        document.addEventListener('languageChanged', () => {
            readDraft();
            render();
        });
    }

    /** Called each time the Model Center opens. */
    function open() {
        bind();
        state.note = '';
        state.results = null;
        return load();
    }

    window.NetworkProxy = { open };
})();
