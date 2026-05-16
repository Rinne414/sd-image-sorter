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
            checkpoints: [],
            loras: [],
            prompts: [],
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
        };
    }

    function cloneState(filters) {
        const source = filters || createDefaultFilterState();
        return {
            generators: [...(source.generators || [])],
            ratings: [...(source.ratings || [])],
            tags: [...(source.tags || [])],
            checkpoints: [...(source.checkpoints || [])],
            loras: [...(source.loras || [])],
            prompts: [...(source.prompts || [])],
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
