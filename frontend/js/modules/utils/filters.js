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
 *   - search: string
 *   - dimensions: string
 *   - artist: string
 */
function formatFilterSummary(filters) {
    const f = filters || {};
    const allGens = ['comfyui', 'nai', 'webui', 'forge', 'unknown'];
    const allRatings = ['general', 'sensitive', 'questionable', 'explicit'];
    const t = window.I18n?.t?.bind(window.I18n);
    const allLabel = t ? t('common.all') : 'All';
    const noneLabel = t ? t('common.none') : 'None';
    const selectedSuffix = t ? t('common.selected') : 'selected';
    const tagLabel = t ? t('modal.tags') : 'tags';
    const promptLabel = t ? t('library.prompts') : 'prompts';
    const anyLabel = t ? t('filter.any') : 'Any';
    const infinityLabel = '∞';
    const customLabel = t ? t('filter.custom') : 'Custom';
    const formatGenerator = (generator) => {
        const normalized = String(generator || 'unknown').trim().toLowerCase();
        const key = `generator.${normalized}`;
        const translated = t ? t(key) : null;
        return translated && translated !== key ? translated : String(generator || 'unknown');
    };
    const formatRating = (rating) => {
        const normalized = String(rating || '').trim().toLowerCase();
        const key = `common.${normalized}`;
        const translated = t ? t(key) : null;
        return translated && translated !== key ? translated : String(rating || '');
    };

    return {
        generators:
            !f.generators || f.generators.length === allGens.length ? allLabel :
                f.generators.length === 0 ? noneLabel :
                    f.generators.length > 2 ? `${f.generators.length} ${selectedSuffix}` : f.generators.map(formatGenerator).join(', '),

        ratings:
            !f.ratings || f.ratings.length === allRatings.length ? allLabel :
                f.ratings.length === 0 ? noneLabel :
                    f.ratings.length > 2 ? `${f.ratings.length} ${selectedSuffix}` : f.ratings.map(formatRating).join(', '),

        tags:
            !f.tags || f.tags.length === 0 ? noneLabel :
                f.tags.length > 2 ? `${f.tags.length} ${tagLabel}` : f.tags.join(', '),

        checkpoints:
            !f.checkpoints || f.checkpoints.length === 0 ? noneLabel :
                f.checkpoints.length > 2 ? `${f.checkpoints.length} ${selectedSuffix}` : f.checkpoints.join(', '),

        loras:
            !f.loras || f.loras.length === 0 ? noneLabel :
                f.loras.length > 2 ? `${f.loras.length} ${selectedSuffix}` : f.loras.join(', '),

        prompts:
            !f.prompts || f.prompts.length === 0 ? noneLabel :
                f.prompts.length > 2 ? `${f.prompts.length} ${promptLabel}` : f.prompts.join(', '),

        search:
            !f.search || !String(f.search).trim() ? noneLabel :
                String(f.search).trim().length > 40 ? `${String(f.search).trim().slice(0, 37)}...` : String(f.search).trim(),

        dimensions: formatDimensionsSummary(f, { anyLabel, infinityLabel, customLabel }),

        artist: f.artist ? formatArtistName(f.artist) : null
    };
}

/**
 * Format dimensions filter as a human-readable string.
 *
 * @param {Object} filters - The filters object
 * @returns {string} Formatted dimensions string
 */
function formatDimensionsSummary(filters, labels = {}) {
    const f = filters || {};
    const hasDimFilter = f.minWidth || f.maxWidth || f.minHeight || f.maxHeight || f.aspectRatio;

    if (!hasDimFilter) {
        return labels.anyLabel || 'Any';
    }

    const parts = [];
    if (f.minWidth || f.maxWidth) {
        parts.push(`W: ${f.minWidth || 0}-${f.maxWidth || labels.infinityLabel || 'infinity'}`);
    }
    if (f.minHeight || f.maxHeight) {
        parts.push(`H: ${f.minHeight || 0}-${f.maxHeight || labels.infinityLabel || 'infinity'}`);
    }
    if (f.aspectRatio) {
        parts.push(f.aspectRatio);
    }

    return parts.join(', ') || labels.customLabel || 'Custom';
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
