/**
 * @fileoverview Sorting API endpoints for scan, move, and manual sort operations
 * @module api/sorting
 */

// Use global API client functions (loaded from client.js)
// Assumes apiGet, apiPost are available

/**
 * @typedef {Object} ScanOptions
 * @property {string} folderPath - Path to scan
 * @property {boolean} [recursive=true] - Scan recursively
 */

/**
 * @typedef {Object} TaggingOptions
 * @property {number} [threshold=0.35] - Tag confidence threshold
 * @property {number} [characterThreshold=0.85] - Character tag threshold
 * @property {string|null} [modelName=null] - Predefined model name
 * @property {string|null} [modelPath=null] - Custom model path
 * @property {string|null} [tagsPath=null] - Custom tags CSV path
 * @property {Array|null} [imageIds=null] - Specific image IDs to tag
 * @property {boolean} [retagAll=false] - Retag already tagged images
 * @property {boolean} [useGpu=true] - Use GPU acceleration
 */

/**
 * @typedef {Object} SortSessionOptions
 * @property {string[]} [generators] - Generators to include
 * @property {string[]} [tags] - Tags to include
 * @property {string[]} [ratings] - Ratings to include
 * @property {Object} [folders] - Folder configuration
 * @property {string[]} [checkpoints] - Checkpoints to include
 * @property {string[]} [loras] - LoRAs to include
 * @property {string[]} [prompts] - Prompts to include
 * @property {Object} [dimensions] - Dimension filters
 */

/**
 * Start folder scan
 * @param {string} folderPath - Path to scan
 * @param {boolean} [recursive=true] - Scan recursively
 * @returns {Promise<Object>} Scan start result
 */
async function startScan(folderPath, recursive = true) {
    return window.apiPost('/api/scan', { folder_path: folderPath, recursive });
}

/**
 * Get scan progress
 * @returns {Promise<{status: string, current: number, total: number, message: string}>} Progress data
 */
async function getScanProgress() {
    return window.apiGet('/api/scan/progress');
}

/**
 * Start AI tagging process
 * @param {TaggingOptions} options - Tagging options
 * @returns {Promise<Object>} Tagging start result
 */
async function startTagging(options = {}) {
    return window.apiPost('/api/tag/start', {
        threshold: options.threshold || 0.35,
        character_threshold: options.characterThreshold || 0.85,
        model_name: options.modelName || null,
        model_path: options.modelPath || null,
        tags_path: options.tagsPath || null,
        image_ids: options.imageIds || null,
        retag_all: options.retagAll || false,
        use_gpu: options.useGpu ?? true
    });
}

/**
 * Get tagging progress
 * @returns {Promise<{status: string, current: number, total: number, message: string}>} Progress data
 */
async function getTagProgress() {
    return window.apiGet('/api/tag/progress');
}

/**
 * Move images to destination folder
 * @param {Array<number|string>} imageIds - Image IDs to move
 * @param {string} destinationFolder - Destination path
 * @returns {Promise<Object>} Move result
 */
async function moveImages(imageIds, destinationFolder) {
    return window.apiPost('/api/move', { image_ids: imageIds, destination_folder: destinationFolder });
}

/**
 * Batch move images by filters
 * @param {string[]} generators - Generator filters
 * @param {string[]} tags - Tag filters
 * @param {string[]} ratings - Rating filters
 * @param {string} destinationFolder - Destination path
 * @param {string[]|null} [checkpoints=null] - Checkpoint filters
 * @param {string[]|null} [loras=null] - LoRA filters
 * @param {string[]|null} [prompts=null] - Prompt filters
 * @param {Object|null} [dimensions=null] - Dimension filters
 * @returns {Promise<Object>} Batch move result
 */
async function batchMove(generators, tags, ratings, destinationFolder, checkpoints = null, loras = null, prompts = null, dimensions = null) {
    return window.apiPost('/api/batch-move', {
        generators,
        tags,
        ratings,
        checkpoints,
        loras,
        prompts,
        min_width: dimensions?.minWidth || null,
        max_width: dimensions?.maxWidth || null,
        min_height: dimensions?.minHeight || null,
        max_height: dimensions?.maxHeight || null,
        aspect_ratio: dimensions?.aspectRatio || null,
        destination_folder: destinationFolder
    });
}

