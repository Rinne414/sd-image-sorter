/**
 * Quick collect: a small window that takes dropped (or pasted, or chosen)
 * pictures and adds them to the gallery. The files are copied into the
 * "collected" folder of the output root (POST /api/import-files?destination=collected)
 * and indexed there; the original files are not touched.
 *
 * Opened by the desktop shell (tray menu, always on top) or as a browser
 * popup from the function catalog. Other windows of the program refresh
 * their gallery through the 'sd-image-sorter-collect' BroadcastChannel.
 */
(function () {
    'use strict';

    const LIBRARY_KEY = 'sd-library-workspace-v1';
    const CHANNEL = 'sd-image-sorter-collect';
    const PICTURE_TYPES = /^image\/(png|jpeg|webp|bmp|gif)$/;
    const DEFAULT_LIBRARY_SEED_NAME = 'Main library';

    const t = (key, fallback, params) => {
        const text = window.I18n?.t?.(key, params);
        if (text && text !== key) return text;
        return window.I18n.format(fallback, params);
    };

    function libraryId() {
        try {
            const raw = localStorage.getItem(LIBRARY_KEY);
            return (raw && JSON.parse(raw).currentId) || 'main';
        } catch (_error) {
            return 'main';
        }
    }

    const state = { library: null, folder: '', busy: false, channel: null, context: null };

    async function api(path, init = {}) {
        const headers = Object.assign({ Accept: 'application/json', 'X-SD-Library-Id': libraryId() }, init.headers || {});
        const response = await fetch(path, Object.assign({}, init, { headers }));
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(window.apiErrorText(body, `HTTP ${response.status}`));
        }
        return body;
    }

    // The backend seeds the default library as "Main library"; until the user
    // renames it, it is named in the UI language (主图库), as in the gallery
    // (library-workspace.js libraryDisplayName).
    function displayLibraryName(library) {
        if (!library?.name) return null;
        if (library.is_default && library.name === DEFAULT_LIBRARY_SEED_NAME) {
            return t('library.defaultName', DEFAULT_LIBRARY_SEED_NAME);
        }
        return library.name;
    }

    function libraryName() {
        return state.library || t('quickCollect.libraryUnknown', 'the current library');
    }

    function renderLead() {
        document.getElementById('qc-lead').textContent = t(
            'quickCollect.lead',
            'Drop pictures here. A copy is kept in {folder} and added to {library}.',
            { folder: state.folder || 'output/collected', library: libraryName() },
        );
    }

    async function loadContext() {
        try {
            const [current, folders] = await Promise.all([api('/api/libraries/current'), api('/api/output-folders')]);
            state.library = displayLibraryName(current?.library);
            state.folder = folders?.folders?.collected || '';
        } catch (_error) {
            // The lead then names the folder and library generically.
        }
        renderLead();
    }

    function addResult(kind, lines) {
        document.getElementById('qc-empty').hidden = true;
        const item = document.createElement('li');
        item.className = `qc-result is-${kind}`;
        lines.filter(Boolean).forEach((text) => {
            const line = document.createElement('span');
            line.className = 'qc-result-line';
            line.textContent = text;
            item.appendChild(line);
        });
        const time = document.createElement('span');
        time.className = 'qc-result-line qc-result-time';
        time.textContent = new Date().toLocaleTimeString();
        item.appendChild(time);
        document.getElementById('qc-results').prepend(item);
    }

    function describe(result) {
        const added = Number(result?.imported || 0);
        const failed = Number(result?.errors || 0);
        const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
        const lines = [t('quickCollect.done', '{count} added to {library}', { count: added, library: libraryName() })];
        if (failed) lines.push(t('quickCollect.unreadable', '{count} copied but could not be read as pictures', { count: failed }));
        if (skipped.length) lines.push(t('quickCollect.skipped', 'Skipped, not a picture: {names}', { names: skipped.join(', ') }));
        const kind = added && !failed && !skipped.length ? 'ok' : (added ? 'warn' : 'error');
        return { kind, lines, added };
    }

    async function upload(files) {
        if (!files.length || state.busy) return;
        state.busy = true;
        const drop = document.getElementById('qc-drop');
        drop.classList.add('is-busy');
        const form = new FormData();
        files.forEach((file) => form.append('files', file, file.name));
        try {
            // The result names the library, so its name must be known first.
            await state.context;
            const result = await api('/api/import-files?destination=collected', { method: 'POST', body: form });
            const summary = describe(result);
            addResult(summary.kind, summary.lines);
            if (summary.added) state.channel?.postMessage({ type: 'collected', count: summary.added, imageIds: result.image_ids || [] });
        } catch (error) {
            addResult('error', [t('quickCollect.failed', 'Could not add the pictures: {error}', { error: error.message || String(error) })]);
        } finally {
            state.busy = false;
            drop.classList.remove('is-busy');
        }
    }

    function filesFrom(dataTransfer) {
        return Array.from(dataTransfer?.files || []);
    }

    // Results list instead of toasts; "reading from disk" is not worth a line.
    function sayInList(message, type) {
        if (type !== 'info') addResult(type === 'error' ? 'error' : 'warn', [message]);
    }

    function missingLine(reason, options) {
        return reason === 'web-only'
            ? t('quickCollect.linkOnly', 'That was a link, not a file. Save the picture first, then drop the file here.')
            : window.LocalPicture.missingText(reason, options);
    }

    function onDrop(event) {
        event.preventDefault();
        document.getElementById('qc-drop').classList.remove('is-over');
        const files = filesFrom(event.dataTransfer);
        if (files.length) {
            upload(files);
            return;
        }
        // A picture dragged out of QQ or another chat app is its file location.
        const dropped = window.LocalPicture.take(event.dataTransfer, upload, { many: true, say: sayInList });
        if (!dropped.taken) addResult('warn', [missingLine(dropped.reason)]);
    }

    function onPaste(event) {
        event.preventDefault();
        // A picture copied in a chat app is its file location: the original
        // file wins over the pasted bitmap, which has lost its generation details.
        const pasted = window.LocalPicture.take(event.clipboardData, (files, how) => {
            // Pasted bitmaps are all called image.png: give each its own name.
            upload(how === 'location' ? files : files.map((file, index) => {
                if (!PICTURE_TYPES.test(file.type)) return file;
                const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                return new File([file], `pasted-${stamp}-${index + 1}.${ext}`, { type: file.type });
            }));
        }, { many: true, preferLocation: true, say: sayInList });
        if (!pasted.taken) addResult('warn', [missingLine(pasted.reason, { clipboard: true })]);
    }

    function bind() {
        const drop = document.getElementById('qc-drop');
        const input = document.getElementById('qc-file-input');
        ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
            event.preventDefault();
            drop.classList.add('is-over');
        }));
        drop.addEventListener('dragleave', (event) => {
            if (!drop.contains(event.relatedTarget)) drop.classList.remove('is-over');
        });
        drop.addEventListener('drop', onDrop);
        // A drop that misses the zone must not navigate the window to the file.
        document.addEventListener('dragover', (event) => event.preventDefault());
        document.addEventListener('drop', (event) => { if (!drop.contains(event.target)) onDrop(event); });
        document.addEventListener('paste', onPaste);
        input.addEventListener('change', () => {
            upload(Array.from(input.files || []));
            input.value = '';
        });
    }

    function start() {
        window.I18n?.init?.();
        window.I18n?.applyToDOM?.();
        if ('BroadcastChannel' in window) state.channel = new BroadcastChannel(CHANNEL);
        bind();
        state.context = loadContext();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
