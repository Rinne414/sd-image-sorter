import { create } from 'zustand'

// 提示词助手's mode (remembered across restarts) and the two images Compare
// shows (kept while the user is elsewhere in the app).

export const MODES = ['stats', 'compare', 'build'] as const
export type LabMode = (typeof MODES)[number]

const MODE_KEY = 'sd-v4-promptlab-mode'

function loadMode(): LabMode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    return MODES.find((m) => m === saved) ?? 'stats'
  } catch {
    return 'stats'
  }
}

export const useLabMode = create<{ mode: LabMode }>(() => ({ mode: loadMode() }))

export function setMode(mode: LabMode): void {
  useLabMode.setState({ mode })
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // storage blocked: the mode is kept for this visit only
  }
}

// ---- Compare ------------------------------------------------------------------

export type Side = 'a' | 'b'

interface Picks {
  a: number | null
  b: number | null
  /** How many images were picked in the library when A and B came from there (0: chosen here). */
  fromSelection: number
}

export const useComparePicks = create<Picks>(() => ({ a: null, b: null, fromSelection: 0 }))

/** A and B from the library: the first two picked, else the image being looked at as A. */
export function picksFrom(selection: readonly number[], inspected: number | null): Picks {
  if (selection.length >= 2) return { a: selection[0] ?? null, b: selection[1] ?? null, fromSelection: selection.length }
  return { a: selection[0] ?? inspected, b: null, fromSelection: 0 }
}

/** Compare opened with nothing chosen yet: start from the library's picks. */
export function seedPicks(selection: readonly number[], inspected: number | null): void {
  const s = useComparePicks.getState()
  if (s.a === null && s.b === null) useComparePicks.setState(picksFrom(selection, inspected))
}

export function takeSelectionPicks(selection: readonly number[]): void {
  useComparePicks.setState(picksFrom(selection, null))
}

export function setPick(side: Side, id: number): void {
  useComparePicks.setState({ [side]: id, fromSelection: 0 })
}

export function swapPicks(): void {
  const { a, b } = useComparePicks.getState()
  useComparePicks.setState({ a: b, b: a })
}
