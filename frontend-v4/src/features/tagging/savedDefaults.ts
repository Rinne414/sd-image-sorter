import type { TagOptions } from './tagOptions'

// The tagger's saved defaults ("Save as defaults" in Settings > AI). Kept in
// the key V3.5 uses, in V3.5's shape, so both interfaces start from the same
// choices. V Opus also remembers the last choices on their own
// (tagOptions.ts); these are what the tag panel starts from when nothing else
// is remembered, and what "Reset" goes back to.

export const TAGGER_DEFAULTS_KEY = 'sd-image-sorter-tagger-defaults-v1'

/** V3.5's own fallbacks, for a tagger whose thresholds are not known. */
export const FALLBACK_THRESHOLD = 0.35
export const FALLBACK_CHARACTER_THRESHOLD = 0.85

export interface SavedTaggerDefaults {
  modelName: string
  threshold: number | null
  characterThreshold: number | null
  useGpu: boolean | null
  /** V3.5 only; kept as it was saved. */
  batchSize: string
  customProfile: string
  customModelPath: string
  customTagsPath: string
}

const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Read what was saved; null when nothing usable is there (no tagger named). */
export function parseTaggerDefaults(value: unknown): SavedTaggerDefaults | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const modelName = str(raw.modelName)
  if (!modelName) return null
  return {
    modelName,
    threshold: unit(raw.threshold),
    characterThreshold: unit(raw.characterThreshold),
    useGpu: typeof raw.useGpu === 'boolean' ? raw.useGpu : null,
    batchSize: raw.batchSize != null ? String(raw.batchSize) : '',
    customProfile: str(raw.customProfile),
    customModelPath: str(raw.customModelPath),
    customTagsPath: str(raw.customTagsPath),
  }
}

/** The tag panel's current choices as V3.5 stores them. A tagger's own default thresholds are written out (V3.5 has no "model default"). */
export function taggerDefaultsOf(
  o: TagOptions,
  own: { threshold?: number; characterThreshold?: number },
  previous: SavedTaggerDefaults | null,
): Record<string, unknown> {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    modelName: o.model,
    threshold: o.threshold ?? own.threshold ?? FALLBACK_THRESHOLD,
    characterThreshold: o.characterThreshold ?? own.characterThreshold ?? FALLBACK_CHARACTER_THRESHOLD,
    useGpu: o.useGpu,
    batchSize: previous?.batchSize ?? '',
    customProfile: o.custom.profile,
    customModelPath: o.custom.modelPath.trim(),
    customTagsPath: o.custom.tagsPath.trim(),
  }
}

export function readTaggerDefaults(): SavedTaggerDefaults | null {
  try {
    const text = localStorage.getItem(TAGGER_DEFAULTS_KEY)
    return parseTaggerDefaults(text ? JSON.parse(text) : null)
  } catch {
    return null
  }
}

/** false when the browser would not store it (the caller says so). */
export function writeTaggerDefaults(payload: Record<string, unknown>): boolean {
  try {
    localStorage.setItem(TAGGER_DEFAULTS_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function clearTaggerDefaults(): void {
  try {
    localStorage.removeItem(TAGGER_DEFAULTS_KEY)
  } catch {
    // storage blocked: nothing was saved either
  }
}
