/**
 * @fileoverview Base fetch wrapper with error handling and request cancellation
 * @module api/client
 */

/**
 * @typedef {Object} FetchOptions
 * @property {AbortSignal} [signal] - AbortController signal for cancellation
 * @property {string} [requestKey] - Key for request management
 */

/**
 * @typedef {Object} ApiError
 * @property {string} name - Error name
 * @property {string} message - Error message
 * @property {boolean} [cancelled] - Whether the request was cancelled
 */

/** @constant {string} API base URL (same origin) */
const API_BASE = '';

/**
 * Format error messages for user-friendly display
 * @param {number} status - HTTP status code
 * @param {Object} [errorData={}] - Error response data
 * @returns {string} User-friendly error message
 */
function formatApiError(status, errorData = {}) {
    // Use error detail if provided
    if (errorData.detail) return errorData.detail;
    if (errorData.error) return errorData.error;

    // Default messages based on status code
    const statusMessages = {
        400: 'Invalid request. Please check your input and try again.',
        401: 'Authentication required. Please refresh the page.',
        403: 'Access denied. You do not have permission for this action.',
        404: 'The requested resource was not found.',
        409: 'This operation conflicts with an existing one. Please wait and try again.',
        422: 'Invalid data provided. Please check your input.',
        429: 'Too many requests. Please wait a moment and try again.',
        500: 'Server error. Please try again later or check the logs.',
        502: 'Server is temporarily unavailable. Please try again.',
        503: 'Service unavailable. The server may be starting up.',
    };

    return statusMessages[status] || `Request failed (${status}). Please try again.`;
}

/**
 * Request Manager for cancellation support
 * @namespace
 */
const RequestManager = {
    /** @type {Map<string, AbortController>} */
    pendingRequests: new Map(),
    requestId: 0,

    /**
     * Create an AbortController for a request key
     * Cancels any existing request with the same key
     * @param {string} key - Request identifier
     * @returns {AbortController} Controller for the new request
     */
    createAbortController(key) {
        // Cancel any existing request with the same key
        this.cancel(key);

        const controller = new AbortController();
        this.pendingRequests.set(key, controller);
        return controller;
    },

    /**
     * Cancel a pending request by key
     * @param {string} key - Request identifier
     */
    cancel(key) {
        const controller = this.pendingRequests.get(key);
        if (controller) {
            controller.abort();
            this.pendingRequests.delete(key);
        }
    },

    /**
     * Cancel all pending requests
     */
    cancelAll() {
        this.pendingRequests.forEach((controller) => {
            controller.abort();
        });
        this.pendingRequests.clear();
    },

    /**
     * Mark a request as complete
     * @param {string} key - Request identifier
     */
    complete(key) {
        this.pendingRequests.delete(key);
    },

    /**
     * Check if an error is an abort error
     * @param {Error} error - Error to check
     * @returns {boolean} True if the error is an abort error
     */
    isAbortedError(error) {
        return error.name === 'AbortError';
    }
};

/**
 * Make a GET request to the API
 * @param {string} endpoint - API endpoint (without base URL)
 * @param {FetchOptions} [options={}] - Fetch options
 * @returns {Promise<Object>} Response JSON data
 * @throws {ApiError} On network or API error
 */
async function get(endpoint, options = {}) {
    const { signal, requestKey } = options;
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, { signal });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const message = formatApiError(response.status, errorData);
            throw new Error(message);
        }
        return response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw { name: 'AbortError', cancelled: true };
        }
        if (error.name === 'SyntaxError') {
            throw new Error('Server returned invalid data. Please try again.');
        }
        throw error;
    }
}

/**
 * Make a cancellable GET request
 * @param {string} endpoint - API endpoint
 * @param {string} requestKey - Key for request management
 * @returns {Promise<Object|null>} Response data or null if cancelled
 */
async function getCancellable(endpoint, requestKey) {
    const controller = RequestManager.createAbortController(requestKey);
    try {
        const result = await get(endpoint, { signal: controller.signal, requestKey });
        RequestManager.complete(requestKey);
        return result;
    } catch (error) {
        if (error.name === 'AbortError') {
            return null; // Request was cancelled
        }
        throw error;
    }
}

/**
 * Make a POST request to the API
 * @param {string} endpoint - API endpoint
 * @param {Object} [data={}] - Request body data
 * @param {FetchOptions} [options={}] - Fetch options
 * @returns {Promise<Object>} Response JSON data
 * @throws {ApiError} On network or API error
 */
async function post(endpoint, data = {}, options = {}) {
    const { signal } = options;
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            signal
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const message = formatApiError(response.status, errorData);
            throw new Error(message);
        }
        return response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw { name: 'AbortError', cancelled: true };
        }
        if (error.name === 'SyntaxError') {
            throw new Error('Server returned invalid data. Please try again.');
        }
        throw error;
    }
}

/**
 * Make a DELETE request to the API
 * @param {string} endpoint - API endpoint
 * @param {FetchOptions} [options={}] - Fetch options
 * @returns {Promise<Object>} Response JSON data
 * @throws {ApiError} On network or API error
 */
async function del(endpoint, options = {}) {
    const { signal } = options;
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            method: 'DELETE',
            signal
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `API Error: ${response.status}`);
        }
        return response.json();
    } catch (error) {
        if (error.name === 'SyntaxError') {
            throw new Error('Invalid JSON response from server');
        }
        throw error;
    }
}

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.API_BASE = API_BASE;
    window.RequestManager = RequestManager;
    window.formatApiError = formatApiError;
    window.apiGet = get;
    window.apiGetCancellable = getCancellable;
    window.apiPost = post;
    window.apiDel = del;
    window.apiClient = {
        API_BASE,
        RequestManager,
        formatApiError,
        get,
        getCancellable,
        post,
        del
    };
}
