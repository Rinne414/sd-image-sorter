/**
 * @fileoverview Toast notification component
 * @module components/toast
 */

// Use global DOM functions (loaded from dom.js)
// Assumes window.$ is available

/**
 * @typedef {'success'|'error'|'info'|'warning'} ToastType
 */

/**
 * Default icons for toast types
 * @constant {Object<ToastType, string>}
 */
const TOAST_ICONS = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠'
};

/**
 * Default duration for toast display (ms)
 * @constant {number}
 */
const DEFAULT_DURATION = 3000;

/**
 * Ensure toast container exists
 * @returns {Element} Toast container element
 */
function ensureContainer() {
    let container = window.$ ? window.$('#toast-container') : document.getElementById('toast-container');

    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    return container;
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {ToastType} [type='info'] - Toast type (success, error, info, warning)
 * @param {Object} [options={}] - Toast options
 * @param {number} [options.duration] - Duration in ms (default 3000)
 * @param {string} [options.icon] - Custom icon
 * @returns {Element} Toast element
 */
function showToast(message, type = 'info', options = {}) {
    const container = ensureContainer();
    const { duration = DEFAULT_DURATION, icon } = options;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    toast.innerHTML = `
        <span class="toast-icon">${icon || TOAST_ICONS[type] || TOAST_ICONS.info}</span>
        <span class="toast-message"></span>
    `;
    toast.querySelector('.toast-message').textContent = message;

    container.appendChild(toast);

    // Auto-dismiss after duration
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);

    return toast;
}

/**
 * Show success toast
 * @param {string} message - Message to display
 * @param {Object} [options={}] - Toast options
 * @returns {Element} Toast element
 */
function showSuccess(message, options = {}) {
    return showToast(message, 'success', options);
}

/**
 * Show error toast
 * @param {string} message - Message to display
 * @param {Object} [options={}] - Toast options
 * @returns {Element} Toast element
 */
function showError(message, options = {}) {
    return showToast(message, 'error', options);
}

/**
 * Show info toast
 * @param {string} message - Message to display
 * @param {Object} [options={}] - Toast options
 * @returns {Element} Toast element
 */
function showInfo(message, options = {}) {
    return showToast(message, 'info', options);
}

/**
 * Show warning toast
 * @param {string} message - Message to display
 * @param {Object} [options={}] - Toast options
 * @returns {Element} Toast element
 */
function showWarning(message, options = {}) {
    return showToast(message, 'warning', options);
}

/**
 * Clear all toasts
 */
function clearAllToasts() {
    const container = window.$ ? window.$('#toast-container') : document.getElementById('toast-container');
    if (container) {
        container.innerHTML = '';
    }
}

const toast = {
    show: showToast,
    success: showSuccess,
    error: showError,
    info: showInfo,
    warning: showWarning,
    clearAll: clearAllToasts,
    TOAST_ICONS,
    DEFAULT_DURATION
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.showToast = showToast;
    window.showSuccess = showSuccess;
    window.showError = showError;
    window.showInfo = showInfo;
    window.showWarning = showWarning;
    window.clearAllToasts = clearAllToasts;
    window.toast = toast;
}
