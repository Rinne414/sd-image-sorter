import { create } from 'zustand'

// Which left-rail sections are folded, remembered across reloads (V3.5 kept
// one flag per section too). Only folded sections are stored.

export type RailSectionId = 'saved' | 'sources' | 'folders' | 'status'

const KEY = 'sd-v4-rail-folded'

function load(): Partial<Record<RailSectionId, boolean>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Partial<Record<RailSectionId, boolean>>) : {}
  } catch {
    return {}
  }
}

export const useRailSections = create<{ folded: Partial<Record<RailSectionId, boolean>>; toggle: (id: RailSectionId) => void }>((set, get) => ({
  folded: load(),
  toggle: (id) => {
    const folded = { ...get().folded, [id]: !get().folded[id] }
    if (!folded[id]) delete folded[id]
    try {
      localStorage.setItem(KEY, JSON.stringify(folded))
    } catch {
      // storage blocked: the sections just won't stay folded
    }
    set({ folded })
  },
}))
