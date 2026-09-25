// The library query line: free text plus key:value tokens.
//   silver hair            -> search (prompt, filename, checkpoint)
//   tag:silver_hair        -> must have tag        (-tag:x  must not have)
//   gen:nai                -> generator            (aliases: generator, 生成器)
//   rating:safe            -> content rating       (safe/general, sensitive, nsfw/questionable, explicit)
//   stars>=4  ★5  星>=3     -> the user's own star rating
// Unknown keys stay in the free text, so typing never loses anything.

export type SortKey = 'newest' | 'oldest' | 'user_rating' | 'aesthetic' | 'random' | 'name_asc'

export interface QueryFilter {
  text: string
  tags: string[]
  excludeTags: string[]
  generators: string[]
  ratings: string[]
  minStars: number | null
}

export interface QueryChip {
  kind: 'text' | 'tag' | 'excludeTag' | 'generator' | 'rating' | 'stars'
  value: string
}

export interface ParsedQuery {
  filter: QueryFilter
  chips: QueryChip[]
  warnings: string[]
}

const TAG_KEYS = new Set(['tag', 't', '标签'])
const GEN_KEYS = new Set(['gen', 'generator', '生成器'])
const RATING_KEYS = new Set(['rating', '分级'])
const STAR_KEYS = new Set(['stars', 'star', '星', '评分'])

const RATING_ALIASES: Record<string, string[]> = {
  safe: ['general'],
  general: ['general'],
  sfw: ['general', 'sensitive'],
  sensitive: ['sensitive'],
  questionable: ['questionable'],
  nsfw: ['questionable', 'explicit'],
  explicit: ['explicit'],
  普通: ['general'],
  全年龄: ['general'],
  敏感: ['sensitive'],
  可疑: ['questionable'],
  限制级: ['explicit'],
}

const GENERATOR_ALIASES: Record<string, string> = {
  novelai: 'nai',
  comfy: 'comfyui',
  a1111: 'webui',
  sd: 'webui',
}

export function emptyFilter(): QueryFilter {
  return { text: '', tags: [], excludeTags: [], generators: [], ratings: [], minStars: null }
}

/** Split on whitespace, keeping "quoted phrases" (and key:"quoted values") together. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

const STAR_TOKEN = /^(?:★|☆)(\d)$/
const STAR_EXPR = /^(stars|star|星|评分)(>=|>|=|:)(\d)$/

function parseStars(token: string): number | null {
  const short = token.match(STAR_TOKEN)
  if (short?.[1]) return Number(short[1])
  const expr = token.match(STAR_EXPR)
  if (expr?.[2] && expr[3]) {
    const n = Number(expr[3])
    return expr[2] === '>' ? Math.min(5, n + 1) : n
  }
  return null
}

export function parseQuery(input: string): ParsedQuery {
  const filter = emptyFilter()
  const chips: QueryChip[] = []
  const warnings: string[] = []
  const free: string[] = []

  for (const token of tokenize(input)) {
    const stars = parseStars(token)
    if (stars !== null) {
      if (stars < 0 || stars > 5) {
        warnings.push(`stars:${stars}`)
        continue
      }
      filter.minStars = stars
      chips.push({ kind: 'stars', value: String(stars) })
      continue
    }

    const negated = token.startsWith('-')
    const body = negated ? token.slice(1) : token
    const sep = body.indexOf(':')
    if (sep <= 0 || sep === body.length - 1) {
      free.push(token)
      continue
    }
    const key = body.slice(0, sep).toLowerCase()
    const value = body.slice(sep + 1).trim()

    if (TAG_KEYS.has(key)) {
      const tag = value.replace(/\s+/g, '_')
      if (negated) {
        filter.excludeTags.push(tag)
        chips.push({ kind: 'excludeTag', value: tag })
      } else {
        filter.tags.push(tag)
        chips.push({ kind: 'tag', value: tag })
      }
    } else if (GEN_KEYS.has(key)) {
      const gen = GENERATOR_ALIASES[value.toLowerCase()] ?? value.toLowerCase()
      filter.generators.push(gen)
      chips.push({ kind: 'generator', value: gen })
    } else if (RATING_KEYS.has(key)) {
      const mapped = RATING_ALIASES[value.toLowerCase()]
      if (!mapped) {
        warnings.push(`rating:${value}`)
        continue
      }
      for (const r of mapped) if (!filter.ratings.includes(r)) filter.ratings.push(r)
      chips.push({ kind: 'rating', value: value.toLowerCase() })
    } else if (STAR_KEYS.has(key)) {
      warnings.push(`${key}:${value}`)
    } else {
      free.push(token)
    }
  }

  filter.text = free.join(' ').trim()
  if (filter.text) chips.unshift({ kind: 'text', value: filter.text })
  return { filter, chips, warnings }
}

export interface ScopeFilter {
  generators: string[]
  folder: string | null
  favoritesCollectionId: number | null
}

export type ImageQueryParams = Record<string, string | number | boolean>

/** Merge the query line with the rail scope into /api/images params. */
export function toImageParams(query: QueryFilter, scope: ScopeFilter, sort: SortKey): ImageQueryParams {
  const params: ImageQueryParams = { sort_by: sort }
  if (query.text) params.search = query.text
  if (query.tags.length) params.tags = query.tags.join(',')
  if (query.excludeTags.length) params.exclude_tags = query.excludeTags.join(',')
  const generators = [...new Set([...scope.generators, ...query.generators])]
  if (generators.length) params.generators = generators.join(',')
  if (query.ratings.length) params.ratings = query.ratings.join(',')
  if (query.minStars !== null && query.minStars > 0) params.min_user_rating = query.minStars
  if (scope.folder) params.folder = scope.folder
  if (scope.favoritesCollectionId !== null) params.collection_id = scope.favoritesCollectionId
  return params
}
