// What each library was last showing: the search line and the left-rail
// scope. Switching library brings back that library's own search (V3.5 kept
// its filters per library too), and a reload keeps it. The store is plain
// data; state/store.ts reads and writes it in localStorage.

export interface Scope {
  generators: string[]
  folder: string | null
  favorites: boolean
}

export interface BrowseState {
  queryText: string
  scope: Scope
}

export type BrowseStore = Record<string, BrowseState>

export const EMPTY_SCOPE: Scope = { generators: [], folder: null, favorites: false }

export function isBrowsingAll(state: BrowseState): boolean {
  const { scope } = state
  return !state.queryText.trim() && !scope.favorites && !scope.folder && scope.generators.length === 0
}

export function recallBrowse(store: BrowseStore, libraryId: string): BrowseState {
  const saved = store[libraryId]
  return saved ? { queryText: saved.queryText, scope: { ...saved.scope, generators: [...saved.scope.generators] } } : { queryText: '', scope: EMPTY_SCOPE }
}

/** A new store with this library's state; showing everything forgets the entry. */
export function rememberBrowse(store: BrowseStore, libraryId: string, state: BrowseState): BrowseStore {
  const { [libraryId]: _old, ...rest } = store
  if (isBrowsingAll(state)) return rest
  return { ...rest, [libraryId]: { queryText: state.queryText, scope: { ...state.scope, generators: [...state.scope.generators] } } }
}

function readScope(raw: unknown): Scope {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    generators: Array.isArray(s.generators) ? s.generators.filter((g): g is string => typeof g === 'string') : [],
    folder: typeof s.folder === 'string' && s.folder ? s.folder : null,
    favorites: s.favorites === true,
  }
}

/** The stored JSON back into a store; anything damaged reads as not remembered. */
export function parseBrowseStore(raw: string | null): BrowseStore {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const store: BrowseStore = {}
  for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.queryText !== 'string') continue
    store[id] = { queryText: e.queryText, scope: readScope(e.scope) }
  }
  return store
}
