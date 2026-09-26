import type { Scope } from '../../lib/browseMemory'
import { parseSearch } from '../../lib/searchQuery'

// "Use the library's current search" in a batch's condition box (V3.5's "use
// gallery filters"): the library's search line plus its left-rail scope, so
// the condition matches what the library shows. Generators and a folder have
// words in the search language; "only favorites" has none and travels as a flag.

export interface BatchCondition {
  text: string
  favorites: boolean
}

export function fromLibrarySearch(queryText: string, scope: Scope): BatchCondition {
  const line = queryText.trim()
  const parsed = parseSearch(line)
  const parts = line ? [line] : []
  for (const gen of scope.generators) {
    if (!parsed.generators.includes(gen)) parts.push(`gen:${gen}`)
  }
  // The library lets a folder in the line win over the rail's.
  if (scope.folder && parsed.scalars.folder === undefined) parts.push(`folder:"${scope.folder}"`)
  return { text: parts.join(' '), favorites: scope.favorites }
}

/** The batch's favorites among `matched` (every Library image in the batch when there is no text condition). */
export function favoriteKeys(
  entries: readonly { key: string; imageId: number | null }[],
  matched: ReadonlySet<string> | null,
  favorites: ReadonlySet<number>,
): ReadonlySet<string> {
  return new Set(entries.filter((e) => e.imageId !== null && favorites.has(e.imageId) && (!matched || matched.has(e.key))).map((e) => e.key))
}
