/**
 * SD Image Sorter extension - options page: program address, connection test,
 * pairing (the user allows it inside the program), drop box switch.
 */
(function () {
    'use strict';

    const { t } = SdisProgram;
    const PAIR_POLL_MS = 1500;
    const ALL_SITES = { origins: ['<all_urls>'] };
    const $ = (id) => document.getElementById(id);

    let pollTimer = null;

    function showStatus(text, kind) {
        const node = $('status');
        node.textContent = text;
        node.dataset.kind = kind;
    }

    async function refreshStatus() {
        showStatus(t('statusChecking'), 'busy');
        const info = await SdisProgram.connectionState();
        const texts = {
            offline: [t('statusOffline', [info.address]), 'bad'],
            unpaired: [t('statusUnpaired', [info.version || '', info.address]), 'warn'],
            pending: [t('statusPending'), 'warn'],
            denied: [t('statusDenied'), 'bad'],
            paired: [t('statusPaired', [info.version || '', info.address]), 'good'],
        };
        const [text, kind] = texts[info.state] || texts.offline;
        showStatus(text, kind);
        $('pair').disabled = info.state === 'offline';
        $('pair').textContent = info.state === 'paired' ? t('pairAgainButton') : t('pairButton');
        $('forget').disabled = !(await SdisProgram.getSettings()).token;
        chrome.runtime.sendMessage({ type: 'sdis-refresh-badge' }).catch(() => undefined);
        return info.state;
    }

    async function focusProgramTab() {
        const { address } = await SdisProgram.getSettings();
        const tabs = await chrome.tabs.query({});
        const open = tabs.find((tab) => (tab.url || '').startsWith(`${address}/`));
        if (open) {
            await chrome.tabs.update(open.id, { active: true });
            if (typeof open.windowId === 'number') await chrome.windows?.update(open.windowId, { focused: true }).catch(() => undefined);
        } else {
            await chrome.tabs.create({ url: `${address}/` });
        }
    }

    function stopPolling() {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    async function pollPairing() {
        const state = await SdisProgram.pairingStatus();
        if (state === 'pending') {
            pollTimer = setTimeout(pollPairing, PAIR_POLL_MS);
            return;
        }
        stopPolling();
        await refreshStatus();
        if (state === 'unknown') showStatus(t('statusPairExpired'), 'bad');
    }

    async function pair() {
        stopPolling();
        $('pair').disabled = true;
        const result = await SdisProgram.requestPairing();
        if (!result.ok) {
            await refreshStatus();
            if (!result.offline) showStatus(t('errorSaveFailed', [String(result.data?.error || result.data?.detail || result.status)]), 'bad');
            return;
        }
        showStatus(t('statusPending'), 'warn');
        await focusProgramTab();
        pollTimer = setTimeout(pollPairing, PAIR_POLL_MS);
    }

    async function saveAddress() {
        const normalized = SdisProgram.normalizeAddress($('address').value);
        if (!normalized) {
            showStatus(t('addressInvalid'), 'bad');
            return;
        }
        const before = (await SdisProgram.getSettings()).address;
        $('address').value = normalized;
        // Another program address is another program: its pairing starts over.
        const changes = normalized === before ? { address: normalized } : { address: normalized, token: '', pairState: 'none' };
        await SdisProgram.setSettings(changes);
        await refreshStatus();
    }

    async function checkPermission() {
        const granted = await chrome.permissions.contains(ALL_SITES).catch(() => true);
        $('permission-block').hidden = granted;
    }

    async function init() {
        const settings = await SdisProgram.getSettings();
        $('address').value = settings.address;
        $('drop-box').checked = settings.showDropBox;
        $('save-address').addEventListener('click', saveAddress);
        $('address').addEventListener('keydown', (event) => { if (event.key === 'Enter') saveAddress(); });
        $('test').addEventListener('click', refreshStatus);
        $('pair').addEventListener('click', pair);
        $('forget').addEventListener('click', async () => {
            stopPolling();
            await SdisProgram.forgetPairing();
            await refreshStatus();
            showStatus(t('statusForgotten'), 'warn');
        });
        $('drop-box').addEventListener('change', (event) => SdisProgram.setSettings({ showDropBox: event.target.checked }));
        $('grant').addEventListener('click', async () => {
            await chrome.permissions.request(ALL_SITES).catch(() => false);
            await checkPermission();
            await refreshStatus();
        });
        await checkPermission();
        const state = await refreshStatus();
        if (state === 'pending') pollTimer = setTimeout(pollPairing, PAIR_POLL_MS);
    }

    init();
})();
