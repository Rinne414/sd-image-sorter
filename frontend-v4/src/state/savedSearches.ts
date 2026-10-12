import { create } from 'zustand'

// Smart filters: saved query lines, one list per library (like V3.5 presets,
// which were global and confused libraries). Kept in localStorage for now.

export interface SavedSearch {
  id: string
  name: string
  query: string
}

const KEY = 'sd-v4-saved-searches'

type Store = Record<string, SavedSearch[]>

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    const v: unknown = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? (v as Store) : {}
  } catch {
    return {}
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // storage blocked: the list lasts for this session only
  }
}

interface State {
  byLibrary: Store
  add: (libraryId: string, name: string, query: string) => void
  remove: (libraryId: string, id: string) => SavedSearch | null
  restore: (libraryId: string, saved: SavedSearch, index: number) => void
}

export const useSavedSearches = create<State>((set, get) => ({
  byLibrary: read(),
  add: (libraryId, name, query) => {
    const list = get().byLibrary[libraryId] ?? []
    const entry: SavedSearch = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, query }
    const byLibrary = { ...get().byLibrary, [libraryId]: [...list, entry] }
    write(byLibrary)
    set({ byLibrary })
  },
  remove: (libraryId, id) => {
    const list = get().byLibrary[libraryId] ?? []
    const gone = list.find((s) => s.id === id) ?? null
    const byLibrary = { ...get().byLibrary, [libraryId]: list.filter((s) => s.id !== id) }
    write(byLibrary)
    set({ byLibrary })
    return gone
  },
  restore: (libraryId, saved, index) => {
    const list = [...(get().byLibrary[libraryId] ?? [])]
    list.splice(Math.min(index, list.length), 0, saved)
    const byLibrary = { ...get().byLibrary, [libraryId]: list }
    write(byLibrary)
    set({ byLibrary })
  },
}))
