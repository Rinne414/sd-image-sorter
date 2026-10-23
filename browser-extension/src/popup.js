/** SD Image Sorter extension - toolbar popup: status and the main actions. */
(function () {
    'use strict';

    const { t } = SdisProgram;
    const $ = (id) => document.getElementById(id);

    async function init() {
        const status = $('status');
        status.textContent = t('statusChecking');
        status.dataset.kind = 'busy';
        const info = await SdisProgram.connectionState();
        const texts = {
            offline: [t('statusOffline', [info.address]), 'bad'],
            unpaired: [t('popupUnpaired'), 'warn'],
            pending: [t('statusPending'), 'warn'],
            denied: [t('statusDenied'), 'bad'],
            paired: [t('popupPaired'), 'good'],
        };
        const [text, kind] = texts[info.state] || texts.offline;
        status.textContent = text;
        status.dataset.kind = kind;
        $('save-page').disabled = info.state !== 'paired';
        $('open-program').disabled = info.state === 'offline';
        chrome.runtime.sendMessage({ type: 'sdis-refresh-badge' }).catch(() => undefined);
    }

    $('save-page').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id !== undefined) await chrome.runtime.sendMessage({ type: 'sdis-open-picker-in-tab', tabId: tab.id });
        window.close();
    });
    $('open-program').addEventListener('click', async () => {
        const { address } = await SdisProgram.getSettings();
        await chrome.tabs.create({ url: `${address}/` });
        window.close();
    });
    $('open-options').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
        window.close();
    });

    init();
})();
