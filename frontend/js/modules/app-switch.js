/**
 * Switching between this interface (/) and the new one, V4 (/v4/).
 *
 * - "试用新版界面（V4）" (More menu #nav-tools-v4, and a row in the All
 *   Features catalog) goes to /v4/?library=<current library>, so V4 opens
 *   the library that is open here.
 * - V4's "回到旧版界面（V3.5）" comes back to /?library=<its library>. The id
 *   is read once and dropped from the address at once (a reload does not
 *   apply it again), then switched to through the normal library switch,
 *   only when /api/libraries lists it. An unknown id keeps this app's own
 *   library without a word.
 *
 * Nothing here listens to the other app at runtime: each side reads the
 * link once on arrival.
 */
(function () {
    'use strict';

    const PARAM = 'library';

    /** The search part without `library=`; every other part stays as written. */
    function withoutParam(search) {
        const parts = String(search || '').replace(/^\?/, '').split('&').filter((part) => {
            if (!part) return false;
            let key = part.split('=')[0];
            try { key = decodeURIComponent(key); } catch (_e) { /* keep it raw */ }
            return key !== PARAM;
        });
        return parts.length ? `?${parts.join('&')}` : '';
    }

    function takeCarried() {
        try {
            const params = new URLSearchParams(window.location.search);
            if (!params.has(PARAM)) return null;
            const { pathname, search, hash } = window.location;
            window.history.replaceState(window.history.state, '', pathname + withoutParam(search) + hash);
            return String(params.get(PARAM) || '').trim() || null;
        } catch (_e) {
            return null;
        }
    }

    const carried = takeCarried();

    function currentLibraryId() {
        const lw = window.LibraryWorkspace;
        return lw && typeof lw.getCurrentLibraryId === 'function' ? lw.getCurrentLibraryId() : 'main';
    }

    function v4Href() {
        return `/v4/?${PARAM}=${encodeURIComponent(currentLibraryId())}`;
    }

    function goToV4() {
        window.location.assign(v4Href());
    }

    function refreshLink() {
        const link = document.getElementById('nav-tools-v4');
        if (link) link.setAttribute('href', v4Href());
    }

    async function knownLibraryIds() {
        const res = await fetch('/api/libraries', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`libraries_list_failed_${res.status}`);
        const data = await res.json();
        return Array.isArray(data.libraries) ? data.libraries.map((lib) => lib.id) : [];
    }

    async function applyCarried() {
        const lw = window.LibraryWorkspace;
        if (!carried || !lw || carried === lw.getCurrentLibraryId()) return;
        try {
            const known = await knownLibraryIds();
            if (!known.includes(carried) || carried === lw.getCurrentLibraryId()) return;
            // Names first, so the chip and entry card show the new library's own name.
            await lw.refreshFromServer();
            await lw.setCurrentLibraryId(carried);
        } catch (error) {
            window.Logger?.warn?.('Could not open the library V4 had open; keeping this one', error);
        }
    }

    function init() {
        refreshLink();
        window.addEventListener('library-workspace-changed', refreshLink);
        // The href is also brought up to date right before it is used.
        const link = document.getElementById('nav-tools-v4');
        if (link) {
            link.addEventListener('pointerdown', refreshLink);
            link.addEventListener('focus', refreshLink);
        }
        applyCarried();
    }

    window.AppSwitch = { v4Href, goToV4 };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
