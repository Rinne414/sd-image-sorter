/**
 * folder-choices.js - a visible list of folders to pick from under a path
 * field (the Move / Copy dialog).
 *
 * Walkthrough 2026-11-09 (a beginner moving three pictures into "日常"): the
 * dialog asked for a typed full path; its suggestions sat in a <datalist> that
 * only appears after typing, so the only way through was copying a path from
 * a folder row's tooltip. This lists the places first: recent destinations,
 * then the library's own folders, each by its short name with the picture
 * count and the full path as the tooltip. A click fills the field; typing in
 * the field narrows the list.
 *
 * Classic script: window.FolderChoices.render(container, input, choices) and
 * window.FolderChoices.clear(container). Choices are {path, count?, recent?}.
 */
(function () {
    'use strict';

    const t = (key, fallback) => {
        const value = window.I18n?.t?.(key);
        return value && value !== key ? value : fallback;
    };

    const bound = new WeakMap(); // container -> {input, handler}

    const norm = (path) => String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');

    /** The part of every library path they share, so rows can show short names. */
    function commonParent(paths) {
        if (!paths.length) return '';
        const split = paths.map((path) => norm(path).split('/'));
        const first = split[0];
        let length = first.length - 1; // keep at least the last segment visible
        split.forEach((parts) => {
            let i = 0;
            while (i < length && i < parts.length - 1 && parts[i] === first[i]) i += 1;
            length = Math.min(length, i);
        });
        return length > 0 ? first.slice(0, length).join('/') : '';
    }

    function shortName(path, parent) {
        const clean = norm(path);
        return parent && clean.startsWith(`${parent}/`) ? clean.slice(parent.length + 1) : clean;
    }

    function row(choice, parent, input, list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'folder-choice';
        button.title = norm(choice.path);
        button.dataset.path = norm(choice.path);
        const icon = document.createElement('span');
        icon.className = 'folder-choice-icon';
        icon.setAttribute('aria-hidden', 'true');
        window.UiIcon?.fill(icon, choice.recent ? 'i-clock' : 'i-folder');
        const name = document.createElement('span');
        name.className = 'folder-choice-name';
        name.textContent = choice.recent ? norm(choice.path) : shortName(choice.path, parent);
        button.append(icon, name);
        if (Number.isFinite(choice.count)) {
            const count = document.createElement('span');
            count.className = 'folder-choice-count';
            count.textContent = String(choice.count);
            button.appendChild(count);
        }
        button.addEventListener('click', () => {
            input.value = norm(choice.path);
            list.querySelectorAll('.folder-choice.is-chosen').forEach((node) => node.classList.remove('is-chosen'));
            button.classList.add('is-chosen');
            input.focus();
        });
        return button;
    }

    function heading(key, fallback) {
        const head = document.createElement('div');
        head.className = 'folder-choices-head';
        head.textContent = t(key, fallback);
        return head;
    }

    /** Shows the rows whose path contains what is typed (a full typed path shows all). */
    function narrow(list, input) {
        const query = norm(input.value).toLowerCase();
        const rows = [...list.querySelectorAll('.folder-choice')];
        const exact = rows.some((node) => node.dataset.path.toLowerCase() === query);
        rows.forEach((node) => {
            node.hidden = Boolean(query) && !exact && !node.dataset.path.toLowerCase().includes(query);
            node.classList.toggle('is-chosen', exact && node.dataset.path.toLowerCase() === query);
        });
    }

    function clear(container) {
        if (!container) return;
        container.replaceChildren();
        container.hidden = true;
        const previous = bound.get(container);
        if (previous) previous.input.removeEventListener('input', previous.handler);
        bound.delete(container);
    }

    /**
     * @param {HTMLElement} container
     * @param {HTMLInputElement} input the path field the rows fill
     * @param {{path: string, count?: number, recent?: boolean}[]} choices
     */
    function render(container, input, choices) {
        clear(container);
        if (!container || !input || !Array.isArray(choices) || !choices.length) return;
        const seen = new Set();
        const unique = choices.filter((choice) => {
            const key = norm(choice.path).toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const recent = unique.filter((choice) => choice.recent);
        const library = unique.filter((choice) => !choice.recent);
        const parent = commonParent(library.map((choice) => choice.path));
        const list = document.createElement('div');
        list.className = 'folder-choices-list';
        if (recent.length) {
            list.appendChild(heading('folderChoices.recent', 'Used recently'));
            recent.forEach((choice) => list.appendChild(row(choice, parent, input, list)));
        }
        if (library.length) {
            list.appendChild(heading('folderChoices.library', 'Folders in this library'));
            library.forEach((choice) => list.appendChild(row(choice, parent, input, list)));
        }
        container.appendChild(list);
        container.hidden = false;
        const handler = () => narrow(list, input);
        bound.set(container, { input, handler });
        input.addEventListener('input', handler);
        narrow(list, input);
    }

    window.FolderChoices = Object.freeze({ render, clear });
})();