/**
 * Start manual sort session
 * @param {string[]} generators - Generator filters
 * @param {string[]} tags - Tag filters
 * @param {string[]} ratings - Rating filters
 * @param {Object} folders - Folder configuration
 * @param {string[]|null} [checkpoints=null] - Checkpoint filters
 * @param {string[]|null} [loras=null] - LoRA filters
 * @param {string[]|null} [prompts=null] - Prompt filters
 * @param {Object|null} [dimensions=null] - Dimension filters
 * @returns {Promise<Object>} Sort session result
 */
async function startSortSession(generators, tags, ratings, folders, checkpoints = null, loras = null, prompts = null, dimensions = null) {
    const params = new URLSearchParams();
    if (generators?.length) params.set('generators', generators.join(','));
    if (tags?.length) params.set('tags', tags.join(','));
    if (ratings?.length) params.set('ratings', ratings.join(','));
    if (checkpoints?.length) params.set('checkpoints', checkpoints.join(','));
    if (loras?.length) params.set('loras', loras.join(','));
    if (prompts?.length) params.set('prompts', prompts.join(','));
    if (dimensions?.minWidth) params.set('min_width', dimensions.minWidth);
    if (dimensions?.maxWidth) params.set('max_width', dimensions.maxWidth);
    if (dimensions?.minHeight) params.set('min_height', dimensions.minHeight);
    if (dimensions?.maxHeight) params.set('max_height', dimensions.maxHeight);
    if (dimensions?.aspectRatio) params.set('aspect_ratio', dimensions.aspectRatio);
    if (folders) params.set('folders', JSON.stringify(folders));
    return window.apiPost(`/api/sort/start?${params}`);
}

/**
 * Get current image in sort session
 * @returns {Promise<Object>} Current sort image data
 */
async function getCurrentSortImage() {
    return window.apiGet('/api/sort/current');
}

/**
 * Perform sort action
 * @param {string} action - Action type (keep, discard, undo, skip, etc.)
 * @param {string|null} [folderKey=null] - Target folder key for move actions
 * @returns {Promise<Object>} Action result
 */
async function sortAction(action, folderKey = null) {
    const params = new URLSearchParams();
    params.set('action', action);
    if (folderKey) params.set('folder_key', folderKey);
    return window.apiPost(`/api/sort/action?${params}`);
}

/**
 * Set sort folders configuration
 * @param {Object} folders - Folder configuration
 * @returns {Promise<Object>} Set folders result
 */
async function setSortFolders(folders) {
    return window.apiPost('/api/sort/set-folders', { folders });
}

/**
 * Export tags batch to files
 * @param {Array<number|string>} imageIds - Image IDs to export
 * @param {string} outputFolder - Output folder path
 * @param {string[]} [blacklist=[]] - Tags to exclude
 * @param {string} [prefix=''] - File name prefix
 * @returns {Promise<{status: string, exported: number}>} Export result
 */
async function exportTagsBatch(imageIds, outputFolder, blacklist = [], prefix = '') {
    return window.apiPost('/api/tags/export-batch', {
        image_ids: imageIds,
        output_folder: outputFolder,
        blacklist: blacklist,
        prefix: prefix
    });
}

const sortingApi = {
    startScan,
    getScanProgress,
    startTagging,
    getTagProgress,
    moveImages,
    batchMove,
    startSortSession,
    getCurrentSortImage,
    sortAction,
    setSortFolders,
    exportTagsBatch
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.startScan = startScan;
    window.getScanProgress = getScanProgress;
    window.startTagging = startTagging;
    window.getTagProgress = getTagProgress;
    window.moveImages = moveImages;
    window.batchMove = batchMove;
    window.startSortSession = startSortSession;
    window.getCurrentSortImage = getCurrentSortImage;
    window.sortAction = sortAction;
    window.setSortFolders = setSortFolders;
    window.exportTagsBatch = exportTagsBatch;
    window.sortingApi = sortingApi;
}
