/**
 * similar/scope.js — similar.js decomposition (verbatim Object.assign mixin).
 * Method bodies moved BYTE-IDENTICAL from frontend/js/similar.js pre-cut
 * lines 67-125 (of 1,517): getScopeQuery, loadScopeOptions, onScopeChange
 * (the All / Favorites / collections search scope). Classic non-strict
 * script: joins the ONE unsealed window.SimilarImages object declared in
 * similar/core.js, which loads FIRST; boot.js publishes initSimilar LAST.
 */
Object.assign(window.SimilarImages, {
    // ============== Search Scope (Favorites / Collections) ==============

    // Build the "&collection_id=<id>" query suffix for the active scope.
    // Returns '' when searching the whole library (default), so request URLs
    // stay byte-for-byte identical to the pre-scope behavior.
    getScopeQuery() {
        return this.collectionId ? `&collection_id=${encodeURIComponent(this.collectionId)}` : '';
    },

    async loadScopeOptions() {
        const select = document.getElementById('similar-search-scope');
        if (!select) return;

        let collections = [];
        try {
            const result = await window.App?.API?.listCollections?.();
            collections = Array.isArray(result?.collections) ? result.collections : [];
        } catch (e) {
            Logger.warn('Failed to load collections for similarity scope:', e);
            collections = [];
        }
        this.scopeCollections = collections;

        const favoritesLabel = this._t('collections.favorites', 'Favorites');
        const allLabel = this._t('similar.scopeAll', 'All images');
        const favorites = collections.find((c) => c.slug === 'favorites');
        const others = collections.filter((c) => c.slug !== 'favorites');

        const options = [`<option value="">${escapeHtml(allLabel)}</option>`];
        if (favorites) {
            options.push(`<option value="${favorites.id}">${escapeHtml(favoritesLabel)}</option>`);
        }
        others.forEach((c) => {
            options.push(`<option value="${c.id}">${escapeHtml(c.name || `#${c.id}`)}</option>`);
        });
        select.innerHTML = options.join('');

        // Preserve a previously chosen scope across reloads when it still exists.
        if (this.collectionId && collections.some((c) => String(c.id) === String(this.collectionId))) {
            select.value = String(this.collectionId);
        } else {
            this.collectionId = null;
            select.value = '';
        }
    },

    onScopeChange(value) {
        const parsed = parseInt(value, 10);
        this.collectionId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        // Re-run the active search under the new scope, if there is one.
        if (this.currentSearchMode === 'id' && this.currentSearchId) {
            this.searchByImage(this.currentSearchId);
        } else if (this.currentSearchMode === 'upload' && this.currentSearchFile) {
            this.searchByUpload(this.currentSearchFile);
        } else if (this.currentSearchMode === 'text' && this.currentSearchText) {
            this.searchByText(this.currentSearchText);
        }
    },

});
