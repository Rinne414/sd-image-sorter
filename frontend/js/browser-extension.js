/**
 * SD Image Sorter - Browser extension, the program's side.
 *
 * - Polls GET /api/browser-extension/state: a pairing request from the
 *   extension opens "Allow this browser extension?" here (a web page cannot
 *   answer it; the answer is POSTed from this page only), and when collected
 *   pictures finish importing the gallery refreshes itself.
 * - Settings > Browser extension: the folders to load the extension from
 *   (built by the program, with Copy and Open folder) and the paired browsers
 *   with Revoke.
 * The poll also tells the program which library this page shows, so pictures
 * from the extension land in it.
 */
(function () {
    'use strict';

    const VISIBLE_POLL_MS = 3000;
    const HIDDEN_POLL_MS = 15000;
    const SOON_MS = 1200;
    const BROWSER_LABELS = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox' };

    function t(key, fallback, params) {
        return typeof appT === 'function' ? appT(key, fallback, params) : fallback;
    }

    function toast(message, type) {
        window.App?.showToast?.(message, type);
    }

    function errorText(error, fallback) {
        return typeof formatUserError === 'function' ? formatUserError(error, fallback) : fallback;
    }

    function formatWhen(value) {
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function browserLabel(kind) {
        return BROWSER_LABELS[kind] || t('ext.browserOther', 'Browser');
    }

    /** "Chrome on this computer" already names its browser; say it only once. */
    function displayName(item) {
        const label = browserLabel(item.browser);
        return String(item.name || '').includes(label) ? item.name : `${item.name} (${label})`;
    }

    /** The extension's own address: chrome-extension://<id> or moz-extension://<uuid>. */
    function extensionId(item) {
        return item.origin ? String(item.origin).replace(/^[a-z-]+:\/\//i, '').replace(/\/$/, '') : '';
    }

    // Pairing prompt ---------------------------------------------------------------

    const Pairing = {
        current: null,
        dismissed: new Set(),

        offer(pending) {
            if (this.current) return;
            const request = (pending || []).find((item) => !this.dismissed.has(item.id));
            if (!request) return;
            this.current = request;
            document.getElementById('ext-pair-message').textContent = t(
                'ext.pairMessage',
                '"{name}" asks to save pictures into this program. Allow it only if you just pressed Pair in the extension.',
                { name: displayName(request) },
            );
            const id = extensionId(request);
            document.getElementById('ext-pair-id').textContent = id || t('ext.pairIdNone', 'unknown');
            document.getElementById('ext-pair-unknown').hidden = Boolean(id);
            document.getElementById('ext-pair-replaces').hidden = !request.replaces_existing;
            showModal('ext-pair-modal', { initialFocus: document.getElementById('btn-ext-pair-deny') });
        },

        async answer(allow) {
            const request = this.current;
            this.current = null;
            hideModal('ext-pair-modal');
            if (!request) return;
            this.dismissed.add(request.id);
            try {
                await window.App.API.post(`/api/browser-extension/pairings/${encodeURIComponent(request.id)}/decide`, { allow });
                toast(allow
                    ? t('ext.pairedToast', '{browser} is paired. Right-click a picture on a web page to save it here.', { browser: browserLabel(request.browser) })
                    : t('ext.deniedToast', 'Pairing refused. The extension cannot save pictures.'), allow ? 'success' : 'info');
                Settings.refreshPaired();
            } catch (error) {
                toast(errorText(error, t('ext.decideFailed', 'The answer could not be saved')), 'error');
            }
        },

        /** Closed with Escape or the backdrop: not answered; the extension can ask again. */
        watchClose() {
            const modal = document.getElementById('ext-pair-modal');
            new MutationObserver(() => {
                if (!modal.classList.contains('visible') && this.current) {
                    this.dismissed.add(this.current.id);
                    this.current = null;
                }
            }).observe(modal, { attributes: true, attributeFilter: ['class'] });
        },
    };

    // Polling ------------------------------------------------------------------------

    const Poller = {
        timer: null,
        generation: null,

        schedule(delay) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.poll(), delay ?? (document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS));
        },

        async poll() {
            const api = window.App?.API;
            if (!api?.get) {
                this.schedule();
                return;
            }
            try {
                const state = await api.get('/api/browser-extension/state');
                Pairing.offer(state.pending);
                this.applyCollect(state.collect || {});
            } catch (error) {
                window.Logger?.warn?.('Browser extension state could not be read', { error });
            }
            this.schedule();
        },

        applyCollect(collect) {
            const generation = Number(collect.generation || 0);
            const changed = this.generation !== null && generation !== this.generation;
            this.generation = generation;
            if (!changed) return;
            if (collect.last_error) toast(collect.last_error, 'error');
            if (typeof _refreshScanDrivenViews === 'function') {
                _refreshScanDrivenViews(true, { refreshGallery: true });
            }
        },
    };

    // Settings section -----------------------------------------------------------------

    const Settings = {
        folders: null,

        async load() {
            await Promise.all([this.loadFolders(), this.refreshPaired()]);
        },

        async loadFolders() {
            try {
                this.folders = await window.App.API.post('/api/browser-extension/install-folders', {});
                document.getElementById('settings-ext-chrome-path').textContent = this.folders.chrome;
                document.getElementById('settings-ext-firefox-path').textContent = this.folders.firefox;
            } catch (error) {
                toast(errorText(error, t('ext.foldersFailed', 'The extension folders could not be prepared')), 'error');
            }
        },

        async refreshPaired() {
            const list = document.getElementById('settings-ext-paired-list');
            if (!list) return;
            let paired = [];
            try {
                paired = (await window.App.API.get('/api/browser-extension/paired')).paired || [];
            } catch (error) {
                list.textContent = errorText(error, t('ext.pairedFailed', 'The paired browsers could not be read'));
                return;
            }
            list.textContent = '';
            if (!paired.length) {
                const empty = document.createElement('li');
                empty.className = 'ext-paired-empty';
                empty.textContent = t('ext.pairedNone', 'No browser is paired yet.');
                list.append(empty);
                return;
            }
            paired.forEach((item) => list.append(this.pairedRow(item)));
        },

        pairedRow(item) {
            const row = document.createElement('li');
            const name = document.createElement('span');
            name.className = 'ext-paired-name';
            name.textContent = displayName(item);
            const id = document.createElement('code');
            id.className = 'ext-paired-id';
            id.textContent = extensionId(item) || t('ext.pairIdNone', 'unknown');
            id.title = t('ext.pairedIdTitle', 'Extension ID: compare it with the browser\'s extensions page');
            const when = document.createElement('span');
            when.className = 'ext-paired-when';
            when.textContent = t('ext.pairedOn', 'paired {when}', { when: formatWhen(item.paired_at) });
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.className = 'btn btn-ghost btn-small danger';
            revoke.textContent = t('ext.revoke', 'Revoke');
            revoke.addEventListener('click', () => this.revoke(item, revoke));
            row.append(name, id, when, revoke);
            return row;
        },

        async revoke(item, button) {
            button.disabled = true;
            try {
                await window.App.API.delete(`/api/browser-extension/pairings/${encodeURIComponent(item.id)}`);
                toast(t('ext.revokedToast', '{name} can no longer save pictures here.', { name: item.name }), 'success');
            } catch (error) {
                toast(errorText(error, t('ext.revokeFailed', 'The pairing could not be revoked')), 'error');
            }
            this.refreshPaired();
        },

        async copy(target) {
            const path = this.folders?.[target];
            if (!path) return;
            try {
                await navigator.clipboard.writeText(path);
                toast(t('ext.pathCopied', 'Folder path copied'), 'success');
            } catch (_error) {
                toast(t('ext.copyFailed', 'The path could not be copied; select it and copy it by hand.'), 'error');
            }
        },

        async open(target) {
            try {
                await window.App.API.post('/api/browser-extension/open-folder', { browser: target });
            } catch (error) {
                toast(errorText(error, t('ext.openFailed', 'The folder could not be opened')), 'error');
            }
        },

        bind() {
            const panel = document.getElementById('settings-browser-ext');
            panel?.addEventListener('toggle', () => { if (panel.open) this.load(); });
            ['chrome', 'firefox'].forEach((target) => {
                document.getElementById(`btn-settings-ext-copy-${target}`)?.addEventListener('click', () => this.copy(target));
                document.getElementById(`btn-settings-ext-open-${target}`)?.addEventListener('click', () => this.open(target));
            });
        },
    };

    function init() {
        document.getElementById('btn-ext-pair-allow')?.addEventListener('click', () => Pairing.answer(true));
        document.getElementById('btn-ext-pair-deny')?.addEventListener('click', () => Pairing.answer(false));
        Pairing.watchClose();
        Settings.bind();
        document.addEventListener('visibilitychange', () => { if (!document.hidden) Poller.schedule(0); });
        window.addEventListener('focus', () => Poller.schedule(0));
        Poller.schedule(0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.BrowserExtension = {
        pokeSoon: () => Poller.schedule(SOON_MS),
        refreshSettings: () => Settings.load(),
    };
})();
