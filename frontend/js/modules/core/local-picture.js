/**
 * SD Image Sorter - pictures that arrive as a file location.
 *
 * QQ and other chat apps copy a picture as `<img src="file://L:\...\x.png">`
 * (HTML, or the same tag as plain text) and drag it out as a file:// link, so
 * a drop or paste can carry no picture file at all. LocalPicture.take() reads
 * what a drop or paste carries:
 *   - picture files (a blank MIME type counts when the name ends in a picture
 *     extension: Windows takes MIME types from the registry, which can be empty);
 *   - else picture locations from text/uri-list, text/html <img src> and
 *     text/plain, which it fetches from disk (POST /api/local-picture) and
 *     hands over as File objects, so every caller keeps its upload path.
 * For a paste the location wins over a pasted bitmap when both are there: the
 * bitmap is a re-encoded copy without generation details, the file is the
 * original. When nothing usable came in, take() says why (tellMissing words it).
 *
 * Loaded by index.html and quick-collect.html; the DataTransfer is read
 * synchronously (it is emptied once the event handler returns).
 */
(function () {
    'use strict';

    const PICTURE_NAME_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
    const LOCAL_RE = /^(?:file:|[A-Za-z]:[\\/]|\\\\[^\\]|\/[^/])/i;
    const WEB_RE = /^https?:\/\//i;

    function t(key, fallback, params) {
        const i18n = window.I18n;
        const value = i18n?.t?.(key, params);
        if (value && value !== key) return value;
        return typeof i18n?.format === 'function' ? i18n.format(fallback, params) : fallback;
    }

    function defaultSay(message, type) {
        window.App?.showToast?.(message, type);
    }

    function isPictureFile(file) {
        if (!file) return false;
        return String(file.type || '').startsWith('image/') || PICTURE_NAME_RE.test(String(file.name || ''));
    }

    function isPictureLocation(location) {
        return PICTURE_NAME_RE.test(location) || PICTURE_NAME_RE.test(location.split(/[?#]/)[0]);
    }

    function unwrap(value) {
        const text = String(value || '').trim();
        const match = /^(["'<])(.*)(["'>])$/s.exec(text);
        return match ? match[2].trim() : text;
    }

    /** The src of every <img> in HTML (or in text that holds an <img> tag). */
    function imageSources(html) {
        if (!html || !/<img\b/i.test(html)) return [];
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return Array.from(doc.querySelectorAll('img[src]'), (img) => img.getAttribute('src') || '');
        } catch (_error) {
            return [];
        }
    }

    function lines(text) {
        return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }

    /** Picture locations (deduplicated), plus whether other local files or web addresses came along. */
    function locationsIn({ uriList, html, plain }) {
        const values = [
            ...lines(uriList).filter((line) => !line.startsWith('#')),
            ...imageSources(html),
            ...(/<img\b/i.test(plain || '') ? imageSources(plain) : lines(plain)),
        ].map(unwrap);
        const found = { paths: [], otherLocal: false, web: false };
        for (const value of values) {
            if (LOCAL_RE.test(value)) {
                if (!isPictureLocation(value)) found.otherLocal = true;
                else if (!found.paths.includes(value)) found.paths.push(value);
            } else if (WEB_RE.test(value)) {
                found.web = true;
            }
        }
        return found;
    }

    function read(dataTransfer, type) {
        try {
            return dataTransfer.getData(type) || '';
        } catch (_error) {
            return '';
        }
    }

    /** What a drop or paste carries: picture files, picture locations, and why nothing is usable. */
    function inspect(dataTransfer) {
        if (!dataTransfer) return { files: [], paths: [], reason: 'empty' };
        let files = Array.from(dataTransfer.files || []);
        if (!files.length && dataTransfer.items) {
            files = Array.from(dataTransfer.items)
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .filter(Boolean);
        }
        const found = locationsIn({
            uriList: read(dataTransfer, 'text/uri-list'),
            html: read(dataTransfer, 'text/html'),
            plain: read(dataTransfer, 'text/plain'),
        });
        let reason = 'empty';
        if (files.length || found.otherLocal) reason = 'not-picture';
        else if (found.web) reason = 'web-only';
        return { files: files.filter(isPictureFile), paths: found.paths, reason };
    }

    function leafName(path) {
        const name = String(path).split(/[\\/]/).pop() || '';
        try {
            return decodeURIComponent(name);
        } catch (_error) {
            return name;
        }
    }

    /** The picture at a location on this computer, as a File; throws an Error that says why not. */
    async function fetchPicture(path) {
        const response = await fetch('/api/local-picture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            const fallback = `HTTP ${response.status}`;
            throw new Error(
                typeof window.apiErrorText === 'function'
                    ? window.apiErrorText(body, fallback)
                    : (body.message || body.error || fallback),
            );
        }
        const blob = await response.blob();
        let name = '';
        try {
            name = decodeURIComponent(response.headers.get('X-Picture-Name') || '');
        } catch (_error) {
            name = '';
        }
        return new File([blob], name || leafName(path) || 'picture.png', {
            type: blob.type || 'image/png',
            lastModified: Date.now(),
        });
    }

    async function openLocations(paths, onFiles, say, fallbackFiles) {
        say(t('localPicture.reading', 'The picture came as its file location (chat apps such as QQ copy pictures this way). Reading the original from disk…'), 'info');
        const files = [];
        const problems = [];
        for (const path of paths) {
            try {
                files.push(await fetchPicture(path));
            } catch (error) {
                problems.push(error?.message || String(error));
            }
        }
        const reasons = [...new Set(problems)];
        if (files.length) {
            onFiles(files, 'location');
        } else if (fallbackFiles.length) {
            say(t('localPicture.fellBack', 'The original file could not be opened ({reason}), so the pasted copy is used. It may have lost the generation details.', { reason: reasons[0] || '' }), 'warning');
            onFiles(fallbackFiles, 'files');
            return;
        }
        reasons.forEach((reason) => {
            say(t('localPicture.readFailed', 'Could not open the picture from its file location: {reason}', { reason }), 'error');
        });
    }

    /**
     * Take the pictures a drop or paste carries. onFiles(files, how) gets the
     * picture files at once (how = 'files'), or the pictures read from disk
     * later (how = 'location': the original files, not clipboard copies).
     * Options: many (all, not just the first), preferLocation (a paste), say
     * (message, type) for pages without the app's toasts.
     * Returns { taken, reason }; reason is 'empty', 'web-only' or 'not-picture'.
     */
    function take(dataTransfer, onFiles, options = {}) {
        const many = Boolean(options.many);
        const say = options.say || defaultSay;
        const found = inspect(dataTransfer);
        const files = many ? found.files : found.files.slice(0, 1);
        const paths = many ? found.paths : found.paths.slice(0, 1);
        if (paths.length && (options.preferLocation || !files.length)) {
            openLocations(paths, onFiles, say, files);
            return { taken: true, reason: '' };
        }
        if (files.length) {
            onFiles(files, 'files');
            return { taken: true, reason: '' };
        }
        return { taken: false, reason: found.reason };
    }

    /**
     * A paste-like object from navigator.clipboard.read() items, for Paste
     * buttons: the first picture as a file, and the HTML and plain text (where
     * a chat app puts the picture's location).
     */
    async function transferFromClipboard(clipboardItems) {
        const files = [];
        const texts = {};
        for (const item of clipboardItems || []) {
            for (const type of item.types) {
                if (type.startsWith('image/') && !files.length) {
                    const blob = await item.getType(type);
                    files.push(new File([blob], `pasted.${type.slice(6)}`, { type }));
                } else if ((type === 'text/html' || type === 'text/plain') && !texts[type]) {
                    texts[type] = await (await item.getType(type)).text();
                }
            }
        }
        return { files, items: [], getData: (type) => texts[type] || '' };
    }

    /** What was missing and what to do, in plain words. */
    function missingText(reason, options = {}) {
        if (reason === 'web-only') {
            return t('localPicture.webOnly', 'Only a web address came in, not the picture. Save the picture to this computer first, then drag the file in.');
        }
        if (reason === 'not-picture') {
            return t('localPicture.notPicture', 'That is not a picture file. The program reads PNG, JPG, WebP, GIF, BMP and TIFF.');
        }
        if (options.clipboard) {
            return t('localPicture.nothingPasted', 'No image found on the clipboard, and no picture file location either. Copy the picture again, or drag the file in.');
        }
        return t('localPicture.nothingDropped', 'No picture came in, and no picture file location either. Drag the picture file in from its folder, or choose it with the file picker.');
    }

    function tellMissing(reason, options = {}) {
        (options.say || defaultSay)(missingText(reason, options), 'warning');
    }

    window.LocalPicture = {
        isPictureFile,
        inspect,
        fetchPicture,
        take,
        transferFromClipboard,
        missingText,
        tellMissing,
    };
})();
