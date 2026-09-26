import { create } from 'zustand'
import type { BatchKind } from '../api/types'
import { parseBrowseStore, recallBrowse, rememberBrowse, type BrowseState, type Scope } from '../lib/browseMemory'
import { isSortBase, type SortBase } from '../lib/sort'

export type Page = 'home' | 'library' | 'batch' | 'sort'
export type Layout = 'masonry' | 'grid'
export type TileSize = 's' | 'm' | 'l'
export type { Scope }

// Shared with V3.5 (same origin), so both apps open the same library.
const LIBRARY_KEY = 'sd-library-workspace-v1'
const PREFS_KEY = 'sd-v4-prefs'
/** Each library's last search line and rail scope (lib/browseMemory.ts). */
const BROWSE_KEY = 'sd-v4-browse'

interface Prefs {
  layout: Layout
  tileSize: TileSize
  cardOpen: boolean
  railOpen: boolean
  sort: SortBase
  sortReverse: boolean
}

const DEFAULT_PREFS: Prefs = {
  layout: 'masonry',
  tileSize: 'm',
  cardOpen: true,
  railOpen: true,
  sort: 'newest',
  sortReverse: false,
}

function readJson<T>(key: string): Partial<T> {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Partial<T>) : {}
  } catch {
    return {}
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage blocked: preferences just won't persist
  }
}

