/**
 * @fileoverview Formatting utilities for display
 * @module utils/format
 */

/**
 * Format file size in human-readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Format number with thousand separators
 * @param {number} num - Number to format
 * @param {string} [separator=','] - Thousand separator
 * @returns {string} Formatted number string
 */
function formatNumber(num, separator = ',') {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Format date in localized format
 * @param {Date|string|number} date - Date to format
 * @param {Object} [options={}] - Intl.DateTimeFormat options
 * @returns {string} Formatted date string
 */
function formatDate(date, options = {}) {
    const d = date instanceof Date ? date : new Date(date);
    const defaultOptions = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    };
    return d.toLocaleDateString(undefined, { ...defaultOptions, ...options });
}

/**
 * Format relative time (e.g., "2 hours ago")
 * @param {Date|string|number} date - Date to format
 * @returns {string} Relative time string
 */
function formatRelativeTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    const now = new Date();
    const diffMs = now - d;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);
    const diffYear = Math.floor(diffDay / 365);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
    if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
    if (diffWeek < 4) return `${diffWeek} week${diffWeek !== 1 ? 's' : ''} ago`;
    if (diffMonth < 12) return `${diffMonth} month${diffMonth !== 1 ? 's' : ''} ago`;
    return `${diffYear} year${diffYear !== 1 ? 's' : ''} ago`;
}

/**
 * Format duration in human-readable format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration string
 */
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);

    return parts.join(' ');
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Unescape HTML entities
 * @param {string} str - String with HTML entities
 * @returns {string} Unescaped string
 */
function unescapeHtml(str) {
    if (!str) return '';
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
}

/**
 * Truncate string with ellipsis
 * @param {string} str - String to truncate
 * @param {number} [maxLength=50] - Maximum length
 * @param {string} [suffix='...'] - Suffix to add when truncated
 * @returns {string} Truncated string
 */
function truncate(str, maxLength = 50, suffix = '...') {
    if (!str || str.length <= maxLength) return str;
    return str.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Capitalize first letter of string
 * @param {string} str - String to capitalize
 * @returns {string} Capitalized string
 */
function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert string to title case
 * @param {string} str - String to convert
 * @returns {string} Title case string
 */
function titleCase(str) {
    if (!str) return '';
    return str.replace(/\b\w/g, char => char.toUpperCase());
}

/**
 * Format percentage
 * @param {number} value - Value (0-1 or 0-100)
 * @param {number} [decimals=1] - Decimal places
 * @param {boolean} [isDecimal=true] - Whether value is decimal (0-1)
 * @returns {string} Formatted percentage
 */
function formatPercent(value, decimals = 1, isDecimal = true) {
    const percent = isDecimal ? value * 100 : value;
    return percent.toFixed(decimals) + '%';
}

/**
 * Format dimensions string
 * @param {number} width - Width
 * @param {number} height - Height
 * @returns {string} Formatted dimensions (e.g., "1920x1080")
 */
function formatDimensions(width, height) {
    return `${width}x${height}`;
}

/**
 * Format aspect ratio
 * @param {number} width - Width
 * @param {number} height - Height
 * @returns {string} Aspect ratio string (e.g., "16:9")
 */
function formatAspectRatio(width, height) {
    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

/**
 * Pluralize a word based on count
 * @param {number} count - Count
 * @param {string} singular - Singular form
 * @param {string} [plural] - Plural form (defaults to singular + 's')
 * @returns {string} Appropriate form
 */
function pluralize(count, singular, plural) {
    const form = count === 1 ? singular : (plural || singular + 's');
    return `${count} ${form}`;
}

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.formatSize = formatSize;
    window.formatNumber = formatNumber;
    window.formatDate = formatDate;
    window.formatRelativeTime = formatRelativeTime;
    window.formatDuration = formatDuration;
    window.escapeHtml = escapeHtml;
    window.unescapeHtml = unescapeHtml;
    window.truncate = truncate;
    window.capitalize = capitalize;
    window.titleCase = titleCase;
    window.formatPercent = formatPercent;
    window.formatDimensions = formatDimensions;
    window.formatAspectRatio = formatAspectRatio;
    window.pluralize = pluralize;
    window.format = {
        formatSize,
        formatNumber,
        formatDate,
        formatRelativeTime,
        formatDuration,
        escapeHtml,
        unescapeHtml,
        truncate,
        capitalize,
        titleCase,
        formatPercent,
        formatDimensions,
        formatAspectRatio,
        pluralize
    };
}
