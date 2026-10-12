import type { CaptionContent } from '../datasetTag'
import { joinTags, sameContent, splitTags, tagKey, type CaptionType } from './captionContent'
import { withTagStyle, type TagStyle } from './tagStyle'

// Changes made to many captions at once, as pure functions. Tags are split
// and compared the way the backend's caption transforms do (commas and line
// breaks; any case, _ or space is the same tag), so what an operation finds
// here is what the export would find. Every function returns new data.

export type Position = 'front' | 'back'
export type FindMode = 'tag' | 'text' | 'regex'
export type FindTarget = 'tags' | 'words' | 'both'

export type BulkOp =
  | { kind: 'add'; tags: string[]; position: Position }
  | { kind: 'remove'; tags: string[] }
  | { kind: 'replace'; find: string; replace: string; mode: FindMode; target: FindTarget; ignoreCase: boolean }
  | { kind: 'dedupe' }
  | { kind: 'removeCategories'; categories: string[] }
  | { kind: 'sortByCategory'; order: readonly string[] }
  | { kind: 'type'; type: CaptionType }
  | { kind: 'style'; style: TagStyle }

/** The category of a tag (the 14 of /api/prompts/categorize); unknown when not known. */
export type CategoryOf = (tag: string) => string

/** The order tags are sorted into by category: who, what they look like and wear, what they do, where, then the rest. */
export const CATEGORY_ORDER: readonly string[] = [
  'character',
  'body',
  'expression',
  'outfit',
  'pose',
  'action',
  'angle',
  'background',
  'style',
  'artist',
  'quality',
  'meta',
  'rating',
  'unknown',
]

const withBooru = (content: CaptionContent, tags: readonly string[]): CaptionContent => ({ ...content, booru_caption: joinTags(tags) })

/** Each tag once (first spelling kept), like the backend's dedupe. */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  return tags.filter((tag) => {
    const key = tagKey(tag)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The tags made sure to be there, at the front or the back (one already there moves). */
function addTags(content: CaptionContent, extra: readonly string[], position: Position): CaptionContent {
  const adding = dedupeTags(extra.flatMap(splitTags))
  const keys = new Set(adding.map(tagKey))
  const rest = splitTags(content.booru_caption).filter((tag) => !keys.has(tagKey(tag)))
  return withBooru(content, position === 'front' ? [...adding, ...rest] : [...rest, ...adding])
}

function removeTags(content: CaptionContent, gone: readonly string[]): CaptionContent {
  const keys = new Set(gone.flatMap(splitTags).map(tagKey))
  return withBooru(content, splitTags(content.booru_caption).filter((tag) => !keys.has(tagKey(tag))))
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The pattern a find matches with, or the reason it cannot be used. */
export function findPattern(find: string, mode: FindMode, ignoreCase: boolean): RegExp | { error: string } | null {
  if (!find) return null
  if (mode === 'tag') return null
  try {
    return new RegExp(mode === 'regex' ? find : escapeRegExp(find), ignoreCase ? 'gi' : 'g')
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/** A whole tag replaced by one or more tags (nothing: the tag goes), in its place. */
function replaceTag(content: CaptionContent, find: string, replace: string): CaptionContent {
  const key = tagKey(find)
  const tags = splitTags(content.booru_caption).flatMap((tag) => (tagKey(tag) === key ? splitTags(replace) : [tag]))
  return withBooru(content, dedupeTags(tags))
}

/** Text or a pattern replaced within each tag (so ^ and $ are a tag's ends), and in the description as a whole. */
function replaceText(content: CaptionContent, pattern: RegExp, replace: string, target: FindTarget): CaptionContent {
  const inTags = target !== 'words'
  const inWords = target !== 'tags'
  const booru = inTags ? joinTags(dedupeTags(splitTags(content.booru_caption).flatMap((tag) => splitTags(tag.replace(pattern, replace))))) : content.booru_caption
  const words = inWords ? content.nl_caption.replace(pattern, replace) : content.nl_caption
  return { ...content, booru_caption: booru, nl_caption: words }
}

function sortByCategory(content: CaptionContent, order: readonly string[], categoryOf: CategoryOf): CaptionContent {
  const rank = new Map(order.map((category, i) => [category, i]))
  const at = (tag: string) => rank.get(categoryOf(tag)) ?? order.length
  const tags = splitTags(content.booru_caption).map((tag, i) => ({ tag, i }))
  tags.sort((a, b) => at(a.tag) - at(b.tag) || a.i - b.i)
  return withBooru(content, tags.map((t) => t.tag))
}

/** One caption after the operation. */
export function applyOp(content: CaptionContent, op: BulkOp, categoryOf: CategoryOf): CaptionContent {
  switch (op.kind) {
    case 'add':
      return addTags(content, op.tags, op.position)
    case 'remove':
      return removeTags(content, op.tags)
    case 'replace': {
      if (op.mode === 'tag') return op.find.trim() ? replaceTag(content, op.find, op.replace) : content
      const pattern = findPattern(op.find, op.mode, op.ignoreCase)
      return pattern instanceof RegExp ? replaceText(content, pattern, op.replace, op.target) : content
    }
    case 'dedupe':
      return withBooru(content, dedupeTags(splitTags(content.booru_caption)))
    case 'removeCategories': {
      const drop = new Set(op.categories)
      return withBooru(content, splitTags(content.booru_caption).filter((tag) => !drop.has(categoryOf(tag))))
    }
    case 'sortByCategory':
      return sortByCategory(content, op.order, categoryOf)
    case 'type':
      return { ...content, caption_type: op.type }
    case 'style':
      return withTagStyle(content, op.style)
  }
}

export interface Change {
  key: string
  before: CaptionContent
  after: CaptionContent
}

/** The captions an operation changes, among `keys` (images without a caption to start from are skipped). */
export function planOp(
  contents: ReadonlyMap<string, CaptionContent>,
  keys: readonly string[],
  op: BulkOp,
  categoryOf: CategoryOf,
): Change[] {
  const out: Change[] = []
  for (const key of keys) {
    const before = contents.get(key)
    if (!before) continue
    const after = applyOp(before, op, categoryOf)
    if (!sameContent(before, after)) out.push({ key, before, after })
  }
  return out
}

export interface TagRow {
  /** The tag as most captions spell it. */
  tag: string
  key: string
  count: number
  /** Images whose caption has it. */
  keys: string[]
}

/** How many captions have each tag (each caption counts a tag once), most used first. */
export function tagFrequency(contents: Iterable<[string, CaptionContent]>): TagRow[] {
  const rows = new Map<string, { spellings: Map<string, number>; keys: string[] }>()
  for (const [entryKey, content] of contents) {
    for (const tag of dedupeTags(splitTags(content.booru_caption))) {
      const key = tagKey(tag)
      const row = rows.get(key) ?? { spellings: new Map<string, number>(), keys: [] }
      row.spellings.set(tag, (row.spellings.get(tag) ?? 0) + 1)
      row.keys.push(entryKey)
      rows.set(key, row)
    }
  }
  const out: TagRow[] = []
  for (const [key, row] of rows) {
    const tag = [...row.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key
    out.push({ tag, key, count: row.keys.length, keys: row.keys })
  }
  return out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** Captions that have a tag twice (any spelling). */
export const hasDuplicateTags = (content: CaptionContent): boolean => {
  const tags = splitTags(content.booru_caption)
  return dedupeTags(tags).length !== tags.length
}
