import type { CaptionContent } from '../datasetTag'
import { joinTags, splitTags } from './captionContent'

// How the batch writes a tag: the way its template renders them. With the
// template's underscore option on (the default) `blue_sky` is written
// `blue sky`; off, tags keep their underscores (`blue sky` -> `blue_sky`).
// The rules are the backend's normalize_lora_tag / is_kaomoji_tag
// (services/export_tag_pipeline.py), so an edited caption reads like the
// rendered ones: `score_*` keeps its underscores, and emoticon tags (`^_^`,
// `>_<`, `o_o`) keep their exact glyphs either way. Every function returns new data.

export type TagStyle = 'spaces' | 'underscores'

export const styleOf = (normalizeUnderscores: boolean): TagStyle => (normalizeUnderscores ? 'spaces' : 'underscores')

/** Prefixes whose underscores stay (the backend's DEFAULT_LORA_PRESERVE_PREFIXES). */
const KEEP_PREFIXES = ['score_']

/** The backend's KAOMOJI_TAGS: danbooru emoticons whose glyphs must survive. */
const KAOMOJI: ReadonlySet<string> = new Set([
  '0_0', '(o)_(o)', '+_+', '+_-', '._.', '3_3', '6_9', '<o>_<o>',
  '<|>_<|>', '=_=', '>_<', '>_o', '@_@', '^_^', '^o^', '|_|', '||_||',
  'o_o', 'u_u', 'x_x', 'n_n', 't_t', ';_;', '<_<', '>_>', '-_-',
  ':3', ':d', ':i', ':o', ':p', ':q', ':t', ':x', ':|', ':>', ':<',
  ':c', ':/', ';3', ';d', ';o', ';p', ';q', ';)', ';(', '>:(', '>:)',
  '!', '!!', '!?', '?', '??', '+++', '...', '^^^', '\\m/', '\\o/',
  '\\||/', 'o3o', '0w0', 'uwu', '>o<', 'd:',
])

/**
 * A danbooru emoticon: in the curated set, or an underscore tag whose every
 * `_`-separated part is at most one character (`v_v`, `=_=`): a face, never
 * words joined by underscores.
 */
export function isKaomojiTag(tag: string): boolean {
  const lowered = tag.trim().toLowerCase()
  if (!lowered) return false
  if (KAOMOJI.has(lowered)) return true
  if (!lowered.includes('_')) return false
  const parts = lowered.split('_')
  return parts.every((part) => part.length <= 1) && parts.some((part) => part.length > 0)
}

/** One tag written the batch's way. */
export function styledTag(tag: string, style: TagStyle): string {
  const clean = tag.trim()
  if (isKaomojiTag(clean)) return clean
  if (style === 'underscores') return clean.split(/\s+/).filter(Boolean).join('_')
  if (KEEP_PREFIXES.some((prefix) => clean.startsWith(prefix))) return clean
  return clean.replace(/_/g, ' ').split(/\s+/).filter(Boolean).join(' ')
}

/** A tag as the screen shows it: spaces for underscores, emoticons and score_ tags as they are. */
export const displayTag = (tag: string): string => styledTag(tag, 'spaces')

/** A caption's tags that are not written the batch's way. */
export function offStyleTags(booru: string, style: TagStyle): string[] {
  return splitTags(booru).filter((tag) => styledTag(tag, style) !== tag)
}

/** Tags typed as text (commas or line breaks), each written the batch's way. */
export const styledList = (text: string, style: TagStyle): string[] => splitTags(text).map((tag) => styledTag(tag, style))

/** The caption with every tag written the batch's way; the same caption when there is nothing to change. */
export function withTagStyle(content: CaptionContent, style: TagStyle): CaptionContent {
  if (offStyleTags(content.booru_caption, style).length === 0) return content
  return { ...content, booru_caption: joinTags(styledList(content.booru_caption, style)) }
}

/** A tag inside a prompt without its brackets and weight: `(long_hair:1.2)` -> `long_hair`. */
const bare = (tag: string) => tag.replace(/[()[\]{}]/g, '').replace(/:[\d.\s]*$/, '').trim()

/**
 * How the tags already in a text with no setting of its own (a prompt) are
 * written: underscores when more of them join words with `_` than with
 * spaces, spaces otherwise. `score_` tags and emoticons say nothing either way.
 */
export function styleOfText(text: string): TagStyle {
  let underscored = 0
  let spaced = 0
  for (const tag of splitTags(text).map(bare)) {
    if (isKaomojiTag(tag) || KEEP_PREFIXES.some((prefix) => tag.startsWith(prefix))) continue
    if (/\w_\w/.test(tag)) underscored += 1
    else if (/\w \w/.test(tag)) spaced += 1
  }
  return underscored > spaced ? 'underscores' : 'spaces'
}
