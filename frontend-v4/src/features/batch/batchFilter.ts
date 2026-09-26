// Narrowing a batch's image strip: by file name (only the view changes) and by
// the library's search conditions (the matches can then be selected).

interface Named {
  key: string
  filename: string
}

/** The entries whose file name contains `text` (any case); the same list for an empty text. */
export function byName<T extends Named>(entries: readonly T[], text: string): readonly T[] {
  const needle = text.trim().toLowerCase()
  return needle ? entries.filter((entry) => entry.filename.toLowerCase().includes(needle)) : entries
}

/** The keys the name filter shows; null when it shows everything. */
export function shownKeys(entries: readonly Named[], text: string): ReadonlySet<string> | null {
  return text.trim() ? new Set(byName(entries, text).map((entry) => entry.key)) : null
}

/** The batch's entries among the library images a search matched, in batch order. */
export function matchKeys(entries: readonly { key: string; imageId: number | null }[], matched: readonly number[]): ReadonlySet<string> {
  const ids = new Set(matched)
  return new Set(entries.filter((entry) => entry.imageId !== null && ids.has(entry.imageId)).map((entry) => entry.key))
}
