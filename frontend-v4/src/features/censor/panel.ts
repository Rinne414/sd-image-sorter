import { create } from 'zustand'

// Which tab the censor tool panel shows, and a request to open an image (for
// work that ends while the editor is open, e.g. "detect all" opening review).
// "review" is the review mode: its keys and the region outlines are on.

export type PanelTab = 'brush' | 'detect' | 'review'

interface PanelState {
  tab: PanelTab
  /** Open this image in the batch's editor (handled and cleared by the editor). */
  jump: { batchId: number; imageId: number } | null
  setTab: (tab: PanelTab) => void
}

export const useCensorPanel = create<PanelState>((set) => ({
  tab: 'brush',
  jump: null,
  setTab: (tab) => set({ tab }),
}))
