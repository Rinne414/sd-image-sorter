/**
 * SD Image Sorter extension - background.
 *
 * Right-click menu ("Save to SD Image Sorter", "Save pictures on this page..."),
 * the toolbar badge (program running / paired), and the save itself: the
 * picture is downloaded here, in the browser, so the site's cookies and the
 * page as Referer apply, then uploaded to the program with its source page.
 * When the browser cannot fetch it, the program downloads it instead
 * (/api/ext/collect-url, with the page as Referer). Content scripts only send
 * a picture address or picture bytes; this script decides where they go.
 */
if (typeof importScripts === 'function' && typeof SdisProgram === 'undefined') {
    importScripts('program.js');
}

const MENU_SAVE_IMAGE = 'sdis-save-image';
const MENU_SAVE_PAGE = 'sdis-save-page';
const STATUS_ALARM = 'sdis-status';
const STATUS_PERIOD_MINUTES = 1;
const REFERER_RULE_ID = 1;
const BADGE = {
    paired: { text: '', color: '#3d8b5a', title: 'badgePaired' },
    offline: { text: 'OFF', color: '#6b6f76', title: 'badgeOffline' },
    unpaired: { text: '!', color: '#b5473a', title: 'badgeUnpaired' },
    pending: { text: '...', color: '#6b6f76', title: 'badgePending' },
    denied: { text: '!', color: '#b5473a', title: 'badgeUnpaired' },
};

const { t } = SdisProgram;

// Status badge ---------------------------------------------------------------

async function refreshBadge() {
    const { state, address } = await SdisProgram.connectionState();
    const badge = BADGE[state] || BADGE.offline;
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    await chrome.action.setTitle({ title: `${t('extName')} - ${t(badge.title, [address])}` });
    return state;
}

function setupMenusAndAlarm() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: MENU_SAVE_IMAGE, title: t('menuSaveImage'), contexts: ['image'] });
        chrome.contextMenus.create({ id: MENU_SAVE_PAGE, title: t('menuSavePage'), contexts: ['page', 'image', 'link'] });
    });
    chrome.alarms.create(STATUS_ALARM, { periodInMinutes: STATUS_PERIOD_MINUTES });
    refreshBadge();
}

chrome.runtime.onInstalled.addListener(setupMenusAndAlarm);
chrome.runtime.onStartup.addListener(setupMenusAndAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STATUS_ALARM) refreshBadge();
});
chrome.storage.onChanged.addListener((changes) => {
    if (changes.address || changes.token || changes.pairState) refreshBadge();
});

// Downloading in the browser ------------------------------------------------

/** One save at a time: the Referer rule below is per site, not per request. */
let saveChain = Promise.resolve();

function serialized(task) {
    const run = saveChain.then(task, task);
    saveChain = run.catch(() => undefined);
    return run;
}

async function withReferer(url, pageUrl, fetchIt) {
    // fetch() cannot set Referer; a session rule does, only for this
    // extension's own requests (no tab) to the picture's site.
    let ruleAdded = false;
    try {
        const host = new URL(url).hostname;
        if (pageUrl && /^https?:/i.test(pageUrl) && chrome.declarativeNetRequest?.updateSessionRules) {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [REFERER_RULE_ID],
                addRules: [{
                    id: REFERER_RULE_ID,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: [{ header: 'referer', operation: 'set', value: pageUrl }],
                    },
                    condition: {
                        requestDomains: [host],
                        tabIds: [chrome.tabs.TAB_ID_NONE],
                        resourceTypes: ['xmlhttprequest', 'other'],
                    },
                }],
            });
            ruleAdded = true;
        }
    } catch (_e) {
        ruleAdded = false; // the program's own download (with Referer) is the fallback
    }
    try {
        return await fetchIt();
    } finally {
        if (ruleAdded) {
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE_ID] }).catch(() => undefined);
        }
    }
}

