/**
 * catalog-search.js - type to find a feature in the "All features" list.
 *
 * The Professional top bar shows the catalog as a field ("Find a feature...
 * Ctrl K"), but the list it opened could not be searched: 30 rows to read.
 * This filters the rows as the user types. Every word typed must appear in a
 * row's name or description; a group with no row left hides with its title.
 * Enter opens the first row left, the arrow keys move between rows.
 *
 * Classic script: window.CatalogSearch.attach(input, body, emptyNote) once,
 * window.CatalogSearch.reset(input, body, emptyNote) each time the list is
 * rebuilt. The rows are the .catalog-item buttons built by entry-catalog.js.
 */
(function () {
    'use strict';

    const visibleRows = (body) => [...body.querySelectorAll('.catalog-item')].filter((row) => !row.hidden);

    function filter(input, body, emptyNote) {
        const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        body.querySelectorAll('.catalog-group').forEach((group) => {
            let groupShown = 0;
            group.querySelectorAll('.catalog-item').forEach((row) => {
                const text = row.textContent.toLowerCase();
                const match = words.every((word) => text.includes(word));
                row.hidden = !match;
                if (match) groupShown += 1;
            });
            group.hidden = groupShown === 0;
            const title = group.previousElementSibling;
            if (title?.classList.contains('catalog-group-title')) title.hidden = groupShown === 0;
            shown += groupShown;
        });
        if (emptyNote) emptyNote.hidden = shown > 0;
    }

    function moveFocus(body, input, step) {
        const rows = visibleRows(body);
        if (!rows.length) return;
        const at = rows.indexOf(document.activeElement);
        if (at === -1) {
            rows[step > 0 ? 0 : rows.length - 1].focus();
        } else if (at + step < 0) {
            input.focus();
        } else {
            rows[Math.min(rows.length - 1, at + step)].focus();
        }
    }

    function attach(input, body, emptyNote) {
        if (!input || !body || input.dataset.catalogSearchBound === '1') return;
        input.dataset.catalogSearchBound = '1';
        input.addEventListener('input', () => filter(input, body, emptyNote));
        input.addEventListener('keydown', (event) => {
            if (event.isComposing) return;
            if (event.key === 'Enter') {
                event.preventDefault();
                visibleRows(body)[0]?.click();
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveFocus(body, input, 1);
            }
        });
        body.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveFocus(body, input, event.key === 'ArrowDown' ? 1 : -1);
            }
        });
    }

    function reset(input, body, emptyNote) {
        if (!input || !body) return;
        input.value = '';
        filter(input, body, emptyNote);
    }

    window.CatalogSearch = Object.freeze({ attach, reset });
})();
