/** The search with one more prompt word (clicked in the recipe column), unless it is already there. */
export function withPromptWord(query: string, word: string): string {
  const clean = word.replace(/"/g, '').trim()
  if (!clean) return query
  const token = /\s/.test(clean) ? `prompt:"${clean}"` : `prompt:${clean}`
  if (query.split(/\s+/).includes(token)) return query
  return query.trim() ? `${query.trim()} ${token}` : token
}
