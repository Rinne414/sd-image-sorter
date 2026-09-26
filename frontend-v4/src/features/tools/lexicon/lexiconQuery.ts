import { isKey, replaceTokens, setTagMode, type PartMatch } from '../../../lib/queryEdit'
import { parseSearch } from '../../../lib/searchQuery'

// Pure: what a click in 词库 does to the library's search text (the only
// filter state). An entry not in the search is added as its filter (tag:,
// prompt:, lora:, checkpoint:); one already there is taken out again.

export type LexTab = 'tags' | 'prompts' | 'loras' | 'checkpoints'

const KEY: Record<LexTab, 'tag' | 'prompt' | 'lora' | 'checkpoint'> = {
  tags: 'tag',
  prompts: 'prompt',
  loras: 'lora',
  checkpoints: 'checkpoint',
}

/** How the library compares names: case, underscores and extra spaces do not matter. */
export const normalize = (value: string) => value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()

const same = (a: string, b: string) => normalize(a) === normalize(b)

/** A value as one token: quoted when it has a space or a colon; quotes inside are dropped. */
export function quoteValue(value: string): string {
  const clean = value.replace(/"/g, '').replace(/\s+/g, ' ').trim()
  return /[\s:]/.test(clean) ? `"${clean}"` : clean
}

const isEntry =
  (tab: LexTab, value: string): PartMatch =>
  (part) =>
    part.kind === 'filter' && part.key === KEY[tab] && same(part.value, value)

/** The entry is one of the search's (required) filters. */
export function hasEntry(text: string, tab: LexTab, value: string): boolean {
  const parsed = parseSearch(text)
  if (tab === 'tags') return parsed.tags.some((tag) => same(tag, value))
  return parsed.parts.some(isEntry(tab, value))
}

/** Required tags in the mode the search uses (any-of folds them into one tag:a|b). */
function withTags(text: string, tags: readonly string[], mode: 'and' | 'or'): string {
  const added = [text.trim(), ...tags.map((tag) => `tag:${quoteValue(tag)}`)].filter(Boolean).join(' ')
  return mode === 'or' ? setTagMode(added, 'or') : added
}

function addEntry(text: string, tab: LexTab, value: string): string {
  const parsed = parseSearch(text)
  if (tab === 'tags') return withTags(text, [value], parsed.tagMode)
  const shown = tab === 'prompts' && parsed.promptMatch === 'contains' ? `*${value}*` : value
  return [text.trim(), `${KEY[tab]}:${quoteValue(shown)}`].filter(Boolean).join(' ')
}

function removeEntry(text: string, tab: LexTab, value: string): string {
  if (tab !== 'tags') return replaceTokens(text, isEntry(tab, value))
  const parsed = parseSearch(text)
  const rest = parsed.tags.filter((tag) => !same(tag, value))
  return withTags(replaceTokens(text, isKey('tag')), rest, parsed.tagMode)
}

/** The (normalized) values of this tab's entries the search holds, to mark them in the list. */
export function activeValues(text: string, tab: LexTab): Set<string> {
  const parsed = parseSearch(text)
  const values = tab === 'tags' ? parsed.tags : parsed.parts.flatMap((p) => (p.kind === 'filter' && p.key === KEY[tab] ? [p.value] : []))
  return new Set(values.map(normalize))
}

/** Add the entry to the search, or take it out when it is already there. */
export function toggleEntry(text: string, tab: LexTab, value: string): string {
  return hasEntry(text, tab, value) ? removeEntry(text, tab, value) : addEntry(text, tab, value)
}
