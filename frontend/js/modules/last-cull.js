/**
 * The last Keep / Reject result, kept after its message is gone.
 *
 * A cull ends with one line offering what to do with the pictures just judged
 * (move the kept, look at the rejected, rejected to the recycle bin). That
 * line was the only place the two lists lived: close it, or let another
 * message take its place, and a reject list that was not saved to a
 * collection was lost with it. The result of the last cull is remembered
 * here, per library, and can be brought back from the Keep / Reject setup
 * page or the function catalog.
 *
 * It stays in this browser (localStorage); the lists are picture ids only.
 */
(function initLastCull(global) {
    'use strict';

    const KEY = 'sd-sorter-last-cull';
    const LINE_ID = 'sort-cull-last';
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );

    function library() {
        const headers = global.LibraryWorkspace?.libraryHeaders?.({}) || {};
        return headers['X-SD-Library-Id'] || 'main';
    }

    function readAll() {
        try {
            const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
            return stored && typeof stored === 'object' ? stored : {};
        } catch (_error) {
            return {};
        }
    }

    /** The last result for the library on screen: { at, kept, rejected }, or null. */
    function last() {
        const found = readAll()[library()];
        if (!found || !Array.isArray(found.kept) || !Array.isArray(found.rejected)) return null;
        return found.kept.length || found.rejected.length ? found : null;
    }

    function remember(kept, rejected) {
        if (!kept.length && !rejected.length) return;
        const all = readAll();
        all[library()] = { at: new Date().toISOString(), kept, rejected };
        try {
            localStorage.setItem(KEY, JSON.stringify(all));
        } catch (_error) {
            // Storage refused (full or private window): the finish line still offers the actions once.
        }
        drawLine();
    }

    function when(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Offer the last result's file actions again. Returns false when there is none. */
    function offer() {
        const found = last();
        if (!found || typeof global.offerCullFileActions !== 'function') {
            global.App?.showToast?.(tr('lastCull.none', 'No Keep / Reject result is remembered for this library yet.'), 'info');
            return false;
        }
        global.offerCullFileActions(found.kept, found.rejected);
        return true;
    }

    /** One line on the Keep / Reject setup page, while a result is remembered. */
    function drawLine() {
        const intro = document.getElementById('sort-cull-intro');
        if (!intro) return;
        document.getElementById(LINE_ID)?.remove();
        const found = last();
        if (!found) return;
        const line = document.createElement('p');
        line.id = LINE_ID;
        line.className = 'sort-cull-last';
        const text = document.createElement('span');
        text.textContent = tr('lastCull.line', 'Last time ({when}): kept {kept}, rejected {rejected}.', {
            when: when(found.at), kept: found.kept.length, rejected: found.rejected.length,
        });
        const again = document.createElement('button');
        again.type = 'button';
        again.className = 'btn btn-secondary btn-small';
        again.id = 'btn-cull-last-actions';
        again.textContent = tr('lastCull.again', 'What to do with them…');
        again.addEventListener('click', offer);
        line.append(text, again);
        intro.appendChild(line);
    }

    global.LastCull = Object.freeze({ remember, offer, last });

    const start = () => {
        drawLine();
        document.addEventListener('languageChanged', drawLine);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(window);
