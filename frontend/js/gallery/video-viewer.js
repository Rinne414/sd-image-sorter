/**
 * gallery/video-viewer.js - plays a video in the picture preview.
 *
 * The preview keeps its <img> for pictures; for a video it shows a <video>
 * of the original file (HTTP Range, so seeking works) with a small bar:
 * Loop and Sound toggles that say their state, and frame steps (, and . keys
 * too). When the browser cannot play the file (ProRes, some MKV/HEVC), the
 * viewer asks the server for a converted VP9 preview, shows its progress, and
 * then plays it with the note "Playing a converted preview".
 */
(function () {
    'use strict';

    const CONVERT_POLL_MS = 1000;
    const DEFAULT_FPS = 24;
    const PREFS_KEY = 'sd-sorter:video-viewer';
    const VIDEO_NAME = /\.(mp4|webm|mkv|mov|m4v)$/i;
    const PICTURE_ONLY_HANDOFFS = new Set(['censor', 'similar', 'dataset', 'stylemap']);

    function t(key, fallback, params) {
        const value = window.I18n.t(key, params);
        return value && value !== key ? value : window.I18n.format(fallback, params);
    }

    function loadPrefs() {
        try {
            return { loop: true, muted: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
        } catch (_e) {
            return { loop: true, muted: false };
        }
    }

    function isVideo(image) {
        if (!image) return false;
        if (image.media_type) return image.media_type === 'video';
        return VIDEO_NAME.test(String(image.filename || image.path || ''));
    }

    const Viewer = {
        imageId: null,
        info: null,
        prefs: loadPrefs(),
        _pollTimer: null,
        _triedConversion: false,
        _tabbed: false,

        _els() {
            return {
                container: document.querySelector('#image-modal .modal-image-container'),
                stage: document.getElementById('modal-video-stage'),
                video: document.getElementById('modal-video'),
                note: document.getElementById('modal-video-note'),
                loop: document.getElementById('modal-video-loop'),
                sound: document.getElementById('modal-video-sound'),
            };
        },

        show(summary, imageId) {
            const els = this._els();
            if (!els.stage || !els.video) return;
            this._reset(els);
            this._syncHandoffs(isVideo(summary));
            if (!isVideo(summary)) {
                els.container?.classList.remove('is-video-preview');
                return;
            }
            this.imageId = imageId;
            this._tabbed = false;
            els.container?.classList.add('is-video-preview');
            els.stage.hidden = false;
            this._applyPrefs(els);
            // A codec the browser cannot decode (ProRes ...) goes straight to
            // the converted preview instead of downloading the original first.
            if (window.VideoCards?.canPreviewInBrowser?.(summary?.video_codec) !== false) {
                els.video.src = `/api/image-file/${imageId}`;
                els.video.play().catch(() => {});
            }
            this._loadInfo(imageId);
        },

        // Censor, Similar, Dataset and Style Map work on pictures only.
        _syncHandoffs(video) {
            document.querySelectorAll('.modal-handoff-btn[data-modal-handoff]').forEach((button) => {
                if (!PICTURE_ONLY_HANDOFFS.has(button.dataset.modalHandoff)) return;
                if (video) {
                    button.disabled = true;
                    button.dataset.videoDisabled = '1';
                    button.setAttribute('aria-disabled', 'true');
                    button.dataset.videoTitle = button.title;
                    button.title = t('video.pictureOnly', 'Works on pictures only, not videos');
                } else if (button.dataset.videoDisabled) {
                    button.disabled = false;
                    button.removeAttribute('aria-disabled');
                    button.title = button.dataset.videoTitle || button.title;
                    delete button.dataset.videoDisabled;
                    delete button.dataset.videoTitle;
                }
            });
        },

        _reset(els) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
            this.imageId = null;
            this.info = null;
            this._triedConversion = false;
            els.video.pause();
            els.video.removeAttribute('src');
            els.video.load();
            els.stage.hidden = true;
            this._setNote('');
        },

        stop() {
            const els = this._els();
            if (els.video && els.stage) this._reset(els);
        },

        _applyPrefs(els) {
            els.video.loop = Boolean(this.prefs.loop);
            els.video.muted = Boolean(this.prefs.muted);
            this._renderToggles(els);
        },

        _renderToggles(els) {
            if (els.loop) {
                els.loop.textContent = this.prefs.loop ? t('video.loopOn', 'Loop: on') : t('video.loopOff', 'Loop: off');
                els.loop.setAttribute('aria-pressed', String(Boolean(this.prefs.loop)));
            }
            if (els.sound) {
                els.sound.textContent = this.prefs.muted ? t('video.soundOff', 'Sound: off') : t('video.soundOn', 'Sound: on');
                els.sound.setAttribute('aria-pressed', String(!this.prefs.muted));
            }
        },

        _savePrefs() {
            try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch (_e) { /* private mode */ }
        },

        toggle(name) {
            const els = this._els();
            if (name === 'loop') this.prefs.loop = !this.prefs.loop;
            if (name === 'sound') this.prefs.muted = !this.prefs.muted;
            this._savePrefs();
            this._applyPrefs(els);
        },

        step(direction) {
            const { video } = this._els();
            if (!video || !this.imageId) return;
            video.pause();
            const fps = Number(this.info?.fps) || DEFAULT_FPS;
            const next = video.currentTime + direction / fps;
            video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : next, next));
        },

        async _loadInfo(imageId) {
            try {
                this.info = await window.App.API.get(`/api/videos/${imageId}/playback`);
            } catch (_error) {
                return;
            }
            if (this.imageId !== imageId) return;
            if (!this.info.plays_in_browser) this._useConvertedPreview();
        },

        _onPlaybackFailed() {
            if (!this.imageId || this._triedConversion) return;
            this._useConvertedPreview();
        },

        async _useConvertedPreview() {
            const imageId = this.imageId;
            this._triedConversion = true;
            const tools = window.VideoSupport?.state?.available ?? this.info?.tools_available;
            if (tools === false) {
                this._setNote(t('video.needsConversion', 'The browser cannot play this video. {action} to make a playable preview.', {
                    action: window.VideoSupport?.installLabel?.() || t('video.install', 'Install video support'),
                }), true);
                return;
            }
            let status;
            try {
                status = await window.App.API.post(`/api/videos/${imageId}/converted`, {});
            } catch (error) {
                this._setNote(error?.message || '');
                return;
            }
            this._followConversion(imageId, status);
        },

        _followConversion(imageId, status) {
            if (this.imageId !== imageId) return;
            if (status?.status === 'done') {
                const { video } = this._els();
                video.src = `/api/videos/${imageId}/converted`;
                video.play().catch(() => {});
                this._setNote(t('video.playingConverted', 'Playing a converted preview (VP9). The original file is unchanged.'));
                return;
            }
            if (status?.status === 'failed') {
                this._setNote(t('video.conversionFailed', 'No playable preview could be made: {reason}', { reason: status.error || '' }));
                return;
            }
            const percent = Math.round((Number(status?.progress) || 0) * 100);
            this._setNote(t('video.converting', 'The browser cannot play this video; making a playable preview... {percent}%', { percent }));
            this._pollTimer = setTimeout(async () => {
                try {
                    const info = await window.App.API.get(`/api/videos/${imageId}/playback`);
                    this._followConversion(imageId, info.converted);
                } catch (_error) {
                    this._setNote(t('video.conversionLost', 'Lost contact while making the preview. Open the video again to retry.'));
                }
            }, CONVERT_POLL_MS);
        },

        _setNote(text, withInstall = false) {
            const { note } = this._els();
            if (!note) return;
            note.textContent = text;
            note.hidden = !text;
            if (withInstall && window.VideoSupport) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-secondary btn-small modal-video-install';
                button.textContent = window.VideoSupport.installLabel();
                button.addEventListener('click', () => window.VideoSupport.install());
                note.append(' ', button);
            }
        },

        describe(image) {
            if (!isVideo(image)) return;
            const sizeEl = document.getElementById('modal-size');
            const parts = [];
            if (image.width && image.height) parts.push(`${image.width}×${image.height}`);
            if (image.duration_seconds) parts.push(window.VideoCards?.formatDuration?.(image.duration_seconds) || `${image.duration_seconds}s`);
            if (image.video_codec) parts.push(String(image.video_codec).toUpperCase());
            if (image.video_fps) parts.push(`${Math.round(image.video_fps * 100) / 100} fps`);
            const formatSize = window.App?.formatSize || window.formatSize;
            if (image.file_size && typeof formatSize === 'function') parts.push(formatSize(image.file_size));
            if (sizeEl && parts.length) sizeEl.textContent = parts.join(' • ');
            this._describeRecipe(image);
        },

        _describeRecipe(image) {
            if (this._els().note?.textContent) return;
            if (image.video_probe_state === 'pending') {
                const ready = window.VideoSupport?.state?.available;
                this._setNote(ready
                    ? t('video.reading', 'Reading this video\'s length and generation info...')
                    : t('video.noToolsNote', 'Length, frames and generation info need video support.'), !ready);
                return;
            }
            if (image.video_probe_state === 'unreadable') {
                this._setNote(t('video.unreadableNote', 'ffmpeg could not read this video: {reason}', { reason: image.video_probe_error || '' }));
                return;
            }
            const recipe = this._recipeSource(image);
            if (recipe?.source === 'companion') {
                this._setNote(t('video.recipeFromCompanion', 'Generation info read from the picture saved beside it: {file}', { file: recipe.file || '' }));
            }
        },

        _recipeSource(image) {
            let meta = image.metadata_json;
            try {
                if (typeof meta === 'string') meta = JSON.parse(meta);
            } catch (_e) {
                return null;
            }
            return meta?._parsed?.video_recipe || null;
        },

        bind() {
            const els = this._els();
            if (!els.video) return;
            els.loop?.addEventListener('click', () => this.toggle('loop'));
            els.sound?.addEventListener('click', () => this.toggle('sound'));
            document.getElementById('modal-video-prev-frame')?.addEventListener('click', () => this.step(-1));
            document.getElementById('modal-video-next-frame')?.addEventListener('click', () => this.step(1));
            els.video.addEventListener('error', () => this._onPlaybackFailed());
            els.video.addEventListener('loadedmetadata', () => {
                if (els.video.videoWidth === 0 && !this._triedConversion) this._onPlaybackFailed();
            });
            els.video.addEventListener('volumechange', () => {
                if (this.prefs.muted === els.video.muted) return;
                this.prefs.muted = els.video.muted;
                this._savePrefs();
                this._renderToggles(els);
            });
            // Capture: answer before a focused button turns Space into a click.
            document.addEventListener('keydown', (event) => this._onKey(event), true);
            const modal = document.getElementById('image-modal');
            if (modal) {
                new MutationObserver(() => {
                    if (!modal.classList.contains('visible') && this.imageId) this.stop();
                }).observe(modal, { attributes: true, attributeFilter: ['class'] });
            }
        },

        togglePlay() {
            const { video } = this._els();
            if (!video || !this.imageId) return;
            if (video.paused || video.ended) video.play().catch(() => {});
            else video.pause();
        },

        // Keys while a video is open: , and . step a frame, Space and K play
        // or pause. Space on a button the user reached with Tab still presses
        // that button; the button the dialog focused on its own does not.
        _onKey(event) {
            if (event.key === 'Tab') {
                this._tabbed = true;
                return;
            }
            const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
            if (!this.imageId || ![',', '.', ' ', 'k'].includes(key)) return;
            if (!this._ownsKeys(event)) return;
            if (key === ',' || key === '.') {
                event.preventDefault();
                this.step(key === ',' ? -1 : 1);
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            // The player's own controls already toggle on Space.
            if (key === ' ' && target?.closest('#modal-video')) return;
            if (key === ' ' && this._tabbed && target?.closest('button, a[href], summary, [role="button"]')) return;
            event.preventDefault();
            event.stopPropagation();
            this.togglePlay();
        },

        _ownsKeys(event) {
            if (!document.getElementById('image-modal')?.classList.contains('visible')) return false;
            if (typeof isTopModal === 'function' && !isTopModal('image-modal')) return false;
            if (event.ctrlKey || event.metaKey || event.altKey) return false;
            const target = event.target;
            return !(target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]'));
        },
    };

    window.VideoViewer = Viewer;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Viewer.bind());
    } else {
        Viewer.bind();
    }
})();
