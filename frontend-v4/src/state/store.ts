import { create } from 'zustand'
import type { SortKey } from '../lib/query'

export type Page = 'home' | 'library' | 'batch' | 'sort'
export type Layout = 'masonry' | 'grid'
export type TileSize = 's' | 'm' | 'l'

// Shared with V3.5 (same origin), so both apps open the same library.
const LIBRARY_KEY = 'sd-library-workspace-v1'
const PREFS_KEY = 'sd-v4-prefs'

interface Prefs {
  layout: Layout
  tileSize: TileSize
  cardOpen: boolean
  railOpen: boolean
  sort: SortKey
}

const DEFAULT_PREFS: Prefs = { layout: 'masonry', tileSize: 'm', cardOpen: true, railOpen: true, sort: 'newest' }

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

function pageFromHash(): Page {
  const h = location.hash.replace(/^#\/?/, '')
  return h === 'home' || h === 'batch' || h === 'sort' ? h : 'library'
}

export interface Scope {
  generators: string[]
  folder: string | null
  favorites: boolean
}

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
  paletteOpen: boolean

  setPage: (page: Page) => void
  setLibrary: (id: string) => void
  setQueryText: (text: string) => void
  setScope: (patch: Partial<Scope>) => void
  setSort: (sort: SortKey) => void
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
  closeLightbox: () => void
  setPaletteOpen: (open: boolean) => void
}

const prefs: Prefs = { ...DEFAULT_PREFS, ...readJson<Prefs>(PREFS_KEY) }
const storedLibrary = readJson<{ currentId: string }>(LIBRARY_KEY).currentId ?? 'main'

function savePrefs(state: Prefs): void {
  const { layout, tileSize, cardOpen, railOpen, sort } = state
  writeJson(PREFS_KEY, { layout, tileSize, cardOpen, railOpen, sort })
}

export const useApp = create<AppState>((set, get) => ({
  ...prefs,
  page: pageFromHash(),
  libraryId: storedLibrary,
  queryText: '',
  scope: { generators: [], folder: null, favorites: false },
  inspectedId: null,
  selection: [],
  selectionAnchor: null,
  lightboxId: null,
  paletteOpen: false,

  setPage: (page) => {
    if (location.hash !== `#/${page}`) history.replaceState(null, '', `#/${page}`)
    set({ page })
  },
  setLibrary: (id) => {
    writeJson(LIBRARY_KEY, { v: 2, currentId: id })
    set({
      libraryId: id,
      scope: { generators: [], folder: null, favorites: false },
      inspectedId: null,
      selection: [],
      selectionAnchor: null,
    })
  },
  setQueryText: (queryText) => set({ queryText }),
  setScope: (patch) => set({ scope: { ...get().scope, ...patch } }),
  setSort: (sort) => {
    set({ sort })
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
  openLightbox: (lightboxId) => set({ lightboxId, inspectedId: lightboxId }),
  closeLightbox: () => set({ lightboxId: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}))

window.addEventListener('hashchange', () => useApp.setState({ page: pageFromHash() }))
