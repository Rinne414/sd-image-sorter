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
    // Failed polls in a row before the dialog says it lost contact (about 5 s).
    const LOST_CONTACT_POLLS = 5;
    // Shown when the program does not know the size of the video support download yet.
    const VIDEO_SUPPORT_MB = 77;
    const VIDEO_INSTALL_POLL_MS = 1500;

    function byId(id) {
        return document.getElementById(id);
    }

    const MediaCensor = {
        _bound: false,
        _listing: null,
        _jobId: null,
        _timer: null,

        _t(key, fallback, params) {
    const value = window.I18n.t(key, params);
    return value && value !== key ? value : window.I18n.format(fallback, params);
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
            // Typing a path must not reach the Censor shortcuts behind the
            // dialog; Escape still goes through and closes it.
            ['media-censor-folder', 'media-censor-output'].forEach((id) => {
                byId(id)?.addEventListener('keydown', (event) => {
                    if (event.key !== 'Escape') event.stopPropagation();
                });
            });
        },

        open() {
            this.init();
            this._restoreFolders();
            if (typeof window.App?.showModal === 'function') {
                // Starts in the folder field; Escape closes it through close(),
                // which also folds the folder browser.
                window.App.showModal('media-censor-modal', {
                    onEscape: () => this.close(),
                    initialFocus: byId('media-censor-folder'),
                });
            } else {
                byId('media-censor-modal')?.classList.add('visible');
                byId('media-censor-folder')?.focus();
            }
        },

        // The last source and save folders come back once per page load; an
        // empty save folder stays empty (= the video-censor folder in the
        // output root, which Settings can move), and a field cleared during
        // this visit is not refilled.
        _restoreFolders() {
            if (this._foldersRestored) return;
            this._foldersRestored = true;
            const source = byId('media-censor-folder');
            const output = byId('media-censor-output');
            try {
                if (output && !output.value.trim()) output.value = localStorage.getItem('media_censor_output_folder') || '';
                const savedSource = localStorage.getItem('media_censor_source_folder') || '';
                if (source && !source.value.trim() && savedSource) {
                    source.value = savedSource;
                    this.list();
                }
            } catch (err) { /* storage can be unavailable; the fields just start empty */ }
        },

        _rememberFolders(sourceFolder, outputFolder) {
            try {
                localStorage.setItem('media_censor_source_folder', sourceFolder);
                localStorage.setItem('media_censor_output_folder', outputFolder);
            } catch (err) { /* not remembering is harmless */ }
        },

        close() {
            window.hideFolderBrowser?.();
            if (typeof window.App?.hideModal === 'function') window.App.hideModal('media-censor-modal');
            else byId('media-censor-modal')?.classList.remove('visible');
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
                let text = this._t('mediaCensor.found', 'Found {gifs} GIFs and {videos} videos.', {
                    gifs: body.gifs.length,
                    videos: body.videos.length,
                });
                if (body.videos.length && !body.video_ready) {
                    text += ' ' + this._t('mediaCensor.videoNeedsFfmpeg', 'Videos need video support (ffmpeg); you will be asked to install it.');
                }
                found.textContent = text;
            }
            return body;
        },

        // Videos run on ONE ffmpeg: video support's when it is installed, else the one the
        // optional imageio-ffmpeg package ships. With neither, the install offered is video
        // support (the same download also plays and reads the gallery's videos), never a
        // second copy of ffmpeg. Resolves true once videos can be censored.
        async _videoToolsReady(listing) {
            const api = window.App?.API || window.API;
            const askReady = async () => {
                try {
                    return Boolean((await api.get('/api/censor/media/status')).video_ready);
                } catch (_error) {
                    return Boolean(listing?.video_ready);
                }
            };
            if (await askReady()) return true;
            const support = window.VideoSupport;
            if (!support) return false;
            await support.refresh();
            if (support.state && support.state.can_install === false) {
                this._toast(this._t('mediaCensor.videoNoBuild',
                    'There is no ready-made ffmpeg for this system. Install ffmpeg with your package manager, or leave the videos out.'), 'warning');
                return false;
            }
            if (support.state?.install?.state !== 'running') {
                const mb = support.state?.estimated_mb || VIDEO_SUPPORT_MB;
                const confirmed = await new Promise((resolve) => {
                    const ask = window.App?.showConfirm || window.showConfirm;
                    const title = this._t('mediaCensor.videoInstallTitle', 'Install video support?');
                    const message = this._t('mediaCensor.videoInstallMessage',
                        'Videos need video support (about {mb} MB). It is one download that also lets the gallery play and read videos. The censoring starts by itself when it is installed.', { mb });
                    if (typeof ask === 'function') ask(title, message, () => resolve(true), () => resolve(false), { tone: 'primary' });
                    else resolve(window.confirm(message));
                });
                if (!confirmed) return false;
                await support.install();
            }
            return this._waitForVideoSupport(support, askReady);
        },

        // Follows the install in the folder line until video support is there or it failed.
        async _waitForVideoSupport(support, askReady) {
            const found = byId('media-censor-found');
            const startButton = byId('media-censor-start');
            if (startButton) startButton.disabled = true;
            try {
                for (;;) {
                    await new Promise((resolve) => setTimeout(resolve, VIDEO_INSTALL_POLL_MS));
                    await support.refresh();
                    if (found) found.textContent = support.statusText();
                    const install = support.state?.install || {};
                    if (install.state === 'running') continue;
                    if (install.state === 'failed') {
                        this._toast(this._t('mediaCensor.videoInstallFailed', 'Video support was not installed, so only the GIFs are censored.'), 'error');
                        return false;
                    }
                    return await askReady();
                }
            } finally {
                if (startButton) startButton.disabled = false;
                if (found) found.textContent = '';
                this.list();
            }
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
            if (includeVideos && !(await this._videoToolsReady(listing))) {
                includeVideos = false;
                this._toast(this._t('mediaCensor.videosSkipped', 'Video support is not installed, so only the GIFs are censored.'), 'warning');
            }
            if (!listing.gifs.length && !includeVideos) {
                this._toast(this._t('mediaCensor.nothingToDo', 'Nothing to censor in this folder.'), 'warning');
                return;
            }
            const detection = this._detection();
            if (['nudenet', 'both'].includes(detection.model_type) && typeof window.ensureFeatureModel === 'function') {
                await window.ensureFeatureModel('censor-nudenet', { label: 'NudeNet', sizeHint: '~12 MB', confirmBytes: 0 });
            }
            const sourceFolder = (byId('media-censor-folder')?.value || '').trim();
            const outputFolder = (byId('media-censor-output')?.value || '').trim();
            const response = await fetch('/api/censor/media/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    folder: sourceFolder,
                    output_folder: outputFolder,
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
            this._missedPolls = 0;
            this._rememberFolders(sourceFolder, outputFolder);
            this._render(body);
            this._setRunning(true);
            this._poll();
        },

        async stop() {
            if (!this._jobId) return;
            try {
                const response = await fetch(`/api/censor/media/jobs/${encodeURIComponent(this._jobId)}/cancel`, { method: 'POST' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
            } catch (error) {
                this._toast(this._t('mediaCensor.stopFailed', 'Could not stop it: {reason}', { reason: error.message || String(error) }), 'error');
            }
        },

        _poll() {
            clearTimeout(this._timer);
            this._timer = setTimeout(async () => {
                let snapshot;
                try {
                    const response = await fetch(`/api/censor/media/jobs/${encodeURIComponent(this._jobId)}`);
                    if (response.status === 404) {
                        // The program no longer knows the job (it was restarted).
                        this._missedPolls = 0;
                        this._setRunning(false);
                        this._toast(this._t('mediaCensor.jobGone',
                            'The censoring job is no longer running (the program was restarted). Files it finished are in the output folder.'), 'warning');
                        return;
                    }
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    snapshot = await response.json();
                } catch (_) {
                    // Not reachable right now (busy or restarting): keep asking, and say so once.
                    this._missedPolls = (this._missedPolls || 0) + 1;
                    if (this._missedPolls === LOST_CONTACT_POLLS) {
                        this._toast(this._t('mediaCensor.noContact', 'Lost contact with the program. Still trying; the progress shows again when it answers.'), 'warning');
                    }
                    this._poll();
                    return;
                }
                if (this._missedPolls >= LOST_CONTACT_POLLS) {
                    this._toast(this._t('mediaCensor.contactBack', 'In contact with the program again.'), 'info');
                }
                this._missedPolls = 0;
                this._render(snapshot);
                if (['done', 'done_with_errors', 'cancelled'].includes(snapshot.status)) {
                    this._setRunning(false);
                    this._toast(this._t('mediaCensor.finished', 'Finished {done} of {total} files.', snapshot), snapshot.status === 'done' ? 'success' : 'warning');
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
                // a cause the program names by code is said in the UI language
                const reason = item.error_code ? this._t(`apiError.${item.error_code}`, item.error) : item.error;
                status.textContent = item.status === 'error' && reason
                    ? window.I18n.joinLabel(this._statusLabel(item.status), reason)
                    : item.status === 'done'
                        ? this._t('mediaCensor.doneFrames', 'Done · {count} frames censored', { count: item.censored_frames })
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
