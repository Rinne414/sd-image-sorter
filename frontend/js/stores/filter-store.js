(function initFilterStore(global) {
    // Mirrors backend/metadata_parser.py::MetadataParser.GENERATORS keys
    // and frontend/js/app.js::ALL_GENERATORS. Stay in sync when adding
    // a new generator.
    const DEFAULT_FILTER_GENERATORS = Object.freeze([
        'comfyui', 'nai', 'webui', 'forge', 'unknown',
        // Bundled under the gallery "Others" tab. Each is still
        // individually filterable via Filter Criteria.
        'others', 'fooocus', 'reforge', 'easy-diffusion', 'invokeai',
        'swarmui', 'drawthings', 'gemini', 'gpt-image',
    ]);

    function createDefaultFilterState() {
        return {
            generators: [...DEFAULT_FILTER_GENERATORS],
            ratings: ['general', 'sensitive', 'questionable', 'explicit'],
            tags: [],
            tagMode: 'and',
            checkpoints: [],
            loras: [],
            prompts: [],
            promptMatchMode: 'exact',
            artist: null,
            search: '',
            sortBy: 'newest',
            limit: 0,
            minWidth: null,
            maxWidth: null,
            minHeight: null,
            maxHeight: null,
            aspectRatio: '',
            minAesthetic: null,
            maxAesthetic: null,
            // v3.3.3 WIRING-01: minimum user star rating (1-5; null = any).
            minUserRating: null,
            brightnessMin: null,
            brightnessMax: null,
            colorTemperature: '',
            brightnessDistribution: '',
            // v3.2.2 per-item exclude filters
            excludeTags: [],
            excludeGenerators: [],
            excludeRatings: [],
            excludeCheckpoints: [],
            excludeLoras: [],
            // v3.3.0 FEAT-EXCLUDE-EXTRA
            excludePrompts: [],
            excludeColors: [],
            // v3.3.1: browse within a collection (Favorites view = favorites collection id).
            // null = no collection constraint (normal gallery listing).
            collectionId: null,
            // v3.3.2 Library Navigation: recursive folder-subtree scope (null = whole library).
            folder: null,
            // v3.3.2 small-opt: "has SD generation parameters" filter
            // (null = all, true = only with metadata, false = only without).
            hasMetadata: null,
        };
    }

    function cloneState(filters) {
        const source = filters || createDefaultFilterState();
        return {
            generators: [...(source.generators || [])],
            ratings: [...(source.ratings || [])],
            tags: [...(source.tags || [])],
            tagMode: source.tagMode || 'and',
            checkpoints: [...(source.checkpoints || [])],
            loras: [...(source.loras || [])],
            prompts: [...(source.prompts || [])],
            promptMatchMode: source.promptMatchMode === 'contains' || source.prompt_match_mode === 'contains' ? 'contains' : 'exact',
            artist: source.artist || null,
            search: source.search || '',
            sortBy: source.sortBy || 'newest',
            limit: source.limit || 0,
            minWidth: source.minWidth ?? null,
            maxWidth: source.maxWidth ?? null,
            minHeight: source.minHeight ?? null,
            maxHeight: source.maxHeight ?? null,
            aspectRatio: ['square', 'landscape', 'portrait'].includes(String(source.aspectRatio || '').trim())
                ? String(source.aspectRatio || '').trim()
                : '',
            minAesthetic: source.minAesthetic ?? null,
            maxAesthetic: source.maxAesthetic ?? null,
            minUserRating: source.minUserRating ?? null,
            brightnessMin: source.brightnessMin ?? null,
            brightnessMax: source.brightnessMax ?? null,
            colorTemperature: ['warm', 'neutral', 'cool'].includes(String(source.colorTemperature || '').trim())
                ? String(source.colorTemperature || '').trim()
                : '',
            brightnessDistribution: ['left_heavy', 'right_heavy', 'middle_heavy', 'edge_heavy', 'balanced'].includes(String(source.brightnessDistribution || '').trim())
                ? String(source.brightnessDistribution || '').trim()
                : '',
            // v3.2.2 per-item exclude filters
            excludeTags: [...(source.excludeTags || [])],
            excludeGenerators: [...(source.excludeGenerators || [])],
            excludeRatings: [...(source.excludeRatings || [])],
            excludeCheckpoints: [...(source.excludeCheckpoints || [])],
            excludeLoras: [...(source.excludeLoras || [])],
            // v3.3.0 FEAT-EXCLUDE-EXTRA
            excludePrompts: [...(source.excludePrompts || [])],
            excludeColors: [...(source.excludeColors || [])],
            // v3.3.1 collection browse
            collectionId: source.collectionId ?? null,
            // v3.3.2 Library Navigation
            folder: source.folder ? String(source.folder).trim() : null,
            // v3.3.2 small-opt: tri-state "has SD generation parameters"
            hasMetadata: typeof source.hasMetadata === 'boolean' ? source.hasMetadata : null,
        };
    }

    function create(initialState) {
        let state = cloneState(initialState);
        const listeners = new Set();

        function notify() {
            listeners.forEach((listener) => {
                try {
                    listener(state);
                } catch (error) {
                    console.error('FilterStore subscriber failed', error);
                }
            });
        }

        return {
            getState() {
                return state;
            },
            setState(nextState) {
                state = cloneState(nextState);
                notify();
                return state;
            },
            update(updater) {
                const draft = cloneState(state);
                const nextState = typeof updater === 'function'
                    ? (updater(draft) ?? draft)
                    : updater;
                return this.setState(nextState);
            },
            subscribe(listener) {
                if (typeof listener !== 'function') {
                    return function noop() {};
                }
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
    }

    global.FilterStore = {
        create,
        createDefaultFilterState,
        cloneState,
        DEFAULT_FILTER_GENERATORS,
    };
})(window);
