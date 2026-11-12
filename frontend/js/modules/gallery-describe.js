/**
 * "Search by meaning instead": when the Gallery's word search finds nothing.
 *
 * The search box looks for words in the prompt, tags, file name and model.
 * A description such as "girl reading under a tree" often has no such words
 * in any prompt, and until now the way out was another page (Find Similar >
 * describe). The empty Gallery now offers it in place: the same words go to
 * the picture-meaning search (CLIP), and the closest pictures open in the
 * Gallery as one set, where they can be selected and acted on like any other.
 *
 * POST /api/similarity/search-text does the ranking; it needs the similarity
 * index and its text model, and says so itself when either is missing.
 */
(function initGalleryDescribe(global) {
    'use strict';

    /**
     * How many of the closest pictures to bring back: the same first page that
     * "Search by meaning" shows on Find Similar, so the two agree. They come
     * closest first (sort_by=set_order).
     */
    const CLOSEST = 100;
    const tr = (key, fallback, params) => (
        typeof global.appT === 'function' ? global.appT(key, fallback, params) : fallback
    );
    const app = () => global.App || null;

    /** The free words of the Gallery's search, without key:value parts. */
    function wordsInSearch() {
        const raw = String(app()?.AppState?.filters?.search || '').trim();
        if (!raw) return '';
        const parsed = global.GalleryToolbar?.parseQuery?.(raw);
        const free = Array.isArray(parsed?.freeText) ? parsed.freeText.join(' ').trim() : raw;
        return free;
    }

    /** Find the pictures closest in meaning to `words` and open them in the Gallery. */
    async function run(words) {
        const api = app();
        const query = String(words || '').trim();
        if (!api || !query) return false;
        let result;
        try {
            result = await api.API.post('/api/similarity/search-text', {
                query, limit: CLOSEST, offset: 0, threshold: 0, scope: 'library',
            });
        } catch (error) {
            api.showToast?.(error?.message || String(error), 'error');
            return false;
        }
        // The English-only text model cannot read Chinese (or other non-Latin) words:
        // its answer would not be about the description. Offer the multilingual
        // model, as Find Similar does, and search again once it is there.
        if (result?.needs_multilingual) {
            const megabytes = Number(result.multilingual_download_mb || 0);
            const outcome = await global.ensureFeatureModel?.('clip-multilingual', {
                label: tr('similar.languageModelName', 'Multilingual text search'),
                sizeHint: `${megabytes} MB`,
            });
            if (outcome?.ok) return run(query);
            api.showToast?.(tr('describe.needsMultilingual', 'The installed text model reads English only, so it cannot search for "{words}". Describe it in English, or get the multilingual model on the Similar page.', { words: query }), 'info');
            return false;
        }
        const ids = (Array.isArray(result?.results) ? result.results : []).map((row) => Number(row.id)).filter(Boolean);
        if (!ids.length) {
            api.showToast?.(
                tr('describe.none', 'The similarity index has no picture to compare with "{words}". Build it on the Similar page first.', { words: query }),
                'info',
                {
                    duration: 12000,
                    actionLabel: tr('describe.openSimilar', 'Open the Similar page'),
                    onAction: () => api.switchView?.('similar'),
                },
            );
            return false;
        }
        // The words found nothing as text, so left in the box they would hide the set too.
        global.GalleryToolbar?.search?.('');
        useClosestFirst(api);
        const shown = await global.GalleryPin?.open?.(ids, { source: 'described' });
        if (!shown) restoreSort(api);
        if (shown) {
            const missing = await notIndexed(api);
            if (missing > 0) {
                // The search only looked at pictures in the similarity index: say how many it did not see.
                api.showToast?.(
                    tr('describe.shownPartly', 'The {n} pictures closest in meaning to "{words}". Not looked at: {missing} pictures that are not in the similarity index yet.', { n: ids.length, words: query, missing }),
                    'info',
                    {
                        duration: 12000,
                        actionLabel: tr('describe.indexNow', 'Index them now'),
                        onAction: () => indexTheRest(api),
                    },
                );
            } else {
                api.showToast?.(tr('describe.shown', 'The {n} pictures closest in meaning to "{words}". The closest come first.', { n: ids.length, words: query }), 'info');
            }
        }
        return Boolean(shown);
    }

    /** How many readable pictures of this library the similarity index does not hold (0 when that cannot be read). */
    async function notIndexed(api) {
        try {
            const stats = await api.API.get('/api/similarity/stats');
            return Math.max(0, Number(stats?.pending_count) || 0);
        } catch (_error) {
            return 0;
        }
    }

    /** Start indexing every picture that has no entry yet; it runs in the background. */
    async function indexTheRest(api) {
        try {
            const started = await api.API.post('/api/similarity/embed', {});
            api.showToast?.(
                started?.status === 'already_running'
                    ? tr('describe.indexRunning', 'The index is already being built. Search again when it is done.')
                    : tr('describe.indexStarted', 'Indexing started in the background. Search again when it is done; the Similar page shows how far it is.'),
                'info',
                {
                    duration: 10000,
                    actionLabel: tr('describe.openSimilar', 'Open the Similar page'),
                    onAction: () => api.switchView?.('similar'),
                },
            );
        } catch (error) {
            api.showToast?.(error?.message || String(error), 'error');
        }
    }

    /** The sort the Gallery had before the described set took it over. */
    let sortBefore = null;

    function offerClosestFirst(on) {
        const option = document.querySelector('#gallery-sort option[value="set_order"]');
        if (option) option.hidden = !on;
    }

    /** The set is kept in the order it was ranked: show it that way (sort_by=set_order). */
    function useClosestFirst(api) {
        const current = api.AppState?.filters?.sortBy || 'newest';
        if (current !== 'set_order') sortBefore = current;
        offerClosestFirst(true);
        api.updateFilters?.((filters) => { filters.sortBy = 'set_order'; });
        api.updateSortReverseButton?.();
    }

    /** Leaving the set: "closest first" means nothing outside it, so the earlier sort comes back. */
    function restoreSort(api) {
        offerClosestFirst(false);
        if (api.AppState?.filters?.sortBy === 'set_order') {
            api.updateFilters?.((filters) => { filters.sortBy = sortBefore || 'newest'; });
        }
        sortBefore = null;
        api.updateSortReverseButton?.();
    }

    /** Called when the "no matches" card is drawn: offer the button when there are words to describe with. */
    function syncEmptyState() {
        const button = document.getElementById('empty-state-describe-btn');
        if (!button) return;
        const words = wordsInSearch();
        const offer = Boolean(words) && app()?.AppState?.filters?.collectionId == null;
        button.hidden = !offer;
        if (offer) {
            button.querySelector('span').textContent = tr('describe.button', 'Search by meaning instead: "{words}"', { words });
            button.dataset.words = words;
        }
    }

    function wire() {
        const button = document.getElementById('empty-state-describe-btn');
        if (!button) return;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await run(button.dataset.words || wordsInSearch());
            } finally {
                button.disabled = false;
            }
        });
        document.addEventListener('languageChanged', syncEmptyState);
        // The x on the set's banner: put the sort back before the Gallery reloads without the set.
        document.getElementById('gallery-pin-banner-clear')?.addEventListener('click', () => {
            if (app()?.AppState?.filters?.sortBy === 'set_order' || sortBefore !== null) restoreSort(app());
        }, true);
        // A page reloaded while the set was open still offers its sort.
        global.addEventListener('load', () => offerClosestFirst(app()?.AppState?.filters?.sortBy === 'set_order'), { once: true });
    }

    global.GalleryDescribe = Object.freeze({ run, syncEmptyState });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
