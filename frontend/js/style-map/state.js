/**
 * Style Map controller. Owns the page state: the Gallery filter token, the
 * points request, the UMAP layout polling, the index job and the three.js
 * scene. Reads window.App (API, AppState, showToast) and never writes it;
 * boot.js publishes the object this returns as window.StyleMap.
 *
 * Data flow (docs/API.md "Style Map"):
 *   filter -> POST /api/images/selection-token -> GET /api/style-map/points
 *   points.umap.status queued|computing -> GET /api/style-map/layout-status
 *   every LAYOUT_POLL_MS; ready or not_started -> points again.
 */
import { StyleMapScene } from './scene.js';
import { StyleMapPanel } from './panel.js';
import { IndexJob } from './index-job.js';
import { t, formatError } from './text.js';

const LAYOUT_POLL_MS = 3000;
const FILTER_DEBOUNCE_MS = 500;
const UMAP_MODEL_ID = 'style-map-umap';

function app() {
    return window.App || null;
}

export function createStyleMap() {
    const state = {
        ready: false,
        unsupported: false,
        space: 'kaloscope',
        token: null,
        points: null,
        umapState: null,
        seq: 0,
        layoutTimer: null,
        debounceTimer: null,
        panel: null,
        scene: null,
        job: null,
    };

    const root = () => document.getElementById('view-stylemap');
    const isViewActive = () => Boolean(root()?.classList.contains('active'));

    function query(extra = {}) {
        const params = new URLSearchParams({ space: state.space });
        if (state.token) params.set('selection_token', state.token);
        for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
        return params.toString();
    }

    async function currentToken() {
        const api = app()?.API;
        if (!api || typeof api.createSelectionToken !== 'function') return null;
        const filters = app()?.AppState?.filters || {};
        // The map only needs the SET of pictures. A random Gallery order has
        // no stable cursor and the token endpoint refuses it (400), so the
        // request always asks for a fixed order; the Gallery keeps its own.
        const payload = await api.createSelectionToken({ ...filters, sortBy: 'newest' });
        return payload?.selection_token || null;
    }

    function clearLayoutTimer() {
        if (state.layoutTimer) clearTimeout(state.layoutTimer);
        state.layoutTimer = null;
    }

    function scheduleLayoutPoll(status) {
        clearLayoutTimer();
        if (status === 'queued' || status === 'computing') {
            state.layoutTimer = setTimeout(pollLayout, LAYOUT_POLL_MS);
        }
    }

    /** Repaint every JS-written text from the current state (also on language switch). */
    function repaint() {
        const points = state.points;
        if (!points || !state.panel) return;
        state.panel.renderScope(points);
        state.panel.renderLayout(state.umapState || points.umap || {}, points.method);
        state.panel.renderEmpty(points, state.space, state.job.isRunning());
        state.panel.renderJob(state.job);
    }

    function applyPoints(points) {
        state.points = points;
        state.umapState = points.umap || {};
        state.scene.setPoints(points.points || [], points.points_layout);
        repaint();
        scheduleLayoutPoll(points.umap?.status);
    }

    async function refresh({ force = false } = {}) {
        if (!state.ready || !isViewActive()) return;
        const seq = ++state.seq;
        clearLayoutTimer();
        state.panel.setLoading(true);
        try {
            const token = await currentToken();
            if (seq !== state.seq) return;
            state.token = token;
            const points = await app().API.get(
                `/api/style-map/points?${query(force ? { refresh: 'true' } : {})}`,
            );
            if (seq !== state.seq) return;
            applyPoints(points);
        } catch (error) {
            if (seq === state.seq) state.panel.showError(formatError(error));
        } finally {
            if (seq === state.seq) state.panel.setLoading(false);
        }
    }

    async function pollLayout() {
        state.layoutTimer = null;
        if (!state.ready || !isViewActive()) return;
        const seq = state.seq;
        try {
            const status = await app().API.get(`/api/style-map/layout-status?${query()}`);
            if (seq !== state.seq || !isViewActive()) return;
            const umap = status?.umap || {};
            // ready: fetch the UMAP coordinates. not_started: the server no
            // longer holds this map's inputs (many filters were opened);
            // only a points call rebuilds and re-queues it.
            if (umap.status === 'ready' || umap.status === 'not_started') {
                await refresh();
                return;
            }
            state.umapState = umap;
            state.panel.renderLayout(umap, status?.method);
            scheduleLayoutPoll(umap.status);
        } catch (_error) {
            if (seq === state.seq) scheduleLayoutPoll('queued');
        }
    }

    function onFilterChanged() {
        if (!isViewActive()) return;
        clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(() => refresh(), FILTER_DEBOUNCE_MS);
    }

    async function installUmap() {
        const ensure = window.ensureFeatureModel;
        if (typeof ensure !== 'function') return;
        state.panel.setInstalling(true);
        try {
            const result = await ensure(UMAP_MODEL_ID, {
                label: t('stylemap.umapLabel', 'UMAP layout for the style map'),
                sizeHint: '~90 MB',
            });
            if (result?.ok) await refresh({ force: true });
        } finally {
            state.panel.setInstalling(false);
        }
    }

    function build() {
        const view = root();
        if (!view) return;
        state.panel = new StyleMapPanel(view, {
            // GET /api/images/{id} answers {"image": {...}}.
            getImageName: (id) => app().API.get(`/api/images/${id}`)
                .then((info) => info?.image?.filename || info?.filename || ''),
        });
        try {
            state.scene = new StyleMapScene(view.querySelector('#stylemap-canvas'), {
                onHover: (hit) => state.panel.renderHover(hit),
            });
        } catch (error) {
            // No WebGL (old driver, hardware acceleration off, remote desktop):
            // say so once and stay quiet; init() must not throw every time.
            state.unsupported = true;
            state.panel.showUnsupported(formatError(error));
            return;
        }
        state.job = new IndexJob({
            getSpace: () => state.space,
            getToken: () => state.token,
            onChange: (job) => {
                state.panel.renderJob(job);
                if (state.points) state.panel.renderEmpty(state.points, state.space, job.isRunning());
            },
            onDone: () => refresh({ force: true }),
        });
        state.panel.bind({
            onSpaceChange: (space) => {
                state.space = space;
                refresh();
            },
            onInstall: installUmap,
            onRetry: () => refresh({ force: true }),
            onResetView: () => state.scene.resetView(),
            onBuild: () => state.job.start(),
            onPause: () => state.job.pause(),
            onResume: () => state.job.resume(),
            onCancel: () => state.job.cancel(),
        });
        // The Gallery filter is the map's scope (not the ticked pictures);
        // rapid changes are debounced into one points request.
        window.addEventListener('gallery-filters-changed', onFilterChanged);
        document.addEventListener('i18n-applied', repaint);
        // The view's `active` class is the only signal that the user left.
        new MutationObserver(() => {
            if (!isViewActive()) dispose();
        }).observe(view, { attributes: true, attributeFilter: ['class'] });
        state.ready = true;
    }

    function init() {
        if (!state.ready && !state.unsupported) build();
        if (!state.ready) return;
        state.scene.resume();
        state.job.probe();
        refresh();
    }

    function dispose() {
        state.seq += 1; // answers still in flight are dropped
        clearLayoutTimer();
        clearTimeout(state.debounceTimer);
        state.scene?.pause();
        state.job?.stopPolling();
    }

    return { init, dispose, refresh, _state: state };
}
