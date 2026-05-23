/**
 * Tag completion notification (v3.2.2 T-power-PR3 / G).
 *
 * Two-layer reliability strategy because browser notifications are
 * flaky:
 *
 *   1. **In-tab favicon blink + title flash** — works on every browser,
 *      no permission required. Activates when the user has the tab
 *      backgrounded (document.visibilityState === 'hidden').
 *
 *   2. **Web Notifications API** — only when the user explicitly
 *      enables it via the Tag modal toggle (which triggers
 *      Notification.requestPermission). We never auto-request on first
 *      load because that's the "never granted" funnel.
 *
 * Public API:
 *   TagCompleteNotify.fireOnDone(message, level)
 *   TagCompleteNotify.requestEnable() -> Promise<'granted'|'denied'|'default'>
 *   TagCompleteNotify.isEnabled() -> bool
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'sd-image-sorter-tag-notify-enabled';

    function isPermissionGranted() {
        return typeof Notification !== 'undefined' && Notification.permission === 'granted';
    }

    function isUserOptedIn() {
        try { return localStorage.getItem(STORAGE_KEY) === '1'; }
        catch { return false; }
    }

    function isEnabled() {
        return isPermissionGranted() && isUserOptedIn();
    }

    async function requestEnable() {
        if (typeof Notification === 'undefined') {
            return 'unsupported';
        }
        // Already granted? Just persist the opt-in.
        if (Notification.permission === 'granted') {
            try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
            return 'granted';
        }
        if (Notification.permission === 'denied') {
            // Browser blocked — nothing we can do.
            return 'denied';
        }
        try {
            const result = await Notification.requestPermission();
            if (result === 'granted') {
                try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
            }
            return result;
        } catch (e) {
            return 'denied';
        }
    }

    function disable() {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }

    // -------- Layer 1: title + favicon blink --------

    let _blinkTimer = null;
    const _originalTitle = document.title;
    const _originalFavicon = (() => {
        const link = document.querySelector('link[rel="icon"]');
        return link ? link.getAttribute('href') : '';
    })();

    function _setFaviconRedDot(enable) {
        // SVG with a red badge so the user notices in the tab bar.
        const link = document.querySelector('link[rel="icon"]');
        if (!link) return;
        if (enable) {
            const svg = `data:image/svg+xml;utf8,${encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
                '<rect width="100" height="100" fill="%23222"/>' +
                '<circle cx="72" cy="28" r="20" fill="%23ef4444"/>' +
                '</svg>'
            )}`;
            link.setAttribute('href', svg);
        } else if (_originalFavicon) {
            link.setAttribute('href', _originalFavicon);
        }
    }

    function _startBlink(message) {
        if (document.visibilityState !== 'hidden') return;  // user already looking
        _stopBlink();
        let on = false;
        _setFaviconRedDot(true);
        _blinkTimer = setInterval(() => {
            on = !on;
            document.title = on ? `✅ ${message}` : _originalTitle;
        }, 800);
        // Stop blinking the moment the user looks at the tab again.
        const stopOnVisible = () => {
            if (document.visibilityState === 'visible') {
                _stopBlink();
                document.removeEventListener('visibilitychange', stopOnVisible);
            }
        };
        document.addEventListener('visibilitychange', stopOnVisible);
    }

    function _stopBlink() {
        if (_blinkTimer) {
            clearInterval(_blinkTimer);
            _blinkTimer = null;
        }
        document.title = _originalTitle;
        _setFaviconRedDot(false);
    }

    // -------- Layer 2: Web Notifications API --------

    function _fireWebNotification(title, body) {
        try {
            const n = new Notification(title, {
                body: body || '',
                icon: _originalFavicon || undefined,
                tag: 'sd-image-sorter-tag-done',  // dedupes back-to-back runs
                renotify: false,
            });
            n.onclick = () => {
                window.focus();
                n.close();
            };
        } catch (e) {
            // Some browsers throw in iframes / insecure contexts. Silent fail.
        }
    }

    // -------- Public --------

    function fireOnDone(message, level) {
        const text = String(message || 'Tagging complete');
        // Always layer 1: title flash if hidden.
        _startBlink(text);
        // Layer 2: only if user opted in AND permission granted.
        if (isEnabled() && document.visibilityState === 'hidden') {
            _fireWebNotification(
                level === 'error' ? 'Tagging failed' : 'Tagging complete',
                text,
            );
        }
    }

    window.TagCompleteNotify = {
        fireOnDone,
        requestEnable,
        disable,
        isEnabled,
        isPermissionGranted,
    };
})();
