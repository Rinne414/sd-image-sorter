/**
 * reference.html: the reference view in a window of its own.
 *
 * Opened as /static/reference.html?id=<picture id> by the desktop program
 * (an always-on-top window) or by a browser that has no picture-in-picture
 * window (an ordinary small window). See js/modules/reference-window.js.
 */
(function initReferencePage(global) {
    'use strict';

    global.I18n?.init?.();
    const text = (key, fallback) => {
        const found = global.I18n?.t?.(key);
        return found && found !== key ? found : fallback;
    };
    const root = document.getElementById('reference-root');
    const id = Number(new URLSearchParams(global.location.search).get('id'));

    if (!Number.isInteger(id) || id <= 0) {
        const problem = document.createElement('p');
        problem.className = 'reference-problem';
        problem.textContent = text('reference.noPicture', 'No picture was chosen for this window.');
        root.replaceChildren(problem);
        return;
    }

    const name = new URLSearchParams(global.location.search).get('name') || '';
    document.title = name ? `${name} - ${text('reference.title', 'Reference')}` : text('reference.title', 'Reference');
    global.ReferenceView.mount(root, { src: `/api/image-file/${id}`, name, text });
})(window);
