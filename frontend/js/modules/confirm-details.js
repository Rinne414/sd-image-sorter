/**
 * confirm-details.js - an optional list and a small note under the shared
 * confirm dialog's message (#confirm-modal).
 *
 * The dialog took plain text only, so a question about several folders typed
 * "•" lines by hand and a size such as "10.22 GB" broke across two lines
 * (UI audit 2026-11-08). showConfirm(title, message, onOk, onCancel,
 * { list, note }) hands both here: list rows are { text, meta }, the note is
 * one quiet paragraph. Every open writes both, so a list never leaks into the
 * next question.
 *
 * Classic script, loaded before app/analytics-export.js: window.ConfirmDetails.
 */
(function () {
    'use strict';

    function row({ text, meta }) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'confirm-list-text';
        label.textContent = text || '';
        item.appendChild(label);
        if (meta) {
            const side = document.createElement('span');
            side.className = 'confirm-list-meta';
            side.textContent = meta;
            item.appendChild(side);
        }
        return item;
    }

    /** Write (or clear) the list and the note of the confirm dialog. */
    function render({ list, note } = {}) {
        const listEl = document.getElementById('confirm-list');
        const noteEl = document.getElementById('confirm-note');
        const rows = Array.isArray(list) ? list.filter(Boolean) : [];
        if (listEl) {
            listEl.replaceChildren(...rows.map(row));
            listEl.hidden = rows.length === 0;
        }
        if (noteEl) {
            noteEl.textContent = note || '';
            noteEl.hidden = !note;
        }
    }

    window.ConfirmDetails = { render };
})();
