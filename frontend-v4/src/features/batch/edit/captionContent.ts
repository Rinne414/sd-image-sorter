import type { CaptionContent } from '../datasetTag'

// One image's own training caption (a revision's content) and the pure edits
// the caption editor makes to it. The batch rules (trigger, common tags,
// blacklist, dropped categories) are not in here: the backend applies them at
// preview and export. Every function returns new data.

export type CaptionType = CaptionContent['caption_type']

export const CAPTION_TYPES: readonly CaptionType[] = ['booru', 'both', 'nl']

export const emptyContent = (): CaptionContent => ({ content_version: 1, booru_caption: '', nl_caption: '', caption_type: 'booru' })

/** The tags of a caption as the backend splits them (commas and line breaks, spaces collapsed). */
export function splitTags(text: string): string[] {
  return text
    .replace(/\r?\n/g, ',')
    .split(',')
    .map((part) => part.split(/\s+/).filter(Boolean).join(' ').replace(/^[ ,]+|[ ,]+$/g, ''))
    .filter(Boolean)
}

/** Two spellings of one tag (any case, _ or space) are the same tag. */
export const tagKey = (tag: string): string => tag.replace(/_/g, ' ').split(/\s+/).filter(Boolean).join(' ').toLowerCase()

export const joinTags = (tags: readonly string[]): string => tags.join(', ')

export function withoutTag(content: CaptionContent, tag: string): CaptionContent {
  const key = tagKey(tag)
  return { ...content, booru_caption: joinTags(splitTags(content.booru_caption).filter((t) => tagKey(t) !== key)) }
}

/** The tags added at the end; ones the caption already has are skipped. */
export function withTags(content: CaptionContent, tags: readonly string[]): { content: CaptionContent; added: number } {
  const have = splitTags(content.booru_caption)
  const seen = new Set(have.map(tagKey))
  const extra: string[] = []
  for (const tag of tags.flatMap(splitTags)) {
    if (seen.has(tagKey(tag))) continue
    seen.add(tagKey(tag))
    extra.push(tag)
  }
  if (extra.length === 0) return { content, added: 0 }
  return { content: { ...content, booru_caption: joinTags([...have, ...extra]) }, added: extra.length }
}

export const withType = (content: CaptionContent, type: CaptionType): CaptionContent => ({ ...content, caption_type: type })
export const withNl = (content: CaptionContent, text: string): CaptionContent => ({ ...content, nl_caption: text })
export const withBooruText = (content: CaptionContent, text: string): CaptionContent => ({ ...content, booru_caption: text })

/**
 * The caption the image contributes before the batch rules: the backend's
 * compose_caption_with_nl, byte for byte (tags; the sentence; or tags then
 * the sentence, which is flattened to one line).
 */
export function composeCaption(content: CaptionContent): string {
  const type = content.caption_type
  if (type !== 'nl' && type !== 'both') return content.booru_caption
  const booru = content.booru_caption.trim()
  const text = content.nl_caption.split(/\s+/).filter(Boolean).join(' ')
  if (type === 'nl') return text || booru
  if (booru && text) return `${booru}, ${text}`
  return booru || text
}

/** The image's own caption is empty: only the batch rules would be written. */
export const isOwnEmpty = (content: CaptionContent): boolean => composeCaption(content).trim() === ''

export const sameContent = (a: CaptionContent, b: CaptionContent): boolean =>
  a.booru_caption === b.booru_caption && a.nl_caption === b.nl_caption && a.caption_type === b.caption_type

const NL_VAR = /\s*[.,;]?\s*\{nl_caption\}/g
const TAG_VAR = /\{(tags(:[^}]*)?|general|characters|copyright|artists(:[^}]*)?|count)\}/

export const templateHasNl = (template: string): boolean => template.includes('{nl_caption}')

const APPEND_VAR = /\s*[.,;]?\s*\{append\}/g

/**
 * The template a fresh caption's tags are rendered with: the batch's own
 * (so the tags come in its order) without the natural-language part. With
 * common tags set, `{append}` goes too: the batch rule puts them in front of
 * every caption, and a hand-edited one must not keep a copy that outlives
 * the setting. A template made only of words (FLUX's) starts from the
 * filtered tags.
 */
export function initialTemplate(template: string, hasCommonTags: boolean): string {
  let stripped = template.replace(NL_VAR, '')
  if (hasCommonTags) stripped = stripped.replace(APPEND_VAR, '')
  stripped = stripped.trim()
  return TAG_VAR.test(stripped) ? stripped : '{tags:filtered}'
}

/**
 * The caption a never-edited image starts from: its tags as the template
 * renders them with the batch rules off, its stored description (the words
 * the template's {nl_caption} reads: the description, else the older fused
 * caption), and the type the template writes (words only, tags and words, or
 * tags). A description the type does not write stays in its box, unused.
 */
export function initialContent(renderedTags: string, words: string, template: string): CaptionContent {
  const usesNl = templateHasNl(template)
  const nl = words.split(/\s+/).filter(Boolean).join(' ')
  const wordsOnly = usesNl && !TAG_VAR.test(template.replace(NL_VAR, ''))
  const type: CaptionType = usesNl && nl ? (wordsOnly ? 'nl' : 'both') : 'booru'
  return { content_version: 1, booru_caption: joinTags(splitTags(renderedTags)), nl_caption: nl, caption_type: type }
}

/** One preview row, as POST /api/dataset/export-preview answers it. */
export interface PreviewRow {
  image_id: number
  abs_path: string
  caption: string
  error: string | null
  skipped_reason: string | null
}

/** Where a preview row belongs among the entries (Library id, or the folder path in one spelling). */
export const rowKey = (imageId: number, path: string | null): string => (imageId > 0 ? `id:${imageId}` : `path:${(path ?? '').replace(/\\/g, '/')}`)

/**
 * Fresh captions by entry key from two renders of the same images: the tags
 * (template without its words) and the words (content mode nl_caption). An
 * image either render skipped or failed is left out.
 */
export function contentsFromRows(
  entries: readonly { key: string; imageId: number | null; path: string | null }[],
  tagRows: readonly PreviewRow[],
  wordRows: readonly PreviewRow[],
  template: string,
): Map<string, CaptionContent> {
  const byRow = new Map(entries.map((e) => [rowKey(e.imageId ?? 0, e.path), e.key]))
  const ok = (row: PreviewRow) => !row.error && !row.skipped_reason
  const words = new Map(wordRows.filter(ok).map((row) => [rowKey(row.image_id, row.abs_path), row.caption]))
  const out = new Map<string, CaptionContent>()
  for (const row of tagRows) {
    const at = rowKey(row.image_id, row.abs_path)
    const key = byRow.get(at)
    if (key && ok(row)) out.set(key, initialContent(row.caption, words.get(at) ?? '', template))
  }
  return out
}

/** How many tags the caption has (the batch's "max tags" only trims never-edited images). */
export const tagCount = (content: CaptionContent): number => splitTags(content.booru_caption).length
