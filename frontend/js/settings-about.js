/**
 * Settings > About (classic): the version, Check for updates, and the two
 * support actions (copy diagnostics, open the log folder). Before this the
 * support actions were reachable only from the card a stalled import shows.
 * The buttons reuse the top bar's update button and the import diagnostics
 * functions (scan-diagnostics.js), so all three behave the same everywhere.
 */
(function () {
    'use strict';

    const el = (id) => document.getElementById(id);

    function t(key, fallback, params) {
        const value = window.I18n?.t?.(key, params);
        if (value && value !== key) return value;
        return typeof window.I18n?.format === 'function' ? window.I18n.format(fallback, params) : fallback;
    }

    async function currentVersion() {
        const known = window.App?.AppState?.appVersion;
        if (known) return known;
        try {
            const response = await fetch('/api/stats', { headers: { Accept: 'application/json' } });
            return response.ok ? (await response.json())?.app_version || '' : '';
        } catch (_error) {
            return '';
        }
    }

    async function showVersion() {
        const node = el('settings-about-version');
        if (!node) return;
        const version = await currentVersion();
        node.textContent = version
            ? t('settings.aboutVersion', 'Version {version}', { version })
            : t('settings.aboutVersionUnknown', 'Version unknown');
    }

    function checkForUpdates() {
        // The top bar's update button owns the check and its popup; close
        // Settings so the popup is not under the dialog.
        if (typeof hideModal === 'function') hideModal('model-manager-modal');
        el('btn-app-update')?.click();
    }

    function bind() {
        el('btn-settings-check-update')?.addEventListener('click', checkForUpdates);
        el('btn-settings-copy-diagnostics')?.addEventListener('click', () => {
            if (typeof copyScanDiagnostics === 'function') copyScanDiagnostics();
        });
        el('btn-settings-open-log')?.addEventListener('click', () => {
            if (typeof openScanLogFile === 'function') openScanLogFile();
        });
        el('btn-open-model-manager')?.addEventListener('click', showVersion);
        document.addEventListener('languageChanged', showVersion);
        showVersion();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
