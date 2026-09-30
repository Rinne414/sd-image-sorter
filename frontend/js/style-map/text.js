/** Text helpers shared by the Style Map modules: i18n through the app's appT. */

export function t(key, fallback, params) {
    const appT = window.appT;
    if (typeof appT === 'function') return appT(key, fallback, params);
    let text = fallback || key;
    for (const [name, value] of Object.entries(params || {})) {
        text = String(text).split(`{${name}}`).join(String(value));
    }
    return text;
}

export function formatError(error) {
    const fmt = window.formatUserError;
    if (typeof fmt === 'function') return fmt(error);
    return String(error?.detail || error?.message || error || '');
}

/** "2m 05s" style remaining time from a millisecond estimate. */
export function formatRemaining(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
