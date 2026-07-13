/**
 * v321/shell.js - v321-ui.js decomposition (verbatim Object.assign mixin).
 * Moved BYTE-IDENTICAL from frontend/js/v321-ui.js pre-cut lines 45-99
 * (of 3,164): bindCaptionEditorUnloadGuard (DUR-1) + bindHardRefreshButton.
 * Classic script: joins the ONE unsealed window.V321Integration object
 * declared in v321/base.js (loads FIRST); v321/boot.js registers the
 * DOMContentLoaded init LAST; index.html lists the family in original
 * line order.
 */
Object.assign(window.V321Integration, {

    /** DUR-1: the caption editor keeps edits in in-memory Maps only —
     *  closing the tab while the modal is open with unsaved edits would
     *  silently discard them. Prompt in that state (and only that state,
     *  so the guard never nags outside the editor). */
    bindCaptionEditorUnloadGuard() {
        window.addEventListener('beforeunload', (e) => {
            const editorOpen = document.getElementById('caption-editor-modal')?.classList.contains('visible');
            const hasEdits = (this.editedCaptions?.size || 0) > 0
                || (this.editedNl?.size || 0) > 0;
            if (editorOpen && hasEdits) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    },

    /** Wire the navbar 🔄 button. Performs a real hard refresh:
     *    1. delete every Cache Storage entry
     *    2. unregister any service worker (we don't ship one but be robust)
     *    3. clear sessionStorage (per-tab volatile state only)
     *    4. navigate to the same URL with a fresh ``?_t=<now>`` query so
     *       intermediate proxies / CDNs cannot serve a stale index.html
     *
     *  localStorage stays intact because that is where the user's gallery
     *  filters, language preference, and last-seen app version live. The
     *  SQLite DB and data directory are obviously untouched (server-side).
     */
    bindHardRefreshButton() {
        const btn = document.getElementById('btn-refresh-ui');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((k) => caches.delete(k)));
                }
            } catch (_e) { /* best-effort */ }
            try {
                if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map((r) => r.unregister()));
                }
            } catch (_e) { /* best-effort */ }
            try { sessionStorage.clear(); } catch (_e) {}
            try {
                const u = new URL(window.location.href);
                u.searchParams.set('_t', Date.now().toString());
                window.location.replace(u.toString());
            } catch (_e) {
                window.location.reload();
            }
        });
    },
});
