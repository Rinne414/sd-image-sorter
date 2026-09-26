// Password digits and the two compatibility modes, ported from V3.5's
// frontend/js/obfuscate-engine.js. Big Tomato (dfqtphx) reads the first two
// characters as the number of scramble passes and the next two as extra width
// and height; Small Tomato (singularpoint) has no password at all.

export type CompatMode = 'big_tomato' | 'small_tomato'

export interface Password {
  step: number
  extraWidth: number
  extraHeight: number
}

const NO_PASSWORD: Password = { step: 1, extraWidth: 0, extraHeight: 0 }

export function normalizeCompatMode(value: unknown): CompatMode {
  return value === 'small_tomato' ? 'small_tomato' : 'big_tomato'
}

/** Exactly the site's reading: "0512" is 5 passes, 1 extra column, 2 extra rows; anything unreadable counts as the default. */
export function parsePassword(raw: string | null | undefined): Password {
  if (!raw) return { ...NO_PASSWORD }
  const source = String(raw)
  const stepPart = source.slice(0, 2)
  const extraWidthPart = source[2] || ''
  const extraHeightPart = source[3] || ''
  return {
    step: Math.max(1, parseInt(stepPart, 10) || 1),
    extraWidth: parseInt(extraWidthPart, 10) || 0,
    extraHeight: parseInt(extraHeightPart, 10) || 0,
  }
}

export function resolvePassword(raw: string | null | undefined, compat: unknown): Password {
  return normalizeCompatMode(compat) === 'small_tomato' ? { ...NO_PASSWORD } : parsePassword(raw)
}

/** The key the text crypto shifts characters by. */
export function passwordKey(password: Password): number[] {
  return [password.step, password.extraWidth, password.extraHeight]
}

/** Only four digits decode on the Big Tomato site too; other passwords work here only. */
export const isSitePassword = (raw: string): boolean => raw === '' || /^\d{4}$/.test(raw)
