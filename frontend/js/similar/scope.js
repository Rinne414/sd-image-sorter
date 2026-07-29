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

    // Build the query suffix for the active session, library, or collection.
    getScopeQuery() {
        if (this.scope === 'current_session') return '&scope=current_session';
        if (this.collectionId) return `&collection_id=${encodeURIComponent(this.collectionId)}&scope=library`;
        return '&scope=library';
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

        const sessionLabel = this._t('similar.scopeSession', 'Current Session');
        const options = [
            `<option value="current_session">${escapeHtml(sessionLabel)}</option>`,
            `<option value="library">${escapeHtml(allLabel)}</option>`,
        ];
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
            this.scope = 'library';
        } else {
            this.collectionId = null;
            this.scope = this.scope === 'current_session' ? 'current_session' : 'library';
            select.value = this.scope;
        }
    },

    onScopeChange(value) {
        const parsed = parseInt(value, 10);
        this.collectionId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
        this.scope = value === 'current_session' ? 'current_session' : 'library';
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
