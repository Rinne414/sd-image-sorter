import { ARTIST_KEY, parsePrefs, type ArtistPrefs } from '../../tools/artist/artistPrefs'
import { TAGGER_DEFAULTS_KEY, FALLBACK_CHARACTER_THRESHOLD, FALLBACK_THRESHOLD, type SavedTaggerDefaults } from '../../tagging/savedDefaults'
import { TAG_OPTIONS_KEY } from '../../tagging/tagOptions'

// AI defaults (Settings > AI): the tagger's and the style finder's starting
// values, saved in the keys V3.5 uses and reset to the program's own. The
// pure parts: what the status lines say, and taking a copy of everything a
// reset touches so Undo can put it back.

/** The three keys a reset touches: V3.5's tagger defaults, V Opus's remembered tag choices, the style finder's settings. */
export const DEFAULT_KEYS: readonly string[] = [TAGGER_DEFAULTS_KEY, TAG_OPTIONS_KEY, ARTIST_KEY]

interface KeyStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** What the keys hold now (null: not set). */
export type Snapshot = Record<string, string | null>

export function takeSnapshot(store: KeyStore, keys: readonly string[] = DEFAULT_KEYS): Snapshot {
  return Object.fromEntries(keys.map((key) => [key, store.getItem(key)]))
}

/** Put every key back as it was in `snapshot`. */
export function restoreSnapshot(store: KeyStore, snapshot: Snapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  }
}

/** The style finder's settings as a snapshot holds them (defaults when none or unreadable). */
export function artistPrefsOf(snapshot: Snapshot): ArtistPrefs {
  const raw = snapshot[ARTIST_KEY]
  try {
    return parsePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return parsePrefs(null)
  }
}

export interface TaggerLine {
  model: string
  general: string
  character: string
  device: 'gpu' | 'cpu'
}

/** What the tagger line shows for the saved defaults (null: none saved). */
export function taggerLine(d: SavedTaggerDefaults | null): TaggerLine | null {
  if (!d) return null
  return {
    model: d.modelName,
    general: (d.threshold ?? FALLBACK_THRESHOLD).toFixed(2),
    character: (d.characterThreshold ?? FALLBACK_CHARACTER_THRESHOLD).toFixed(2),
    device: d.useGpu === false ? 'cpu' : 'gpu',
  }
}

export interface ArtistLine {
  source: 'huggingface' | 'modelscope' | 'local'
  threshold: string
  device: 'gpu' | 'cpu'
}

/** What the style finder line shows for the settings stored in `raw` (null: nothing stored). */
export function artistLine(raw: string | null): ArtistLine | null {
  if (raw === null) return null
  const prefs = artistPrefsOf({ [ARTIST_KEY]: raw })
  return { source: prefs.modelSource, threshold: prefs.threshold.toFixed(2), device: prefs.useGpu ? 'gpu' : 'cpu' }
}
