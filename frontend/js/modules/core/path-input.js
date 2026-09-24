/**
 * Pasted Windows paths: Explorer's "Copy as path" wraps them in quotes, which
 * every folder field then rejected as an invalid character. One pair of
 * surrounding quotes is stripped as the value is typed or pasted, in the
 * capture phase, so the field's own validators never see it.
 */
(function () {
    'use strict';

    const QUOTED = /^\s*(["'])([\s\S]*)\1\s*$/;
    const PATH_FIELD = /(folder|path|dir|destination|output)/;

    function unquotePath(value) {
        const text = String(value ?? '');
        const match = QUOTED.exec(text);
        return match ? match[2].trim() : text;
    }

    function isPathField(element) {
        if (!(element instanceof HTMLInputElement)) return false;
        if (element.type !== 'text') return false;
        const key = `${element.id} ${element.name} ${element.className}`.toLowerCase();
        // Quotes mean an exact phrase in the search boxes; leave those alone.
        if (key.includes('search')) return false;
        return PATH_FIELD.test(key);
    }

    document.addEventListener('input', (event) => {
        const element = event.target;
        if (!isPathField(element)) return;
        const unquoted = unquotePath(element.value);
        if (unquoted !== element.value) element.value = unquoted;
    }, true);

    window.unquotePath = unquotePath;
})();
