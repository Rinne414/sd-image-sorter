/**
 * Gallery pin: "show only these pictures" (opened from the Style Map's box
 * selection). The ids are stored server side as a hidden collection
 * (POST /api/collections/pinned), and the Gallery opens it with its ordinary
 * collection filter, so counts, paging, select-all and every bulk action see
 * exactly those pictures. A banner above the grid says so ("N from the Style
 * Map") and its x restores the filter that was active before. A pin that the
 * server no longer has (pruned or deleted) is announced as such instead of
 * quietly showing the whole Gallery.
 *
 * The pin survives a reload: the Gallery's saved filter already carries the
 * collection id, and the previous filter is kept in localStorage beside it.
 */
(function initGalleryPin(global) {
    const STORAGE_KEY = 'sd-image-sorter-gallery-pin';
    const state = { id: null, count: 0, gone: false, previous: null };

    const app = () => global.App || null;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );

    function persist() {
        try {
            if (state.id === null) localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: state.id, count: state.count, previous: state.previous }));
        } catch (_error) { /* storage can be blocked; the pin then lasts for this page only */ }
    }

    function restoreFromStorage() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (saved && Number.isFinite(Number(saved.id))) {
                state.id = Number(saved.id);
                state.count = Number(saved.count) || 0;
                state.previous = saved.previous || { collectionId: null, scope: null };
            }
        } catch (_error) { /* a damaged value is ignored */ }
    }

    function render() {
        const banner = document.getElementById('gallery-pin-banner');
        if (!banner) return;
        banner.hidden = state.id === null;
        banner.classList.toggle('is-gone', state.gone);
        const title = document.getElementById('gallery-pin-banner-title');
        if (title) {
            title.textContent = state.gone
                ? tr('galleryPin.gone', 'This set of pictures is no longer available')
                : tr('galleryPin.title', '{n} from the Style Map', { n: state.count.toLocaleString() });
        }
        const clear = document.getElementById('gallery-pin-banner-clear');
        if (clear) {
            const label = tr('galleryPin.clear', 'Remove this filter and show the whole Gallery again');
            clear.setAttribute('aria-label', label);
            clear.title = label;
        }
    }

    /** Make the Gallery show exactly the pictures of pinned set `id`. */
    function apply(id, count) {
        const api = app();
        if (!api) return;
        if (state.id === null) {
            const filters = api.AppState?.filters || {};
            state.previous = { collectionId: filters.collectionId ?? null, scope: filters.scope ?? null };
        }
        state.id = Number(id);
        state.count = Number(count) || 0;
        state.gone = false;
        persist();
        api.updateFilters?.((filters) => {
            filters.collectionId = state.id;
            filters.scope = 'library';
        });
        api.updateFilterSummary?.();
        api.markGalleryNeedsRefresh?.();
        render();
        api.switchView?.('gallery');
        api.selectAllFilteredResults?.();
    }

    /** Store `ids` as a pinned set and open the Gallery on it. Resolves false when nothing could be pinned. */
    async function open(ids) {
        const api = app();
        if (!api || !ids?.length) return false;
        const made = await api.API.post('/api/collections/pinned', { image_ids: ids });
        if (!made?.count) {
            api.showToast?.(tr('galleryPin.empty', 'None of these pictures are in the Gallery any more'), 'info');
            return false;
        }
        apply(made.collection_id, made.count);
        return true;
    }

    /**
     * A selection token for `ids`: they are stored as a pinned set and the
     * token names it (the same tokens "select all matching" makes), so a tool
     * that accepts a token reads the ids server side in chunks instead of
     * receiving tens of thousands of ids in one call. The set is a "token"
     * set (kept 30 days, not pruned by Gallery views: the tool pages through
     * it lazily). null when nothing could be stored.
     */
    async function tokenFor(ids) {
        const api = app();
        if (!api || !ids?.length) return null;
        const made = await api.API.post('/api/collections/pinned', { image_ids: ids, purpose: 'token' });
        if (!made?.count) return null;
        const created = await api.API.createSelectionToken({ collectionId: made.collection_id, sortBy: 'newest' });
        if (!created?.selection_token) return null;
        return { selectionToken: created.selection_token, total: made.count, exactTotal: true, filterKey: null, visibleImageIds: [] };
    }

    /** The x: give the Gallery its previous filter back. */
    function clear() {
        const api = app();
        const previous = state.previous || { collectionId: null, scope: null };
        const wasActive = state.id !== null && Number(api?.AppState?.filters?.collectionId) === state.id;
        state.id = null;
        state.gone = false;
        state.previous = null;
        persist();
        render();
        if (!api || !wasActive) return;
        api.updateFilters?.((filters) => {
            filters.collectionId = previous.collectionId;
            filters.scope = previous.scope;
        });
        api.updateFilterSummary?.();
        api.clearSelectedIds?.({ scope: 'visible' });
        api.updateSelectionUI?.();
        api.emitSelectionStateChanged?.();
        api.loadImages?.();
    }

    /** The user picked another collection (or none) by hand: the pin no longer describes the Gallery. */
    function dropIfReplaced() {
        const api = app();
        if (state.id === null || !api) return;
        if (Number(api.AppState?.filters?.collectionId) !== state.id) {
            state.id = null;
            state.gone = false;
            state.previous = null;
            persist();
            render();
        }
    }

    /** After a reload: confirm the stored pin still exists, else say it is gone. */
    async function verify() {
        const api = app();
        if (state.id === null || !api) return;
        if (Number(api.AppState?.filters?.collectionId) !== state.id) {
            dropIfReplaced();
            return;
        }
        try {
            const found = await api.API.get(`/api/collections/pinned/${state.id}`);
            state.gone = !found?.exists;
            if (found?.exists) state.count = Number(found.count) || 0;
        } catch (_error) {
            return; // the server is not answering: leave the banner as it is
        }
        persist();
        render();
    }

    function wire() {
        restoreFromStorage();
        document.getElementById('gallery-pin-banner-clear')?.addEventListener('click', clear);
        global.addEventListener('gallery-filters-changed', dropIfReplaced);
        // A pin that is on screen but loads nothing may have been removed meanwhile.
        global.addEventListener('gallery-images-loaded', (event) => {
            const empty = Number(app()?.AppState?.pagination?.total) === 0;
            if (state.id !== null && !state.gone && !event.detail?.appendMode && empty) verify();
        });
        document.addEventListener('i18n-applied', render);
        document.addEventListener('languageChanged', render);
        render();
        // The saved Gallery filter is restored at boot; check the pin once everything is up.
        global.addEventListener('load', verify, { once: true });
    }

    global.GalleryPin = { open, apply, clear, verify, tokenFor, _state: state };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
}(window));
