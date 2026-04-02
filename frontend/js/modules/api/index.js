/**
 * @fileoverview Re-export all API modules
 * @module api
 *
 * Note: This file aggregates API functions loaded from individual module files.
 * All functions are expected to be available on the window object when this runs.
 */

/**
 * Combined API object for backward compatibility
 * Provides all API methods in a single namespace
 * Assumes all individual API modules have been loaded and attached to window
 */
const API = {
    // Images
    getImages: function() { return window.imagesApi.getImages.apply(window.imagesApi, arguments); },
    getAnalytics: function() { return window.imagesApi.getAnalytics.apply(window.imagesApi, arguments); },
    clearGallery: function() { return window.imagesApi.clearGallery.apply(window.imagesApi, arguments); },
    getImage: function() { return window.imagesApi.getImage.apply(window.imagesApi, arguments); },
    reparseImage: function() { return window.imagesApi.reparseImage.apply(window.imagesApi, arguments); },
    getImageUrl: function() { return window.imagesApi.getImageUrl.apply(window.imagesApi, arguments); },
    getThumbnailUrl: function() { return window.imagesApi.getThumbnailUrl.apply(window.imagesApi, arguments); },
    getStats: function() { return window.imagesApi.getStats.apply(window.imagesApi, arguments); },

    // Tags
    getTags: function() { return window.tagsApi.getTags.apply(window.tagsApi, arguments); },
    getTagsLibrary: function() { return window.tagsApi.getTagsLibrary.apply(window.tagsApi, arguments); },
    importTags: function() { return window.tagsApi.importTags.apply(window.tagsApi, arguments); },
    getPromptsLibrary: function() { return window.tagsApi.getPromptsLibrary.apply(window.tagsApi, arguments); },
    getGenerators: function() { return window.tagsApi.getGenerators.apply(window.tagsApi, arguments); },

    // Sorting
    startScan: function() { return window.sortingApi.startScan.apply(window.sortingApi, arguments); },
    getScanProgress: function() { return window.sortingApi.getScanProgress.apply(window.sortingApi, arguments); },
    startTagging: function() { return window.sortingApi.startTagging.apply(window.sortingApi, arguments); },
    getTagProgress: function() { return window.sortingApi.getTagProgress.apply(window.sortingApi, arguments); },
    moveImages: function() { return window.sortingApi.moveImages.apply(window.sortingApi, arguments); },
    batchMove: function() { return window.sortingApi.batchMove.apply(window.sortingApi, arguments); },
    startSortSession: function() { return window.sortingApi.startSortSession.apply(window.sortingApi, arguments); },
    getCurrentSortImage: function() { return window.sortingApi.getCurrentSortImage.apply(window.sortingApi, arguments); },
    sortAction: function() { return window.sortingApi.sortAction.apply(window.sortingApi, arguments); },
    setSortFolders: function() { return window.sortingApi.setSortFolders.apply(window.sortingApi, arguments); },
    exportTagsBatch: function() { return window.sortingApi.exportTagsBatch.apply(window.sortingApi, arguments); }
};

// Export to global namespace for backward compatibility with non-module scripts
if (typeof window !== 'undefined') {
    window.API = API;
}
