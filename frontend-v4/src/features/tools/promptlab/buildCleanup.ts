import type { TagCategory } from '../../../api/types'
import { segmentPrompt } from '../../../lib/prompt'
import { TAG_GROUPS, type TagGroupId } from '../../../lib/tagGroups'

// Build's clean-up tools on a comma-separated prompt. LoRA directives
// (<lora:name:0.8>, also lyco / hypernet) are never rewritten, merged away or
// dropped: they are how the prompt loads a model, not words to tidy.

const DIRECTIVE = /<(?:lora|lyco|hypernet):[^<>]*>/i
const DIRECTIVES = /<(?:lora|lyco|hypernet):[^<>]*>/gi

export const isDirective = (tag: string): boolean => DIRECTIVE.test(tag)

/** Collapse whitespace outside directives; the inside of a directive stays exact. */
function tidy(chunk: string): string {
  let out = ''
  let at = 0
  for (const m of chunk.matchAll(DIRECTIVES)) {
    out += chunk.slice(at, m.index).replace(/\s+/g, ' ') + m[0]
    at = (m.index ?? 0) + m[0].length
  }
  return (out + chunk.slice(at).replace(/\s+/g, ' ')).trim()
}

const OPEN = '([{<'
const CLOSE = ')]}>'

/** The prompt's comma-separated parts; commas inside brackets or a directive do not split. */
export function splitPrompt(text: string): string[] {
  const parts: string[] = []
  const depth = [0, 0, 0, 0]
  let current = ''
  const flush = () => {
    const part = tidy(current)
    if (part) parts.push(part)
    current = ''
  }
  for (const ch of text) {
    const open = OPEN.indexOf(ch)
    const close = CLOSE.indexOf(ch)
    if (open >= 0) depth[open] = (depth[open] ?? 0) + 1
    else if (close >= 0 && (depth[close] ?? 0) > 0) depth[close] = (depth[close] ?? 0) - 1
    if (ch === ',' && depth.every((d) => d === 0)) flush()
    else current += ch
  }
  flush()
  return parts
}

const fold = (tag: string) => tag.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ')

const underscoresToSpaces = (tag: string) => tag.replace(DIRECTIVES, (m) => m.replace(/_/g, '\u0000')).replace(/_/g, ' ').replace(/\u0000/g, '_')

/**
 * Each word once (case ignored; with `spaces`, also underscores against
 * spaces), whitespace tidied; every directive is kept, even a repeated one.
 */
export function cleanTags(tags: readonly string[], opts: { spaces?: boolean } = {}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    let tag = tidy(raw)
    if (!tag) continue
    if (opts.spaces) tag = tidy(underscoresToSpaces(tag))
    if (isDirective(tag)) {
      out.push(tag)
      continue
    }
    const key = opts.spaces ? fold(tag) : tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

const wordsOf = (tag: string) => (isDirective(tag) ? undefined : segmentPrompt(tag).find((s) => s.kind === 'tag'))

/** The bare words of a part, for looking up its category ('' for a directive). */
export function lookupKey(tag: string): string {
  return wordsOf(tag)?.key ?? ''
}

/** A part's category: what the prompt says (artist:name) first, then the lookup. */
export function categoryFor(tag: string, categoryOf: (key: string) => TagCategory | undefined): TagCategory {
  const words = wordsOf(tag)
  return words?.forcedCategory ?? categoryOf(words?.key ?? '') ?? 'unknown'
}

/**
 * Parts ordered by group (appearance, clothing, pose, scenery, style,
 * quality/meta, unclassified), by category inside a group, directives last.
 * `dropQuality` leaves the quality/meta group out.
 */
export function arrangeByGroup(tags: readonly string[], categoryOf: (key: string) => TagCategory | undefined, opts: { dropQuality: boolean }): string[] {
  const byCategory = new Map<TagCategory, string[]>()
  const directives: string[] = []
  for (const tag of tags) {
    if (isDirective(tag)) {
      directives.push(tag)
      continue
    }
    const category = categoryFor(tag, categoryOf)
    byCategory.set(category, [...(byCategory.get(category) ?? []), tag])
  }
  const skip: TagGroupId | null = opts.dropQuality ? 'qualityMeta' : null
  const ordered = TAG_GROUPS.filter((g) => g.id !== skip).flatMap((g) => g.categories.flatMap((c) => byCategory.get(c) ?? []))
  return [...ordered, ...directives]
}

/** The text with these words added once each (case and underscores ignored), spelled as given. */
export function mergeInto(text: string, tags: readonly string[]): { text: string; added: number } {
  const parts = splitPrompt(text)
  const seen = new Set(parts.map(fold))
  let added = 0
  for (const raw of tags) {
    const tag = tidy(raw)
    if (!tag || seen.has(fold(tag))) continue
    seen.add(fold(tag))
    parts.push(tag)
    added += 1
  }
  return { text: parts.join(', '), added }
}
