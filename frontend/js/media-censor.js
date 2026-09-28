/**
 * SD Image Sorter - GIF / video auto-censor dialog (Censor page).
 *
 * Works on a folder, not uploads: videos are large and already on disk. The
 * detector settings are the Censor page's current ones (model, targets,
 * confidence, face guard, shape, grow edge, Auto cell), so a moving picture
 * is censored the same way a still one would be. Jobs run on the server;
 * this dialog polls one for per-file progress.
 */

(function () {
    'use strict';

    const POLL_MS = 1000;
    const VIDEO_SIZE_HINT = '~31 MB';
    const VIDEO_CONFIRM_BYTES = 31 * 1024 * 1024;

    function byId(id) {
        return document.getElementById(id);
    }

    const MediaCensor = {
        _bound: false,
        _listing: null,
        _jobId: null,
        _timer: null,

        _t(key, fallback, params) {
            const value = window.I18n?.t?.(key, params);
            if (value && value !== key) return value;
            return String(fallback).replace(/\{(\w+)\}/g, (_, name) => (params && name in params ? params[name] : `{${name}}`));
        },

        init() {
            if (this._bound) return;
            this._bound = true;
            byId('btn-media-censor-open')?.addEventListener('click', () => this.open());
            byId('media-censor-close')?.addEventListener('click', () => this.close());
            byId('media-censor-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => this.close());
            byId('media-censor-browse-source')?.addEventListener('click', () => window.showFolderBrowser?.(byId('media-censor-folder')));
            byId('media-censor-browse-output')?.addEventListener('click', () => window.showFolderBrowser?.(byId('media-censor-output')));
            byId('media-censor-folder')?.addEventListener('change', () => this.list());
            byId('media-censor-start')?.addEventListener('click', () => this.start());
            byId('media-censor-stop')?.addEventListener('click', () => this.stop());
            ['media-censor-folder', 'media-censor-output'].forEach((id) => {
                byId(id)?.addEventListener('keydown', (event) => event.stopPropagation());
            });
        },

        open() {
            this.init();
            byId('media-censor-modal')?.classList.add('visible');
            byId('media-censor-folder')?.focus();
        },

        close() {
            window.hideFolderBrowser?.();
            byId('media-censor-modal')?.classList.remove('visible');
        },

        async list() {
            const folder = (byId('media-censor-folder')?.value || '').trim();
            const found = byId('media-censor-found');
            this._listing = null;
            if (!folder) {
                if (found) found.textContent = '';
                return null;
            }
            const response = await fetch('/api/censor/media/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (found) found.textContent = body.error || body.detail || this._t('mediaCensor.badFolder', 'That folder cannot be read.');
                return null;
            }
            this._listing = body;
            if (found) {
                let text = this._t('mediaCensor.found', 'Found {gifs} GIF(s) and {videos} video(s).', {
                    gifs: body.gifs.length,
                    videos: body.videos.length,
                });
                if (body.videos.length && !body.video_ready) {
                    text += ' ' + this._t('mediaCensor.videoNeedsFfmpeg', 'Videos need the ffmpeg component (~31 MB); you will be asked to install it.');
                }
                found.textContent = text;
            }
            return body;
        },

        // The Censor page's current detection settings (see censor/state.js).
        _detection() {
            const state = typeof CensorState !== 'undefined' ? CensorState : null;
            let modelType = byId('censor-model-type')?.value || 'nudenet';
            if (modelType === 'sam3') modelType = 'nudenet';
            if (modelType === 'legacy') {
                const record = typeof getSelectedLegacyModelRecord === 'function' ? getSelectedLegacyModelRecord() : null;
                if (record?.profile !== 'privacy-censor') modelType = 'nudenet';
            }
            return {
                model_type: modelType,
                model_path: modelType === 'nudenet' ? '' : (state?.modelPath || ''),
                confidence: Number.isFinite(state?.confidence) ? state.confidence : 0.5,
                target_classes: Array.isArray(state?.targetClasses) && state.targetClasses.length ? state.targetClasses : null,
                face_guard: state ? Boolean(state.faceGuard) : true,
                shape: state?.maskShape || 'precise',
                expand_percent: Number(state?.expandPercent) || 0,
                block_size: state && !state.blockSizeAuto ? Number(state.blockSize) || 0 : 0,
            };
        },

        async start() {
            const listing = this._listing || await this.list();
            if (!listing) return;
            let includeVideos = Boolean(byId('media-censor-videos')?.checked) && listing.videos.length > 0;
            if (includeVideos && !listing.video_ready && typeof window.ensureFeatureModel === 'function') {
                const ensured = await window.ensureFeatureModel('video-ffmpeg', {
                    label: 'ffmpeg',
                    sizeHint: VIDEO_SIZE_HINT,
                    confirmBytes: VIDEO_CONFIRM_BYTES,
                });
                if (!ensured?.ok) {
                    includeVideos = false;
                    this._toast(this._t('mediaCensor.videosSkipped', 'ffmpeg is not installed, so only the GIFs are censored.'), 'warning');
                }
            }
            if (!listing.gifs.length && !includeVideos) {
                this._toast(this._t('mediaCensor.nothingToDo', 'Nothing to censor in this folder.'), 'warning');
                return;
            }
            const detection = this._detection();
            if (['nudenet', 'both'].includes(detection.model_type) && typeof window.ensureFeatureModel === 'function') {
                await window.ensureFeatureModel('censor-nudenet', { label: 'NudeNet', sizeHint: '~12 MB', confirmBytes: 0 });
            }
            const response = await fetch('/api/censor/media/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    folder: (byId('media-censor-folder')?.value || '').trim(),
                    output_folder: (byId('media-censor-output')?.value || '').trim(),
                    include_videos: includeVideos,
                    style: byId('media-censor-style')?.value || 'mosaic',
                    detect_every: Number(byId('media-censor-every')?.value) || 2,
                    hold: Number(byId('media-censor-hold')?.value) || 0,
                    ...detection,
                }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                this._toast(body.error || body.detail || this._t('mediaCensor.startFailed', 'Could not start.'), 'error');
                return;
            }
            this._jobId = body.job_id;
            const output = byId('media-censor-output');
            if (output && !output.value.trim()) output.value = body.output_folder;
            this._render(body);
            this._setRunning(true);
            this._poll();
        },

        async stop() {
            if (!this._jobId) return;
            await fetch(`/api/censor/media/jobs/${encodeURIComponent(this._jobId)}/cancel`, { method: 'POST' });
        },

        _poll() {
            clearTimeout(this._timer);
            this._timer = setTimeout(async () => {
                const response = await fetch(`/api/censor/media/jobs/${encodeURIComponent(this._jobId)}`);
                if (!response.ok) {
                    this._setRunning(false);
                    return;
                }
                const snapshot = await response.json();
                this._render(snapshot);
                if (['done', 'done_with_errors', 'cancelled'].includes(snapshot.status)) {
                    this._setRunning(false);
                    this._toast(this._t('mediaCensor.finished', 'Finished {done} of {total} file(s).', snapshot), snapshot.status === 'done' ? 'success' : 'warning');
                    return;
                }
                this._poll();
            }, POLL_MS);
        },

        _setRunning(running) {
            const start = byId('media-censor-start');
            const stop = byId('media-censor-stop');
            if (start) start.disabled = running;
            if (stop) stop.hidden = !running;
        },

        _statusLabel(status) {
            const labels = {
                queued: ['mediaCensor.statusQueued', 'Waiting'],
                running: ['mediaCensor.statusRunning', 'Working'],
                done: ['mediaCensor.statusDone', 'Done'],
                error: ['mediaCensor.statusError', 'Failed'],
                skipped: ['mediaCensor.statusSkipped', 'Skipped'],
            };
            const [key, fallback] = labels[status] || ['', status];
            return key ? this._t(key, fallback) : fallback;
        },

        _render(snapshot) {
            const list = byId('media-censor-progress');
            if (!list) return;
            list.replaceChildren(...snapshot.files.map((item, index) => {
                const row = document.createElement('div');
                row.className = `media-censor-row is-${item.status}`;
                const name = document.createElement('span');
                name.className = 'media-censor-name';
                name.textContent = item.name;
                const bar = document.createElement('progress');
                bar.max = Math.max(1, item.frames_total || 1);
                bar.value = item.status === 'done' ? bar.max : item.frames_done || 0;
                const status = document.createElement('span');
                status.className = 'media-censor-status';
                status.textContent = item.status === 'error' && item.error
                    ? `${this._statusLabel(item.status)}: ${item.error}`
                    : item.status === 'done'
                        ? this._t('mediaCensor.doneFrames', 'Done · {count} frame(s) censored', { count: item.censored_frames })
                        : this._statusLabel(item.status);
                row.append(name, bar, status);
                if (item.status === 'done' && item.output) {
                    const reveal = document.createElement('button');
                    reveal.type = 'button';
                    reveal.className = 'btn btn-ghost btn-small';
                    reveal.textContent = this._t('disguise.showInFolder', 'Show in folder');
                    reveal.addEventListener('click', () => {
                        fetch(`/api/censor/media/jobs/${encodeURIComponent(snapshot.id)}/reveal/${index}`, { method: 'POST' });
                    });
                    row.append(reveal);
                } else {
                    row.append(document.createElement('span'));
                }
                return row;
            }));
        },

        _toast(message, kind) {
            window.App?.showToast?.(message, kind);
        },
    };

    window.MediaCensor = MediaCensor;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => MediaCensor.init());
    } else {
        MediaCensor.init();
    }
})();
