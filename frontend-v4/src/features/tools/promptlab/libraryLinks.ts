import { modelFilterValue } from '../../../lib/imageInfo'
import { addTags, onlyWith } from '../../../lib/queryEdit'
import { parseSearch } from '../../../lib/searchQuery'

// "筛到图库": the library's search text is the only filter state, so these
// return the new text and never touch filters directly (V3.5 pain point 4).

/** The search with this tag required too (in the tag mode the search already uses). */
export function withTag(text: string, tag: string): string {
  return withTags(text, [tag])
}

export function withTags(text: string, tags: readonly string[]): string {
  return addTags(text, [...tags], parseSearch(text).tagMode)
}

/** Only images made with this model: other model filters give way. */
export function withCheckpoint(text: string, name: string): string {
  const value = modelFilterValue(name)
  return value ? onlyWith(text, 'checkpoint', value) : text
}

/** A recipe: its model, plus its tags. */
export function withRecipe(text: string, name: string, tags: readonly string[]): string {
  return withTags(withCheckpoint(text, name), tags)
}
