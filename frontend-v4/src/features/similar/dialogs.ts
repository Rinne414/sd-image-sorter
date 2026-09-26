import { create } from 'zustand'

// Which of the similarity dialogs is open: comparing two images, or the
// duplicate review. Opened from the card menu, Ctrl K, the selection bar and
// the library status.

interface State {
  compare: readonly [number, number] | null
  duplicates: boolean
  openCompare: (a: number, b: number) => void
  closeCompare: () => void
  setDuplicates: (open: boolean) => void
}

export const useSimilarDialogs = create<State>((set) => ({
  compare: null,
  duplicates: false,
  openCompare: (a, b) => set({ compare: [a, b] }),
  closeCompare: () => set({ compare: null }),
  setDuplicates: (duplicates) => set({ duplicates }),
}))
