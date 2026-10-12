import { captionTransforms } from '../captionRules'
import type { DatasetForm, TargetModel } from '../datasetSettings'
import { splitTags, tagKey } from '../edit/captionContent'
import { ownEmpty } from '../edit/marks'
import { offStyleTags, styleOf } from '../edit/tagStyle'
import type { CaptionContent } from '../datasetTag'
import { issue, type CheckIssue, type TagPair } from './checkIssues'

// What the final captions (as the export writes them) say: empty ones, ones
// longer than the base model reads, tags that always go together, tags on one
// image only. Pure: the captions come from export-preview.

/** Tokens the base model's text encoder reads (V3.5 target-model profiles): CLIP 75, T5 / Qwen 512. */
const TOKEN_BUDGET: Record<TargetModel, number> = { '': 75, sdxl: 75, flux: 512, krea2: 512, anima: 512 }

export const tokenBudget = (model: TargetModel): number => TOKEN_BUDGET[model]

/**
 * An estimate of the CLIP tokens of a caption (V3.5's QW-1 counter): exact
 * BPE needs the whole vocabulary, so each word counts one token per four
 * letters and each comma one. Said as "about" wherever it is shown.
 */
export function estimateTokens(text: string): number {
  const folded = text.replace(/_/g, ' ').trim()
  if (!folded) return 0
  let tokens = 0
  for (const word of folded.split(/[\s,]+/)) if (word) tokens += Math.max(1, Math.ceil(word.length / 4))
  return tokens + (folded.match(/,/g) ?? []).length
}

/** Parts of a caption that read like tags (a sentence split at its commas does not). */
const isTagLike = (key: string) => !/[.!?]/.test(key) && key.split(' ').length <= 5

/** The tags of one caption by key, once each. */
export function captionTagKeys(caption: string): Set<string> {
  return new Set(splitTags(caption).map(tagKey).filter((key) => key && isTagLike(key)))
}

/** The folded tags the batch rules put in front of every caption. */
export const ruleTagKeys = (form: DatasetForm): Set<string> => new Set(captionTransforms(form).prepend.map(tagKey))

/** Tags reach this many captions before their pairs are looked at (the health check's numbers). */
const PAIR_MIN_COUNT = 3
const PAIR_TOP_TAGS = 150
const PAIR_MIN_RATIO = 0.9

/** Tags that are (almost) always in the same captions: the model cannot tell them apart. */
export function cooccurringPairs(captions: Iterable<string>, skip: ReadonlySet<string>): TagPair[] {
  const holders = new Map<string, Set<number>>()
  let i = 0
  for (const caption of captions) {
    for (const key of captionTagKeys(caption)) if (!skip.has(key)) holders.set(key, (holders.get(key) ?? new Set()).add(i))
    i += 1
  }
  const top = [...holders.entries()]
    .filter(([, set]) => set.size >= PAIR_MIN_COUNT)
    .sort((x, y) => y[1].size - x[1].size || x[0].localeCompare(y[0]))
    .slice(0, PAIR_TOP_TAGS)
  const pairs: TagPair[] = []
  for (let a = 0; a < top.length; a += 1) {
    for (let b = a + 1; b < top.length; b += 1) {
      const [ta, sa] = top[a] as [string, Set<number>]
      const [tb, sb] = top[b] as [string, Set<number>]
      let together = 0
      for (const n of sa) if (sb.has(n)) together += 1
      const ratio = together / (sa.size + sb.size - together)
      if (ratio >= PAIR_MIN_RATIO) {
        const [x, y] = [ta, tb].sort()
        pairs.push({ a: x as string, b: y as string, together, ratio: Math.round(ratio * 1000) / 1000 })
      }
    }
  }
  return pairs.sort((x, y) => y.together - x.together || x.a.localeCompare(y.a))
}

/** Below this many captions a tag on one image is not worth a word (the health check's floor). */
const RARE_MIN_CAPTIONS = 10

/** Tags only one caption has: often a tagger's noise or a typo. */
export function rareTags(captions: readonly string[], skip: ReadonlySet<string>): string[] {
  if (captions.length < RARE_MIN_CAPTIONS) return []
  const counts = new Map<string, number>()
  for (const caption of captions) for (const key of captionTagKeys(caption)) if (!skip.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts.entries()].filter(([, n]) => n === 1).map(([key]) => key).sort()
}

/** The images whose caption has this tag (any spelling), in the order given. */
export function tagHolders(finals: ReadonlyMap<string, string>, tag: string): string[] {
  const key = tagKey(tag)
  return [...finals.entries()].filter(([, caption]) => captionTagKeys(caption).has(key)).map(([k]) => k)
}

/** Which other tags ride along with this one, and how often (the batch's own co-occurrence). */
export function companions(finals: ReadonlyMap<string, string>, tag: string, skip: ReadonlySet<string>, topN = 8) {
  const key = tagKey(tag)
  const counts = new Map<string, number>()
  let carriers = 0
  for (const caption of finals.values()) {
    const tags = captionTagKeys(caption)
    if (!tags.has(key)) continue
    carriers += 1
    for (const other of tags) if (other !== key && !skip.has(other)) counts.set(other, (counts.get(other) ?? 0) + 1)
  }
  const rows = [...counts.entries()]
    .map(([other, count]) => ({ tag: other, count, ratio: carriers ? count / carriers : 0 }))
    .sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag))
    .slice(0, topN)
  return { carriers, rows }
}

/** Issues the final captions show. */
export function captionIssues(finals: ReadonlyMap<string, string>, form: DatasetForm): CheckIssue[] {
  const budget = tokenBudget(form.targetModel)
  const empty: string[] = []
  const long: string[] = []
  const notes: Record<string, string> = {}
  for (const [key, caption] of finals) {
    if (ownEmpty(caption, form)) empty.push(key)
    const tokens = estimateTokens(caption)
    if (tokens > budget) {
      long.push(key)
      notes[key] = String(tokens)
    }
  }
  const skip = ruleTagKeys(form)
  const captions = [...finals.values()]
  const pairs = cooccurringPairs(captions, skip)
  const rare = rareTags(captions, skip)
  return [
    ...(empty.length ? [issue('empty_caption', 'captions', { keys: empty })] : []),
    ...(long.length ? [issue('too_long', 'captions', { keys: long, notes, params: { budget } })] : []),
    ...(pairs.length ? [issue('cooccur', 'captions', { pairs })] : []),
    ...(rare.length ? [issue('rare_tags', 'captions', { tags: rare })] : []),
  ]
}

/**
 * Edited captions with tags written another way than the batch template
 * writes them (`blue_sky` beside rendered `blue sky`): the trainer reads the
 * two spellings as two different words. The note is one such tag.
 */
export function tagStyleIssues(heads: ReadonlyMap<string, { content?: CaptionContent }>, normalizeUnderscores: boolean): CheckIssue[] {
  const style = styleOf(normalizeUnderscores)
  const keys: string[] = []
  const notes: Record<string, string> = {}
  for (const [key, head] of heads) {
    const off = head.content ? offStyleTags(head.content.booru_caption, style) : []
    if (off.length === 0) continue
    keys.push(key)
    notes[key] = off[0] as string
  }
  return keys.length ? [issue('tag_style', 'captions', { keys, notes })] : []
}
