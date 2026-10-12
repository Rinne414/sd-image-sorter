import { create } from 'zustand'
import { useCensorPanel } from './panel'
import { useCanvasPixels } from './pixels'

// Turning "show changes" on. Comparing every pixel of a very large picture
// takes a moment, so above LARGE_PIXELS the editor asks first (V3.5 did too).

export const LARGE_PIXELS = 20_000_000

/** The question waiting for an answer (shown by the editor): the picture's size in megapixels. */
export const useChangesAsk = create<{ megapixels: number | null }>(() => ({ megapixels: null }))

export function requestShowChanges(on: boolean): void {
  if (!on) return useCensorPanel.getState().setShowChanges(false)
  const result = useCanvasPixels.getState().result
  const pixels = result ? result.width * result.height : 0
  if (pixels > LARGE_PIXELS) return useChangesAsk.setState({ megapixels: Math.round(pixels / 1e6) })
  useCensorPanel.getState().setShowChanges(true)
}
