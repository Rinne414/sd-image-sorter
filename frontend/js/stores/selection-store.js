(function initSelectionStore(global) {
    const VALID_SCOPES = new Set(['visible', 'loaded', 'filtered']);

    function normalizeSelectionId(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : value;
    }

    function cloneSelectedIds(selectedIds) {
        const source = selectedIds instanceof Set
            ? selectedIds
            : Array.isArray(selectedIds)
                ? selectedIds
                : Array.from(selectedIds || []);
        const nextIds = new Set();
        source.forEach((value) => {
            const normalized = normalizeSelectionId(value);
            if (normalized != null && normalized !== '') {
                nextIds.add(normalized);
            }
        });
        return nextIds;
    }

    function normalizeScope(scope) {
        return VALID_SCOPES.has(scope) ? scope : 'visible';
    }

    function createDefaultState() {
        return {
            selectionMode: false,
            selectedIds: new Set(),
            scope: 'visible',
            filterKey: null,
            selectionToken: null,
        };
    }

    function cloneState(state) {
        const source = state || createDefaultState();
        return {
            selectionMode: Boolean(source.selectionMode),
            selectedIds: cloneSelectedIds(source.selectedIds),
            scope: normalizeScope(source.scope),
            filterKey: typeof source.filterKey === 'string' && source.filterKey
                ? source.filterKey
                : null,
            selectionToken: typeof source.selectionToken === 'string' && source.selectionToken
                ? source.selectionToken
                : null,
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
                    console.error('SelectionStore subscriber failed', error);
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

    global.SelectionStore = {
        create,
        createDefaultState,
        cloneState,
        normalizeSelectionId,
        normalizeScope,
        VALID_SCOPES: Array.from(VALID_SCOPES),
    };
})(window);
