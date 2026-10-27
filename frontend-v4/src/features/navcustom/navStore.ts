import { create, type UseBoundStore, type StoreApi } from 'zustand'
import { defaultChoice, parseChoice, type NavChoice, type NavDef } from './navChoice'

/** The top bar's choice of places, kept in this browser under its own key. */
export interface NavStore {
  choice: NavChoice
  set: (choice: NavChoice) => void
  reset: () => void
}

function read(key: string, defs: readonly NavDef[]): NavChoice {
  try {
    return parseChoice(localStorage.getItem(key), defs)
  } catch {
    return defaultChoice(defs)
  }
}

function write(key: string, choice: NavChoice): void {
  try {
    localStorage.setItem(key, JSON.stringify(choice))
  } catch {
    // storage blocked: the choice just lasts until the page closes
  }
}

/** One store per interface: V Opus and /next/ each have their own places and key. */
export function createNavStore(key: string, defs: readonly NavDef[]): UseBoundStore<StoreApi<NavStore>> {
  return create<NavStore>((set) => ({
    choice: read(key, defs),
    set: (choice) => {
      write(key, choice)
      set({ choice })
    },
    reset: () => {
      try {
        localStorage.removeItem(key)
      } catch {
        // nothing stored that could be removed
      }
      set({ choice: defaultChoice(defs) })
    },
  }))
}

/** Whether Customize places… is open (one top bar exists at a time). */
export const useNavCustomizeOpen = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
