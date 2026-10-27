import { COLOR_FIELDS, SPACES, type ColorBy, type Space } from './types'

// What the Style Map remembers in this browser. The dot colour, the landmarks
// and the axis labels share the classic page's keys (both interfaces show the
// same choices); the space is remembered here too, so the map reopens where
// the user left it. Every key is listed in lib/resetSettings.ts.

export const PREF_KEYS = {
  space: 'sd-stylemap-space',
  colorBy: 'sd-stylemap-color-by',
  landmarks: 'sd-stylemap-landmarks',
  labels: 'sd-stylemap-axis-labels',
} as const

export const DEFAULT_SPACE: Space = 'kaloscope'
export const DEFAULT_COLOR_BY: ColorBy = 'generator'

export interface StyleMapPrefs {
  space: Space
  colorBy: ColorBy
  landmarks: boolean
  labels: boolean
}

type Read = (key: string) => string | null

export function parseSpace(value: string | null): Space {
  return SPACES.find((s) => s === value) ?? DEFAULT_SPACE
}

export function parseColorBy(value: string | null): ColorBy {
  return COLOR_FIELDS.find((c) => c === value) ?? DEFAULT_COLOR_BY
}

/** A switch that is on unless it was turned off (the classic page writes 'on' / 'off'). */
export const parseSwitch = (value: string | null): boolean => value !== 'off'

export function readPrefs(read: Read): StyleMapPrefs {
  const safe = (key: string) => {
    try {
      return read(key)
    } catch {
      return null
    }
  }
  return {
    space: parseSpace(safe(PREF_KEYS.space)),
    colorBy: parseColorBy(safe(PREF_KEYS.colorBy)),
    landmarks: parseSwitch(safe(PREF_KEYS.landmarks)),
    labels: parseSwitch(safe(PREF_KEYS.labels)),
  }
}

/** The stored text of one preference (switches as 'on' / 'off', like the classic page). */
export function storedValue(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return value
}

export function writePref<K extends keyof StyleMapPrefs>(key: K, value: StyleMapPrefs[K]): void {
  try {
    localStorage.setItem(PREF_KEYS[key], storedValue(value))
  } catch {
    // storage blocked: the choice holds for this visit
  }
}

export function loadPrefs(): StyleMapPrefs {
  try {
    return readPrefs((key) => localStorage.getItem(key))
  } catch {
    return readPrefs(() => null)
  }
}
