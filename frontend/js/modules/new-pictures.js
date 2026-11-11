/**
 * New pictures: only what was made since the last cull.
 *
 * The most frequent job after a generation session is "go through the new
 * ones". This remembers, per library, the time of the newest picture the user
 * has dealt with; "New pictures" then opens the Gallery on exactly the
 * pictures made after it and offers the two ways to deal with them: Keep /
 * Reject (Manual Sort over this set) or "Mark all as seen".
 *
 * The marker moves only when the user finishes that cull or marks the set as
 * seen, never just by looking. The first time there is no marker, so the
 * last seven days count as new.
 *
 * GET /api/new-pictures gives the ids and the next marker
 * (routers/images_parts/new_pictures.py). The marker is the server's own
 * time string, passed back unchanged.
 */
(function initNewPictures(global) {
    'use strict';

    const STORAGE_KEY = 'sd-new-pictures-marker-v1';
    const FIRST_TIME_DAYS = 7;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;
    const libraryId = () => global.LibraryWorkspace?.getCurrentLibraryId?.() || 'main';

    /** What open() showed and not yet dealt with: { library, time, previous }. */
    let pending = null;

    function markers() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return saved && typeof saved === 'object' ? saved : {};
        } catch (_error) {
            return {};
        }
    }

    function setMarker(library, time) {
        const all = markers();
        if (time) all[library] = time;
        else delete all[library];
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        } catch (_error) { /* storage can be blocked; the marker then lasts for this page only */ }
    }

    function firstTimeAfter() {
        const date = new Date(Date.now() - FIRST_TIME_DAYS * DAY_MS);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
            + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** "2026-11-09 14:30": exact, and the same in both languages. */
    const minute = (time) => String(time || '').slice(0, 16);

    /** Ask the server what is new for the open library. */
    async function look() {
        const library = libraryId();
        const remembered = markers()[library] || null;
        const after = remembered || firstTimeAfter();
        const data = await app().API.get(`/api/new-pictures?after=${encodeURIComponent(after)}`);
        return { ...data, library, after, remembered };
    }

    function sinceText(found) {
        return found.remembered
            ? tr('newPictures.sinceCull', 'since {when}', { when: minute(found.after) })
            : tr('newPictures.sinceDays', 'from the last week', { days: FIRST_TIME_DAYS });
    }

    /** The Home tile's live line. */
    async function refreshTile() {
        const line = document.getElementById('entry-mission-new-count');
        if (!line || !app()?.API) return;
        try {
            const found = await look();
            line.textContent = found.count
                ? tr('newPictures.tileCount', '{n} to go through, {since}', { n: found.count, since: sinceText(found) })
                : tr('newPictures.tileNone', 'Nothing new {since}', { since: sinceText(found) });
        } catch (_error) {
            // The tile still works without its number; the action reports a failure itself.
            line.textContent = '';
        }
    }

    function markSeen({ quiet = false } = {}) {
        if (!pending || !pending.time) return false;
        const done = pending;
        pending = null;
        setMarker(done.library, done.time);
        refreshTile();
        if (!quiet) {
            app()?.showToast?.(
                tr('newPictures.marked', 'Marked as seen. Next time only pictures made after {when} count as new.', { when: minute(done.time) }),
                'success',
                {
                    actionLabel: tr('common.undo', 'Undo'),
                    onAction: () => {
                        setMarker(done.library, done.previous);
                        pending = done;
                        refreshTile();
                    },
                },
            );
        }
        return true;
    }

    /** Manual Sort, Keep / Reject, over the set the Gallery is showing. */
    function cull() {
        const api = app();
        if (!api) return;
        api.switchView?.('sorting');
        global._switchSortingSub?.('manual');
        global.setManualSortSelectedMode?.('cull');
        global.syncManualSortFiltersFromGallery?.({ toastKey: null });
    }

    /** Open the Gallery on the new pictures. Resolves false when there are none. */
    async function open() {
        const api = app();
        if (!api) return false;
        let found;
        try {
            found = await look();
        } catch (error) {
            api.showToast?.(error?.message || String(error), 'error');
            return false;
        }
        if (!found.count) {
            api.showToast?.(
                tr('newPictures.none', 'Nothing new {since}.', { since: sinceText(found) }),
                'info',
                global.LibraryRootsUI?.open ? {
                    // Pictures made since may simply not have been read in yet.
                    actionLabel: tr('newPictures.checkFolders', 'Check the folders'),
                    onAction: () => global.LibraryRootsUI.open(),
                } : {},
            );
            return false;
        }
        const shown = await global.GalleryPin?.open?.(found.ids, { source: 'new' });
        if (!shown) return false;
        pending = { library: found.library, time: found.newest_time, previous: found.remembered };
        api.showPipelineNextStep?.({
            icon: 'i-images',
            title: tr('newPictures.title', '{n} new pictures {since}. What next?', { n: found.count, since: sinceText(found) }),
            actions: [
                { icon: '#i-keyboard', label: tr('newPictures.cull', 'Keep / Reject them'), action: cull },
                { icon: '#i-check', label: tr('newPictures.markSeen', 'Mark all as seen'), action: () => markSeen() },
            ],
        });
        return true;
    }

    /** Manual Sort calls this when a Keep / Reject session ends: the set it came from is dealt with. */
    function noteCullFinished() {
        // The cull's own finish line and toast already speak; a third message only
        // competed with them. The Home tile shows the new count.
        if (pending) markSeen({ quiet: true });
    }

    function wire() {
        document.addEventListener('languageChanged', refreshTile);
        global.addEventListener('load', refreshTile, { once: true });
    }

    global.NewPictures = Object.freeze({ open, markSeen, noteCullFinished, refreshTile });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
