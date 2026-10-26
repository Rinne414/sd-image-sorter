/**
 * gallery/video-cards.js - video cards in the gallery grid.
 *
 * A video card keeps the normal thumbnail (a frame ffmpeg grabbed) and adds a
 * duration badge. Hovering it plays the original file muted and looped in
 * place; moving the mouse across the card scrubs (left edge = start, right
 * edge = end). This needs no extra files or ffmpeg work: AIGC clips are short
 * and local, so the browser streams them instantly with HTTP Range. A codec
 * the browser cannot play (ProRes ...) keeps the still frame.
 *
 * Classic script: joins window.Gallery (gallery/base.js loads first).
 */
(function () {
    'use strict';

    const HOVER_DELAY_MS = 160;
    const NON_BROWSER_CODECS = new Set(['prores', 'dnxhd', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'mjpeg', 'rawvideo', 'ffv1', 'cfhd']);

    function t(key, fallback, params) {
        const value = window.I18n.t(key, params);
        return value && value !== key ? value : window.I18n.format(fallback, params);
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const secs = String(total % 60).padStart(2, '0');
        return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
    }

    function badgeText(image) {
        if (image.duration_seconds) return formatDuration(image.duration_seconds);
        if (image.video_probe_state === 'unreadable') return t('video.badgeUnreadable', 'Video, unreadable');
        return t('video.badge', 'Video');
    }

    function canPreviewInBrowser(codec) {
        return !codec || !NON_BROWSER_CODECS.has(String(codec).toLowerCase());
    }

    const hover = {
        card: null,
        video: null,
        bar: null,
        timer: null,

        start(card) {
            if (this.card === card) return;
            this.stop();
            if (!canPreviewInBrowser(card.dataset.videoCodec)) return;
            this.card = card;
            this.timer = setTimeout(() => this._mount(card), HOVER_DELAY_MS);
        },

        _mount(card) {
            if (this.card !== card || !card.isConnected) return;
            const host = card.querySelector('.gallery-item-media') || card;
            const video = document.createElement('video');
            video.className = 'gallery-video-hover';
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.setAttribute('aria-hidden', 'true');
            video.src = `/api/image-file/${card.dataset.id}`;
            video.addEventListener('playing', () => card.classList.add('is-video-playing'));
            video.addEventListener('error', () => this.stop());
            const bar = document.createElement('span');
            bar.className = 'gallery-video-scrub';
            bar.setAttribute('aria-hidden', 'true');
            video.addEventListener('timeupdate', () => this._paint());
            host.append(video, bar);
            this.video = video;
            this.bar = bar;
            video.play().catch(() => {});
        },

        scrub(event) {
            const video = this.video;
            if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
            const rect = this.card.getBoundingClientRect();
            const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
            video.currentTime = fraction * video.duration;
            this._paint();
        },

        _paint() {
            const video = this.video;
            if (!video || !this.bar || !(video.duration > 0)) return;
            this.bar.style.setProperty('--scrub', `${(video.currentTime / video.duration) * 100}%`);
        },

        stop() {
            clearTimeout(this.timer);
            this.timer = null;
            if (this.video) {
                this.video.pause();
                this.video.removeAttribute('src');
                this.video.load();
                this.video.remove();
            }
            this.bar?.remove();
            this.card?.classList.remove('is-video-playing');
            this.card = null;
            this.video = null;
            this.bar = null;
        },
    };

    function bindHover() {
        document.addEventListener('pointerover', (event) => {
            if (event.pointerType && event.pointerType !== 'mouse') return;
            const card = event.target.closest?.('.gallery-item.is-video');
            if (card) hover.start(card);
        });
        document.addEventListener('pointerout', (event) => {
            if (!hover.card) return;
            const next = event.relatedTarget;
            if (next && hover.card.contains(next)) return;
            if (event.target.closest?.('.gallery-item.is-video') === hover.card) hover.stop();
        });
        document.addEventListener('pointermove', (event) => {
            if (hover.card && hover.card.contains(event.target)) hover.scrub(event);
        });
        window.addEventListener('blur', () => hover.stop());
    }

    Object.assign(window.Gallery, {
        _decorateVideoCard(item, image) {
            if (image?.media_type !== 'video') return;
            item.classList.add('is-video');
            item.dataset.videoCodec = image.video_codec || '';
            const host = item.querySelector('.gallery-item-media') || item;
            const badge = document.createElement('span');
            badge.className = 'gallery-video-badge';
            badge.textContent = badgeText(image);
            badge.title = t('video.badgeTitle', 'Video: hover to play, move the mouse to scrub');
            host.appendChild(badge);
            const label = item.getAttribute('aria-label') || '';
            item.setAttribute('aria-label', `${label} - ${t('video.badge', 'Video')} ${badge.textContent}`);
        },
    });

    window.VideoCards = { formatDuration, canPreviewInBrowser, stopHover: () => hover.stop() };
    bindHover();
})();
