/**
 * SD Image Sorter - desktop shell bridge (classic interface).
 *
 * The optional desktop shell (desktop/) exposes `window.sdDesktop` through a
 * preload script. When it is there, this module
 *   - turns a gallery card drag into a native drag of the real picture files
 *     (all selected pictures when the dragged card is selected),
 *   - shows Settings > Desktop (start at login, keep running in the tray,
 *     global shortcut, Quick collect),
 *   - puts the cursor in the gallery search when the global shortcut fires.
 * In a normal browser none of that changes anything. Quick collect works in
 * both (a popup window in a browser), and any window of the program refreshes
 * its gallery when Quick collect added pictures.
 */
(function () {
    'use strict';

    const desktop = window.sdDesktop || null;
    const COLLECT_CHANNEL = 'sd-image-sorter-collect';
    const BY_IDS_CHUNK = 2000;
    const FOCUS_ATTEMPTS = 20;
    const DEFAULT_SHORTCUT = 'Control+Alt+Space';
    const QUICK_COLLECT_URL = '/static/quick-collect.html';

    const t = (key, fallback, params) => (typeof appT === 'function'
        ? appT(key, fallback, params)
        : (window.I18n?.t?.(key, params) || fallback));

    // ---------------------------------------------------------------- drag-out

    let ownDragActive = false;

    function appState() {
        return window.App?.AppState || null;
    }

    async function dragIds(image, card) {
        const id = Number(image.id);
        const state = appState();
        const cardSelected = card?.classList?.contains('selected');
        if (!cardSelected || !state) return [id];
        const ids = typeof expandGallerySelectionIds === 'function'
            ? await expandGallerySelectionIds()
            : Array.from(state.selectedIds || []).map(Number);
        return ids.length ? ids : [id];
    }

    async function dragPaths(ids, image) {
        const known = new Map((appState()?.images || []).map((row) => [Number(row.id), row.path]));
        known.set(Number(image.id), image.path);
        const missing = ids.filter((id) => !known.get(id));
        for (let start = 0; start < missing.length; start += BY_IDS_CHUNK) {
            const chunk = missing.slice(start, start + BY_IDS_CHUNK);
            const result = await window.App.API.post('/api/images/by-ids', { image_ids: chunk });
            (result?.images || []).forEach((row) => known.set(Number(row.id), row.path));
        }
        return ids.map((id) => known.get(id)).filter(Boolean);
    }

    function clearOwnDragOnNextMove() {
        const clear = () => { ownDragActive = false; };
        window.addEventListener('pointermove', clear, { once: true });
    }

    async function runNativeDrag(image, card) {
        try {
            const paths = await dragPaths(await dragIds(image, card), image);
            if (!paths.length) return;
            await desktop.startDrag(paths);
        } catch (error) {
            window.Logger?.warn?.('Native drag could not start', { error });
            if (typeof showToast === 'function') {
                showToast(t('desktop.dragFailed', 'Could not start dragging the files: {error}', { error: error?.message || String(error) }), 'error');
            }
        } finally {
            clearOwnDragOnNextMove();
        }
    }

    /**
     * Call from a gallery card's dragstart. Returns true when the shell took
     * the drag (the browser drag is cancelled), false in a normal browser.
     */
    function startNativeDrag(event, image) {
        if (!desktop?.startDrag || !image?.path) return false;
        event.preventDefault();
        ownDragActive = true;
        runNativeDrag(image, event.currentTarget);
        return true;
    }

    /** True while a native drag started here is under way: its drop must not import the files again. */
    function isOwnDragActive() {
        return ownDragActive;
    }

    // ------------------------------------------------------------ Quick collect

    function openQuickCollect() {
        if (desktop?.openQuickCollect) {
            desktop.openQuickCollect();
            return;
        }
        window.open(QUICK_COLLECT_URL, 'sd-quick-collect', 'popup,width=380,height=480');
    }

    function listenForCollected() {
        if (!('BroadcastChannel' in window)) return;
        const channel = new BroadcastChannel(COLLECT_CHANNEL);
        channel.addEventListener('message', (event) => {
            if (event.data?.type !== 'collected') return;
            if (typeof _refreshScanDrivenViews === 'function') _refreshScanDrivenViews(true, { refreshGallery: true });
        });
    }

    // ------------------------------------------------------------ focus search

    function focusSearch(attempts = FOCUS_ATTEMPTS) {
        window.EntryPage?.hide?.();
        if (appState()?.currentView !== 'gallery') document.getElementById('nav-tab-gallery')?.click();
        const input = document.getElementById('gallery-search-input');
        if (input && input.offsetParent !== null) {
            input.focus();
            input.select();
            return;
        }
        if (attempts > 0) window.requestAnimationFrame(() => focusSearch(attempts - 1));
    }

    window.DesktopBridge = { isDesktop: Boolean(desktop), startNativeDrag, isOwnDragActive, openQuickCollect, focusSearch };

    listenForCollected();
    if (desktop) {
        desktop.onFocusSearch?.(() => focusSearch());
        const startSettings = () => window.DesktopSettings?.start?.(desktop, { t, DEFAULT_SHORTCUT, openQuickCollect });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startSettings);
        else startSettings();
    }
})();
