// The check step's thresholds, kept for this browser (a convenience, never
// needed for correctness: the defaults are V3.5's audit defaults).

export interface CheckOptions {
  /** Flag images whose shorter side is under this many pixels (0: do not check). */
  minSide: number
  /** Flag images whose aesthetic score is under this (0: do not check). */
  minAesthetic: number
  /** Near duplicates: perceptual-hash distance at most this (0: identical pictures only). */
  nearDistance: number
  /** Compare every pair for near duplicates even on a large set (slower). */
  everyPair: boolean
  /** Score folder images with the aesthetic model now (they have no stored score). */
  scoreFolders: boolean
}

export const DEFAULT_CHECK_OPTIONS: CheckOptions = { minSide: 512, minAesthetic: 4.5, nearDistance: 5, everyPair: false, scoreFolders: false }

const KEY = 'sd-v4-dataset-check'

const inRange = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback)

export function loadCheckOptions(): CheckOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    const d = DEFAULT_CHECK_OPTIONS
    return {
      minSide: inRange(raw.minSide, 0, 8192, d.minSide),
      minAesthetic: inRange(raw.minAesthetic, 0, 10, d.minAesthetic),
      nearDistance: inRange(raw.nearDistance, 0, 64, d.nearDistance),
      everyPair: raw.everyPair === true,
      scoreFolders: raw.scoreFolders === true,
    }
  } catch {
    return DEFAULT_CHECK_OPTIONS
  }
}

export function saveCheckOptions(o: CheckOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o))
  } catch {
    // storage blocked: the defaults come back next time
  }
}
