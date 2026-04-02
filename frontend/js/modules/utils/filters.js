/**
 * SD Image Sorter - Filter Summary Utilities
 * Shared functions for formatting and displaying filter summaries
 */

/**
 * Format a filter summary object for display.
 * Returns a formatted summary object with human-readable strings.
 *
 * @param {Object} filters - The filters object from AppState
 * @returns {Object} Formatted summary object with properties:
 *   - generators: string
 *   - ratings: string
 *   - tags: string
 *   - checkpoints: string
 *   - loras: string
 *   - prompts: string
 *   - dimensions: string
 *   - artist: string
 */
function formatFilterSummary(filters) {
    const f = filters || {};
    const allGens = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];

    return {
        generators:
            !f.generators || f.generators.length === allGens.length ? 'All' :
                f.generators.length === 0 ? 'None' :
                    f.generators.length > 2 ? `${f.generators.length} selected` : f.generators.join(', '),

        ratings:
            !f.ratings || f.ratings.length === allRatings.length ? 'All' :
                f.ratings.length === 0 ? 'None' :
                    f.ratings.length > 2 ? `${f.ratings.length} selected` : f.ratings.join(', '),

        tags:
            !f.tags || f.tags.length === 0 ? 'None' :
                f.tags.length > 2 ? `${f.tags.length} tags` : f.tags.join(', '),

        checkpoints:
            !f.checkpoints || f.checkpoints.length === 0 ? 'None' :
                f.checkpoints.length > 2 ? `${f.checkpoints.length} selected` : f.checkpoints.join(', '),

        loras:
            !f.loras || f.loras.length === 0 ? 'None' :
                f.loras.length > 2 ? `${f.loras.length} selected` : f.loras.join(', '),

        prompts:
            !f.prompts || f.prompts.length === 0 ? 'None' :
                f.prompts.length > 2 ? `${f.prompts.length} prompts` : f.prompts.join(', '),

        dimensions: formatDimensionsSummary(f),

        artist: f.artist ? formatArtistName(f.artist) : null
    };
}

/**
 * Format dimensions filter as a human-readable string.
 *
 * @param {Object} filters - The filters object
 * @returns {string} Formatted dimensions string
 */
function formatDimensionsSummary(filters) {
    const f = filters || {};
    const hasDimFilter = f.minWidth || f.maxWidth || f.minHeight || f.maxHeight || f.aspectRatio;

    if (!hasDimFilter) {
        return 'Any';
    }

    const parts = [];
    if (f.minWidth || f.maxWidth) {
        parts.push(`W: ${f.minWidth || 0}-${f.maxWidth || 'infinity'}`);
    }
    if (f.minHeight || f.maxHeight) {
        parts.push(`H: ${f.minHeight || 0}-${f.maxHeight || 'infinity'}`);
    }
    if (f.aspectRatio) {
        parts.push(f.aspectRatio);
    }

    return parts.join(', ') || 'Custom';
}

/**
 * Format an artist name for display.
 * Replaces underscores with spaces and capitalizes words.
 *
 * @param {string} artist - The artist identifier
 * @returns {string} Formatted artist name
 */
function formatArtistName(artist) {
    if (!artist) return '';
    return artist.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Export for ES modules (future use)
// export { formatFilterSummary, formatDimensionsSummary, formatArtistName };

// Export to global namespace for current use (backward compatibility)
window.formatFilterSummary = formatFilterSummary;
window.formatDimensionsSummary = formatDimensionsSummary;
window.formatArtistName = formatArtistName;
