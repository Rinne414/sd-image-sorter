/**
 * The Style Map page chrome: toolbar (space, layout status, index job),
 * scope line, empty-state card and the hover preview. Every text it writes
 * is composed from i18n keys at write time, so the ui-refresh re-apply
 * (which resets [data-i18n] elements) never clobbers it: these elements
 * carry no data-i18n.
 */
import { t, formatRemaining } from './text.js';

// The preview pane fills the side column, so ask for a larger cached thumbnail.
const THUMBNAIL_SIZE = 512;
const NAME_CACHE_LIMIT = 64;
const NAME_MAX_CHARS = 28;

function middleEllipsis(text, max) {
    const value = String(text || '');
    if (value.length <= max) return value;
    const keep = Math.max(4, Math.floor((max - 1) / 2));
    return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

const LAYOUT_TEXT = {
    unavailable: ['stylemap.layoutPcaNoUmap', 'Layout: PCA. Install UMAP so that pictures placed together really look alike.', 'is-plain'],
    too_few_points: ['stylemap.layoutTooFew', 'Layout: PCA (UMAP needs more than 20 pictures).', 'is-plain'],
    not_started: ['stylemap.layoutPca', 'Layout: PCA', 'is-plain'],
    queued: ['stylemap.layoutQueued', 'Layout: PCA for now, UMAP queued', 'is-computing'],
    computing: ['stylemap.layoutComputing', 'Layout: PCA for now, computing UMAP', 'is-computing'],
    ready: ['stylemap.layoutReady', 'Layout: UMAP', 'is-ready'],
    failed: ['stylemap.layoutFailed', 'Layout: PCA (the UMAP fit failed)', 'is-failed'],
};

export class StyleMapPanel {
    constructor(root, { getImageName } = {}) {
        this.root = root;
        this.getImageName = typeof getImageName === 'function' ? getImageName : null;
        this.names = new Map();
        const $ = (id) => root.querySelector(`#${id}`);
        this.el = {
            space: $('stylemap-space'),
            colorBy: $('stylemap-color-by'),
            legend: $('stylemap-legend'),
            layout: $('stylemap-layout'),
            layoutDot: $('stylemap-layout-dot'),
            layoutText: $('stylemap-layout-text'),
            install: $('stylemap-install-umap'),
            retry: $('stylemap-retry-layout'),
            build: $('stylemap-build-btn'),
            progress: $('stylemap-index-progress'),
            fill: $('stylemap-index-fill'),
            progressText: $('stylemap-index-text'),
            pause: $('stylemap-index-pause'),
            cancel: $('stylemap-index-cancel'),
            scope: $('stylemap-scope'),
            error: $('stylemap-error'),
            empty: $('stylemap-empty'),
            emptyEyebrow: $('stylemap-empty-eyebrow'),
            emptyTitle: $('stylemap-empty-title'),
            emptyText: $('stylemap-empty-text'),
            emptyBuild: $('stylemap-empty-build'),
            emptySimilar: $('stylemap-empty-similar'),
            resetView: $('stylemap-reset-view'),
            landmarksToggle: $('stylemap-landmarks-toggle'),
            unsupported: $('stylemap-unsupported'),
            unsupportedDetail: $('stylemap-unsupported-detail'),
            previewHint: $('stylemap-preview-hint'),
            previewImg: $('stylemap-preview-img'),
            previewName: $('stylemap-preview-name'),
            previewMembers: $('stylemap-preview-members'),
            loading: $('stylemap-loading'),
        };
        this.hoverId = null;
    }

    bind(handlers) {
        const { el } = this;
        el.space?.addEventListener('change', () => handlers.onSpaceChange(el.space.value));
        el.colorBy?.addEventListener('change', () => handlers.onColorByChange(el.colorBy.value));
        el.install?.addEventListener('click', () => handlers.onInstall());
        el.retry?.addEventListener('click', () => handlers.onRetry());
        el.resetView?.addEventListener('click', () => handlers.onResetView());
        el.landmarksToggle?.addEventListener('click', () => handlers.onToggleLandmarks());
        el.build?.addEventListener('click', () => handlers.onBuild());
        // Rule 11: the card's button is a proxy of the toolbar's, not a fork.
        el.emptyBuild?.addEventListener('click', () => el.build?.click());
        el.emptySimilar?.addEventListener('click', () => document.getElementById('nav-tab-similar')?.click());
        el.pause?.addEventListener('click', () => {
            if (el.pause.dataset.state === 'paused') handlers.onResume();
            else handlers.onPause();
        });
        el.cancel?.addEventListener('click', () => handlers.onCancel());
    }

    setLoading(flag) {
        if (this.el.loading) this.el.loading.hidden = !flag;
    }

    /** Show the remembered colour field in the select. */
    setColorBy(by) {
        if (this.el.colorBy && this.el.colorBy.value !== by) this.el.colorBy.value = by;
    }

    /**
     * The map stays grey meanwhile; the legend row says why (loading,
     * failed). With `onRetry` a small retry button follows the note, in the
     * same row as the select (never a button on a row of its own, rule 17).
     */
    showColorsNote(message, onRetry = null) {
        const { legend } = this.el;
        if (!legend) return;
        const note = document.createElement('span');
        note.className = 'stylemap-legend-chip is-nodata';
        note.textContent = message;
        legend.replaceChildren(note);
        if (typeof onRetry !== 'function') return;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-ghost btn-small stylemap-legend-retry';
        retry.textContent = t('stylemap.colorsRetry', 'Retry');
        retry.addEventListener('click', onRetry);
        legend.append(retry);
    }

    /** WebGL could not be set up: one explanatory card, no map controls. */
    showUnsupported(detail) {
        const { unsupported, unsupportedDetail, build, empty, resetView, layout } = this.el;
        if (unsupported) unsupported.hidden = false;
        if (unsupportedDetail) unsupportedDetail.textContent = detail ? String(detail) : '';
        if (build) build.hidden = true;
        if (empty) empty.hidden = true;
        if (resetView) resetView.hidden = true;
        if (layout) layout.hidden = true;
    }

    setInstalling(flag) {
        if (this.el.install) this.el.install.disabled = Boolean(flag);
    }

    showError(message) {
        const { error } = this.el;
        if (!error) return;
        error.textContent = t('stylemap.loadError', 'The style map could not be loaded: {error}', { error: message });
        error.hidden = false;
    }

    renderScope(points) {
        const { scope, error } = this.el;
        if (error) error.hidden = true;
        if (!scope) return;
        const total = Number(points.total_images || 0);
        const missing = Number(points.missing_vectors || 0);
        const unlocatable = Array.isArray(points.unlocatable) ? points.unlocatable.length : 0;
        let text;
        if (points.status === 'empty' || total === 0) {
            text = t('stylemap.scopeEmpty', 'The current Gallery filter matches no pictures.');
        } else if (missing === 0) {
            text = t('stylemap.scopeAll', 'All {total} pictures in the current Gallery filter have style data.', { total });
        } else {
            text = t('stylemap.scope', '{total} pictures in the current Gallery filter, {missing} without style data yet.', { total, missing });
        }
        if (unlocatable > 0) {
            text += ` · ${t('stylemap.unlocatable', '{n} cannot be placed', { n: unlocatable })}`;
        }
        scope.textContent = text;
    }

    renderLayout(umap, method) {
        const { layout, layoutDot, layoutText, install, retry } = this.el;
        if (!layout) return;
        const status = umap?.status || (method === 'umap' ? 'ready' : 'not_started');
        const [key, fallback, tone] = LAYOUT_TEXT[status] || LAYOUT_TEXT.not_started;
        const sentence = t(key, fallback);
        // The line shows the short form; the whole sentence (and a failure's
        // error) is the tooltip, so a narrow row never hides the words.
        layoutText.textContent = status === 'unavailable'
            ? t('stylemap.layoutPcaNoUmapShort', 'Layout: PCA, UMAP not installed')
            : sentence;
        layoutDot.className = `stylemap-dot ${tone}`;
        layout.dataset.status = status;
        if (install) {
            install.hidden = status !== 'unavailable';
            install.title = sentence;
        }
        if (retry) retry.hidden = status !== 'failed';
        layout.title = status === 'failed' && umap?.error ? `${sentence}\n${umap.error}` : sentence;
    }

    /**
     * The toolbar button says whether there is work to do: an amber primary
     * "Build" while pictures lack style data, a secondary "Refresh" once
     * every picture has it. The label moves with its i18n key so a language
     * switch keeps the right words.
     */
    renderBuildButton(points, space, jobRunning) {
        const { build } = this.el;
        if (!build) return;
        // Nothing to index when the filter matches no picture at all.
        build.hidden = space !== 'kaloscope' || jobRunning || points.status === 'empty';
        const pending = Number(points.missing_vectors || 0) > 0 || points.status !== 'ok';
        const key = pending ? 'stylemap.buildIndex' : 'stylemap.refreshIndex';
        build.classList.toggle('btn-primary', pending);
        build.classList.toggle('btn-secondary', !pending);
        build.setAttribute('data-i18n', key);
        build.textContent = t(key, pending ? 'Build style index' : 'Refresh style index');
    }

    /**
     * The landmarks switch names the action, so its words flip with the
     * state (rule 16) and its i18n key moves with them.
     */
    renderLandmarksToggle(on) {
        const { landmarksToggle } = this.el;
        if (!landmarksToggle) return;
        const key = on ? 'stylemap.landmarksHide' : 'stylemap.landmarksShow';
        landmarksToggle.setAttribute('data-i18n', key);
        landmarksToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
        landmarksToggle.textContent = t(key, on ? 'Hide region landmarks' : 'Show region landmarks');
    }

    /** The start card replaces the toolbar's primary button (one solid primary per screen). */
    renderEmpty(points, space, jobRunning) {
        const { empty, emptyEyebrow, emptyTitle, emptyText, emptyBuild, emptySimilar, build } = this.el;
        if (!empty) return;
        const hasPoints = points.status === 'ok' && Array.isArray(points.points) && points.points.length > 0;
        const noPictures = points.status === 'empty';
        if (hasPoints || noPictures) {
            empty.hidden = true;
            this.renderBuildButton(points, space, jobRunning);
            return;
        }
        empty.hidden = false;
        if (build) build.hidden = true;
        const isKaloscope = space === 'kaloscope';
        if (emptyBuild) emptyBuild.hidden = !isKaloscope || jobRunning;
        if (emptySimilar) emptySimilar.hidden = isKaloscope;
        if (emptyEyebrow) {
            emptyEyebrow.textContent = jobRunning
                ? t('stylemap.emptyEyebrowRunning', 'In progress')
                : t('stylemap.emptyEyebrow', 'Start Here');
        }
        if (isKaloscope) {
            emptyTitle.textContent = jobRunning
                ? t('stylemap.emptyTitleRunning', 'Building the style index')
                : t('stylemap.emptyTitle', 'Build the style index first');
            emptyText.textContent = jobRunning
                ? t('stylemap.emptyTextRunning', 'The map fills in once the pictures have their style vectors; you can keep browsing meanwhile.')
                : t('stylemap.emptyText', 'Each picture in the filter gets a style vector; the map has nothing to draw before that. It uses the Style Finder model (Kaloscope), and a GPU makes it much faster.');
        } else {
            emptyTitle.textContent = t('stylemap.emptyTitleClip', 'The Similarity index is empty');
            emptyText.textContent = t('stylemap.emptyTextClip', 'This space uses the Similarity index (CLIP). Build it in Find Similar, then come back.');
        }
    }

    renderJob(job) {
        const s = job.state;
        const { build, progress, fill, progressText, pause, cancel } = this.el;
        if (!progress) return;
        const showRow = s.running || Boolean(s.done);
        progress.hidden = !showRow;
        if (build && s.running) build.hidden = true; // renderBuildButton shows it again when idle
        if (!showRow) return;
        const total = Math.max(0, s.total);
        const done = Math.min(total, s.processed);
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        if (fill) fill.style.width = `${percent}%`;
        if (s.done) {
            progressText.textContent = s.done.errors > 0
                ? t('stylemap.indexDoneErrors', 'Done: {n} pictures added, {errors} failed', { n: s.done.written, errors: s.done.errors })
                : t('stylemap.indexDone', 'Done: {n} pictures added', { n: s.done.written });
            progress.dataset.state = 'done';
            if (pause) pause.hidden = true;
            if (cancel) cancel.hidden = true;
            return;
        }
        progress.dataset.state = s.paused ? 'paused' : 'running';
        let text = t('stylemap.indexRunning', 'Building the style index: {done} / {total}', { done, total });
        const remaining = job.estimateRemainingMs();
        if (remaining !== null && !s.paused) {
            text += ` · ${t('stylemap.indexRemaining', 'about {time} left', { time: formatRemaining(remaining) })}`;
        }
        if (s.paused) text += ` · ${t('stylemap.indexPaused', 'paused')}`;
        progressText.textContent = text;
        if (pause) {
            pause.hidden = false;
            pause.dataset.state = s.paused ? 'paused' : 'running';
            pause.textContent = s.paused ? t('stylemap.resume', 'Resume') : t('stylemap.pause', 'Pause');
        }
        if (cancel) cancel.hidden = false;
    }

    renderHover(hit) {
        const { previewHint, previewImg, previewName, previewMembers } = this.el;
        if (!previewImg) return;
        if (!hit) {
            this.hoverId = null;
            previewHint.hidden = false;
            previewImg.hidden = true;
            previewImg.removeAttribute('src');
            previewName.textContent = '';
            previewMembers.textContent = '';
            return;
        }
        if (hit.id === this.hoverId) return;
        this.hoverId = hit.id;
        previewHint.hidden = true;
        previewImg.hidden = false;
        previewImg.src = `/api/image-thumbnail/${hit.id}?size=${THUMBNAIL_SIZE}`;
        previewMembers.textContent = hit.members > 1
            ? t('stylemap.members', 'Stands for {n} near-identical pictures', { n: hit.members })
            : '';
        this.showName(this.names.get(hit.id) || `#${hit.id}`);
        if (this.getImageName && !this.names.has(hit.id)) {
            this.getImageName(hit.id).then((name) => {
                if (!name) return;
                if (this.names.size >= NAME_CACHE_LIMIT) this.names.delete(this.names.keys().next().value);
                this.names.set(hit.id, name);
                if (this.hoverId === hit.id) this.showName(name);
            }).catch(() => {});
        }
    }

    /** One line: long names keep their head and tail, the whole name is the tooltip. */
    showName(name) {
        const { previewName } = this.el;
        previewName.textContent = middleEllipsis(name, NAME_MAX_CHARS);
        previewName.title = name;
    }
}
