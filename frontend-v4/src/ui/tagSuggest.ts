// The tag suggestion list's rules, shared by every field that takes tags
// (ui/TagField.tsx). Pure: what is being typed, when to ask, what taking a
// suggestion writes, and where the list sits. The keys and the comma rules
// are V3.5's (caption-autocomplete.js).

/**
 * list: tags separated by commas or lines (", " follows a taken tag).
 * single: the field holds one tag. insert: free prompt text, where only the
 * word under the caret is completed and nothing is added around it.
 */
export type TagFieldMode = 'list' | 'single' | 'insert'

/** library: tags already in the library. global: the library plus the danbooru vocabulary and its Chinese / Japanese aliases. */
export type Vocabulary = 'library' | 'global'

export interface Token {
  /** What is typed so far (asked for). */
  text: string
  /** The span a taken suggestion replaces. */
  start: number
  end: number
}

export interface Option {
  value: string
  count?: number
  zh?: string | null
  /** A character's series (the backend's `copyright`), comma separated. */
  copyright?: string | null
}

const LIST_BREAK = /[,，\n]/
const INSERT_BREAK = /[,，\n\s()[\]{}:|]/
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/
const SPACE = /\s/

export const hasCjk = (text: string): boolean => CJK.test(text)

/** A tag compared loosely: case, and underscores against spaces, ignored. */
export const fold = (tag: string): string => tag.replace(/_/g, ' ').trim().toLowerCase()

/** The tag at the caret: from the separator before it to the one after it. */
export function tokenAt(value: string, caret: number, mode: TagFieldMode): Token {
  const brk = mode === 'insert' ? INSERT_BREAK : LIST_BREAK
  let start = 0
  let end = value.length
  if (mode !== 'single') {
    start = caret
    while (start > 0 && !brk.test(value[start - 1] ?? '')) start--
    end = caret
    while (end < value.length && !brk.test(value[end] ?? '')) end++
  }
  while (start < end && SPACE.test(value[start] ?? '')) start++
  while (end > start && SPACE.test(value[end - 1] ?? '')) end--
  const typed = caret > start ? value.slice(start, Math.min(caret, end)) : ''
  return { text: typed.trim(), start, end }
}

/** Two letters, or one Chinese / Japanese character where the vocabulary has aliases; never a bare number or weight. */
export function wantsSuggestions(text: string, vocabulary: Vocabulary): boolean {
  if (!/\p{L}/u.test(text)) return false
  return text.length >= 2 || (vocabulary === 'global' && hasCjk(text))
}

/** The field after taking `tags` (a tag, maybe with its series) for the token. */
export function insertTag(value: string, token: Token, tags: readonly string[], mode: TagFieldMode): { value: string; caret: number } {
  const text = tags.join(', ')
  if (mode === 'single') return { value: text, caret: text.length }
  const before = value.slice(0, token.start)
  const after = value.slice(token.end)
  if (mode === 'insert') return { value: before + text + after, caret: before.length + text.length }
  const lead = before && !SPACE.test(before.at(-1) ?? '') ? ' ' : ''
  const rest = after.trim() === '' ? '' : after
  // The list goes on after this tag: its own separator is kept; at the end ", " waits for the next tag.
  const sep = /^\s*[,，\n]/.test(rest) ? '' : ', '
  const head = before + lead + text + sep
  return { value: head + rest, caret: head.length }
}

const seriesKey = (tag: string) => tag.trim().toLowerCase().replace(/[\s_]+/g, '_')

/** A character comes with its series, unless the field already has it (V3.5's comma rule). */
export function withSeries(tag: string, copyright: string | null | undefined, field: string): string[] {
  const seen = new Set([seriesKey(tag), ...field.split(/[,，\n]/).map(seriesKey).filter(Boolean)])
  const out = [tag]
  for (const series of (copyright ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const key = seriesKey(series)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(series)
  }
  return out
}

/** Preferred tags that start with what is typed come first; each tag once; the typed tag itself is not offered. */
export function mergeOptions(typed: string, preferred: readonly string[], found: readonly Option[]): Option[] {
  const key = fold(typed)
  const first = preferred.filter((tag) => fold(tag).startsWith(key) && fold(tag) !== key).map((value): Option => ({ value }))
  const seen = new Set<string>()
  return [...first, ...found].filter((o) => {
    const k = fold(o.value)
    if (!o.value || k === key || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** ↓ and ↑ go round the list. */
export function nextActive(active: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count <= 0) return 0
  return key === 'ArrowDown' ? (active + 1) % count : (active - 1 + count) % count
}

const EDGE = 8
const GAP = 2
const MIN_WIDTH = 240
const MAX_WIDTH = 420
const MAX_HEIGHT = 280

export interface ListPlace {
  left: number
  /** Set when the list hangs under the field. */
  top: number | null
  /** Set when it stands above it (distance from the window's bottom). */
  bottom: number | null
  width: number
  maxHeight: number
}

/**
 * Where the list sits (page px): under the field, as wide as it, inside the
 * window; above it when there is more room there than below.
 */
export function placeList(box: { left: number; top: number; bottom: number; width: number }, view: { width: number; height: number }): ListPlace {
  const width = Math.min(Math.max(box.width, MIN_WIDTH), MAX_WIDTH, view.width - 2 * EDGE)
  const left = Math.max(EDGE, Math.min(box.left, view.width - EDGE - width))
  const below = view.height - EDGE - (box.bottom + GAP)
  const above = box.top - GAP - EDGE
  if (below >= MAX_HEIGHT || below >= above) return { left, top: box.bottom + GAP, bottom: null, width, maxHeight: Math.min(MAX_HEIGHT, below) }
  return { left, top: null, bottom: view.height - (box.top - GAP), width, maxHeight: Math.min(MAX_HEIGHT, above) }
}
