/**
 * Whole-interface error fallback (owner baseline, docs/DESIGN.md
 * §redesign-2026-10): an error no part of the page caught is never silent.
 * A strip at the bottom says what failed, with Reload and Copy the error
 * (personal paths hidden). Loaded first, so it also covers a failed start.
 */
(function () {
    'use strict';

    var SHOW_EVERY_MS = 4000;
    var lastShownAt = 0;
    var lastText = '';

    function t(key, fallback) {
        var value = window.I18n && typeof window.I18n.t === 'function' ? window.I18n.t(key) : null;
        return value && value !== key ? value : fallback;
    }

    function hidePaths(text) {
        return String(text)
            .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>')
            .replace(/\/(?:home|Users|mnt|media)\/[^\s"'<>|]*/g, '<path>');
    }

    function reasonOf(error) {
        if (error && error.message) return error.message;
        return String(error || 'unknown');
    }

    function strip() {
        var el = document.getElementById('app-error-strip');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'app-error-strip';
        el.className = 'app-error-strip';
        el.setAttribute('role', 'alert');
        var text = document.createElement('span');
        text.className = 'app-error-strip-text';
        var reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'btn btn-primary btn-small';
        reload.addEventListener('click', function () { window.location.reload(); });
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-ghost btn-small';
        copy.addEventListener('click', function () {
            var body = lastText + '\n' + navigator.userAgent + '\n' + window.location.pathname;
            if (navigator.clipboard) navigator.clipboard.writeText(body).catch(function () {});
            copy.textContent = t('errorFallback.copied', 'Copied (paths hidden)');
        });
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-ghost btn-small';
        close.setAttribute('aria-label', t('common.close', 'Close'));
        close.textContent = '×';
        close.addEventListener('click', function () { el.hidden = true; });
        el.append(text, reload, copy, close);
        el.dataset.i18nLocked = '1';
        (document.body || document.documentElement).appendChild(el);
        return el;
    }

    function show(error) {
        if (error && error.name === 'AbortError') return;
        var now = Date.now();
        if (now - lastShownAt < SHOW_EVERY_MS) return;
        lastShownAt = now;
        lastText = hidePaths(reasonOf(error) + (error && error.stack ? '\n' + error.stack : ''));
        var el = strip();
        var buttons = el.querySelectorAll('button');
        el.querySelector('.app-error-strip-text').textContent =
            t('errorFallback.message', 'Something went wrong: {reason}. Your library and files were not touched; reloading usually fixes it.')
                .replace('{reason}', hidePaths(reasonOf(error)));
        buttons[0].textContent = t('errorFallback.reload', 'Reload');
        buttons[1].textContent = t('errorFallback.copy', 'Copy the error');
        el.hidden = false;
    }

    window.addEventListener('error', function (event) {
        // A missing image or stylesheet fires here too, without an error object: not ours to report.
        if (!event.error && !event.message) return;
        show(event.error || new Error(event.message));
    });
    window.addEventListener('unhandledrejection', function (event) { show(event.reason); });

    window.AppErrorFallback = { show: show, hidePaths: hidePaths };
})();
