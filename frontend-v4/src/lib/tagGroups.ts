import type { TagCategory } from '../api/types'

// "Copy tags by category": the 14 tag categories folded into the 7 groups
// V3.5's copy menu offered (tag-category-copy.js CATEGORY_GROUPS).

export type TagGroupId = 'appearance' | 'clothing' | 'pose' | 'scenery' | 'style' | 'qualityMeta' | 'unclassified'

export const TAG_GROUPS: { id: TagGroupId; categories: readonly TagCategory[] }[] = [
  { id: 'appearance', categories: ['character', 'body', 'expression'] },
  { id: 'clothing', categories: ['outfit'] },
  { id: 'pose', categories: ['pose', 'action', 'angle'] },
  { id: 'scenery', categories: ['background'] },
  { id: 'style', categories: ['style', 'artist'] },
  { id: 'qualityMeta', categories: ['quality', 'meta', 'rating'] },
  { id: 'unclassified', categories: ['unknown'] },
]

const GROUP_OF = new Map<TagCategory, TagGroupId>(TAG_GROUPS.flatMap((g) => g.categories.map((c) => [c, g.id] as const)))

export type GroupedTags = Record<TagGroupId, string[]>

/** Each tag once, in its group, in the order given; a tag without a known category is unclassified. */
export function groupTags(tags: readonly string[], categoryOf: (tag: string) => TagCategory | undefined): GroupedTags {
  const out = Object.fromEntries(TAG_GROUPS.map((g) => [g.id, [] as string[]])) as GroupedTags
  const seen = new Set<string>()
  for (const tag of tags) {
    const clean = tag.trim()
    if (!clean || seen.has(clean.toLowerCase())) continue
    seen.add(clean.toLowerCase())
    const category = categoryOf(clean)
    out[(category && GROUP_OF.get(category)) || 'unclassified'].push(clean)
  }
  return out
}
