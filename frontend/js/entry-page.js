/**
 * Entry page — v4.0 Aurora shell, Phase 2 (spec: canvas #11a + #12a flow map).
 *
 * Behaviors:
 * - Shown at launch unless the 跳过入口页 setting is on (localStorage).
 * - Pure overlay: the app underneath stays mounted, so returning to the entry
 *   via ESC never loses view state ("Esc 永远回上一级且不丢进度").
 * - Every tile is a shortcut into an existing view (missions are shortcuts,
 *   never cages); navigation reuses the nav-tab click bindings.
 * - Daily ★5 hero with 换一张 (seed re-roll) and 不想展示 (persistent off).
 */
(function () {
    'use strict';

    const SKIP_KEY = 'aurora-entry-skip';
    const HERO_OFF_KEY = 'aurora-entry-hero-off';
    const HERO_SEED_KEY = 'aurora-entry-hero-seed';
    const LAST_SEEN_KEY = 'aurora-entry-last-seen';

    const PROMPT_TEXTURE_MAX_CHARS = 90;
    const CLOCK_TICK_MS = 30 * 1000;

    const state = {
        visible: false,
        summary: null,
        clockTimer: null,
    };

    function t(key, params, fallback) {
        const value = window.I18n && window.I18n.t ? window.I18n.t(key, params) : null;
        if (value && value !== key) return value;
        let text = fallback || key;
        Object.entries(params || {}).forEach(([name, val]) => {
            text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), String(val));
        });
        return text;
    }

    async function api(path) {
        try {
            const response = await fetch(path);
            if (!response.ok) return null;
            return await response.json();
        } catch (error) {
            if (window.Logger) Logger.warn('Entry fetch failed:', path, error);
            return null;
        }
    }

    function el(id) {
        return document.getElementById(id);
    }

    function isSkipped() {
        try {
            if (new URLSearchParams(window.location.search).has('skip-entry')) return true;
            return localStorage.getItem(SKIP_KEY) === '1';
        } catch (error) {
            return true;
        }
    }

    function isHeroOff() {
        try { return localStorage.getItem(HERO_OFF_KEY) === '1'; } catch (e) { return true; }
    }

    function heroSeed() {
        try { return Math.max(0, parseInt(localStorage.getItem(HERO_SEED_KEY), 10) || 0); } catch (e) { return 0; }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function renderHero(hero) {
        const bg = el('entry-hero');
        const credit = el('entry-hero-credit');
        const swap = el('entry-hero-swap');
        const hide = el('entry-hero-hide');
        const texture = el('entry-prompt-texture');
        if (!bg || !credit) return;

        if (isHeroOff() || !hero) {
            bg.style.backgroundImage = '';
            texture.textContent = '';
            credit.textContent = t('entry.heroEmpty', {}, 'Rate an image ★5 and it becomes the cover here');
            swap.hidden = true;
            hide.hidden = true;
            return;
        }

        bg.style.backgroundImage = `url("/api/image-file/${hero.id}")`;
        credit.textContent = t('entry.heroCredit', { filename: hero.filename }, "Today's cover: {filename} · ★5");
        swap.hidden = hero.pool <= 1;
        hide.hidden = false;

        api(`/api/images/${hero.id}`).then((image) => {
            if (!texture || !state.visible) return;
            const prompt = (image && image.prompt) ? String(image.prompt) : '';
            texture.textContent = prompt ? prompt.slice(0, PROMPT_TEXTURE_MAX_CHARS) : '';
        });
    }

    function renderSummary(summary) {
        if (!summary) return;
        state.summary = summary;

        const galleryCount = el('entry-count-gallery');
        if (galleryCount) galleryCount.textContent = String(summary.library_total ?? '');
        const gallerySub = el('entry-sub-gallery');
        if (gallerySub) {
            const added = Number(summary.added_today || 0);
            const unviewed = Number(summary.unviewed || 0);
            gallerySub.textContent = (added > 0 || unviewed > 0)
                ? t('entry.tileGallerySub', { added, unviewed }, '{added} new today · {unviewed} not seen yet')
                : t('entry.tileGallerySubQuiet', {}, 'Browse, filter, and pick images');
        }

        const streakNum = el('entry-streak-num');
        if (streakNum) streakNum.textContent = String(summary.streak_days || 0);
        const streakToday = el('entry-streak-today');
        if (streakToday) {
            const touched = Number(summary.today_touched || 0);
            streakToday.textContent = touched > 0
                ? t('entry.todayTouched', { count: touched }, '· {count} images handled today')
                : '';
        }

        renderHero(summary.hero);
    }

    function renderSortSession(session) {
        const anchor = el('entry-anchor');
        const organizeTile = el('entry-mission-organize');
        const sortCount = el('entry-count-sort');
        const sortSub = el('entry-sub-sort');
        const resumable = Boolean(
            session && !session.done && (session.image || session.champion)
        );

        if (sortCount) sortCount.textContent = resumable ? String(session.remaining ?? '') : '';
        if (sortSub) {
            sortSub.textContent = resumable
                ? t('entry.tileSortSub', {}, 'Left from last time · pick it back up')
                : t('entry.tileSortIdle', {}, 'Sort a batch with WASD');
        }

        if (!anchor) return;
        if (!resumable) {
            anchor.hidden = true;
            if (organizeTile) organizeTile.hidden = false;
            return;
        }

        // The anchor absorbs its parent mission's tile (批量整理 hosts manual sort).
        anchor.hidden = false;
        if (organizeTile) organizeTile.hidden = true;

        const total = Number(session.total || 0);
        const remaining = Number(session.remaining || 0);
        const done = Math.max(0, total - remaining);
        el('entry-anchor-title').textContent = t('entry.continueSortTitle', {}, 'Manual Sort');
        el('entry-anchor-detail').textContent = t('entry.continueSortDetail', { remaining }, '{remaining} images left');
        el('entry-anchor-count').textContent = `${done} / ${total}`;
        el('entry-anchor-fill').style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
        el('entry-anchor-when').textContent = '';
    }

    function formatBytes(bytes) {
        const size = Number(bytes || 0);
        if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(1)}G`;
        return `${Math.round(size / (1024 * 1024))}M`;
    }

    function renderClock() {
        const clock = el('entry-sys-clock');
        if (!clock) return;
        const now = new Date();
        clock.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }

    function renderSystemLine() {
        renderClock();

        api('/api/tag/progress').then((progress) => {
            const slot = el('entry-sys-tagging');
            if (!slot) return;
            const running = progress && (progress.status === 'running' || progress.status === 'starting');
            if (running && Number(progress.total) > 0) {
                const percent = Math.round((Number(progress.current || 0) / Number(progress.total)) * 100);
                slot.textContent = '';
                const bar = document.createElement('span');
                bar.className = 'sys-accent';
                bar.textContent = '▍';
                slot.appendChild(bar);
                slot.appendChild(document.createTextNode(
                    t('entry.sysTagging', { percent }, 'Tagging {percent}%')
                ));
                slot.hidden = false;
            } else {
                slot.hidden = true;
            }
        });

        api('/api/disk/cache-status').then((status) => {
            const slot = el('entry-sys-cache');
            if (!slot) return;
            const total = status && (status.total_bytes ?? status.total_size_bytes);
            if (total != null) {
                slot.textContent = t('entry.sysCache', { size: formatBytes(total) }, 'Cache {size}');
                slot.hidden = false;
            }
        });

        api('/api/system-info').then((info) => {
            const slot = el('entry-sys-vram');
            if (!slot || !info) return;
            const total = Number(info.gpu_vram_total_mb || 0);
            const available = Number(info.gpu_vram_available_mb || 0);
            if (total > 0 && available >= 0) {
                const used = ((total - available) / 1024).toFixed(1);
                const cap = (total / 1024).toFixed(1);
                slot.textContent = t('entry.sysVram', { used, total: cap }, 'VRAM {used}/{total}');
                slot.hidden = false;
            }
        });
    }

    async function render() {
        const versionEl = el('entry-version');
        const brandVersion = document.getElementById('brand-version');
        if (versionEl && brandVersion) versionEl.textContent = brandVersion.textContent || '';

        renderSystemLine();

        let lastSeen = null;
        try { lastSeen = localStorage.getItem(LAST_SEEN_KEY); } catch (e) { /* ignore */ }
        const query = new URLSearchParams();
        if (lastSeen) query.set('last_seen', lastSeen);
        query.set('hero_seed', String(heroSeed()));

        const [summary, session] = await Promise.all([
            api(`/api/entry/summary?${query.toString()}`),
            api('/api/sort/current'),
        ]);
        renderSummary(summary);
        renderSortSession(session);
    }

    // ------------------------------------------------------------------
    // Visibility & navigation
    // ------------------------------------------------------------------

    function show() {
        const page = el('entry-page');
        if (!page) return;
        page.hidden = false;
        document.body.classList.add('entry-active');
        state.visible = true;
        render();
        renderClock();
        if (!state.clockTimer) state.clockTimer = setInterval(renderClock, CLOCK_TICK_MS);
    }

    function hide() {
        const page = el('entry-page');
        if (!page) return;
        page.hidden = true;
        document.body.classList.remove('entry-active');
        state.visible = false;
        if (state.clockTimer) {
            clearInterval(state.clockTimer);
            state.clockTimer = null;
        }
    }

    function navigate(view) {
        if (view === 'gallery' && state.summary && state.summary.server_now) {
            // The user is about to lay eyes on the library: advance the
            // "还没看过" watermark.
            try { localStorage.setItem(LAST_SEEN_KEY, state.summary.server_now); } catch (e) { /* ignore */ }
        }
        hide();
        const tab = document.getElementById(`nav-tab-${view}`);
        if (tab) tab.click();
    }

    // ------------------------------------------------------------------
    // Settings toggles (跳过入口页 / ★5 门面)
    // ------------------------------------------------------------------

    function refreshSettingsButtons() {
        const entryBtn = el('btn-settings-entry-toggle');
        if (entryBtn) {
            const shown = !((localStorage.getItem(SKIP_KEY) || '') === '1');
            entryBtn.setAttribute('aria-pressed', String(shown));
            const label = el('settings-entry-label');
            if (label) {
                label.textContent = shown
                    ? t('settings.entryOn', {}, 'Shown')
                    : t('settings.entryOff', {}, 'Skipped');
            }
        }
        const heroBtn = el('btn-settings-entry-hero-toggle');
        if (heroBtn) {
            const shown = !isHeroOff();
            heroBtn.setAttribute('aria-pressed', String(shown));
            const label = el('settings-entry-hero-label');
            if (label) {
                label.textContent = shown
                    ? t('settings.entryHeroOn', {}, 'Shown')
                    : t('settings.entryHeroOff', {}, 'Hidden');
            }
        }
    }

    function wireSettings() {
        const entryBtn = el('btn-settings-entry-toggle');
        if (entryBtn) {
            entryBtn.addEventListener('click', () => {
                const skipped = (localStorage.getItem(SKIP_KEY) || '') === '1';
                try { localStorage.setItem(SKIP_KEY, skipped ? '0' : '1'); } catch (e) { /* ignore */ }
                refreshSettingsButtons();
            });
        }
        const heroBtn = el('btn-settings-entry-hero-toggle');
        if (heroBtn) {
            heroBtn.addEventListener('click', () => {
                try { localStorage.setItem(HERO_OFF_KEY, isHeroOff() ? '0' : '1'); } catch (e) { /* ignore */ }
                refreshSettingsButtons();
                if (state.visible && state.summary) renderHero(state.summary.hero);
            });
        }
        refreshSettingsButtons();
    }

    // ------------------------------------------------------------------
    // ESC-to-entry ("任意步骤 ESC 回入口，进度自动保存" — #12a)
    // ------------------------------------------------------------------

    const OVERLAY_SELECTOR = [
        '.modal.visible',
        '.dataset-modal:not([hidden])',
        '.image-workspace.visible',
        '#onboarding-overlay:not([hidden])',
        '.guide-overlay.visible',
        '.update-popup.visible',
    ].join(', ');

    function editingTarget(target) {
        if (!target) return false;
        const tag = (target.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
    }

    function onKeydownCapture(event) {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (state.visible || isSkipped()) return;
        if (editingTarget(document.activeElement)) return;
        // Any visible modal / overlay owns this ESC (checked in capture phase,
        // BEFORE its own handler closes it — otherwise we would misread the
        // post-close state and jump home on the same keypress).
        if (document.querySelector(OVERLAY_SELECTOR)) return;
        show();
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------

    function wire() {
        const clicks = {
            'entry-mission-lora': () => navigate('dataset'),
            'entry-mission-pixiv': () => navigate('gallery'),
            'entry-mission-organize': () => navigate('sorting'),
            'entry-anchor-continue': () => navigate('sorting'),
            'entry-fn-gallery': () => navigate('gallery'),
            'entry-fn-sort': () => navigate('sorting'),
            'entry-fn-censor': () => navigate('censor'),
            'entry-fn-reader': () => navigate('reader'),
            'entry-fn-similar': () => navigate('similar'),
            'entry-free-mode': () => navigate('gallery'),
            'entry-all-tools': () => navigate('gallery'),
        };
        Object.entries(clicks).forEach(([id, handler]) => {
            const node = el(id);
            if (node) node.addEventListener('click', handler);
        });

        const settingsBtn = el('entry-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                const opener = document.getElementById('btn-open-model-manager');
                if (opener) opener.click();
            });
        }

        const swap = el('entry-hero-swap');
        if (swap) {
            swap.addEventListener('click', async () => {
                try { localStorage.setItem(HERO_SEED_KEY, String((heroSeed() + 1) % 1000000)); } catch (e) { /* ignore */ }
                const summary = await api(`/api/entry/summary?hero_seed=${heroSeed()}`);
                if (summary) {
                    state.summary = { ...(state.summary || {}), hero: summary.hero };
                    renderHero(summary.hero);
                }
            });
        }

        const hideLink = el('entry-hero-hide');
        if (hideLink) {
            hideLink.addEventListener('click', () => {
                try { localStorage.setItem(HERO_OFF_KEY, '1'); } catch (e) { /* ignore */ }
                refreshSettingsButtons();
                renderHero(null);
            });
        }

        wireSettings();
        document.addEventListener('keydown', onKeydownCapture, true);
    }

    function boot() {
        wire();
        if (!isSkipped()) show();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.EntryPage = { show, hide, render };
})();
