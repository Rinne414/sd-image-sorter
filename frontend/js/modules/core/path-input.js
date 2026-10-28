/**
 * Pasted Windows paths: Explorer's "Copy as path" wraps them in quotes, which
 * every folder field then rejected as an invalid character. One pair of
 * surrounding quotes is stripped as the value is typed or pasted, in the
 * capture phase, so the field's own validators never see it.
 *
 * Also: field hints that are never cut off (fitPathPlaceholder, fitPlaceholder).
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

    // A hint is never cut off: the first of its texts (longest first) that fits
    // inside the field is shown, and fitted again whenever the field resizes.
    const SEPARATOR = /[\\/]/;
    const fitters = new WeakMap();
    let measure = null;

    function textWidth(element, text) {
        measure = measure || document.createElement('canvas').getContext('2d');
        const style = getComputedStyle(element);
        measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return measure.measureText(text).width;
    }

    function firstFitting(input, texts) {
        const style = getComputedStyle(input);
        const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        // Hidden for now: the whole text, until the observer sees a size.
        if (!(room > 0)) return texts[0];
        return texts.find((text) => textWidth(input, text) <= room) ?? texts[texts.length - 1];
    }

    const observer = typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            for (const entry of entries) fitters.get(entry.target)?.();
        })
        : null;

    function watch(input, fit) {
        fitters.set(input, fit);
        fit();
        if (observer) observer.observe(input);
    }

    /** "Empty = <path>": leading folders give way ("Empty = …\output\censor"); the tooltip keeps all of it. */
    function fitPathPlaceholder(input, format, path) {
        if (!(input instanceof HTMLInputElement)) return;
        const sep = String(path).includes('\\') ? '\\' : '/';
        const parts = String(path).split(SEPARATOR).filter(Boolean);
        const texts = [format(path), ...parts.slice(1).map((_, i) => format(`…${sep}${parts.slice(i + 1).join(sep)}`))];
        watch(input, () => {
            input.title = texts[0];
            input.placeholder = firstFitting(input, texts);
        });
    }

    /** A hint with shorter stand-ins for a narrow field (data-i18n-placeholder-short, i18n.js). */
    function fitPlaceholder(input, texts) {
        if (!(input instanceof HTMLInputElement) || !texts.length) return;
        watch(input, () => {
            input.placeholder = firstFitting(input, texts);
        });
    }

    window.fitPathPlaceholder = fitPathPlaceholder;
    window.fitPlaceholder = fitPlaceholder;
})();
