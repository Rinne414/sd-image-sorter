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

    /** DUR-1: export-preview caption edits (caption, NL sentence, caption
     *  type) are kept until they are exported. They live in memory while the
     *  page is open, are written to localStorage when it unloads and restored
     *  on the next start, so a reload or a closed tab no longer drops them.
     *  An export clears the saved copy (markCaptionEditsExported); when the
     *  browser cannot store them, the page asks before leaving instead. */
    CAPTION_EDITS_KEY: 'sd-sorter-export-caption-edits',
    _captionEditsUnexported: false,

    _hasCaptionEdits() {
        return (this.editedCaptions?.size || 0) > 0
            || (this.editedNl?.size || 0) > 0
            || (this.captionTypes?.size || 0) > 0;
    },

    markCaptionEditsChanged() {
        this._captionEditsUnexported = true;
    },

    markCaptionEditsExported() {
        this._captionEditsUnexported = false;
        try { localStorage.removeItem(this.CAPTION_EDITS_KEY); } catch (_e) { /* storage blocked */ }
    },

    _saveCaptionEdits() {
        // Leaving before the saved edits were put back: keep them as they are.
        if (this._captionEditsRestorePending) return;
        if (!this._captionEditsUnexported || !this._hasCaptionEdits()) {
            localStorage.removeItem(this.CAPTION_EDITS_KEY);
            return;
        }
        localStorage.setItem(this.CAPTION_EDITS_KEY, JSON.stringify({
            version: 1,
            contentMode: document.getElementById('batch-export-content-mode')?.value || '',
            captions: Object.fromEntries(this.editedCaptions),
            nl: Object.fromEntries(this.editedNl),
            types: Object.fromEntries(this.captionTypes),
        }));
    },

    /** Put saved edits back; returns how many images they cover. */
    restoreCaptionEdits() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(this.CAPTION_EDITS_KEY) || 'null');
        } catch (_e) {
            return 0;
        }
        if (!saved || saved.version !== 1) return 0;
        // The caption text was written for one content format; switching to it
        // first (its change handler clears captions) keeps text and format together.
        const select = document.getElementById('batch-export-content-mode');
        const hasMode = select && Array.from(select.options).some((option) => option.value === saved.contentMode);
        if (hasMode && select.value !== saved.contentMode) {
            select.value = saved.contentMode;
            select.dispatchEvent(new Event('change'));
        }
        const ids = new Set();
        const fill = (target, entries, isValid) => {
            for (const [key, value] of Object.entries(entries || {})) {
                const id = Number(key);
                if (!Number.isFinite(id) || id <= 0 || !isValid(value)) continue;
                target.set(id, String(value));
                ids.add(id);
            }
        };
        fill(this.editedCaptions, saved.captions, (value) => typeof value === 'string');
        fill(this.editedNl, saved.nl, (value) => typeof value === 'string');
        fill(this.captionTypes, saved.types, (value) => value === 'nl' || value === 'both');
        this._captionEditsUnexported = ids.size > 0;
        return ids.size;
    },

    bindCaptionEditorUnloadGuard() {
        this._captionEditsRestorePending = true;
        Promise.resolve(this._exportPresetUiReady).catch(() => {}).then(() => {
            this._captionEditsRestorePending = false;
            const restored = this.restoreCaptionEdits();
            if (restored > 0) {
                window.showToast?.(this._i18n('batchExport.captionEditsRestored',
                    'Caption edits for {count} image(s) that were not exported yet are back; the next training-caption export uses them.',
                    { count: restored }).replace('{count}', String(restored)), 'info');
            }
        });
        window.addEventListener('beforeunload', (e) => {
            try {
                this._saveCaptionEdits();
            } catch (_e) {
                if (this._captionEditsUnexported && this._hasCaptionEdits()) {
                    e.preventDefault();
                    e.returnValue = '';
                }
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
