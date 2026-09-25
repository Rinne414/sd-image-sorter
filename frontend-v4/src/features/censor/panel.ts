import { create } from 'zustand'

// Which tab the censor tool panel shows, and a request to open an image (for
// work that ends while the editor is open, e.g. "detect all" opening review).
// "review" is the review mode: its keys and the region outlines are on. Also
// "show changes" and the filmstrip's picked images (Ctrl/Shift+click), which
// the Adjust tab can apply its filters to.

export type PanelTab = 'brush' | 'adjust' | 'detect' | 'review'

interface PanelState {
  tab: PanelTab
  /** Open this image in the batch's editor (handled and cleared by the editor). */
  jump: { batchId: number; imageId: number } | null
  /** Pixels that differ from the original are highlighted. */
  showChanges: boolean
  /** Filmstrip picks: image ids of one batch, and the last one clicked (for Shift ranges). */
  picked: { batchId: number; ids: number[]; anchor: number | null }
  setTab: (tab: PanelTab) => void
  setShowChanges: (on: boolean) => void
}

export const useCensorPanel = create<PanelState>((set) => ({
  tab: 'brush',
  jump: null,
  showChanges: false,
  picked: { batchId: 0, ids: [], anchor: null },
  setTab: (tab) => set({ tab }),
  setShowChanges: (showChanges) => set({ showChanges }),
}))

/** The ids picked in this batch's filmstrip. */
export function pickedIn(batchId: number): number[] {
  const { picked } = useCensorPanel.getState()
  return picked.batchId === batchId ? picked.ids : []
}

/** Ctrl+click toggles one image; Shift+click picks the range from the last click; a plain click clears the picks. */
export function pickClick(batchId: number, order: readonly number[], imageId: number, mode: 'toggle' | 'range' | 'clear'): void {
  const now = pickedIn(batchId)
  const anchor = useCensorPanel.getState().picked.anchor
  let ids: number[] = []
  if (mode === 'toggle') ids = now.includes(imageId) ? now.filter((id) => id !== imageId) : [...now, imageId]
  if (mode === 'range') {
    const from = order.indexOf(anchor ?? imageId)
    const to = order.indexOf(imageId)
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const range = from < 0 ? [imageId] : order.slice(lo, hi + 1)
    ids = [...now, ...range.filter((id) => !now.includes(id))]
  }
  useCensorPanel.setState({ picked: { batchId, ids, anchor: mode === 'range' ? anchor : imageId } })
}
