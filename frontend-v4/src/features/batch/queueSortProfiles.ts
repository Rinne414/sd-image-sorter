import { create } from 'zustand'
import { parseProfiles, type Profile } from './queueSort'

// The saved queue-sort profiles: named lists of rules, kept in this browser
// like the Sort page's presets (they are the user's work, so Reset all
// settings leaves them). The classic page keeps its own under
// queue_solitaire_auto_sort_profiles_v1 in a different shape.

export const PROFILES_KEY = 'sd-v4-queue-sort-profiles'

function read(): Profile[] {
  try {
    return parseProfiles(localStorage.getItem(PROFILES_KEY))
  } catch {
    return []
  }
}

function write(list: readonly Profile[]): void {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(list))
  } catch {
    // storage blocked: the profiles last until the page closes
  }
}

interface State {
  profiles: readonly Profile[]
  /** Replace the whole list (saved at once). */
  set: (next: readonly Profile[]) => void
}

export const useQueueProfiles = create<State>((set) => ({
  profiles: read(),
  set: (next) => {
    write(next)
    set({ profiles: next })
  },
}))