async function downloadInBrowser(url, pageUrl) {
    if (url.startsWith('data:')) return (await fetch(url)).blob();
    const response = await withReferer(url, pageUrl, () => fetch(url, { credentials: 'include', cache: 'force-cache' }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (type.startsWith('text/')) throw new Error(`not a picture (${type})`);
    return response.blob();
}

function fileNameFor(url, blob) {
    let name = 'picture';
    if (!url.startsWith('data:')) {
        try {
            const leaf = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
            if (leaf) name = leaf;
        } catch (_e) { /* keep the default name */ }
    }
    if (!/\.[a-z0-9]{2,5}$/i.test(name) && blob?.type?.startsWith('image/')) {
        name += `.${blob.type.slice(6).replace('jpeg', 'jpg').replace(/\+.*$/, '')}`;
    }
    return name;
}

// Saving into the program ---------------------------------------------------

function explain(result) {
    if (result.offline) return { ok: false, stop: true, text: t('errorOffline') };
    if (result.status === 403 && result.data?.code === 'ext_not_paired') {
        SdisProgram.setSettings({ pairState: 'none' });
        return { ok: false, stop: true, text: t('errorNotPaired') };
    }
    return { ok: false, text: t('errorSaveFailed', [SdisProgram.errorText(result)]) };
}

async function uploadBlob(blob, item, source) {
    const form = new FormData();
    const filename = fileNameFor(item.srcUrl, blob);
    form.append('file', blob, filename);
    form.append('meta', JSON.stringify({ ...source, filename }));
    return SdisProgram.call('/api/ext/collect', { form });
}

/** Save one picture: {srcUrl}, plus the page it is on. Resolves {ok, text}. */
async function saveOne(item, page) {
    const isData = item.srcUrl.startsWith('data:');
    const source = { source_url: isData ? null : item.srcUrl, page_url: page.url || null, page_title: page.title || null };
    let blob = null;
    try {
        blob = await downloadInBrowser(item.srcUrl, page.url);
    } catch (_e) {
        blob = null;
    }
    let result;
    if (blob) {
        result = await uploadBlob(blob, item, source);
    } else if (isData) {
        return { ok: false, text: t('errorReadFailed') };
    } else {
        result = await SdisProgram.call('/api/ext/collect-url', {
            json: { image_url: item.srcUrl, page_url: page.url || null, page_title: page.title || null },
        });
    }
    if (!result.ok) return explain(result);
    const note = result.data.converted_from ? t('savedConverted', [result.data.converted_from]) : '';
    return { ok: true, text: t('savedOne', [result.data.filename]) + note };
}

async function saveMany(items, page, tabId) {
    let saved = 0;
    const failures = [];
    for (let index = 0; index < items.length; index += 1) {
        notifyTab(tabId, { type: 'sdis-progress', done: index, total: items.length });
        const outcome = await saveOne(items[index], page);
        if (outcome.ok) saved += 1;
        else failures.push(outcome.text);
        // Nothing else can be saved while the program is closed or unpaired.
        if (outcome.stop) break;
    }
    const notSaved = items.length - saved;
    const text = notSaved
        ? t('savedSomeFailed', [String(saved), String(notSaved), failures[0]])
        : t('savedMany', [String(saved)]);
    notifyTab(tabId, { type: 'sdis-progress', done: items.length, total: items.length, finished: true, text, ok: !notSaved });
    return { ok: !notSaved, text, saved, failed: notSaved };
}

function notifyTab(tabId, message) {
    if (typeof tabId !== 'number' || tabId < 0) return;
    chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

async function readBlobInTab(tabId, url) {
    // A blob: address belongs to the page; only its content script can read it.
    const answer = await chrome.tabs.sendMessage(tabId, { type: 'sdis-read-blob', url }).catch(() => null);
    return answer?.dataUrl || null;
}

async function saveFromMenu(info, tab) {
    let srcUrl = info.srcUrl || '';
    if (srcUrl.startsWith('blob:')) srcUrl = (await readBlobInTab(tab.id, srcUrl)) || '';
    if (!srcUrl) {
        notifyTab(tab.id, { type: 'sdis-toast', ok: false, text: t('errorReadFailed') });
        return;
    }
    const page = { url: info.pageUrl || tab.url, title: tab.title };
    const outcome = await serialized(() => saveOne({ srcUrl }, page));
    notifyTab(tab.id, { type: 'sdis-toast', ok: outcome.ok, text: outcome.text });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab) return;
    if (info.menuItemId === MENU_SAVE_IMAGE) saveFromMenu(info, tab);
    if (info.menuItemId === MENU_SAVE_PAGE) notifyTab(tab.id, { type: 'sdis-open-picker' });
});

function validItems(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => ({ srcUrl: String(item?.srcUrl || '') }))
        .filter((item) => /^(https?:|data:image\/)/i.test(item.srcUrl));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'sdis-collect' && sender.tab) {
        const items = validItems(message.items);
        const page = { url: sender.tab.url, title: sender.tab.title };
        if (!items.length) {
            sendResponse({ ok: false, text: t('errorReadFailed') });
            return false;
        }
        serialized(() => (items.length === 1 ? saveOne(items[0], page) : saveMany(items, page, sender.tab.id)))
            .then(sendResponse);
        return true;
    }
    if (message?.type === 'sdis-open-picker-in-tab' && typeof message.tabId === 'number') {
        notifyTab(message.tabId, { type: 'sdis-open-picker' });
        return false;
    }
    if (message?.type === 'sdis-refresh-badge') {
        refreshBadge().then((state) => sendResponse({ state }));
        return true;
    }
    return false;
});
