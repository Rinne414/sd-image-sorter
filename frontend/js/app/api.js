/**
 * app/api.js — app.js decomposition, stage 3 (the API object, part 1 of 2).
 * Extracted VERBATIM (byte-identical) from frontend/js/app.js: pre-split
 * lines 333-766 + the literal's original closing lines 1289-1290. The
 * remaining members live in app/api-features.js and are merged onto this
 * same object at load time. Classic script: one shared global lexical
 * environment; index.html loads this before app.js. No behavior change.
 */
const API = {
    async get(endpoint, options = {}) {
        const { signal, requestKey } = options;
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, { signal });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const message = formatApiError(response.status, errorData);
                const error = new Error(message);
                error.apiStatus = response.status;
                error.apiData = errorData;
                throw error;
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
    },

    // Cancellable GET request - use for filter operations
    async getCancellable(endpoint, requestKey) {
        const controller = RequestManager.createAbortController(requestKey);
        try {
            const result = await this.get(endpoint, { signal: controller.signal, requestKey });
            RequestManager.complete(requestKey);
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                return null; // Request was cancelled
            }
            throw error;
        }
    },

    async post(endpoint, data = {}, options = {}) {
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
                const error = new Error(message);
                error.apiStatus = response.status;
                error.apiData = errorData;
                throw error;
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
    },

    async delete(endpoint, options = {}) {
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
    },

    // v3.3.0 FEAT-COLLECTIONS: PATCH for partial updates (e.g. rename).
    async patch(endpoint, data = {}, options = {}) {
        const { signal } = options;
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
                signal
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const message = formatApiError(response.status, errorData);
                const error = new Error(message);
                error.apiStatus = response.status;
                error.apiData = errorData;
                throw error;
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
    },

    // Aurora Phase 3: filter → query params for GET /api/images/count (the
    // live hit-count preview). Mirrors getImages' filter mapping WITHOUT the
    // pagination/sort params — keep the two in step when adding filters.
    buildFilterQueryParams(filters = {}) {
        const params = new URLSearchParams();
        if (filters.generators?.length) params.set('generators', filters.generators.join(','));
        if (filters.ratings?.length) params.set('ratings', filters.ratings.join(','));
        if (filters.tags?.length) params.set('tags', filters.tags.join(','));
        if (filters.tagMode && filters.tagMode !== 'and') params.set('tag_mode', filters.tagMode);
        if (filters.checkpoints?.length) params.set('checkpoints', filters.checkpoints.join(','));
        if (filters.loras?.length) params.set('loras', filters.loras.join(','));
        if (filters.prompts?.length) params.set('prompts', filters.prompts.join(','));
        const promptMatchMode = normalizePromptMatchMode(filters.promptMatchMode);
        if (promptMatchMode !== 'exact') params.set('prompt_match_mode', promptMatchMode);
        if (filters.artist) params.set('artist', filters.artist);
        if (filters.search) params.set('search', filters.search);
        if (filters.minWidth) params.set('min_width', filters.minWidth);
        if (filters.maxWidth) params.set('max_width', filters.maxWidth);
        if (filters.minHeight) params.set('min_height', filters.minHeight);
        if (filters.maxHeight) params.set('max_height', filters.maxHeight);
        const aspectRatio = normalizeAspectRatioFilter(filters.aspectRatio);
        if (aspectRatio) params.set('aspect_ratio', aspectRatio);
        if (filters.dateFrom) params.set('date_from', filters.dateFrom);
        if (filters.dateTo) params.set('date_to', filters.dateTo);
        if (filters.minAesthetic) params.set('min_aesthetic', filters.minAesthetic);
        if (filters.maxAesthetic) params.set('max_aesthetic', filters.maxAesthetic);
        if (filters.minUserRating) params.set('min_user_rating', filters.minUserRating);
        if (filters.brightnessMin) params.set('brightness_min', filters.brightnessMin);
        if (filters.brightnessMax) params.set('brightness_max', filters.brightnessMax);
        if (filters.colorTemperature) params.set('color_temperature', filters.colorTemperature);
        if (filters.colorHues?.length) params.set('color_hues', filters.colorHues.join(','));
        if (filters.excludeColorHues?.length) params.set('exclude_color_hues', filters.excludeColorHues.join(','));
        if (filters.brightnessDistribution) params.set('brightness_distribution', filters.brightnessDistribution);
        if (filters.excludeTags?.length) params.set('exclude_tags', filters.excludeTags.join(','));
        if (filters.excludeGenerators?.length) params.set('exclude_generators', filters.excludeGenerators.join(','));
        if (filters.excludeRatings?.length) params.set('exclude_ratings', filters.excludeRatings.join(','));
        if (filters.excludeCheckpoints?.length) params.set('exclude_checkpoints', filters.excludeCheckpoints.join(','));
        if (filters.excludeLoras?.length) params.set('exclude_loras', filters.excludeLoras.join(','));
        if (filters.excludePrompts?.length) params.set('exclude_prompts', filters.excludePrompts.join(','));
        if (filters.excludeColors?.length) params.set('exclude_colors', filters.excludeColors.join(','));
        if (filters.collectionId) params.set('collection_id', filters.collectionId);
        if (filters.folder) params.set('folder', filters.folder);
        if (filters.hasMetadata != null) params.set('has_metadata', String(filters.hasMetadata));
        if (filters.noCaption === true) params.set('no_caption', 'true');
        if (filters.aestheticUnscored === true) params.set('aesthetic_unscored', 'true');
        if (filters.minSaturation != null) params.set('min_saturation', filters.minSaturation);
        if (filters.maxSaturation != null) params.set('max_saturation', filters.maxSaturation);
        if (filters.seed != null) params.set('seed', filters.seed);
        return params;
    },

    // Images with cursor-based pagination
    async getImages(filters = {}, options = {}) {
        const params = new URLSearchParams();
        if (filters.generators?.length) params.set('generators', filters.generators.join(','));

        // Fix: Always send ratings if they are selected/changed
        // If all 4 selected, we still send them so backend includes untagged
        if (filters.ratings?.length) {
            params.set('ratings', filters.ratings.join(','));
        }

        if (filters.tags?.length) params.set('tags', filters.tags.join(','));
        if (filters.tagMode && filters.tagMode !== 'and') params.set('tag_mode', filters.tagMode);
        if (filters.checkpoints?.length) params.set('checkpoints', filters.checkpoints.join(','));
        if (filters.loras?.length) params.set('loras', filters.loras.join(','));
        if (filters.prompts?.length) params.set('prompts', filters.prompts.join(','));
        const promptMatchMode = normalizePromptMatchMode(filters.promptMatchMode);
        if (promptMatchMode !== 'exact') params.set('prompt_match_mode', promptMatchMode);
        if (filters.artist) params.set('artist', filters.artist);  // Artist filter
        if (filters.search) params.set('search', filters.search);
        if (filters.sortBy) params.set('sort_by', filters.sortBy);
        params.set('limit', filters.limit ?? 200);
        if (filters.cursor) params.set('cursor', filters.cursor);
        if (Number.isFinite(filters.offset)) params.set('offset', filters.offset);

        // Dimension filters
        if (filters.minWidth) params.set('min_width', filters.minWidth);
        if (filters.maxWidth) params.set('max_width', filters.maxWidth);
        if (filters.minHeight) params.set('min_height', filters.minHeight);
        if (filters.maxHeight) params.set('max_height', filters.maxHeight);
        const aspectRatio = normalizeAspectRatioFilter(filters.aspectRatio);
        if (aspectRatio) params.set('aspect_ratio', aspectRatio);
        if (filters.dateFrom) params.set('date_from', filters.dateFrom);
        if (filters.dateTo) params.set('date_to', filters.dateTo);
        if (filters.minAesthetic) params.set('min_aesthetic', filters.minAesthetic);
        if (filters.maxAesthetic) params.set('max_aesthetic', filters.maxAesthetic);
        if (filters.minUserRating) params.set('min_user_rating', filters.minUserRating);
        if (filters.brightnessMin) params.set('brightness_min', filters.brightnessMin);
        if (filters.brightnessMax) params.set('brightness_max', filters.brightnessMax);
        if (filters.colorTemperature) params.set('color_temperature', filters.colorTemperature);
        if (filters.colorHues?.length) params.set('color_hues', filters.colorHues.join(','));
        if (filters.excludeColorHues?.length) params.set('exclude_color_hues', filters.excludeColorHues.join(','));
        if (filters.brightnessDistribution) params.set('brightness_distribution', filters.brightnessDistribution);

        // v3.2.2 per-item exclude filters
        if (filters.excludeTags?.length) params.set('exclude_tags', filters.excludeTags.join(','));
        if (filters.excludeGenerators?.length) params.set('exclude_generators', filters.excludeGenerators.join(','));
        if (filters.excludeRatings?.length) params.set('exclude_ratings', filters.excludeRatings.join(','));
        if (filters.excludeCheckpoints?.length) params.set('exclude_checkpoints', filters.excludeCheckpoints.join(','));
        if (filters.excludeLoras?.length) params.set('exclude_loras', filters.excludeLoras.join(','));
        if (filters.excludePrompts?.length) params.set('exclude_prompts', filters.excludePrompts.join(','));
        if (filters.excludeColors?.length) params.set('exclude_colors', filters.excludeColors.join(','));
        // v3.3.1: restrict to a collection (Favorites view / browse a collection).
        if (filters.collectionId) params.set('collection_id', filters.collectionId);
        // v3.3.2 Library Navigation: recursive folder-subtree scope
        if (filters.folder) params.set('folder', filters.folder);
        if (filters.hasMetadata != null) params.set('has_metadata', String(filters.hasMetadata));
        // Aurora Phase 3 toolbar/24d filters
        if (filters.noCaption === true) params.set('no_caption', 'true');
        if (filters.aestheticUnscored === true) params.set('aesthetic_unscored', 'true');
        if (filters.minSaturation != null) params.set('min_saturation', filters.minSaturation);
        if (filters.maxSaturation != null) params.set('max_saturation', filters.maxSaturation);
        if (filters.seed != null) params.set('seed', filters.seed);

        return this.get(`/api/images?${params}`, options);
    },

    async clearGallery() {
        return this.delete('/api/clear-gallery');
    },

    async getImage(id) {
        return this.get(`/api/images/${id}`);
    },

    async getSelectionIds(filters = {}) {
        return this.post('/api/images/selection-ids', buildSelectionFilterRequest(filters));
    },

    // Smart Folders v1: count the images matching a filter state without
    // fetching rows. Same payload as selection-ids; returns {count, exact}.
    async countImages(filters = {}, options = {}) {
        return this.post('/api/images/count', buildSelectionFilterRequest(filters), options);
    },

    async createSelectionToken(filters = {}, chunkSize = FILTERED_SELECTION_CHUNK_SIZE, options = {}) {
        const payload = {
            ...buildSelectionFilterRequest(filters),
            chunkSize,
        };
        if (Array.isArray(options.excludedImageIds) && options.excludedImageIds.length > 0) {
            payload.excludedImageIds = options.excludedImageIds;
        }
        return this.post('/api/images/selection-token', payload);
    },

    async getSelectionChunk(selectionToken, { offset = 0, limit = FILTERED_SELECTION_CHUNK_SIZE } = {}) {
        const params = new URLSearchParams();
        params.set('selection_token', selectionToken);
        params.set('offset', String(offset));
        params.set('limit', String(limit));
        return this.get(`/api/images/selection-chunk?${params.toString()}`);
    },

    async getSelectionData(imageIds) {
        return this.post('/api/images/export-data', { image_ids: imageIds });
    },

    async getSelectionDataByToken(selectionToken, { offset = 0, limit = EXPORT_PREVIEW_MAX_IMAGES } = {}) {
        return this.post('/api/images/export-data', {
            selection_token: selectionToken,
            offset,
            limit,
        });
    },

    async reparseImage(id) {
        return this.post(`/api/images/${id}/reparse`);
    },

    async saveEditedMetadata(sourcePath, outputPath, format, metadata, allowOverwrite = true) {
        return this.post('/api/image-metadata/save-edited', {
            source_path: sourcePath,
            output_path: outputPath,
            format: format,
            metadata: metadata,
            allow_overwrite: allowOverwrite
        });
    },

    async openFolder(imageId) {
        return this.post('/api/open-folder', { image_id: imageId });
    },

    async deleteSelectedImages(imageIds, options = {}) {
        const payload = { confirm_delete_files: true };
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/delete-selected', payload);
    },

    // v3.3.2 Phase-1: background delete-to-trash job (start + poll) so large
    // selections stream progress instead of freezing the request. Mirrors the
    // move job's startMoveJob/getMoveProgress/cancelMove client methods.
    async startDeleteJob(imageIds, options = {}) {
        const payload = { confirm_delete_files: true };
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/delete-selected/start', payload);
    },

    async getDeleteProgress() {
        return this.get('/api/images/delete-selected/progress');
    },

    async cancelDelete() {
        return this.post('/api/images/delete-selected/cancel', {});
    },

    async removeSelectedImages(imageIds, options = {}) {
        const payload = {};
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/remove-selected', payload);
    },

    // v3.3.2 Phase-1: background remove-from-gallery job (start + poll), DB-only.
    async startRemoveJob(imageIds, options = {}) {
        const payload = {};
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/remove-selected/start', payload);
    },

    async getRemoveProgress() {
        return this.get('/api/images/remove-selected/progress');
    },

    async cancelRemove() {
        return this.post('/api/images/remove-selected/cancel', {});
    },

    // Debt-22: durable-id bulk-job path. Opting in with `background: true` makes
    // the delete / remove / export endpoints return a job envelope instead of
    // the synchronous result; progress and cancellation then flow through the
    // shared /api/bulk-jobs registry (poll by id, cancel by id) rather than the
    // per-operation Phase-1 singleton /progress endpoints above.
    async startDeleteBulkJob(imageIds, options = {}) {
        const payload = { confirm_delete_files: true, background: true };
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/delete-selected', payload);
    },

    async startRemoveBulkJob(imageIds, options = {}) {
        const payload = { background: true };
        if (options.selectionToken) {
            payload.selection_token = options.selectionToken;
        } else {
            payload.image_ids = imageIds;
        }
        return this.post('/api/images/remove-selected', payload);
    },

    async getBulkJob(jobId) {
        return this.get(`/api/bulk-jobs/${encodeURIComponent(jobId)}`);
    },

    async cancelBulkJob(jobId) {
        return this.post(`/api/bulk-jobs/${encodeURIComponent(jobId)}/cancel`, {});
    },

    getImageUrl(id) {
        return `${API_BASE}/api/image-file/${id}`;
    },

    getThumbnailUrl(id, size = null) {
        const actualSize = size || (AppState.viewMode === 'large' ? 512 : AppState.viewMode === 'waterfall' ? 384 : 256);
        // Thumbnail responses are browser-cached for 24h (Cache-Control
        // max-age=86400), which kept serving pre-censor pixels after an
        // overwrite. Version the URL with the image's source mtime: the
        // censor save/reconcile path bumps source_mtime_ns in the DB, so the
        // post-save gallery refresh produces a new URL and busts the cache.
        const version = this._getThumbnailVersion(id);
        const versionSuffix = version ? `&v=${encodeURIComponent(version)}` : '';
        return `${API_BASE}/api/image-thumbnail/${id}?size=${actualSize}${versionSuffix}`;
    },

    _thumbVersionCache: null,

    _getThumbnailVersion(id) {
        const images = AppState.images;
        if (!Array.isArray(images) || images.length === 0) return '';
        // Gallery refreshes replace AppState.images with a new array, so the
        // array identity (plus length, guarding in-place appends) is a cheap
        // staleness key for the id → mtime lookup map.
        let cache = this._thumbVersionCache;
        if (!cache || cache.source !== images || cache.size !== images.length) {
            const map = new Map();
            for (const image of images) {
                if (image?.id == null) continue;
                const version = image.source_mtime_ns ?? image.source_file_mtime;
                if (version != null && version !== '') map.set(Number(image.id), String(version));
            }
            cache = { source: images, size: images.length, map };
            this._thumbVersionCache = cache;
        }
        return cache.map.get(Number(id)) || '';
    },
};

