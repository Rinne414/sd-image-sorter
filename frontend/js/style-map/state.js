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
import { RegionLandmarks, assignRegions, readLandmarksPreference, writeLandmarksPreference } from './regions.js';
import { ColorLegend, buildPointColors, readColorPreference, writeColorPreference } from './colors.js';
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
        regions: null,
        regionLabels: null,
        landmarks: null,
        landmarksOn: readLandmarksPreference(),
        // Dot colours: the chosen field, the last answer and its legend;
        // colorStats records how long the last repaint took (ms, points).
        colorBy: readColorPreference(),
        colors: null,
        legend: null,
        colorSeq: 0,
        colorStats: null,
    };

    const root = () => document.getElementById('view-stylemap');
    const isViewActive = () => Boolean(root()?.classList.contains('active'));

    const OFFICIAL_MODEL = { model_source: 'huggingface', model_path: null, use_gpu: null };

    /**
     * The Style Finder page's model settings (source, local checkpoint, GPU)
     * and its threshold slider, read from that page's controls exactly as it
     * reads them for its own requests (artist/identify.js _getIdentifyPayload;
     * ArtistIdent is a static script, always present), so the index runs the
     * same weights as identification, tiers the artist with the same floor
     * and the map shows the vectors of those weights. Throws like the Finder
     * does when the source is local but no file is named: the index job must
     * not start on the official weights then, or it overwrites the user's own
     * identification results. Without the slider (no Finder) the field is
     * left out and the server applies the Finder's default.
     */
    function modelSettings() {
        const finder = window.ArtistIdent;
        if (!finder || typeof finder._getIdentifyModelConfig !== 'function') return { ...OFFICIAL_MODEL };
        const settings = finder._getIdentifyModelConfig();
        if (typeof finder.getThresholdValue !== 'function') return settings;
        return { ...settings, threshold: finder.getThresholdValue() };
    }

    /** Reading is harmless: a half-filled local setting shows the official map. */
    function readModelSettings() {
        try {
            return modelSettings();
        } catch (_error) {
            return { ...OFFICIAL_MODEL };
        }
    }

    function query(extra = {}) {
        const params = new URLSearchParams({ space: state.space });
        if (state.token) params.set('selection_token', state.token);
        // Only the Kaloscope space has weights to name; the CLIP map reads
        // the Similarity index and must stay up when a local file is gone.
        if (state.space === 'kaloscope') {
            const settings = readModelSettings();
            params.set('model_source', settings.model_source);
            if (settings.model_path) params.set('model_path', settings.model_path);
        }
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
        state.panel.renderLandmarksToggle(state.landmarksOn);
        state.landmarks.repaintText();
        state.legend.repaintText();
    }

    function applyPoints(points) {
        state.points = points;
        state.umapState = points.umap || {};
        state.scene.setPoints(points.points || [], points.points_layout);
        // The regions belong to these coordinates: drop the old ones and ask
        // again (a PCA -> UMAP switch arrives as a new points answer).
        applyRegions(null);
        state.regionsRetried = false;
        state.colorsRetried = false;
        // Colours are per picture, not per layout: the previous answer is
        // laid over the new ids at once (a picture that left or joined the
        // filter is grey until the fresh answer lands), so a refresh of a
        // 50k map does not flash grey while the server answers.
        applyColors(state.colors?.by === state.colorBy ? state.colors : null);
        repaint();
        scheduleLayoutPoll(points.umap?.status);
        if (points.status === 'ok' && Array.isArray(points.points) && points.points.length > 0) {
            if (!state.colors) state.panel.showColorsNote(t('stylemap.colorsLoading', 'Loading colours...'));
            loadRegions();
            loadColors();
        }
    }

    /** Paint one colours answer onto the dots the scene holds (null: grey, no legend). */
    function applyColors(body) {
        state.colors = body;
        const started = performance.now();
        state.scene.setBaseColors(body ? buildPointColors(body, state.scene.ids) : null);
        state.colorStats = { ms: performance.now() - started, points: state.scene.count, by: body?.by || null };
        state.legend.render(body, body?.by || state.colorBy);
    }

    /**
     * Ask for the chosen field's values of the map just drawn. Never
     * refetches points for a colour change. A not_started answer means the
     * server no longer holds this map (restarted, evicted, or the library
     * changed under it): points are asked for again, and that answer asks
     * for the colours. A failure leaves the dots grey and says so in the
     * legend row; the select never shows a field the dots do not.
     */
    async function loadColors() {
        const seq = state.seq;
        const colorSeq = ++state.colorSeq;
        const by = state.colorBy;
        try {
            const body = await app().API.get(`/api/style-map/colors?${query({ by })}`);
            if (seq !== state.seq || colorSeq !== state.colorSeq || !isViewActive()) return;
            if (body?.status === 'not_started') {
                applyColors(null);
                // One rebuild per points answer: a server that keeps losing
                // the map must not loop; the row then says the colours failed.
                if (!state.colorsRetried) {
                    state.colorsRetried = true;
                    await refresh();
                    return;
                }
                throw new Error('not_started');
            }
            if (body?.status !== 'ok') throw new Error(String(body?.status || 'bad answer'));
            applyColors(body);
        } catch (_error) {
            if (seq === state.seq && colorSeq === state.colorSeq) {
                applyColors(null);
                state.panel.showColorsNote(t('stylemap.colorsError', 'Dot colours could not be loaded'));
            }
        }
    }

    function setColorBy(by) {
        if (!by || by === state.colorBy) return;
        state.colorBy = by;
        writeColorPreference(by);
        state.panel.setColorBy(by);
        if (state.points?.status !== 'ok' || state.scene.count === 0) return;
        // Grey and "loading" until the new field's answer lands: the dots
        // must never show one field while the select names another.
        applyColors(null);
        state.panel.showColorsNote(t('stylemap.colorsLoading', 'Loading colours...'));
        loadColors();
    }

    function applyRegions(body) {
        state.regions = body;
        const regions = body?.regions || [];
        state.regionLabels = regions.length ? assignRegions(state.scene.geometry.getAttribute('position'), regions) : null;
        state.scene.setFocus(null, null);
        state.landmarks.setRegions(regions);
        state.landmarks.place(state.scene.view());
    }

    /** Regions of the map just drawn; answered from the server's cache when unchanged. */
    async function loadRegions() {
        const seq = state.seq;
        try {
            const body = await app().API.get(`/api/style-map/regions?${query()}`);
            if (seq !== state.seq || !isViewActive()) return;
            // not_started: the server no longer holds this map (restarted or
            // evicted); a points call rebuilds it and asks for regions again.
            if (body?.status === 'not_started') {
                if (!state.regionsRetried) {
                    state.regionsRetried = true;
                    await refresh();
                }
                return;
            }
            // Regions of another layout (UMAP finished between the points
            // and the regions request): UMAP centres on a PCA cloud would
            // mislead; the layout poll fetches both again.
            if (body?.method && state.points?.method && body.method !== state.points.method) return;
            applyRegions(body);
        } catch (_error) {
            // the map stays usable without landmarks; the next points answer retries
        }
    }

    function setLandmarks(on) {
        state.landmarksOn = Boolean(on);
        writeLandmarksPreference(state.landmarksOn);
        state.landmarks.setVisible(state.landmarksOn);
        state.landmarks.place(state.scene.view());
        state.panel.renderLandmarksToggle(state.landmarksOn);
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
                onCameraChange: (camera) => state.landmarks?.place(camera),
            });
        } catch (error) {
            // No WebGL (old driver, hardware acceleration off, remote desktop):
            // say so once and stay quiet; init() must not throw every time.
            state.unsupported = true;
            state.panel.showUnsupported(formatError(error));
            return;
        }
        state.landmarks = new RegionLandmarks(view.querySelector('#stylemap-canvas-card'), {
            onHoverRegion: (index) => state.scene.setFocus(state.regionLabels, index),
        });
        state.landmarks.setVisible(state.landmarksOn);
        state.legend = new ColorLegend(view.querySelector('#stylemap-legend'));
        state.panel.setColorBy(state.colorBy);
        state.job = new IndexJob({
            getSpace: () => state.space,
            getToken: () => state.token,
            getModelSettings: modelSettings,
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
            onColorByChange: setColorBy,
            onInstall: installUmap,
            onRetry: () => refresh({ force: true }),
            onResetView: () => state.scene.resetView(),
            onToggleLandmarks: () => setLandmarks(!state.landmarksOn),
            onBuild: () => state.job.start(),
            onPause: () => state.job.pause(),
            onResume: () => state.job.resume(),
            onCancel: () => state.job.cancel(),
        });
        // The switch shows the stored preference before the first map arrives.
        state.panel.renderLandmarksToggle(state.landmarksOn);
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
        state.landmarks?.hover(-1);
        state.legend?.closePop();
    }

    return { init, dispose, refresh, setColorBy, _state: state };
}
