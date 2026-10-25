/**
 * SD Image Sorter extension - talking to the program.
 *
 * Shared by the background script, the options page and the popup. Every call
 * goes to the program's own address (default http://127.0.0.1:8487) as a
 * POST; once paired, the token the user approved inside the program travels
 * in the X-SD-Ext-Token header. Nothing is sent anywhere else.
 */
(function (root) {
    'use strict';

    const DEFAULT_ADDRESS = 'http://127.0.0.1:8487';
    const TOKEN_HEADER = 'X-SD-Ext-Token';
    const PING_TIMEOUT_MS = 4000;
    const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

    function t(key, substitutions) {
        return chrome.i18n.getMessage(key, substitutions) || key;
    }

    // The values each coded error message takes, in its $1, $2 order.
    const ERROR_PARAMS = {
        collect_site_refused: ['status'],
        collect_download_failed: ['reason'],
        collect_index_failed: ['folder', 'reason'],
        ext_folders_failed: ['reason'],
    };

    /**
     * The program's error in the extension's language: the message for its
     * code (messages.json apiError_<code>), else the program's own sentence.
     */
    function errorText(result) {
        const data = (result && result.data) || {};
        const code = typeof data.code === 'string' ? data.code : '';
        const params = data.params && typeof data.params === 'object' ? data.params : {};
        if (/^[a-z_]+$/.test(code)) {
            const values = (ERROR_PARAMS[code] || []).map((name) => String(params[name] ?? ''));
            const known = chrome.i18n.getMessage(`apiError_${code}`, values);
            if (known) return known;
        }
        const message = data.error || data.detail;
        return typeof message === 'string' ? message : `HTTP ${result ? result.status : ''}`.trim();
    }

    /** "127.0.0.1:8487/" -> "http://127.0.0.1:8487"; null when it is not this computer. */
    function normalizeAddress(raw) {
        let text = String(raw || '').trim();
        if (!text) return DEFAULT_ADDRESS;
        if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
        let url;
        try {
            url = new URL(text);
        } catch (_e) {
            return null;
        }
        if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
        return `${url.protocol}//${url.host}`;
    }

    async function getSettings() {
        const stored = await chrome.storage.local.get(['address', 'token', 'pairState', 'showDropBox']);
        return {
            address: normalizeAddress(stored.address) || DEFAULT_ADDRESS,
            token: stored.token || '',
            pairState: stored.pairState || 'none',
            showDropBox: stored.showDropBox !== false,
        };
    }

    function setSettings(values) {
        return chrome.storage.local.set(values);
    }

    function makeToken() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        let binary = '';
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function browserKind() {
        const agent = navigator.userAgent || '';
        if (agent.includes('Firefox/')) return 'firefox';
        if (agent.includes('Edg/')) return 'edge';
        if (agent.includes('Chrome/')) return 'chrome';
        return 'other';
    }

    function browserLabel(kind) {
        return { firefox: 'Firefox', edge: 'Edge', chrome: 'Chrome' }[kind] || t('browserOther');
    }

    /**
     * POST to the program. Resolves {ok, status, data, offline}; never throws,
     * so every caller can say plainly what happened.
     */
    async function call(path, { json, form, timeoutMs } = {}) {
        const settings = await getSettings();
        const headers = {};
        if (settings.token) headers[TOKEN_HEADER] = settings.token;
        let body;
        if (form) {
            body = form;
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(json || {});
        }
        const controller = timeoutMs ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const response = await fetch(`${settings.address}${path}`, {
                method: 'POST',
                headers,
                body,
                credentials: 'omit',
                signal: controller?.signal,
            });
            const data = await response.json().catch(() => ({}));
            return { ok: response.ok, status: response.status, data, offline: false };
        } catch (_error) {
            return { ok: false, status: 0, data: {}, offline: true };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** {state: 'offline' | 'unpaired' | 'pending' | 'denied' | 'paired', version} */
    async function connectionState() {
        const settings = await getSettings();
        const result = await call('/api/ext/ping', { timeoutMs: PING_TIMEOUT_MS });
        if (result.offline || !result.ok) return { state: 'offline', address: settings.address };
        const pairing = result.data.pairing;
        const state = pairing === 'approved' ? 'paired'
            : (pairing === 'pending' || pairing === 'denied') ? pairing : 'unpaired';
        if (state === 'unpaired' && settings.pairState === 'approved') {
            await setSettings({ pairState: 'none' });
        }
        if (state === 'paired' && settings.pairState !== 'approved') {
            await setSettings({ pairState: 'approved' });
        }
        return { state, address: settings.address, version: result.data.version };
    }

    /** Ask the program to pair; the user answers inside the program. */
    async function requestPairing() {
        const token = makeToken();
        await setSettings({ token, pairState: 'pending' });
        const kind = browserKind();
        const result = await call('/api/ext/pair', {
            json: { token, browser: kind, name: t('pairName', [browserLabel(kind)]) },
        });
        if (!result.ok) await setSettings({ token: '', pairState: 'none' });
        return result;
    }

    async function pairingStatus() {
        const result = await call('/api/ext/pair/status');
        const state = result.ok ? result.data.state : (result.offline ? 'offline' : 'unknown');
        if (state === 'approved') await setSettings({ pairState: 'approved' });
        if (state === 'denied' || state === 'unknown') await setSettings({ pairState: 'none' });
        return state;
    }

    function forgetPairing() {
        return setSettings({ token: '', pairState: 'none' });
    }

    root.SdisProgram = {
        DEFAULT_ADDRESS,
        t,
        errorText,
        normalizeAddress,
        getSettings,
        setSettings,
        call,
        connectionState,
        requestPairing,
        pairingStatus,
        forgetPairing,
    };
})(globalThis);
