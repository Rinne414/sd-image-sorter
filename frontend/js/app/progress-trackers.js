/**
 * app/progress-trackers.js — app.js decomposition, stage 2 (leaf sections).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js,
 * pre-split lines 3072-3263. Classic script: shares ONE global lexical
 * environment with app.js and the other app/ parts; index.html loads
 * every app/ file BEFORE app.js, so these top-level declarations stay
 * visible there. No behavior change intended.
 */
function createProgressTracker(maxSamples = 12) {
    return {
        maxSamples,
        scopeKey: '',
        startedAt: null,
        samples: [],
        lastEtaSeconds: null,
    };
}

function resetProgressTracker(tracker) {
    if (!tracker) return;
    tracker.scopeKey = '';
    tracker.startedAt = null;
    tracker.samples = [];
    tracker.lastEtaSeconds = null;
}

function formatDurationCompact(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const secs = safeSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

function updateProgressTracker(tracker, completed, total, options = {}) {
    if (!tracker) return { elapsedText: '', etaText: '' };

    const safeCompleted = Math.max(0, Number(completed) || 0);
    const safeTotal = Math.max(0, Number(total) || 0);
    const scopeKey = String(options.scopeKey || '');
    const now = Date.now();

    if (tracker.scopeKey !== scopeKey) {
        tracker.scopeKey = scopeKey;
        tracker.startedAt = null;
        tracker.samples = [];
        tracker.lastEtaSeconds = null;
    }

    if (!tracker.startedAt && safeCompleted > 0) {
        tracker.startedAt = now;
    }

    if (tracker.startedAt) {
        tracker.samples.push({ time: now, completed: safeCompleted });
        if (tracker.samples.length > tracker.maxSamples) {
            tracker.samples.shift();
        }
    }

    const elapsedSeconds = tracker.startedAt ? Math.max(0, (now - tracker.startedAt) / 1000) : 0;
    let etaSeconds = null;
    if (options.showEta !== false && safeTotal > 0 && tracker.samples.length >= 3) {
        const first = tracker.samples[0];
        const last = tracker.samples[tracker.samples.length - 1];
        const completedDelta = last.completed - first.completed;
        const secondsDelta = (last.time - first.time) / 1000;
        if (completedDelta > 0 && secondsDelta > 0) {
            const rate = completedDelta / secondsDelta;
            const remaining = Math.max(0, safeTotal - safeCompleted);
            if (rate > 0 && remaining > 0) {
                etaSeconds = remaining / rate;
                if (tracker.lastEtaSeconds != null && Number.isFinite(tracker.lastEtaSeconds)) {
                    etaSeconds = (tracker.lastEtaSeconds * 0.65) + (etaSeconds * 0.35);
                }
                tracker.lastEtaSeconds = etaSeconds;
            }
        }
    }
    if (etaSeconds == null && safeTotal > 0 && safeCompleted >= safeTotal) {
        tracker.lastEtaSeconds = null;
    }

    return {
        elapsedSeconds,
        elapsedText: elapsedSeconds > 0 ? formatDurationCompact(elapsedSeconds) : '',
        etaSeconds,
        etaText: etaSeconds != null ? formatDurationCompact(etaSeconds) : '',
    };
}

function buildProgressText({
    progress = {},
    completed = 0,
    total = 0,
    tracker = null,
    defaultMessage = 'Processing...',
    primaryLabel = '',
}) {
    const meta = updateProgressTracker(tracker, completed, total);
    const parts = [];

    if (primaryLabel) parts.push(primaryLabel);
    if (total > 0) parts.push(`${completed}/${total}`);
    if (meta.etaText) parts.push(appT('progress.eta', 'ETA {time}').replace('{time}', meta.etaText));
    else if (meta.elapsedText) parts.push(appT('progress.elapsed', 'Elapsed {time}').replace('{time}', meta.elapsedText));

    const detail = progress.current_item || progress.message || defaultMessage;
    if (detail) parts.push(detail);

    return parts.join(' · ');
}

function buildOperationProgressText({
    completed = 0,
    total = 0,
    tracker = null,
    primaryLabel = '',
    extraParts = [],
    detail = '',
    defaultMessage = 'Processing...',
    showEta = true,
    progressKey = '',
}) {
    const meta = updateProgressTracker(tracker, completed, total, { showEta, scopeKey: progressKey });
    const parts = [];

    if (primaryLabel) parts.push(primaryLabel);
    if (total > 0) parts.push(`${completed}/${total}`);
    extraParts.filter(Boolean).forEach((part) => parts.push(part));
    if (showEta && meta.etaText) parts.push(appT('progress.eta', 'ETA {time}').replace('{time}', meta.etaText));
    else if (meta.elapsedText) parts.push(appT('progress.elapsed', 'Elapsed {time}').replace('{time}', meta.elapsedText));

    parts.push(detail || defaultMessage);
    return parts.join(' · ');
}

function lockDynamicI18nText(selector, fallbackKey = '') {
    const el = $(selector);
    if (!el) return;
    if (!el.dataset.i18nOriginal && (el.hasAttribute('data-i18n') || fallbackKey)) {
        el.dataset.i18nOriginal = el.getAttribute('data-i18n') || fallbackKey || '';
    }
    el.removeAttribute('data-i18n');
    el.dataset.i18nLocked = '1';
}

function unlockDynamicI18nText(selector, fallbackKey, fallbackText) {
    const el = $(selector);
    if (!el) return;
    const originalKey = el.dataset.i18nOriginal || fallbackKey || '';
    if (originalKey) {
        el.setAttribute('data-i18n', originalKey);
    }
    delete el.dataset.i18nLocked;
    el.textContent = originalKey ? appT(originalKey, fallbackText || originalKey) : (fallbackText || '');
}

function lockLiveProgressText(selector) {
    lockDynamicI18nText(selector);
}

function unlockLiveProgressText(selector, fallbackKey, fallbackText) {
    unlockDynamicI18nText(selector, fallbackKey, fallbackText);
}

function setScanCancelButtonState(mode = 'idle') {
    const button = $('#btn-cancel-scan');
    if (!button) return;

    if (!button.dataset.i18nOriginal && button.hasAttribute('data-i18n')) {
        button.dataset.i18nOriginal = button.getAttribute('data-i18n') || 'modal.cancel';
    }

    if (mode === 'running') {
        button.removeAttribute('data-i18n');
        button.dataset.liveLabel = '1';
        button.disabled = false;
        button.textContent = appT('scan.stopButton', 'Stop Scan');
        return;
    }

    if (mode === 'cancelling') {
        button.removeAttribute('data-i18n');
        button.dataset.liveLabel = '1';
        button.disabled = true;
        button.textContent = appT('scan.stoppingButton', 'Stopping...');
        return;
    }

    const originalKey = button.dataset.i18nOriginal || 'modal.cancel';
    button.setAttribute('data-i18n', originalKey);
    delete button.dataset.liveLabel;
    button.disabled = false;
    button.textContent = appT(originalKey, 'Cancel');
}

