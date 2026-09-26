import { create } from 'zustand'
import type { BatchKind } from '../api/types'
import { parseBrowseStore, recallBrowse, rememberBrowse, type BrowseState, type Scope } from '../lib/browseMemory'
import { isMainPage, isStartPage, parseRoute, routeHash, startRoute, type MainPage, type Page, type Route, type SettingsTab, type StartPage, type ToolId } from '../lib/route'
import { isSortBase, type SortBase } from '../lib/sort'
// First: arriving from V3.5 rewrites the address (drops ?library=, reopens the page V4 was left from).
import './arrival'

export type { MainPage, Page, SettingsTab, StartPage, ToolId }
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
  /** The page a plain launch opens on (Settings › Appearance). */
  startPage: StartPage
  /** Home shows the ★5 film strip (off while sharing the screen). */
  homeFilm: boolean
}

const DEFAULT_PREFS: Prefs = {
  layout: 'masonry',
  tileSize: 'm',
  cardOpen: true,
  railOpen: true,
  sort: 'newest',
  sortReverse: false,
  // V3.5 opens on its entry page at launch, with the ★5 cover art on.
  startPage: 'home',
  homeFilm: true,
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

function writeHash(route: Route): void {
  const hash = routeHash(route)
  if (location.hash !== hash) history.replaceState(null, '', hash)
}

/** Where "← back" on the settings and tools pages returns to. */
interface Back {
  page: MainPage
  batchId: number | null
}

type RouteState = Pick<AppState, 'page' | 'batchId' | 'settingsTab' | 'toolId' | 'back'>

/**
 * The state a route shows. Going from a main page to settings or a tool
 * remembers that page for "back"; the tab and tool not on screen keep their
 * last value, so ⚙ opens the tab used last.
 */
function stateFor(route: Route, from: RouteState): RouteState {
  const back = isMainPage(from.page) ? { page: from.page, batchId: from.batchId } : from.back
  if (route.page === 'settings') return { ...from, page: 'settings', batchId: null, settingsTab: route.tab, back }
  if (route.page === 'tools') return { ...from, page: 'tools', batchId: null, toolId: route.tool, back }
  return { ...from, page: route.page, batchId: route.batchId }
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
  /** The Settings page's tab (kept while elsewhere: ⚙ reopens it). */
  settingsTab: SettingsTab
  /** The tool on the Tools page. */
  toolId: ToolId
  /** The main page the settings and tools pages go back to. */
  back: Back
  adding: AddTarget | null

  setPage: (page: Page) => void
  openSettings: (tab?: SettingsTab) => void
  openTool: (tool: ToolId) => void
  /** Leave settings or a tool for the page it was opened from. */
  goBack: () => void
  setLibrary: (id: string) => void
  setQueryText: (text: string) => void
  setScope: (patch: Partial<Scope>) => void
  setSort: (sort: SortBase) => void
  setSortReverse: (reverse: boolean) => void
  setLayout: (layout: Layout) => void
  setTileSize: (size: TileSize) => void
  toggleCard: () => void
  toggleRail: () => void
  setStartPage: (startPage: StartPage) => void
  setHomeFilm: (homeFilm: boolean) => void
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
  if (!isStartPage(prefs.startPage)) prefs.startPage = DEFAULT_PREFS.startPage
  if (typeof prefs.homeFilm !== 'boolean') prefs.homeFilm = DEFAULT_PREFS.homeFilm
  return prefs
}

const prefs = loadPrefs()

// A plain launch opens the start page; an address that names a page (or the
// page V4 was left from, put back by ./arrival) opens that page.
const initialRoute = stateFor(startRoute(location.hash, prefs.startPage), {
  page: 'library',
  batchId: null,
  settingsTab: 'appearance',
  toolId: 'reader',
  back: { page: 'library', batchId: null },
})
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
  const { layout, tileSize, cardOpen, railOpen, sort, sortReverse, startPage, homeFilm } = state
  writeJson(PREFS_KEY, { layout, tileSize, cardOpen, railOpen, sort, sortReverse, startPage, homeFilm })
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
  ...initialRoute,
  adding: null,

  setPage: (page) => {
    // The Batch tab opens the list; a batch opens through openBatch.
    const s = get()
    const route: Route = page === 'settings' ? { page, tab: s.settingsTab } : page === 'tools' ? { page, tool: s.toolId } : { page, batchId: null }
    go(route)
  },
  openSettings: (tab) => go({ page: 'settings', tab: tab ?? get().settingsTab }),
  openTool: (tool) => go({ page: 'tools', tool }),
  goBack: () => go(get().back),
  setLibrary: (id) => {
    writeJson(LIBRARY_KEY, { v: 2, currentId: id })
    // That library's own last search, not the one from the library we leave.
    const browse = recallBrowse(readBrowse(), id)
    const back = get().back.page === 'batch' ? { page: 'batch' as const, batchId: null } : get().back
    set({
      libraryId: id,
      queryText: browse.queryText,
      scope: browse.scope,
      inspectedId: null,
      selection: [],
      selectionAnchor: null,
      batchId: null,
      back,
      adding: null,
    })
    if (get().page === 'batch') writeHash({ page: 'batch', batchId: null })
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
  setStartPage: (startPage) => {
    set({ startPage })
    savePrefs(get())
  },
  setHomeFilm: (homeFilm) => {
    set({ homeFilm })
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
  openBatch: (batchId) => go({ page: 'batch', batchId }),
  setAdding: (adding) => set({ adding }),
}))

/** Show a route and write it into the address. */
function go(route: Route): void {
  writeHash(route)
  useApp.setState((s) => ({ ...stateFor(route, s), lightboxId: null }))
}

window.addEventListener('hashchange', () => useApp.setState((s) => ({ ...stateFor(parseRoute(location.hash), s), lightboxId: null })))
