/**
 * The assistant's connection to the program: starting a run, reading its
 * events, answering a confirmation, stopping, and carrying out what the
 * assistant wants on screen (filters, a picture set, a page).
 *
 * The panel (assistant/panel.js) draws; this file knows nothing about the DOM
 * of the panel.
 */
(function initAssistantClient(global) {
    'use strict';

    const BASE = '/api/assistant';
    const SELECTED_IDS_SENT = 500;
    const POLL_RETRIES = 4;
    const POLL_RETRY_MS = 1500;

    const app = () => global.App || null;
    const api = () => app()?.API;

    /** Tool filter name -> the Gallery's filter key. */
    const FILTER_KEYS = {
        search: 'search', tags: 'tags', tag_mode: 'tagMode', exclude_tags: 'excludeTags',
        untagged: 'untagged', no_caption: 'noCaption', generators: 'generators', ratings: 'ratings',
        checkpoints: 'checkpoints', exclude_checkpoints: 'excludeCheckpoints', loras: 'loras',
        exclude_loras: 'excludeLoras', prompts: 'prompts', artist: 'artist', seed: 'seed',
        collection_id: 'collectionId', folder: 'folder', has_metadata: 'hasMetadata',
        min_user_rating: 'minUserRating', min_aesthetic: 'minAesthetic', max_aesthetic: 'maxAesthetic',
        aesthetic_unscored: 'aestheticUnscored', min_width: 'minWidth', max_width: 'maxWidth',
        min_height: 'minHeight', max_height: 'maxHeight', aspect_ratio: 'aspectRatio',
        media_type: 'mediaType', date_from: 'dateFrom', date_to: 'dateTo', sort_by: 'sortBy',
    };
    const PAGES = {
        gallery: 'gallery', reader: 'reader', organize: 'sorting', censor: 'censor', similar: 'similar',
        'style-map': 'stylemap', dataset: 'dataset', 'prompt-helper': 'promptlab',
    };

    /** What the user is looking at, for the assistant's get_current_view. */
    function currentView() {
        const state = app()?.AppState || {};
        const defaults = typeof global.createDefaultFilterState === 'function' ? global.createDefaultFilterState() : {};
        const filters = {};
        Object.entries(FILTER_KEYS).forEach(([name, key]) => {
            const value = state.filters?.[key];
            if (value === null || value === undefined || value === '') return;
            if (JSON.stringify(value) === JSON.stringify(defaults[key])) return;
            filters[name] = value;
        });
        const selected = state.selectedIds instanceof Set ? Array.from(state.selectedIds) : [];
        const everyMatch = state.selectionScope === 'filtered';
        return {
            page: state.currentView || 'gallery',
            language: global.I18n?.currentLang || document.documentElement.lang || 'en',
            filters,
            pictures_in_view: Number(state.totalImages ?? state.images?.length ?? 0),
            selected_count: everyMatch ? Number(state.selectionTotal || selected.length) : selected.length,
            selected_ids: everyMatch ? [] : selected.slice(0, SELECTED_IDS_SENT),
            selection_is_every_match_of_the_filters: everyMatch,
        };
    }

    function showInGallery(args) {
        if (typeof global.setAppFilters !== 'function' || typeof global.createDefaultFilterState !== 'function') return;
        const next = global.createDefaultFilterState();
        Object.entries(args || {}).forEach(([name, value]) => {
            const key = FILTER_KEYS[name];
            if (key && value !== null && value !== undefined && value !== '') next[key] = value;
        });
        global.setAppFilters(next);
        if (global.FolderTreeUI?.isScoped?.()) global.FolderTreeUI.refresh();
        global.renderActiveTagFilters?.();
        global.updateFilterSummary?.();
        global.syncGenTabsWithFilters?.();
        global.updateSortReverseButton?.();
        app()?.switchView?.('gallery');
        global.loadImages?.();
    }

    /** Carry out one "show" event of a run. */
    async function show(action, args) {
        if (action === 'show_in_gallery') showInGallery(args);
        else if (action === 'select_images') await global.GalleryPin?.open?.((args?.image_ids || []).map(Number), { source: 'assistant' });
        else if (action === 'open_image') global.Gallery?.openPreview?.(Number(args?.image_id));
        else if (action === 'open_page') {
            if (args?.page === 'models') global.openModelManager?.('models');
            else if (PAGES[args?.page]) app()?.switchView?.(PAGES[args.page]);
        }
    }

    /**
     * Run the assistant on `messages`. `on` receives every event of the run;
     * the returned object stops it or answers a confirmation (answer). Resolves `done`
     * with the run's last event (done / stopped / error).
     */
    function run(messages, on) {
        let runId = null;
        let stopped = false;
        const done = (async () => {
            const started = await api().post(`${BASE}/runs`, { messages, view: currentView() });
            runId = started.run_id;
            if (stopped) api().post(`${BASE}/runs/${runId}/stop`, {}).catch(() => {});
            let next = 0;
            let failures = 0;
            for (;;) {
                let body;
                try {
                    body = await api().get(`${BASE}/runs/${runId}/events?after=${next}`);
                    failures = 0;
                } catch (error) {
                    // The run is gone (the program restarted): say so instead of a raw error.
                    if (error?.apiStatus === 404) {
                        on({ type: 'lost' });
                        return { type: 'stopped', messages: [], lost: true };
                    }
                    // A dropped connection: try again a few times, then stop the run rather than leave it going unseen.
                    failures += 1;
                    if (failures > POLL_RETRIES) {
                        api().post(`${BASE}/runs/${runId}/stop`, {}).catch(() => {});
                        throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_MS * failures));
                    continue;
                }
                next = body.next;
                for (const event of body.events) {
                    if (event.type === 'show') await show(event.action, event.args).catch(() => {});
                    on(event);
                    if (['done', 'stopped', 'error'].includes(event.type)) return event;
                }
                if (body.finished && !body.events.length) return { type: 'error', message: '', messages: [] };
            }
        })();
        return {
            done,
            stop() {
                stopped = true;
                if (runId) api().post(`${BASE}/runs/${runId}/stop`, {}).catch(() => {});
            },
            answer(id, approved) {
                return api().post(`${BASE}/runs/${runId}/confirm`, { id, approved });
            },
        };
    }

    global.AssistantClient = Object.freeze({
        run,
        currentView,
        settings: () => api().get(`${BASE}/settings`),
        saveSettings: (changes) => api().post(`${BASE}/settings`, changes),
        models: () => api().post(`${BASE}/models`, {}),
        test: () => api().post(`${BASE}/test`, {}),
    });
})(window);
