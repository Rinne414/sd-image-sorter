/**
 * @fileoverview Image API endpoints
 * @module api/images
 */

// Use global API client functions (loaded from client.js)
// Assumes apiClient.get, apiClient.post, apiClient.del, apiClient.API_BASE are available

/**
 * @typedef {Object} ImageFilters
 * @property {string[]} [generators] - Generator types to filter
 * @property {string[]} [ratings] - Rating categories to filter
 * @property {string[]} [tags] - Tags to filter
 * @property {string[]} [checkpoints] - Checkpoints to filter
 * @property {string[]} [loras] - LoRAs to filter
 * @property {string[]} [prompts] - Prompts to filter
 * @property {string} [artist] - Artist to filter
 * @property {string} [search] - Search query
 * @property {string} [sortBy] - Sort order
 * @property {number} [limit] - Maximum results per page
 * @property {string} [cursor] - Pagination cursor
 * @property {number} [minWidth] - Minimum width filter
 * @property {number} [maxWidth] - Maximum width filter
 * @property {number} [minHeight] - Minimum height filter
 * @property {number} [maxHeight] - Maximum height filter
 * @property {string} [aspectRatio] - Aspect ratio filter
 */

/**
 * @typedef {Object} ImageResult
 * @property {Array} images - Array of image objects
 * @property {string|null} next_cursor - Cursor for next page
 * @property {boolean} has_more - Whether more results exist
 * @property {number} total - Total count
 */

/**
 * @typedef {Object} ImageDetail
 * @property {Object} image - Image object with full details
 * @property {Array} tags - Array of tags for the image
 */

/**
 * Get images with cursor-based pagination
 * @param {ImageFilters} filters - Filter options
 * @param {Object} [options={}] - Fetch options
 * @returns {Promise<ImageResult>} Paginated image results
 */
async function getImages(filters = {}, options = {}) {
    const params = new URLSearchParams();
    if (filters.generators?.length) params.set('generators', filters.generators.join(','));

    // Fix: Always send ratings if they are selected/changed
    // If all 4 selected, we still send them so backend includes untagged
    if (filters.ratings?.length) {
        params.set('ratings', filters.ratings.join(','));
    }

    if (filters.tags?.length) params.set('tags', filters.tags.join(','));
    if (filters.checkpoints?.length) params.set('checkpoints', filters.checkpoints.join(','));
    if (filters.loras?.length) params.set('loras', filters.loras.join(','));
    if (filters.prompts?.length) params.set('prompts', filters.prompts.join(','));
    if (filters.artist) params.set('artist', filters.artist);
    if (filters.search) params.set('search', filters.search);
    if (filters.sortBy) params.set('sort_by', filters.sortBy);
    params.set('limit', filters.limit ?? 100);

    // Cursor-based pagination
    if (filters.cursor) params.set('cursor', filters.cursor);

    // Dimension filters
    if (filters.minWidth) params.set('min_width', filters.minWidth);
    if (filters.maxWidth) params.set('max_width', filters.maxWidth);
    if (filters.minHeight) params.set('min_height', filters.minHeight);
    if (filters.maxHeight) params.set('max_height', filters.maxHeight);
    if (filters.aspectRatio) params.set('aspect_ratio', filters.aspectRatio);

    return window.apiGet(`/api/images?${params}`, options);
}

/**
 * Get analytics data
 * @returns {Promise<Object>} Analytics data
 */
async function getAnalytics() {
    return window.apiGet('/api/analytics');
}

/**
 * Clear gallery database
 * @returns {Promise<Object>} Result object
 */
async function clearGallery() {
    return window.apiDel('/api/clear-gallery');
}

/**
 * Get single image details
 * @param {number|string} id - Image ID
 * @returns {Promise<ImageDetail>} Image details with tags
 */
async function getImage(id) {
    return window.apiGet(`/api/images/${id}`);
}

/**
 * Reparse image metadata
 * @param {number|string} id - Image ID
 * @returns {Promise<Object>} Reparsed image data
 */
async function reparseImage(id) {
    return window.apiPost(`/api/images/${id}/reparse`);
}

/**
 * Get URL for image file
 * @param {number|string} id - Image ID
 * @returns {string} Image URL
 */
function getImageUrl(id) {
    const API_BASE = window.API_BASE || '';
    return `${API_BASE}/api/image-file/${id}`;
}

/**
 * Get URL for image thumbnail
 * @param {number|string} id - Image ID
 * @param {number|null} [size=null] - Thumbnail size (defaults based on view mode)
 * @returns {string} Thumbnail URL
 */
function getThumbnailUrl(id, size = null) {
    const API_BASE = window.API_BASE || '';
    // Use provided size or default to 256
    const actualSize = size || 256;
    return `${API_BASE}/api/image-thumbnail/${id}?size=${actualSize}`;
}

/**
 * Get statistics
 * @returns {Promise<Object>} Stats data
 */
async function getStats() {
    return window.apiGet('/api/stats');
}

const imagesApi = {
    getImages,
    getAnalytics,
    clearGallery,
    getImage,
    reparseImage,
    getImageUrl,
    getThumbnailUrl,
    getStats
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.getImages = getImages;
    window.getAnalytics = getAnalytics;
    window.clearGallery = clearGallery;
    window.getImage = getImage;
    window.reparseImage = reparseImage;
    window.getImageUrl = getImageUrl;
    window.getThumbnailUrl = getThumbnailUrl;
    window.getStats = getStats;
    window.imagesApi = imagesApi;
}
