/**
 * @fileoverview User-friendly error message utilities
 * @module utils/errors
 */

/**
 * Map technical error messages to user-friendly messages
 * @constant {Object.<string, string>}
 */
const ERROR_MESSAGE_MAP = {
    // Network errors
    'Failed to fetch': 'Unable to connect to server. Please check if the server is running.',
    'NetworkError': 'Network connection error. Please check your internet connection.',
    'Network request failed': 'Network request failed. Please try again.',
    
    // Server errors
    'Internal Server Error': 'Server encountered an error. Please try again later.',
    'Service Unavailable': 'Service temporarily unavailable. Please wait and try again.',
    'Bad Gateway': 'Server is temporarily unavailable. Please try again.',
    'Gateway Timeout': 'Server response timed out. Please try again.',
    
    // Client errors
    'Unauthorized': 'Authentication required. Please refresh the page.',
    'Forbidden': 'Access denied. You do not have permission for this action.',
    'Not Found': 'The requested resource was not found.',
    'Bad Request': 'Invalid request. Please check your input.',
    
    // File operations
    'ENOENT': 'File or folder not found.',
    'EACCES': 'Permission denied. Please check folder permissions.',
    'EPERM': 'Operation not permitted. Please check permissions.',
    'ENOSPC': 'Not enough disk space for this operation.',
    'EMFILE': 'Too many files open. Please close other applications.',
    
    // Image operations
    'Invalid image': 'The image file is invalid or corrupted.',
    'Image too large': 'The image is too large to process.',
    'Unsupported format': 'This image format is not supported.',
    
    // Tagging/AI operations
    'Model not loaded': 'AI model is not loaded. Please wait for initialization.',
    'Model loading': 'AI model is loading. Please wait.',
    'CUDA out of memory': 'Not enough GPU memory. Try closing other applications.',
    'Out of memory': 'Not enough memory. Try closing other applications.',
    
    // Generic
    'timeout': 'Operation timed out. Please try again.',
    'cancelled': 'Operation was cancelled.',
    'abort': 'Operation was cancelled.',
};

/**
 * Patterns to match error messages and map to user-friendly versions
 * @constant {Array.<{pattern: RegExp, message: string}>}
 */
const ERROR_PATTERNS = [
    { pattern: /Failed to fetch/i, message: 'Unable to connect to server. Please check if the server is running.' },
    { pattern: /NetworkError/i, message: 'Network connection error. Please check your connection.' },
    { pattern: /ENOENT.*no such file/i, message: 'File or folder not found.' },
    { pattern: /EACCES|EPERM/i, message: 'Permission denied. Please check folder permissions.' },
    { pattern: /ENOSPC/i, message: 'Not enough disk space for this operation.' },
    { pattern: /CUDA.*memory|out of memory/i, message: 'Not enough memory. Try closing other applications.' },
    { pattern: /timeout/i, message: 'Operation timed out. Please try again.' },
    { pattern: /abort|cancelled/i, message: 'Operation was cancelled.' },
    { pattern: /invalid.*path/i, message: 'Invalid file path. Please check the path is correct.' },
    { pattern: /path.*not.*exist/i, message: 'The specified folder does not exist.' },
    { pattern: /connection.*refused/i, message: 'Cannot connect to server. Please ensure the server is running.' },
];

/**
 * Convert technical error to user-friendly message
 * @param {Error|string} error - The error object or message
 * @param {string} [context] - Context for the error (e.g., 'loading images')
 * @returns {string} User-friendly error message
 */
function formatUserError(error, context = '') {
    // Get error message string
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    // Check for exact match first
    if (ERROR_MESSAGE_MAP[errorMsg]) {
        return context ? `${context}: ${ERROR_MESSAGE_MAP[errorMsg]}` : ERROR_MESSAGE_MAP[errorMsg];
    }
    
    // Check patterns
    for (const { pattern, message } of ERROR_PATTERNS) {
        if (pattern.test(errorMsg)) {
            return context ? `${context}: ${message}` : message;
        }
    }
    
    // Check if error message is already user-friendly (no technical jargon)
    const hasTechnicalJargon = /[\[\]{}()._\\/]|ENOENT|EACCES|EPERM|ENOSPC|CUDA|undefined|null/i.test(errorMsg);
    
    if (!hasTechnicalJargon && errorMsg.length < 100) {
        return context ? `${context}: ${errorMsg}` : errorMsg;
    }
    
    // Return generic message with context
    return context 
        ? `Failed to ${context}. Please try again.`
        : 'An unexpected error occurred. Please try again.';
}

/**
 * Check if error is a cancellation/abort error
 * @param {Error} error - Error to check
 * @returns {boolean} True if error is cancellation
 */
function isCancellationError(error) {
    if (!error) return false;
    const name = error.name || '';
    const message = error.message || '';
    return name === 'AbortError' || 
           name === 'CancellationError' ||
           message.toLowerCase().includes('abort') ||
           message.toLowerCase().includes('cancel');
}

/**
 * Show user-friendly error toast
 * @param {Error|string} error - The error
 * @param {string} [context] - Context for the error
 * @param {Function} [showToast] - Toast function to use (defaults to window.showToast)
 */
function showUserError(error, context = '', showToast = null) {
    // Don't show toast for cancellation errors
    if (isCancellationError(error)) {
        return;
    }
    
    const message = formatUserError(error, context);
    const toastFn = showToast || window.showToast;
    
    if (typeof toastFn === 'function') {
        toastFn(message, 'error');
    } else {
        console.error('[Error]', context, error);
    }
}

// Export to global namespace
if (typeof window !== 'undefined') {
    window.formatUserError = formatUserError;
    window.showUserError = showUserError;
    window.isCancellationError = isCancellationError;
    window.ERROR_MESSAGE_MAP = ERROR_MESSAGE_MAP;
    window.errorUtils = {
        formatUserError,
        showUserError,
        isCancellationError,
        ERROR_MESSAGE_MAP,
        ERROR_PATTERNS,
    };
}
