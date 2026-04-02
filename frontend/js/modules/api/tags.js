/**
 * @fileoverview Tag API endpoints
 * @module api/tags
 */

// Use global API client functions (loaded from client.js)
// Assumes apiGet, apiPost are available

/**
 * @typedef {Object} TagItem
 * @property {string} tag - Tag name
 * @property {number} count - Tag count
 */

/**
 * @typedef {Object} TagsResult
 * @property {TagItem[]} tags - Array of tags
 */

/**
 * @typedef {Object} TagsLibraryResult
 * @property {TagItem[]} tags - Array of tags
 * @property {number} total - Total count
 */

/**
 * @typedef {Object} PromptsLibraryResult
 * @property {Array<{prompt: string, count: number}>} prompts - Array of prompts
 * @property {number} total - Total count
 */

/**
 * Get all tags
 * @returns {Promise<TagsResult>} Tags data
 */
async function getTags() {
    return window.apiGet('/api/tags');
}

/**
 * Get tags library with sorting and limit
 * @param {string} [sortBy='frequency'] - Sort field
 * @param {number} [limit=2000] - Maximum results
 * @returns {Promise<TagsLibraryResult>} Tags library data
 */
async function getTagsLibrary(sortBy = 'frequency', limit = 2000) {
    return window.apiGet(`/api/tags/library?sort_by=${sortBy}&limit=${limit}`);
}

/**
 * Import tags from external data
 * @param {Array} images - Array of image tag data
 * @param {boolean} [overwrite=false] - Whether to overwrite existing tags
 * @returns {Promise<{imported: number, skipped: number}>} Import result
 */
async function importTags(images, overwrite = false) {
    return window.apiPost('/api/tags/import', { images, overwrite });
}

/**
 * Get prompts library
 * @param {number} [limit=5000] - Maximum results
 * @returns {Promise<PromptsLibraryResult>} Prompts library data
 */
async function getPromptsLibrary(limit = 5000) {
    return window.apiGet(`/api/prompts/library?limit=${limit}`);
}

/**
 * Get generators list
 * @returns {Promise<Array<{generator: string, count: number}>>} Generators data
 */
async function getGenerators() {
    return window.apiGet('/api/generators');
}

const tagsApi = {
    getTags,
    getTagsLibrary,
    importTags,
    getPromptsLibrary,
    getGenerators
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.getTags = getTags;
    window.getTagsLibrary = getTagsLibrary;
    window.importTags = importTags;
    window.getPromptsLibrary = getPromptsLibrary;
    window.getGenerators = getGenerators;
    window.tagsApi = tagsApi;
}
