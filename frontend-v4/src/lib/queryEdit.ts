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
