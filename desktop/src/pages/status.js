'use strict';

// Start-up and error page of the desktop shell. Text comes from the main
// process in the query string (desktop/src/strings.js), already translated.
(function () {
    const params = new URLSearchParams(window.location.search);
    document.documentElement.lang = params.get('lang') || 'en';
    document.getElementById('status-title').textContent = params.get('title') || '';
    document.getElementById('status-detail').textContent = params.get('detail') || '';
    const log = params.get('log') || '';
    const logBox = document.getElementById('status-log');
    if (log) {
        logBox.textContent = log;
        logBox.hidden = false;
        logBox.scrollTop = logBox.scrollHeight;
    }
    if (params.get('actions') === '1' && window.sdDesktop) {
        const retry = document.getElementById('status-retry');
        const openLog = document.getElementById('status-open-log');
        retry.textContent = params.get('retry') || 'Try again';
        openLog.textContent = params.get('openLog') || 'Open log folder';
        retry.addEventListener('click', () => window.sdDesktop.retryStart());
        openLog.addEventListener('click', () => window.sdDesktop.openLogFolder());
        document.getElementById('status-actions').hidden = false;
    }
})();
