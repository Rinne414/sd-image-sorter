/**
 * Server watch: says so when the program's own server has stopped.
 *
 * With the page open and the backend gone, every request failed on its own and
 * most screens only logged it. This module watches for the one signal that
 * matters, a request to this page's own server that could not connect at all,
 * and then asks the server once whether it still answers. Only if that quick
 * check also fails does it show a single banner. While the banner is up it
 * checks again every few seconds and when the Retry button is pressed, and it
 * removes the banner when the server is back. There is no polling at any other
 * time: a healthy server is never asked anything extra.
 *
 * Public: ServerWatch.isNetworkFailure(error), ServerWatch.report(), and the
 * document event "server-watch:back" once the server answers again.
 */
(function () {
    'use strict';

    const PROBE_URL = '/api/updates/boot-id';
    const PROBE_TIMEOUT_MS = 3000;
    const RETRY_MS = 5000;
    const BANNER_ID = 'server-gone-banner';

    const nativeFetch = window.fetch.bind(window);
    let isChecking = false;
    let isDown = false;
    let retryTimer = 0;

    function t(key, fallback) {
        const value = window.I18n && window.I18n.t ? window.I18n.t(key) : null;
        return value && value !== key ? value : fallback;
    }

    /** A request that never reached any server (refused, reset, offline). */
    function isNetworkFailure(error) {
        if (!(error instanceof TypeError)) return false;
        return /failed to fetch|networkerror|load failed|network request failed/i.test(String(error.message || ''));
    }

    function isOwnServer(input) {
        try {
            const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
            return new URL(raw, window.location.href).origin === window.location.origin;
        } catch (_error) {
            return false;
        }
    }

    /** True when the server answers at all, whatever the answer says. */
    async function serverAnswers() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
            await nativeFetch(PROBE_URL, { cache: 'no-store', signal: controller.signal });
            return true;
        } catch (_error) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    function bannerText() {
        return t('server.gone',
            'The program stopped, so nothing can be loaded or saved right now. Open the program again; this message goes away when it is back.');
    }

    function renderBanner() {
        let banner = document.getElementById(BANNER_ID);
        if (!banner) {
            banner = document.createElement('div');
            banner.id = BANNER_ID;
            banner.className = 'server-gone-banner';
            banner.setAttribute('role', 'alert');
            const message = document.createElement('span');
            message.className = 'server-gone-message';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.id = 'btn-server-retry';
            retry.className = 'btn btn-small';
            retry.addEventListener('click', () => { void check(true); });
            banner.append(message, retry);
            document.body.appendChild(banner);
        }
        banner.querySelector('.server-gone-message').textContent = bannerText();
        banner.querySelector('button').textContent = t('server.retry', 'Try again');
    }

    function scheduleRetry() {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { void check(false); }, RETRY_MS);
    }

    async function check(manual) {
        if (isChecking) return;
        isChecking = true;
        try {
            if (await serverAnswers()) {
                if (isDown) {
                    isDown = false;
                    clearTimeout(retryTimer);
                    document.getElementById(BANNER_ID)?.remove();
                    window.App?.showToast?.(t('server.back', 'The program is back.'), 'success');
                    document.dispatchEvent(new CustomEvent('server-watch:back'));
                }
                return;
            }
            isDown = true;
            renderBanner();
            scheduleRetry();
            if (manual) window.A11y?.announce?.(bannerText(), 'assertive');
        } finally {
            isChecking = false;
        }
    }

    /** A request just failed to connect: find out whether the server is really gone. */
    function report() {
        if (isDown || isChecking) return;
        void check(false);
    }

    window.fetch = function watchedFetch(input, init) {
        const request = nativeFetch(input, init);
        request.catch((error) => {
            if (isNetworkFailure(error) && isOwnServer(input)) report();
        });
        return request;
    };

    document.addEventListener('languageChanged', () => {
        if (document.getElementById(BANNER_ID)) renderBanner();
    });

    window.ServerWatch = { isNetworkFailure, report };
})();
