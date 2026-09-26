// Edit the query text the way the filter panel needs: drop the tokens that set
// one filter and add the new ones. The query text stays the only filter state.

import { parseSearch, type Part } from './searchQuery'

export type PartMatch = (part: Part) => boolean

/** Tokens (by index) whose parsed part matches. */
function matching(text: string, match: PartMatch): { tokens: string[]; drop: Set<number> } {
  const parsed = parseSearch(text)
  const drop = new Set<number>()
  for (const part of parsed.parts) if (match(part)) drop.add(part.token)
  return { tokens: parsed.tokens, drop }
}

/** Remove every token matching `match`, then append `add` (in order). */
export function replaceTokens(text: string, match: PartMatch, add: string[] = []): string {
  const { tokens, drop } = matching(text, match)
  return [...tokens.filter((_, i) => !drop.has(i)), ...add].join(' ').trim()
}

/** Add `token` if no part matches, otherwise remove the matching ones. */
export function toggleToken(text: string, match: PartMatch, token: string): string {
  const { drop } = matching(text, match)
  return drop.size ? replaceTokens(text, match) : replaceTokens(text, () => false, [token])
}

export const isKey =
  (key: string, value?: string): PartMatch =>
  (part) =>
    part.kind === 'filter' && part.key === key && (value === undefined || part.value === value)

export const isAnyOf =
  (...matches: PartMatch[]): PartMatch =>
  (part) =>
    matches.some((m) => m(part))

/** The value of the first filter part with this key, if any. */
export function valueOf(parts: Part[], key: string): string | null {
  for (const p of parts) if (p.kind === 'filter' && p.key === key) return p.value
  return null
}

export function hasPart(parts: Part[], match: PartMatch): boolean {
  return parts.some(match)
}

/** A value as one token: quoted when it has spaces; quotes inside it are dropped. */
export function tokenValue(value: string): string {
  const clean = value.replace(/"/g, '').replace(/\s+/g, ' ').trim()
  return /\s/.test(clean) ? `"${clean}"` : clean
}

/**
 * Show only images with this checkpoint or LoRA: every earlier filter of that
 * kind (kept or excluded) goes, the rest of the query stays. Replacing rather
 * than adding matters: two filters of one kind mean "either", so adding would
 * widen the result instead of narrowing it.
 */
export function onlyWith(text: string, key: 'checkpoint' | 'lora', value: string): string {
  return replaceTokens(text, isAnyOf(isKey(key), isKey(`-${key}`)), [`${key}:${tokenValue(value)}`])
}

export type TagMode = 'and' | 'or'
export type PromptMode = 'exact' | 'contains'

/** The one filter a token sets, when it sets exactly one. */
function onlyPart(token: string): { part: Part; tags: string[] } | null {
  const q = parseSearch(token)
  const part = q.parts[0]
  return q.parts.length === 1 && part?.kind === 'filter' ? { part, tags: q.tags } : null
}

/** The tags a token requires (tag:a, tag:a|b), or null for any other token. */
function requiredTags(token: string): string[] | null {
  const found = onlyPart(token)
  return found?.part.kind === 'filter' && found.part.key === 'tag' ? found.tags : null
}

/**
 * Tag match mode as the panel writes it: 'or' folds every required tag into
 * one tag:a|b|c (where the first one was); 'and' splits lists into tag:a tag:b.
 */
export function setTagMode(text: string, mode: TagMode): string {
  const tokens = parseSearch(text).tokens
  const found = tokens.map(requiredTags)
  const values = [...new Set(found.flatMap((v) => v ?? []))]
  const first = found.findIndex((v) => v !== null)
  const seen = new Set<string>()
  const out = tokens.flatMap((token, i) => {
    const tags = found[i]
    if (!tags) return [token]
    if (mode === 'or') return i === first ? [`tag:${tokenValue(values.join('|'))}`] : []
    const fresh = tags.filter((t) => !seen.has(t))
    fresh.forEach((t) => seen.add(t))
    return fresh.map((t) => `tag:${tokenValue(t)}`)
  })
  return out.join(' ')
}

/** Add required tags (skipping ones already there) in the mode the panel shows. */
export function addTags(text: string, tags: string[], mode: TagMode): string {
  const have = new Set(parseSearch(text).tokens.flatMap((t) => requiredTags(t) ?? []))
  const fresh = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].filter((t) => !have.has(t))
  const added = [text.trim(), ...fresh.map((t) => `tag:${tokenValue(t)}`)].filter(Boolean).join(' ')
  return mode === 'or' ? setTagMode(added, 'or') : added
}

function promptToken(value: string, negated: boolean, mode: PromptMode): string {
  return `${negated ? '-' : ''}prompt:${tokenValue(mode === 'contains' ? `*${value}*` : value)}`
}

/** Prompt match mode: 'contains' stars every prompt term (kept or excluded), 'exact' drops the stars. */
export function setPromptMode(text: string, mode: PromptMode): string {
  return parseSearch(text)
    .tokens.map((token) => {
      const found = onlyPart(token)
      if (found?.part.kind !== 'filter' || (found.part.key !== 'prompt' && found.part.key !== '-prompt')) return token
      return promptToken(found.part.value, found.part.key === '-prompt', mode)
    })
    .join(' ')
}

export function addPrompt(text: string, words: string, mode: PromptMode): string {
  const clean = words.replace(/\*/g, '').trim()
  return clean ? [text.trim(), promptToken(clean, false, mode)].filter(Boolean).join(' ') : text
}
