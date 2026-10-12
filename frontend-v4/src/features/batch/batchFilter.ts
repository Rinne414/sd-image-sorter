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

/** The batch's Library entries among the images a search matched, in batch order (folder images never match). */
export function matchKeys(entries: readonly { key: string; imageId: number | null }[], matched: readonly number[]): ReadonlySet<string> {
  const ids = new Set(matched)
  return new Set(entries.filter((entry) => entry.imageId !== null && ids.has(entry.imageId)).map((entry) => entry.key))
}

/** A condition is set and this Library image does not match it (folder images are neither: it does not apply to them). */
export function unmatched(matches: ReadonlySet<string> | null, entry: { key: string; imageId: number | null }): boolean {
  return matches !== null && entry.imageId !== null && !matches.has(entry.key)
}

/** How many entries are not Library images (a dataset's folder images): no library condition applies to them. */
export function outsideLibrary(entries: readonly { imageId: number | null }[]): number {
  return entries.filter((entry) => entry.imageId === null).length
}

/** The matches the name filter still shows (all of them without a name filter): what "select the matches" selects. */
export function visibleMatches(matches: ReadonlySet<string>, shown: ReadonlySet<string> | null): ReadonlySet<string> {
  return shown ? new Set([...matches].filter((key) => shown.has(key))) : matches
}
