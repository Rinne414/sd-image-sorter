/**
 * "Float as reference": keep one picture in a small window above other work.
 *
 * Three ways, best first:
 *  - the desktop program opens its own always-on-top window (window.sdDesktop);
 *  - Chrome and Edge give a picture-in-picture window, which also stays on top
 *    (one at a time: a second picture replaces the first);
 *  - any other browser gets an ordinary small window, and is told that it
 *    will not stay on top.
 *
 * The view itself is js/reference-view/view.js; the window's page is reference.html.
 */
(function initReferenceWindow(global) {
    'use strict';

    const SIZE = { width: 420, height: 560 };
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;

    function pageUrl(id, name) {
        const query = new URLSearchParams({ id: String(id) });
        if (name) query.set('name', name);
        return `/static/reference.html?${query}`;
    }

    async function openInPicture(id, name) {
        const pip = await global.documentPictureInPicture.requestWindow(SIZE);
        const sheet = pip.document.createElement('link');
        sheet.rel = 'stylesheet';
        sheet.href = new URL('/static/css/reference.css', global.location.href).href;
        pip.document.head.appendChild(sheet);
        pip.document.title = name || tr('reference.title', 'Reference');
        pip.document.body.className = 'reference-body';
        const root = pip.document.createElement('main');
        root.className = 'reference-root';
        pip.document.body.appendChild(root);
        global.ReferenceView.mount(root, {
            src: new URL(`/api/image-file/${id}`, global.location.href).href,
            name,
            text: (key, fallback) => tr(key, fallback),
        });
    }

    /** @returns {Promise<'desktop'|'picture'|'window'|'blocked'>} how it was opened */
    async function open(imageId, name) {
        const id = Number(imageId);
        if (!Number.isInteger(id) || id <= 0) return 'blocked';
        if (typeof global.sdDesktop?.openReference === 'function') {
            await global.sdDesktop.openReference(id, name || '');
            return 'desktop';
        }
        if (global.documentPictureInPicture?.requestWindow) {
            await openInPicture(id, name || '');
            return 'picture';
        }
        const opened = global.open(pageUrl(id, name), `sd-reference-${id}`, `popup,width=${SIZE.width},height=${SIZE.height}`);
        if (!opened) {
            app()?.showToast?.(tr('reference.blocked', 'The browser blocked the reference window. Allow pop-ups for this page and try again.'), 'error');
            return 'blocked';
        }
        app()?.showToast?.(tr('reference.notOnTop', 'Opened as an ordinary window: this browser cannot keep it above other windows. Chrome, Edge and the desktop program can.'), 'info');
        return 'window';
    }

    function wire() {
        document.getElementById('btn-modal-reference')?.addEventListener('click', async () => {
            document.getElementById('modal-tools-menu')?.removeAttribute('open');
            const id = global.Gallery?._currentPreviewId;
            const picture = (app()?.AppState?.images || []).find((image) => Number(image.id) === Number(id));
            try {
                await open(id, picture?.filename || '');
            } catch (error) {
                app()?.showToast?.(error?.message || String(error), 'error');
            }
        });
    }

    global.ReferenceWindow = Object.freeze({ open });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
