import { create } from 'zustand'
import type { MovingPick } from './mediaKind'

// Whether the GIF and video dialog is open, and what it was opened for: the
// moving pictures picked in the library, or null for "a folder, chosen in the
// dialog". The censor step's button and the library's Censor… share it.

interface MediaDialogState {
  open: boolean
  picks: MovingPick[] | null
  show: (picks: MovingPick[] | null) => void
  close: () => void
}

export const useMediaDialog = create<MediaDialogState>((set) => ({
  open: false,
  picks: null,
  show: (picks) => set({ open: true, picks: picks ? [...picks] : null }),
  close: () => set({ open: false, picks: null }),
}))

export const openMediaCensor = (picks: MovingPick[] | null = null) => useMediaDialog.getState().show(picks)
