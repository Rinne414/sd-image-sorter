/**
 * SD Image Sorter - video support (ffmpeg) status and one-click install.
 *
 * GET /api/video-support says whether ffmpeg/ffprobe were found, how big the
 * LGPL download is, install progress and how many videos still wait to be
 * read. Three places use it: the Settings row (always), the gallery banner
 * (only while videos are indexed and ffmpeg is missing) and the video viewer
 * note. While videos are being read, the gallery refreshes when they finish.
 */
(function () {
    'use strict';

    const BUSY_POLL_MS = 2000;
    const IDLE_POLL_MS = 60000;
    const DISMISS_KEY = 'sd-sorter:video-banner-dismissed';

    function t(key, fallback, params) {
        const value = window.I18n.t(key, params);
        return value && value !== key ? value : window.I18n.format(fallback, params);
    }

    function mb(bytes) {
        return Math.max(1, Math.round((Number(bytes) || 0) / 1e6));
    }

    const VideoSupport = {
        state: null,
        _timer: null,
        _lastPending: null,
        _listeners: new Set(),

        start() {
            document.getElementById('btn-video-install')?.addEventListener('click', () => this.install());
            document.getElementById('gallery-video-banner-install')?.addEventListener('click', () => this.install());
            document.getElementById('gallery-video-banner-dismiss')?.addEventListener('click', () => {
                try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (_e) { /* private mode */ }
                this._render();
            });
            this.refresh();
        },

        onChange(listener) {
            this._listeners.add(listener);
        },

        installLabel() {
            const size = this.state?.estimated_mb;
            return size
                ? t('video.installWithSize', 'Install video support (about {mb} MB)', { mb: size })
                : t('video.install', 'Install video support');
        },

        async refresh() {
            clearTimeout(this._timer);
            try {
                this.state = await window.App.API.get('/api/video-support');
            } catch (_error) {
                this._timer = setTimeout(() => this.refresh(), IDLE_POLL_MS);
                return;
            }
            this._noticeFinishedVideos();
            this._render();
            this._listeners.forEach((listener) => listener(this.state));
            const busy = this.state.install?.state === 'running' || (this.state.available && this.state.pending > 0);
            this._timer = setTimeout(() => this.refresh(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
        },

        async install() {
            try {
                await window.App.API.post('/api/video-support/install', {});
            } catch (error) {
                const message = error?.message || '';
                const toast = window.App?.showToast || window.showToast;
                toast?.(t('video.installFailed', 'Video support was not installed: {reason}', { reason: message }), 'error');
            }
            this.refresh();
        },

        _noticeFinishedVideos() {
            const pending = Number(this.state?.pending || 0);
            if (this._lastPending !== null && pending < this._lastPending
                && typeof _refreshScanDrivenViews === 'function') {
                _refreshScanDrivenViews(true, { refreshGallery: true });
            }
            this._lastPending = pending;
        },

        statusText() {
            const s = this.state;
            if (!s) return t('video.statusChecking', 'Checking for ffmpeg...');
            const install = s.install || {};
            if (install.state === 'running') return this._progressText(install);
            if (install.state === 'failed') {
                const reason = window.apiErrorText({ code: install.error_code, params: install.error_params, message: install.error }, '');
                return t('video.statusFailed', 'The install failed: {reason}', { reason });
            }
            if (s.available) {
                const where = {
                    installed: t('video.sourceInstalled', 'installed in the program\'s data folder'),
                    beside_program: t('video.sourceBeside', 'found beside the program'),
                    path: t('video.sourcePath', 'found on your system PATH'),
                }[s.source] || '';
                const reading = s.pending ? t('video.statusReading', ' Reading {count} videos...', { count: s.pending }) : '';
                return t('video.statusReady', 'Ready: ffmpeg {where}.', { where }) + reading;
            }
            if (!s.can_install) {
                return t('video.statusNoBuild', 'Install ffmpeg with your package manager; videos are listed by name, size and date until then.');
            }
            return t('video.statusMissing', 'Not installed. Videos are listed by name, size and date only. The download comes from {from}; nothing else is sent.', { from: s.download_from });
        },

        _progressText(install) {
            if (install.phase === 'downloading' && install.total) {
                return t('video.statusDownloading', 'Downloading ffmpeg: {done} of {total} MB...', { done: mb(install.downloaded), total: mb(install.total) });
            }
            if (install.phase === 'unpacking') return t('video.statusUnpacking', 'Checking and unpacking ffmpeg...');
            return t('video.statusLooking', 'Looking up the newest ffmpeg build...');
        },

        _render() {
            const s = this.state || {};
            const running = s.install?.state === 'running';
            const statusEl = document.getElementById('settings-video-status');
            if (statusEl) statusEl.textContent = this.statusText();
            const button = document.getElementById('btn-video-install');
            if (button) {
                button.hidden = Boolean(s.available) || !s.can_install;
                button.disabled = running;
                button.textContent = s.install?.state === 'failed' ? t('video.tryAgain', 'Try again') : this.installLabel();
            }
            this._renderBanner(s, running);
        },

        _renderBanner(s, running) {
            const banner = document.getElementById('gallery-video-banner');
            if (!banner) return;
            let dismissed = false;
            try { dismissed = sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (_e) { dismissed = false; }
            const show = !dismissed && !s.available && Number(s.videos || 0) > 0;
            banner.hidden = !show;
            if (!show) return;
            document.getElementById('gallery-video-banner-title').textContent = t(
                'video.bannerTitle', '{count} videos have no frames or generation info yet', { count: s.videos },
            );
            const installState = s.install?.state;
            document.getElementById('gallery-video-banner-detail').textContent = installState === 'running' || installState === 'failed'
                ? this.statusText()
                : t('video.bannerDetail', 'Video support (ffmpeg) reads them. It downloads from {from}; nothing else is sent.', { from: s.download_from });
            const install = document.getElementById('gallery-video-banner-install');
            install.hidden = !s.can_install;
            install.disabled = running;
            document.getElementById('gallery-video-banner-install-label').textContent = s.install?.state === 'failed'
                ? t('video.tryAgain', 'Try again')
                : this.installLabel();
        },
    };

    window.VideoSupport = VideoSupport;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => VideoSupport.start());
    } else {
        VideoSupport.start();
    }
})();
