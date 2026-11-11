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
     * How many of the closest pictures to bring back. A ranking has no natural
     * end, and the Gallery shows the set in its own order, so the set is kept
     * to a screenful or two: 200 was the whole of a small library.
     */
    const CLOSEST = 60;
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
        const ids = (Array.isArray(result?.results) ? result.results : []).map((row) => Number(row.id)).filter(Boolean);
        if (!ids.length) {
            api.showToast?.(tr('describe.none', 'The similarity index has no picture to compare with "{words}". Build it on the Similar page first.', { words: query }), 'info');
            return false;
        }
        // The words found nothing as text, so left in the box they would hide the set too.
        global.GalleryToolbar?.search?.('');
        const shown = await global.GalleryPin?.open?.(ids, { source: 'described' });
        if (shown) {
            api.showToast?.(tr('describe.shown', 'The {n} pictures closest in meaning to "{words}". They are shown in the Gallery order, not by closeness.', { n: ids.length, words: query }), 'info');
        }
        return Boolean(shown);
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
    }

    global.GalleryDescribe = Object.freeze({ run, syncEmptyState });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})(window);
