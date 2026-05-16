/**
 * Gallery banner that surfaces unreadable / moved-file rows so the user can
 * reach the existing Find Moved Files flow without hunting for it.
 *
 * Design:
 * - Stays hidden when there are zero unreadable rows.
 * - Polls /api/library-health every time the gallery view becomes active,
 *   with a 60s cache so we do not spam the backend during normal browsing.
 * - "Hide for now" only hides until the next page load (sessionStorage).
 *   We deliberately do not persist a permanent dismissal — if files really
 *   are missing, the user needs to know.
 */
(function () {
    'use strict';

    var SESSION_KEY = 'sd-image-sorter:unreadable-banner-dismissed';
    var CACHE_MS = 60 * 1000;

    var state = {
        cachedAt: 0,
        cachedCount: null,
        inFlight: null
    };

    function $(selector) {
        return document.querySelector(selector);
    }

    function appT(key, fallback, params) {
        var t = window.I18n && typeof window.I18n.t === 'function'
            ? window.I18n.t(key, params)
            : null;
        if (t && t !== key) return t;
        if (typeof fallback === 'string') {
            if (params && typeof params === 'object') {
                return fallback.replace(/\{(\w+)\}/g, function (_, name) {
                    return Object.prototype.hasOwnProperty.call(params, name)
                        ? String(params[name])
                        : '{' + name + '}';
                });
            }
            return fallback;
        }
        return key;
    }

    function isDismissedThisSession() {
        try {
            return window.sessionStorage.getItem(SESSION_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function markDismissedForSession() {
        try {
            window.sessionStorage.setItem(SESSION_KEY, '1');
        } catch (e) {
            /* noop — sessionStorage may be disabled */
        }
    }

    function setBannerCount(count) {
        var banner = $('#gallery-unreadable-banner');
        if (!banner) return;
        var titleEl = $('#gallery-unreadable-banner-title');
        if (titleEl) {
            titleEl.textContent = appT(
                'reconnect.banner.title',
                '{count} image(s) cannot be opened — their original files are missing.',
                { count: count }
            );
        }
    }

    function showBanner(count) {
        var banner = $('#gallery-unreadable-banner');
        if (!banner) return;
        if (isDismissedThisSession()) return;
        setBannerCount(count);
        banner.hidden = false;
    }

    function hideBanner() {
        var banner = $('#gallery-unreadable-banner');
        if (!banner) return;
        banner.hidden = true;
    }

    async function fetchUnreadableCount(force) {
        var now = Date.now();
        if (!force && state.cachedCount !== null && (now - state.cachedAt) < CACHE_MS) {
            return state.cachedCount;
        }
        if (state.inFlight) return state.inFlight;

        state.inFlight = (async function () {
            try {
                var api = window.App && window.App.API;
                var data = api && typeof api.get === 'function'
                    ? await api.get('/api/library-health?sample_limit=1')
                    : await fetch('/api/library-health?sample_limit=1').then(function (r) {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.json();
                    });
                var count = 0;
                if (data && data.issue_counts && typeof data.issue_counts.unreadable === 'number') {
                    count = data.issue_counts.unreadable;
                } else if (data && data.summary && typeof data.summary.unreadable === 'number') {
                    count = data.summary.unreadable;
                }
                state.cachedCount = count;
                state.cachedAt = Date.now();
                return count;
            } catch (e) {
                // Soft-fail: never break gallery just because the audit failed.
                return state.cachedCount !== null ? state.cachedCount : 0;
            } finally {
                state.inFlight = null;
            }
        })();
        return state.inFlight;
    }

    async function refresh(force) {
        var count = await fetchUnreadableCount(force);
        if (count > 0) {
            showBanner(count);
        } else {
            hideBanner();
        }
    }

    function bind() {
        var cta = $('#gallery-unreadable-banner-cta');
        if (cta && !cta.dataset.bound) {
            cta.dataset.bound = '1';
            cta.addEventListener('click', function () {
                var openModal = window.App && window.App.showModal
                    ? window.App.showModal
                    : window.showModal;
                if (typeof openModal === 'function') {
                    openModal('reconnect-modal');
                } else {
                    var trigger = $('#btn-reconnect-missing');
                    if (trigger) trigger.click();
                }
            });
        }

        var dismiss = $('#gallery-unreadable-banner-dismiss');
        if (dismiss && !dismiss.dataset.bound) {
            dismiss.dataset.bound = '1';
            dismiss.addEventListener('click', function () {
                markDismissedForSession();
                hideBanner();
                if (window.showToast) {
                    window.showToast(appT('reconnect.banner.dismissed', 'Banner hidden. Reopen the gallery to see it again.'), 'info');
                }
            });
        }

        document.addEventListener('languageChanged', function () {
            if (state.cachedCount !== null && state.cachedCount > 0) {
                setBannerCount(state.cachedCount);
            }
        });
    }

    function init() {
        if (!$('#gallery-unreadable-banner')) return;
        bind();
        // Initial check after first paint, with a small delay so we do not
        // contend with the first /api/images load.
        setTimeout(function () { refresh(false); }, 1500);
    }

    window.UnreadableBanner = {
        init: init,
        refresh: refresh,
        invalidate: function () {
            state.cachedCount = null;
            state.cachedAt = 0;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
