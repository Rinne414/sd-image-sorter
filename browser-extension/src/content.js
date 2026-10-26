/**
 * SD Image Sorter extension - in the page.
 *
 * Shows a small drop box while a picture is dragged (drop it there to save),
 * the "Save pictures on this page" picker, and short save messages. It only
 * passes picture addresses (or, for blob: pictures, their bytes) to the
 * background script; the background decides what is sent where.
 */
(function () {
    'use strict';

    if (window.__sdisContentLoaded) return;
    window.__sdisContentLoaded = true;

    const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
    const MIN_PICKER_SIDE = 120;
    const TOAST_MS = 4500;
    const IMAGE_LINK_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)(\?|#|$)/i;

    const STYLE = `
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
        .drop { position: fixed; top: 16px; right: 16px; width: 240px; padding: 18px 16px; z-index: 2147483647;
            border-radius: 14px; border: 2px dashed #9aa0a8; background: rgba(30, 32, 36, .94); color: #eef0f2;
            font-size: 15px; line-height: 1.4; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
        .drop.over { border-color: #e9ecef; background: rgba(52, 56, 62, .97); }
        .drop small { display: block; margin-top: 6px; color: #b9bec5; font-size: 13px; }
        .toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 12px 16px; z-index: 2147483647;
            border-radius: 12px; background: #1e2024; color: #eef0f2; font-size: 14px; line-height: 1.45;
            box-shadow: 0 10px 30px rgba(0,0,0,.35); border-left: 4px solid #3d8b5a; }
        .toast.bad { border-left-color: #c0543f; }
        .veil { position: fixed; inset: 0; z-index: 2147483647; background: rgba(10, 11, 13, .72);
            display: flex; align-items: center; justify-content: center; }
        .panel { width: min(1100px, calc(100vw - 48px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column;
            background: #1e2024; color: #eef0f2; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
        .head, .foot { display: flex; align-items: center; gap: 10px; padding: 14px 18px; flex-wrap: wrap; }
        .head h2 { margin: 0 auto 0 0; font-size: 17px; font-weight: 600; }
        .foot { border-top: 1px solid #33363c; }
        .foot .status { margin-right: auto; font-size: 14px; color: #c9cdd2; }
        .grid { overflow: auto; padding: 4px 18px 14px; display: grid; gap: 10px;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
        .tile { position: relative; border-radius: 10px; overflow: hidden; background: #2a2d32; cursor: pointer;
            border: 2px solid transparent; aspect-ratio: 1; }
        .tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
        .tile.on { border-color: #e9ecef; }
        .tile .mark { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 6px;
            background: rgba(0,0,0,.6); border: 2px solid #e9ecef; color: #fff; font-size: 14px; line-height: 18px; text-align: center; }
        .tile .size { position: absolute; bottom: 0; left: 0; right: 0; padding: 3px 6px; font-size: 12px;
            background: rgba(0,0,0,.6); color: #dfe2e6; }
        button { font: inherit; font-size: 14px; padding: 8px 14px; border-radius: 9px; cursor: pointer;
            border: 1px solid #4a4e55; background: #2c2f34; color: #eef0f2; }
        button.primary { background: #e9ecef; color: #16181b; border-color: #e9ecef; font-weight: 600; }
        button:disabled { opacity: .5; cursor: default; }
        label { font-size: 14px; color: #c9cdd2; display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
        .empty { padding: 30px 18px; color: #c9cdd2; font-size: 15px; }
    `;

    let host = null;
    let shadow = null;

    function layer() {
        if (!host) {
            host = document.createElement('sd-image-sorter-layer');
            shadow = host.attachShadow({ mode: 'closed' });
            // A constructed sheet is not an inline style, so a strict page CSP
            // cannot block it.
            try {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(STYLE);
                shadow.adoptedStyleSheets = [sheet];
            } catch (_e) {
                const style = document.createElement('style');
                style.textContent = STYLE;
                shadow.append(style);
            }
        }
        if (!host.isConnected) document.documentElement.append(host);
        return shadow;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // Toast ---------------------------------------------------------------------

    let toastTimer = null;
    function toast(text, ok) {
        const root = layer();
        root.querySelector('.toast')?.remove();
        const node = el('div', ok ? 'toast' : 'toast bad', text);
        node.setAttribute('role', 'status');
        root.append(node);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.remove(), TOAST_MS);
    }

    // Reading pictures ------------------------------------------------------------

    function pictureUrl(img) {
        return img.currentSrc || img.src || '';
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    async function shareableUrl(url) {
        if (!url.startsWith('blob:')) return url;
        try {
            return await blobToDataUrl(await (await fetch(url)).blob());
        } catch (_e) {
            return '';
        }
    }

    function send(items) {
        return chrome.runtime.sendMessage({ type: 'sdis-collect', items }).catch(() => ({ ok: false, text: t('errorExtensionReloaded') }));
    }

    async function saveUrls(urls) {
        const items = [];
        for (const url of urls) {
            const shared = await shareableUrl(url);
            if (shared) items.push({ srcUrl: shared });
        }
        if (!items.length) {
            toast(t('errorReadFailed'), false);
            return { ok: false, text: t('errorReadFailed') };
        }
        if (items.length === 1) toast(t('saving'), true);
        const outcome = (await send(items)) || { ok: false, text: t('errorExtensionReloaded') };
        if (items.length === 1) toast(outcome.text, outcome.ok);
        return outcome;
    }

    // Drop box ------------------------------------------------------------------

    let draggedUrl = '';
    let dropBox = null;

    async function dropBoxWanted() {
        const stored = await chrome.storage.local.get(['token', 'pairState', 'showDropBox']);
        return Boolean(stored.token) && stored.pairState === 'approved' && stored.showDropBox !== false;
    }

    function hideDropBox() {
        dropBox?.remove();
        dropBox = null;
    }

    function showDropBox() {
        if (dropBox) return;
        dropBox = el('div', 'drop', t('dropHere'));
        dropBox.append(el('small', '', t('dropHint')));
        dropBox.addEventListener('dragover', (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            dropBox?.classList.add('over');
        });
        dropBox.addEventListener('dragleave', () => dropBox?.classList.remove('over'));
        dropBox.addEventListener('drop', onDrop);
        layer().append(dropBox);
    }

    async function onDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        const transfer = event.dataTransfer;
        const files = [...(transfer.files || [])].filter((file) => file.type.startsWith('image/'));
        const listed = (transfer.getData('text/uri-list') || '').split(/\r?\n/).find((line) => line && !line.startsWith('#'));
        const url = draggedUrl || listed || '';
        hideDropBox();
        draggedUrl = '';
        if (files.length) {
            const urls = await Promise.all(files.map((file) => blobToDataUrl(file)));
            await saveUrls(urls);
        } else if (url) {
            await saveUrls([url]);
        }
    }

    document.addEventListener('dragstart', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const img = target?.closest('img');
        const link = target?.closest('a[href]');
        draggedUrl = img ? pictureUrl(img) : (link && IMAGE_LINK_RE.test(link.href) ? link.href : '');
        if (draggedUrl && await dropBoxWanted()) showDropBox();
    }, true);
    document.addEventListener('dragend', () => {
        // The drop handler runs first when the picture lands on the box.
        setTimeout(hideDropBox, 0);
    }, true);

    // Picker ----------------------------------------------------------------------

    function pagePictures() {
        const seen = new Set();
        const found = [];
        for (const img of document.images) {
            const link = img.closest('a[href]');
            // A thumbnail that links straight to a picture file: take the full one.
            const full = link && IMAGE_LINK_RE.test(link.href) ? link.href : '';
            const url = full || pictureUrl(img);
            if (!url || seen.has(url) || !/^(https?:|data:image\/|blob:)/i.test(url)) continue;
            seen.add(url);
            found.push({ url, preview: pictureUrl(img) || url, width: img.naturalWidth, height: img.naturalHeight, full: Boolean(full) });
        }
        return found;
    }

    function openPicker() {
        const root = layer();
        root.querySelector('.veil')?.remove();
        const all = pagePictures();
        const veil = el('div', 'veil');
        const panel = el('div', 'panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', t('pickerTitle'));
        const head = el('div', 'head');
        const grid = el('div', 'grid');
        const foot = el('div', 'foot');
        const status = el('span', 'status');
        const smallToggle = el('label');
        const smallBox = el('input');
        smallBox.type = 'checkbox';
        smallToggle.append(smallBox, document.createTextNode(t('pickerShowSmall')));
        const selectAll = el('button', '', t('pickerSelectAll'));
        const selectNone = el('button', '', t('pickerSelectNone'));
        const cancel = el('button', '', t('cancel'));
        const save = el('button', 'primary', t('pickerSave', ['0']));
        head.append(el('h2', '', t('pickerTitle')), smallToggle, selectAll, selectNone);
        foot.append(status, cancel, save);
        panel.append(head, grid, foot);
        veil.append(panel);
        root.append(veil);

        const chosen = new Set();
        const isSmall = (pic) => pic.width && pic.height && Math.min(pic.width, pic.height) < MIN_PICKER_SIDE;
        const visible = () => all.filter((pic) => smallBox.checked || !isSmall(pic));
        const close = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); };
        const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);

        function sync() {
            const shown = visible();
            [...chosen].forEach((url) => { if (!shown.some((pic) => pic.url === url)) chosen.delete(url); });
            // chrome.i18n has no plural forms: one picture has its own message.
            save.textContent = t(chosen.size === 1 ? 'pickerSaveOne' : 'pickerSave', [String(chosen.size)]);
            save.disabled = !chosen.size;
            const hidden = all.length - shown.length;
            status.textContent = hidden ? t('pickerHiddenSmall', [String(hidden)]) : '';
            grid.querySelectorAll('.tile').forEach((tile) => {
                const on = chosen.has(tile.dataset.url);
                tile.classList.toggle('on', on);
                tile.querySelector('.mark').textContent = on ? '✓' : '';
                tile.setAttribute('aria-checked', String(on));
            });
        }

        function render() {
            grid.textContent = '';
            const shown = visible();
            if (!shown.length) grid.append(el('div', 'empty', t('pickerEmpty')));
            shown.forEach((pic) => {
                const tile = el('div', 'tile');
                tile.dataset.url = pic.url;
                tile.setAttribute('role', 'checkbox');
                tile.tabIndex = 0;
                const img = el('img');
                img.src = pic.preview;
                img.alt = '';
                const size = pic.width ? `${pic.width} x ${pic.height}` : '';
                tile.append(img, el('span', 'mark'), el('span', 'size', pic.full ? `${size} ${t('pickerFullSize')}` : size));
                tile.addEventListener('click', () => { chosen.has(pic.url) ? chosen.delete(pic.url) : chosen.add(pic.url); sync(); });
                grid.append(tile);
            });
            sync();
        }

        visible().forEach((pic) => chosen.add(pic.url));
        smallBox.addEventListener('change', () => { if (smallBox.checked) all.forEach((pic) => chosen.add(pic.url)); render(); });
        selectAll.addEventListener('click', () => { visible().forEach((pic) => chosen.add(pic.url)); sync(); });
        selectNone.addEventListener('click', () => { chosen.clear(); sync(); });
        cancel.addEventListener('click', close);
        veil.addEventListener('click', (event) => { if (event.target === veil) close(); });
        save.addEventListener('click', async () => {
            const urls = [...chosen];
            save.disabled = true;
            cancel.textContent = t('close');
            status.textContent = t('pickerSaving', ['0', String(urls.length)]);
            const outcome = await saveUrls(urls);
            status.textContent = outcome.text;
            if (outcome.ok && urls.length === 1) close();
        });
        render();
        return { status, close };
    }

    let picker = null;

    // Messages from the background ------------------------------------------------

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === 'sdis-toast') toast(message.text, message.ok);
        if (message?.type === 'sdis-open-picker') picker = openPicker();
        if (message?.type === 'sdis-progress' && picker?.status?.isConnected) {
            picker.status.textContent = message.finished
                ? message.text
                : t('pickerSaving', [String(message.done), String(message.total)]);
        }
        if (message?.type === 'sdis-read-blob') {
            shareableUrl(String(message.url || '')).then((dataUrl) => sendResponse({ dataUrl }));
            return true;
        }
        return false;
    });
})();