/** Page and open batch from the address: #/library, #/batch, #/batch/12, #/home, #/sort. */
function routeFromHash(): { page: Page; batchId: number | null } {
  const h = location.hash.replace(/^#\/?/, '')
  const batch = /^batch\/(\d+)$/.exec(h)
  if (batch) return { page: 'batch', batchId: Number(batch[1]) }
  const page: Page = h === 'home' || h === 'batch' || h === 'sort' ? h : 'library'
  return { page, batchId: null }
}

function writeHash(page: Page, batchId: number | null): void {
  const hash = page === 'batch' && batchId !== null ? `#/batch/${batchId}` : `#/${page}`
  if (location.hash !== hash) history.replaceState(null, '', hash)
}

/** Picking in the library for a batch: an existing one, or a new one made from the picks. */
export type AddTarget = { batchId: number } | { kind: BatchKind }

interface AppState extends Prefs {
  page: Page
  libraryId: string
  queryText: string
  scope: Scope
  inspectedId: number | null
  /** Picked ids in the order they were picked. */
  selection: number[]
  selectionAnchor: number | null
  lightboxId: number | null
  /**
   * Where the big image sits in the whole result when it is outside the loaded
   * pages (a random pick); null when it is one of the loaded images.
   */
  lightboxAt: number | null
  paletteOpen: boolean
  /** The batch open on the Batch page (null: the list). */
  batchId: number | null
  adding: AddTarget | null

  setPage: (page: Page) => void
  setLibrary: (id: string) => void
  setQueryText: (text: string) => void
  setScope: (patch: Partial<Scope>) => void
  setSort: (sort: SortBase) => void
  setSortReverse: (reverse: boolean) => void
  setLayout: (layout: Layout) => void
  setTileSize: (size: TileSize) => void
  toggleCard: () => void
  toggleRail: () => void
  inspect: (id: number | null) => void
  togglePick: (id: number) => void
  selectRange: (ids: number[]) => void
  setSelection: (ids: number[]) => void
  clearSelection: () => void
  openLightbox: (id: number) => void
  /** Open an image that may lie outside the loaded pages, at `at` in the result. */
  openLightboxAt: (id: number, at: number) => void
  closeLightbox: () => void
  setPaletteOpen: (open: boolean) => void
  openBatch: (id: number) => void
  setAdding: (target: AddTarget | null) => void
}

function loadPrefs(): Prefs {
  const stored = readJson<Prefs & { sort: string }>(PREFS_KEY)
  const prefs: Prefs = { ...DEFAULT_PREFS, ...stored, sort: DEFAULT_PREFS.sort }
  // Prototype builds stored backend keys ("oldest", "name_asc"); map them onto base + reverse.
  const raw = stored.sort
  if (isSortBase(raw)) prefs.sort = raw
  else if (raw === 'oldest') Object.assign(prefs, { sort: 'newest', sortReverse: true })
  else if (raw === 'name_asc') prefs.sort = 'name'
  return prefs
}

const prefs = loadPrefs()
const storedLibrary = readJson<{ currentId: string }>(LIBRARY_KEY).currentId ?? 'main'

function readBrowse() {
  try {
    return parseBrowseStore(localStorage.getItem(BROWSE_KEY))
  } catch {
    return {}
  }
}

function saveBrowse(libraryId: string, state: BrowseState): void {
  writeJson(BROWSE_KEY, rememberBrowse(readBrowse(), libraryId, state))
}

const storedBrowse = recallBrowse(readBrowse(), storedLibrary)

function savePrefs(state: Prefs): void {
  const { layout, tileSize, cardOpen, railOpen, sort, sortReverse } = state
  writeJson(PREFS_KEY, { layout, tileSize, cardOpen, railOpen, sort, sortReverse })
}

export const useApp = create<AppState>((set, get) => ({
  ...prefs,
  libraryId: storedLibrary,
  queryText: storedBrowse.queryText,
  scope: storedBrowse.scope,
  inspectedId: null,
  selection: [],
  selectionAnchor: null,
  lightboxId: null,
  lightboxAt: null,
  paletteOpen: false,
  ...routeFromHash(),
  adding: null,

  setPage: (page) => {
    // The Batch tab opens the list; a batch opens through openBatch.
    writeHash(page, null)
    set({ page, batchId: null, lightboxId: null })
  },
  setLibrary: (id) => {
    writeJson(LIBRARY_KEY, { v: 2, currentId: id })
    // That library's own last search, not the one from the library we leave.
    const browse = recallBrowse(readBrowse(), id)
    set({
      libraryId: id,
      queryText: browse.queryText,
      scope: browse.scope,
      inspectedId: null,
      selection: [],
      selectionAnchor: null,
      batchId: null,
      adding: null,
    })
    if (get().page === 'batch') writeHash('batch', null)
  },
  setQueryText: (queryText) => {
    set({ queryText })
    saveBrowse(get().libraryId, { queryText, scope: get().scope })
  },
  setScope: (patch) => {
    const scope = { ...get().scope, ...patch }
    set({ scope })
    saveBrowse(get().libraryId, { queryText: get().queryText, scope })
  },
  setSort: (sort) => {
    set({ sort })
    savePrefs(get())
  },
  setSortReverse: (sortReverse) => {
    set({ sortReverse })
    savePrefs(get())
  },
  setLayout: (layout) => {
    set({ layout })
    savePrefs(get())
  },
  setTileSize: (tileSize) => {
    set({ tileSize })
    savePrefs(get())
  },
  toggleCard: () => {
    set({ cardOpen: !get().cardOpen })
    savePrefs(get())
  },
  toggleRail: () => {
    set({ railOpen: !get().railOpen })
    savePrefs(get())
  },
  inspect: (inspectedId) => set({ inspectedId }),
  togglePick: (id) => {
    const { selection } = get()
    const next = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]
    set({ selection: next, selectionAnchor: id })
  },
  selectRange: (ids) => {
    const { selection } = get()
    const merged = [...selection]
    for (const id of ids) if (!merged.includes(id)) merged.push(id)
    set({ selection: merged })
  },
  setSelection: (ids) => set({ selection: [...ids], selectionAnchor: ids.at(-1) ?? null }),
  clearSelection: () => set({ selection: [], selectionAnchor: null }),
  openLightbox: (lightboxId) => set({ lightboxId, lightboxAt: null, inspectedId: lightboxId }),
  openLightboxAt: (lightboxId, lightboxAt) => set({ lightboxId, lightboxAt, inspectedId: lightboxId }),
  closeLightbox: () => set({ lightboxId: null, lightboxAt: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openBatch: (batchId) => {
    writeHash('batch', batchId)
    set({ page: 'batch', batchId, lightboxId: null })
  },
  setAdding: (adding) => set({ adding }),
}))

window.addEventListener('hashchange', () => useApp.setState({ ...routeFromHash(), lightboxId: null }))
