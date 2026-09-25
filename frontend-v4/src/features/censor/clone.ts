import { create } from 'zustand'

// The clone stamp's source on the image open in the editor. Alt+click sets it;
// the first stroke after that fixes the offset (source minus where the stroke
// starts), and every later stroke copies from the same offset ("aligned"), as
// in V3.5, until a new source is set. Opening another image forgets it.

interface CloneState {
  imageId: number | null
  /** Where Alt+click was, in image pixels. */
  source: [number, number] | null
  offset: [number, number] | null
}

export const useCloneSource = create<CloneState>(() => ({ imageId: null, source: null, offset: null }))

export function setCloneSource(imageId: number, x: number, y: number): void {
  useCloneSource.setState({ imageId, source: [Math.round(x), Math.round(y)], offset: null })
}

export function cloneSourceOf(imageId: number): CloneState {
  const s = useCloneSource.getState()
  return s.imageId === imageId ? s : { imageId, source: null, offset: null }
}

/** The offset a stroke starting at (x, y) copies from; null when no source is set. */
export function cloneOffsetFor(imageId: number, x: number, y: number): [number, number] | null {
  const s = cloneSourceOf(imageId)
  if (!s.source) return null
  if (s.offset) return s.offset
  const offset: [number, number] = [s.source[0] - Math.round(x), s.source[1] - Math.round(y)]
  useCloneSource.setState({ offset })
  return offset
}
