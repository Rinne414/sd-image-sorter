// "Reset all settings" (owner baseline, docs/DESIGN.md §redesign-2026-10):
// every preference this interface keeps in the browser goes back to its
// default. The user's work stays: libraries and images, the open library and
// its searches, saved searches, batches, drafts, recent folders, resumable
// jobs, AI services and keys, models (those live on the server or are work,
// not settings).

/** Preferences kept in this browser: how things look and behave. */
export const SETTING_KEYS: readonly string[] = [
  // look and start
  'sd-v4-prefs',
  'sd-v4-ui-scale',
  'sd-v4-theme',
  'sd-image-sorter-lang',
  'sd-v4-update-autocheck',
  'sd-v4-auto-refresh',
  // panels shown or folded, and which places the top bar shows (Customize top bar)
  'sd-v4-nav-places',
  'sd-next-nav-places',
  'sd-v4-rail-folded',
  'sd-v4-folder-tree',
  'sd-v4-lightbox-info',
  'sd-v4-video-viewer',
  'sd-v4-reader-folds',
  'sd-v4-lexicon',
  // tool and step options
  'sd-v4-sort-info',
  'sd-v4-sort-auto-preview',
  'manual_sort_cooldown_ms_v1',
  'sort-audio-enabled',
  'manual_sort_zen_v1',
  'manual_sort_exclude_sorted_v1',
  'sd-v4-tag-options',
  'sd-v4-privacy-options',
  'sd-v4-privacy-disguise',
  'sd-v4-reverse-options',
  'sd-v4-promptlab-mode',
  'sd-v4-export-format',
  'sd-v4-pixiv-export',
  'sd-v4-dataset-check',
  'sd-v4-caption-zh',
  'sd-tipo-model-v1',
  'sd-image-sorter-artist-defaults-v1',
  'sd-v4-generator-seed-mode',
  'sd-image-sorter-tagger-defaults-v1',
  // the Style Map: what places the pictures, the dot colour, landmarks and axis labels (shared with the classic page)
  'sd-stylemap-space',
  'sd-stylemap-color-by',
  'sd-stylemap-landmarks',
  'sd-stylemap-axis-labels',
  // Not here on purpose: the Style Map's own axes (`sd-stylemap-custom-axes:<library>`) are the
  // user's work (example pictures and names), not a preference; a reset must not wipe them.
]

/** Censor tool options share a prefix (brush, style, detection). */
const SETTING_PREFIXES: readonly string[] = ['sd-v4-censor-']

export function isSettingKey(key: string): boolean {
  return SETTING_KEYS.includes(key) || SETTING_PREFIXES.some((p) => key.startsWith(p))
}

interface KeyStore {
  readonly length: number
  key(index: number): string | null
  removeItem(key: string): void
}

/** Remove every setting from `store`; returns the keys removed. */
export function resetAllSettings(store: KeyStore): string[] {
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (key !== null && isSettingKey(key)) keys.push(key)
  }
  for (const key of keys) store.removeItem(key)
  return keys
}
