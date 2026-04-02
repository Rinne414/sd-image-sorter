/**
 * SD Image Sorter - Logger Utility
 * Provides structured logging with debug mode support
 * 
 * Features:
 * - Debug mode configurable at runtime via localStorage
 * - Log history with size limits (prevents memory leaks)
 * - Multiple log levels (debug, info, warn, error)
 */

(function() {
    'use strict';

    // Configuration keys
    const DEBUG_STORAGE_KEY = 'sd-image-sorter-debug-enabled';
    const LOG_HISTORY_KEY = 'sd-image-sorter-log-history';
    const MAX_LOG_ENTRIES = 100; // Prevent unbounded growth
    const LOG_PERSISTENCE_ENABLED = false; // Set to true to persist logs across sessions

    // Get initial debug state from localStorage
    function getStoredDebugState() {
        try {
            const stored = localStorage.getItem(DEBUG_STORAGE_KEY);
            return stored === 'true';
        } catch (e) {
            return false;
        }
    }

    // Initialize debug state
    let DEBUG = getStoredDebugState();

    // Log history for debugging (circular buffer)
    const logHistory = [];
    let logIndex = 0;

    /**
     * Add entry to log history with rotation
     * @param {string} level - Log level
     * @param {Array} args - Log arguments
     */
    function addToHistory(level, args) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message: args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ')
        };

        if (logHistory.length < MAX_LOG_ENTRIES) {
            logHistory.push(entry);
        } else {
            // Circular buffer rotation
            logHistory[logIndex] = entry;
            logIndex = (logIndex + 1) % MAX_LOG_ENTRIES;
        }
    }

    const Logger = {
        /**
         * Debug messages - only shown when DEBUG is true
         * Use for detailed diagnostic information during development
         */
        debug: function(...args) {
            addToHistory('debug', args);
            if (DEBUG) {
                console.log('[DEBUG]', ...args);
            }
        },

        /**
         * Info messages - general operational information
         * Use for significant application events
         */
        info: function(...args) {
            addToHistory('info', args);
            console.info('[INFO]', ...args);
        },

        /**
         * Warning messages - potential issues that don't prevent operation
         * Use for recoverable errors or deprecated usage
         */
        warn: function(...args) {
            addToHistory('warn', args);
            console.warn('[WARN]', ...args);
        },

        /**
         * Error messages - failures that affect functionality
         * Use for caught exceptions and operational failures
         */
        error: function(...args) {
            addToHistory('error', args);
            console.error('[ERROR]', ...args);
        },

        /**
         * Set debug mode at runtime and persist to localStorage
         * @param {boolean} enabled - Whether to enable debug logging
         */
        setDebug: function(enabled) {
            DEBUG = !!enabled;
            try {
                localStorage.setItem(DEBUG_STORAGE_KEY, String(DEBUG));
            } catch (e) {
                // localStorage not available
            }
        },

        /**
         * Check if debug mode is enabled
         * @returns {boolean}
         */
        isDebug: function() {
            return DEBUG;
        },

        /**
         * Toggle debug mode
         * @returns {boolean} New debug state
         */
        toggleDebug: function() {
            this.setDebug(!DEBUG);
            return DEBUG;
        },

        /**
         * Get log history (sorted chronologically)
         * @param {string} [level] - Optional filter by level
         * @returns {Array} Log entries
         */
        getHistory: function(level) {
            let entries;
            if (logHistory.length < MAX_LOG_ENTRIES) {
                entries = [...logHistory];
            } else {
                // Sort circular buffer chronologically
                entries = [
                    ...logHistory.slice(logIndex),
                    ...logHistory.slice(0, logIndex)
                ];
            }
            if (level) {
                entries = entries.filter(e => e.level === level);
            }
            return entries;
        },

        /**
         * Clear log history
         */
        clearHistory: function() {
            logHistory.length = 0;
            logIndex = 0;
        },

        /**
         * Export logs as formatted string (useful for debugging)
         * @returns {string} Formatted log output
         */
        exportLogs: function() {
            const entries = this.getHistory();
            return entries.map(e => `[${e.timestamp}] [${e.level.toUpperCase()}] ${e.message}`).join('\n');
        },

        /**
         * Get configuration info
         * @returns {Object} Configuration object
         */
        getConfig: function() {
            return {
                debug: DEBUG,
                maxLogEntries: MAX_LOG_ENTRIES,
                currentEntries: logHistory.length
            };
        }
    };

    // Expose DEBUG flag globally for conditional checks
    Object.defineProperty(window, 'DEBUG', {
        get: function() { return DEBUG; },
        set: function(value) { Logger.setDebug(value); }
    });

    // Export logger globally
    window.Logger = Logger;

    // Convenience: Log initialization
    Logger.debug('Logger initialized', { debug: DEBUG, maxEntries: MAX_LOG_ENTRIES });
})();
