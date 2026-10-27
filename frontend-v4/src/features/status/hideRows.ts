import { create } from 'zustand'

// Two status lines the user can send away without losing the facts:
//  - the unreadable files line stays hidden while the number of unreadable
//    files is the one that was hidden, for this browser session (the classic
//    banner hides until the page is opened again; a changed number is news, so
//    it also brings the line back). The library report always lists them.
//  - the colour analysis line, while one run goes on (the run keeps going;
//    the Jobs drawer follows it).

const SESSION_KEY = 'sd-v4-unreadable-hidden'

/** Whether the unreadable line stays hidden: only while the count is the one hidden. */
export function stillHidden(hiddenAt: number | null, count: number): boolean {
  return hiddenAt !== null && count > 0 && hiddenAt === count
}

function readHiddenAt(): number | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeHiddenAt(count: number | null): void {
  try {
    if (count === null) sessionStorage.removeItem(SESSION_KEY)
    else sessionStorage.setItem(SESSION_KEY, String(count))
  } catch {
    // storage blocked: the line just comes back after a reload
  }
}

interface HideState {
  /** The number of unreadable files when the user hid the line. */
  unreadableAt: number | null
  /** The colour analysis run (Jobs id) whose line is hidden. */
  colorsJobId: string | null
  hideUnreadable: (count: number) => void
  showUnreadable: () => void
  hideColors: (jobId: string) => void
}

export const useRowHides = create<HideState>((set) => ({
  unreadableAt: readHiddenAt(),
  colorsJobId: null,
  hideUnreadable: (count) => {
    writeHiddenAt(count)
    set({ unreadableAt: count })
  },
  showUnreadable: () => {
    writeHiddenAt(null)
    set({ unreadableAt: null })
  },
  hideColors: (colorsJobId) => set({ colorsJobId }),
}))
