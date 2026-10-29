/**
 * SD Image Sorter - Collect pictures inside the program.
 *
 * - Ctrl+V in the gallery with a picture on the clipboard saves it to
 *   collected/<date> in the output folder and adds it to the current library
 *   (POST /api/collect/paste). Typing in a field is never taken over.
 * - Pasting text that is an http(s) picture address asks "Save this picture
 *   from the web?"; on yes the program downloads it (POST /api/collect/url).
 * - "Paste picture" in the import dialog does the same for people who do not
 *   know the shortcut (it reads the clipboard; the browser may ask first).
 * - The preview shows where a collected picture came from, with a link to the
 *   page (GET /api/collect/source/{id}).
 * The gallery refreshes itself when the import finishes (browser-extension.js
 * polls the collect generation).
 */
(function () {
    'use strict';

    const PICTURE_URL_RE = /^https?:\/\/\S+$/i;

    function t(key, fallback, params) {
        return typeof appT === 'function' ? appT(key, fallback, params) : fallback;
    }

    function toast(message, type) {
        window.App?.showToast?.(message, type);
    }

    function errorText(error, fallback) {
        return typeof formatUserError === 'function' ? formatUserError(error, fallback) : fallback;
    }

    async function postForm(path, form) {
        const response = await fetch(path, { method: 'POST', body: form, headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(window.apiErrorText(data, `HTTP ${response.status}`));
            error.apiStatus = response.status;
            error.apiData = data;
            throw error;
        }
        return data;
    }

    function savedMessage(result) {
        const converted = result.converted_from
            ? ` ${t('collect.convertedNote', '(converted from {format} to PNG)', { format: result.converted_from })}`
            : '';
        // "collected/2026-10-23": the full path is in the preview once it is indexed.
        const folder = String(result.folder || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
        return `${t('collect.savedToast', 'Saved {name} in {folder}. It appears in the gallery in a moment.', {
            name: result.filename,
            folder,
        })}${converted}`;
    }

    async function savePictureFile(file) {
        const form = new FormData();
        form.append('file', file, file.name || 'pasted.png');
        try {
            const result = await postForm('/api/collect/paste', form);
            toast(savedMessage(result), 'success');
            window.BrowserExtension?.pokeSoon?.();
        } catch (error) {
            toast(errorText(error, t('collect.pasteFailed', 'The pasted picture could not be saved')), 'error');
        }
    }

    // A pasted picture address ------------------------------------------------

    let pendingUrl = '';

    function offerUrl(url) {
        pendingUrl = url;
        let host = url;
        try {
            host = new URL(url).host;
        } catch (_e) { /* show the whole address */ }
        document.getElementById('collect-url-message').textContent = t(
            'collect.urlMessage',
            'The program downloads this picture from {host} and saves it in collected/<date> in your output folder.',
            { host },
        );
        document.getElementById('collect-url-value').textContent = url;
        showModal('collect-url-modal', { initialFocus: document.getElementById('btn-collect-url-save') });
    }

    async function saveOfferedUrl() {
        const url = pendingUrl;
        pendingUrl = '';
        hideModal('collect-url-modal');
        if (!url) return;
        toast(t('collect.downloading', 'Downloading the picture...'), 'info');
        try {
            const result = await window.App.API.post('/api/collect/url', { url });
            toast(savedMessage(result), 'success');
            window.BrowserExtension?.pokeSoon?.();
        } catch (error) {
            toast(errorText(error, t('collect.urlFailed', 'The picture could not be downloaded')), 'error');
        }
    }

    // Ctrl+V in the gallery ------------------------------------------------------

    function pasteTargetActive(event) {
        const target = event.target;
        if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
            return false;
        }
        if (!document.getElementById('view-gallery')?.classList.contains('active')) return false;
        const top = typeof _topOpenModal === 'function' ? _topOpenModal() : null;
        return !top || top.modal.id === 'scan-modal';
    }

    // A picture copied in QQ or another chat app is its file location
    // (<img src="file://...">); LocalPicture reads the original from disk.
    function takePasted(transfer) {
        return window.LocalPicture.take(transfer, ([file]) => savePictureFile(file), { preferLocation: true });
    }

    function onPaste(event) {
        if (!pasteTargetActive(event)) return;
        const pasted = takePasted(event.clipboardData);
        if (pasted.taken) {
            event.preventDefault();
            return;
        }
        const text = (event.clipboardData?.getData('text/plain') || '').trim();
        if (PICTURE_URL_RE.test(text)) {
            event.preventDefault();
            offerUrl(text);
        } else if (pasted.reason === 'not-picture') {
            event.preventDefault();
            window.LocalPicture.tellMissing(pasted.reason);
        }
    }

    async function pasteFromButton() {
        if (!navigator.clipboard?.read) {
            toast(t('collect.clipboardUnavailable', 'This browser does not let the page read the clipboard. Press Ctrl+V in the gallery instead.'), 'info');
            return;
        }
        try {
            const transfer = await window.LocalPicture.transferFromClipboard(await navigator.clipboard.read());
            if (takePasted(transfer).taken) return;
            const text = (transfer.getData('text/plain') || '').trim();
            if (PICTURE_URL_RE.test(text)) {
                offerUrl(text);
                return;
            }
            toast(t('collect.clipboardEmpty', 'There is no picture or picture address on the clipboard.'), 'info');
        } catch (_error) {
            toast(t('collect.clipboardDenied', 'The browser did not allow reading the clipboard. Press Ctrl+V in the gallery instead.'), 'info');
        }
    }

    // Where a collected picture came from ------------------------------------------

    let sourceRequest = 0;

    function hideSource() {
        sourceRequest += 1;
        const row = document.getElementById('modal-collected-source');
        if (row) row.hidden = true;
    }

    function setLink(id, href) {
        const link = document.getElementById(id);
        if (!link) return;
        link.hidden = !href;
        if (href) link.href = href;
        else link.removeAttribute('href');
    }

    function formatWhen(value) {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function safeWebUrl(value) {
        return /^https?:\/\//i.test(String(value || '')) ? String(value) : '';
    }

    async function showSource(imageId) {
        hideSource();
        const request = sourceRequest;
        let source = null;
        try {
            source = (await window.App.API.get(`/api/collect/source/${encodeURIComponent(imageId)}`))?.source;
        } catch (_error) {
            return; // the rest of the preview stays usable
        }
        if (request !== sourceRequest || !source) return;
        const pageUrl = safeWebUrl(source.page_url);
        const imageUrl = safeWebUrl(source.source_url);
        const label = document.getElementById('modal-collected-source-page');
        let host = '';
        try {
            host = pageUrl ? new URL(pageUrl).host : (imageUrl ? new URL(imageUrl).host : '');
        } catch (_e) { host = ''; }
        const viaLabel = { paste: t('collect.viaPaste', 'the clipboard'), url: host || t('collect.viaUrl', 'a picture address') };
        label.textContent = source.page_title || host || viaLabel[source.via] || t('collect.viaPaste', 'the clipboard');
        label.title = pageUrl || imageUrl || '';
        document.getElementById('modal-collected-source-when').textContent = formatWhen(source.collected_at);
        setLink('modal-collected-source-open', pageUrl);
        setLink('modal-collected-source-image', imageUrl);
        document.getElementById('modal-collected-source').hidden = false;
    }

    function init() {
        document.addEventListener('paste', onPaste);
        document.getElementById('btn-paste-picture')?.addEventListener('click', pasteFromButton);
        document.getElementById('btn-collect-url-save')?.addEventListener('click', saveOfferedUrl);
        document.getElementById('btn-collect-url-cancel')?.addEventListener('click', () => {
            pendingUrl = '';
            hideModal('collect-url-modal');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CollectedSource = { show: showSource, hide: hideSource };
    window.CollectPaste = { savePictureFile, offerUrl };
})();
