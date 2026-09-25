// The library search language, ported from V3.5 (frontend/js/modules/
// gallery-search-query.js) so both apps read a query the same way.
//
//   key:value          filter (":" "=" "==" are the same)
//   key>=n key<=n      numeric bounds (< and > become the inclusive bound;
//                      the chip shows ≥ / ≤ so you see what applies)
//   key:a..b           numeric range
//   -key:value         exclude (tag, generator, rating, checkpoint, lora,
//                      prompt, color)
//   "quoted value"     values with spaces
//   contains(text)     same as free text
//   ★4 / ☆4            V4 shorthand for stars>=4
//   anything else      free text (file name, checkpoint, prompt)

export type SortKey = 'newest' | 'oldest' | 'user_rating' | 'aesthetic' | 'random' | 'name_asc'

export const GENERATOR_VALUES = [
  'comfyui', 'nai', 'webui', 'forge', 'reforge', 'fooocus', 'easy-diffusion', 'invokeai',
  'swarmui', 'drawthings', 'gemini', 'gpt-image', 'others', 'unknown',
] as const

const GENERATOR_ALIASES: Record<string, string> = { novelai: 'nai', comfy: 'comfyui', a1111: 'webui' }

const RATING_ALIASES: Record<string, string> = {
  general: 'general', g: 'general', 普通: 'general', safe: 'general',
  sensitive: 'sensitive', s: 'sensitive', 敏感: 'sensitive',
  questionable: 'questionable', q: 'questionable', 可疑: 'questionable',
  explicit: 'explicit', e: 'explicit', 限制级: 'explicit',
}

const ASPECT_ALIASES: Record<string, string> = {
  square: 'square', 方图: 'square', 方: 'square',
  portrait: 'portrait', 竖图: 'portrait', 竖: 'portrait',
  landscape: 'landscape', 横图: 'landscape', 横: 'landscape',
}

const TEMPERATURE_ALIASES: Record<string, string> = {
  warm: 'warm', 暖: 'warm', 暖色: 'warm',
  cool: 'cool', 冷: 'cool', 冷色: 'cool',
  neutral: 'neutral', 中性: 'neutral',
}

export const HUE_VALUES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'brown', 'white', 'black', 'gray'] as const

const HUE_ALIASES: Record<string, string> = {
  red: 'red', 红: 'red', 红色: 'red',
  orange: 'orange', 橙: 'orange', 橙色: 'orange',
  yellow: 'yellow', 黄: 'yellow', 黄色: 'yellow',
  green: 'green', 绿: 'green', 绿色: 'green',
  cyan: 'cyan', 青: 'cyan', 青色: 'cyan',
  blue: 'blue', 蓝: 'blue', 蓝色: 'blue',
  purple: 'purple', 紫: 'purple', 紫色: 'purple',
  pink: 'pink', 粉: 'pink', 粉色: 'pink', 粉红: 'pink',
  brown: 'brown', 棕: 'brown', 棕色: 'brown', 褐色: 'brown',
  white: 'white', 白: 'white', 白色: 'white',
  black: 'black', 黑: 'black', 黑色: 'black',
  gray: 'gray', grey: 'gray', 灰: 'gray', 灰色: 'gray',
}

const DISTRIBUTION_VALUES = ['left_heavy', 'right_heavy', 'middle_heavy', 'edge_heavy', 'balanced']

export type QueryKey =
  | 'tag' | 'checkpoint' | 'lora' | 'prompt' | 'generator' | 'rating' | 'score' | 'stars'
  | 'width' | 'height' | 'size' | 'aspect' | 'color' | 'light' | 'brightness' | 'saturation'
  | 'seed' | 'date' | 'artist' | 'folder' | 'has' | 'no'

const KEY_ALIASES: Record<string, QueryKey> = {
  tag: 'tag', t: 'tag', 标签: 'tag',
  checkpoint: 'checkpoint', model: 'checkpoint', 模型: 'checkpoint',
  lora: 'lora',
  prompt: 'prompt', 提示词: 'prompt', 提示: 'prompt',
  generator: 'generator', gen: 'generator', 生成器: 'generator',
  rating: 'rating', 分级: 'rating',
  score: 'score', aesthetic: 'score', 美学: 'score',
  stars: 'stars', star: 'stars', 星级: 'stars', 星: 'stars', 评分: 'stars',
  width: 'width', 宽: 'width', 宽度: 'width',
  height: 'height', 高: 'height', 高度: 'height',
  size: 'size', 尺寸: 'size',
  aspect: 'aspect', ratio: 'aspect', 比例: 'aspect',
  color: 'color', theme: 'color', temp: 'color', temperature: 'color', 颜色: 'color', 主题: 'color', 色温: 'color',
  light: 'light', dist: 'light', 光影: 'light',
  brightness: 'brightness', bright: 'brightness', 亮度: 'brightness',
  saturation: 'saturation', sat: 'saturation', 饱和度: 'saturation',
  seed: 'seed', 种子: 'seed',
  date: 'date', time: 'date', 日期: 'date', 时间: 'date',
  artist: 'artist', 画师: 'artist',
  folder: 'folder', 文件夹: 'folder',
  has: 'has', 有: 'has',
  no: 'no', 无: 'no',
}

/** Keys whose values autocomplete from a library endpoint. */
export const AUTOCOMPLETE_KEYS: Partial<Record<QueryKey, 'tags' | 'checkpoints' | 'loras' | 'prompts'>> = {
  tag: 'tags',
  checkpoint: 'checkpoints',
  lora: 'loras',
  prompt: 'prompts',
}

/** Fixed value suggestions for enum keys. */
export const ENUM_SUGGESTIONS: Partial<Record<QueryKey, readonly string[]>> = {
  generator: GENERATOR_VALUES,
  rating: ['general', 'sensitive', 'questionable', 'explicit'],
  aspect: ['square', 'portrait', 'landscape'],
  color: ['warm', 'cool', 'neutral', ...HUE_VALUES],
  light: DISTRIBUTION_VALUES,
  has: ['params'],
  no: ['params', 'caption'],
  score: ['none'],
  date: ['today', '7d', '30d'],
}

const NEGATABLE = new Set<QueryKey>(['tag', 'checkpoint', 'lora', 'prompt', 'generator', 'rating', 'color'])

export type WarnReason =
  | 'number' | 'date' | 'size' | 'generator' | 'rating' | 'aspect' | 'color' | 'light'
  | 'notNegatable' | 'starsMinOnly' | 'has' | 'no'

/** One line of the search-syntax help; descriptions live in the language packs. */
export const SYNTAX_ROWS: { syntax: string; example: string; key: string }[] = [
  { syntax: 'free text', example: 'silver hair', key: 'free' },
  { syntax: 'tag:VALUE', example: 'tag:silver_hair', key: 'tag' },
  { syntax: '-tag:VALUE', example: '-tag:blurry', key: 'negate' },
  { syntax: 'prompt:VALUE', example: 'prompt:"long hair"', key: 'prompt' },
  { syntax: 'checkpoint:VALUE', example: 'model:noobai', key: 'checkpoint' },
  { syntax: 'lora:VALUE', example: 'lora:detailer', key: 'lora' },
  { syntax: 'generator:VALUE', example: 'gen:nai', key: 'generator' },
  { syntax: 'rating:VALUE', example: 'rating:general', key: 'rating' },
  { syntax: 'score OP N', example: 'score>=7', key: 'score' },
  { syntax: 'score:none', example: 'score:none', key: 'scoreNone' },
  { syntax: 'stars>=N / ★N', example: '★4', key: 'stars' },
  { syntax: 'width / height OP N', example: 'width>=1024 height<=2048', key: 'dimensions' },
  { syntax: 'size:WxH', example: 'size:1024x1536', key: 'size' },
  { syntax: 'aspect:VALUE', example: 'aspect:portrait', key: 'aspect' },
  { syntax: 'color:VALUE', example: 'color:warm', key: 'color' },
  { syntax: 'brightness / saturation OP N', example: 'brightness>=180 sat<=60', key: 'brightness' },
  { syntax: 'seed:N', example: 'seed:314159', key: 'seed' },
  { syntax: 'date:VALUE', example: 'date:2026-05 date:7d', key: 'date' },
  { syntax: 'artist:VALUE', example: 'artist:wlop', key: 'artist' },
  { syntax: 'folder:VALUE', example: 'folder:keep', key: 'folder' },
  { syntax: 'has:params / no:params', example: 'has:params', key: 'hasParams' },
  { syntax: 'no:caption', example: 'no:caption', key: 'noCaption' },
  { syntax: 'key:a..b', example: 'score:6..8', key: 'range' },
  { syntax: 'contains(text)', example: 'contains(red)', key: 'contains' },
]

export interface Scalars {
  minAesthetic?: number
  maxAesthetic?: number
  aestheticUnscored?: boolean
  minUserRating?: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  aspectRatio?: string
  colorTemperature?: string
  brightnessDistribution?: string
  brightnessMin?: number
  brightnessMax?: number
  minSaturation?: number
  maxSaturation?: number
  seed?: number
  dateFrom?: string
  dateTo?: string
  artist?: string
  folder?: string
  hasMetadata?: boolean
  noCaption?: boolean
}

/** One recognised piece of the query, shown as a chip. `token` is its index in `tokens`. */
export type Part =
  | { kind: 'filter'; key: string; op: string; value: string; token: number }
  | { kind: 'free'; value: string; token: number }
  | { kind: 'warn'; raw: string; reason: WarnReason; hint: string; token: number }

export interface ParsedQuery {
  tokens: string[]
  tags: string[]
  excludeTags: string[]
  checkpoints: string[]
  excludeCheckpoints: string[]
  loras: string[]
  excludeLoras: string[]
  prompts: string[]
  excludePrompts: string[]
  generators: string[]
  excludeGenerators: string[]
  ratings: string[]
  excludeRatings: string[]
  excludeColors: string[]
  colorHues: string[]
  excludeColorHues: string[]
  scalars: Scalars
  freeText: string[]
  parts: Part[]
}

function empty(tokens: string[]): ParsedQuery {
  return {
    tokens,
    tags: [], excludeTags: [], checkpoints: [], excludeCheckpoints: [], loras: [], excludeLoras: [],
    prompts: [], excludePrompts: [], generators: [], excludeGenerators: [], ratings: [], excludeRatings: [],
    excludeColors: [], colorHues: [], excludeColorHues: [],
    scalars: {}, freeText: [], parts: [],
  }
}

const stripQuotes = (v: string) => v.replace(/^"|"$/g, '').trim()

function toNumber(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `score >= 7` → `score>=7`, so spaces around operators are fine. */
export function tightenOperators(raw: string): string {
  return raw
    .replace(/([A-Za-z一-鿿_]+)\s*(>=|<=|==|!=)\s*/g, '$1$2')
    .replace(/([A-Za-z一-鿿_]+)\s*([<>])\s*(?=[\d"])/g, '$1$2')
}

/** Split into tokens; quoted phrases (also key:"a b") stay together. */
export function splitTokens(raw: string): string[] {
  return tightenOperators(raw).match(/(?:[^\s"]+"[^"]*"|[^\s"]+|"[^"]*")+/g) ?? []
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return isoDay(new Date(y, m - 1, d + delta))
}

/** 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' → whole-period day bounds. */
function parsePeriod(value: string): { from: string; to: string } | null {
  let m = value.match(/^(\d{4})$/)
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` }
  m = value.match(/^(\d{4})-(\d{1,2})$/)
  if (m) {
    const month = m[2]!.padStart(2, '0')
    const last = new Date(Number(m[1]), Number(m[2]), 0).getDate()
    return { from: `${m[1]}-${month}-01`, to: `${m[1]}-${month}-${String(last).padStart(2, '0')}` }
  }
  m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) {
    const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
    return { from: iso, to: iso }
  }
  return null
}

function parseRange(value: string): [number, number] | null {
  const m = value.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/)
  if (!m) return null
  const lo = Number(m[1])
  const hi = Number(m[2])
  return [Math.min(lo, hi), Math.max(lo, hi)]
}

type NumericField = [keyof Scalars, keyof Scalars]

const NUMERIC_FIELDS: Partial<Record<QueryKey, NumericField>> = {
  score: ['minAesthetic', 'maxAesthetic'],
  width: ['minWidth', 'maxWidth'],
  height: ['minHeight', 'maxHeight'],
  brightness: ['brightnessMin', 'brightnessMax'],
  saturation: ['minSaturation', 'maxSaturation'],
}

export function parseSearch(raw: string, today: Date = new Date()): ParsedQuery {
  const tokens = splitTokens(raw)
  const r = empty(tokens)
  tokens.forEach((token, i) => handleToken(r, token, i, today))
  return r
}

function handleToken(r: ParsedQuery, token: string, index: number, today: Date): void {
  const filter = (key: string, op: string, value: string) => r.parts.push({ kind: 'filter', key, op, value, token: index })
  const warn = (reason: WarnReason, hint = '') => r.parts.push({ kind: 'warn', raw: token, reason, hint, token: index })
  const free = (text: string) => {
    if (!text) return
    r.freeText.push(text)
    r.parts.push({ kind: 'free', value: text, token: index })
  }
  const setScalar = <K extends keyof Scalars>(k: K, v: Scalars[K]) => {
    r.scalars[k] = v
  }

  // ★4 / ☆4: V4 shorthand for stars>=4
  const star = token.match(/^[★☆](\d)$/)
  if (star) {
    const n = Math.max(1, Math.min(5, Number(star[1])))
    setScalar('minUserRating', n)
    filter('stars', '≥', String(n))
    return
  }

  const contains = token.match(/^contains\((.*)\)$/i)
  if (contains) {
    free(stripQuotes(contains[1] ?? ''))
    return
  }

  let body = token
  let negated = false
  if (body.startsWith('-') && body.length > 1) {
    negated = true
    body = body.slice(1)
  }

  const m = body.match(/^([^:<>=!]+?)(>=|<=|==|!=|:|=|>|<)(.*)$/)
  if (!m) {
    free(stripQuotes(token))
    return
  }
  const rawKey = m[1]!.trim()
  let op = m[2]!
  const value = stripQuotes(m[3] ?? '')
  const key = KEY_ALIASES[rawKey.toLowerCase()] ?? KEY_ALIASES[rawKey]
  if (!key || !value) {
    free(stripQuotes(token))
    return
  }
  if (op === '!=') {
    negated = true
    op = ':'
  }
  if (op === '==' || op === '=') op = ':'
  if (negated && !NEGATABLE.has(key)) {
    warn('notNegatable')
    return
  }

  const list = (inc: string[], exc: string[], name: string, v: string) => {
    ;(negated ? exc : inc).push(v)
    filter(negated ? `-${name}` : name, '', v)
  }

  const numeric = NUMERIC_FIELDS[key]
  if (numeric) {
    if (key === 'score' && value.toLowerCase() === 'none') {
      setScalar('aestheticUnscored', true)
      filter('score', '=', 'none')
      return
    }
    const [minF, maxF] = numeric
    const range = parseRange(value)
    if (range) {
      ;(r.scalars as Record<string, unknown>)[minF] = range[0]
      ;(r.scalars as Record<string, unknown>)[maxF] = range[1]
      filter(key, '=', `${range[0]}..${range[1]}`)
      return
    }
    const n = toNumber(value)
    if (n === null) {
      warn('number')
      return
    }
    const s = r.scalars as Record<string, unknown>
    if (op === '>=' || op === '>') {
      s[minF] = n
      filter(key, '≥', String(n))
    } else if (op === '<=' || op === '<') {
      s[maxF] = n
      filter(key, '≤', String(n))
    } else if (key === 'score') {
      // score:7 reads as "at least 7", the way people write it
      s[minF] = n
      filter(key, '≥', String(n))
    } else {
      s[minF] = n
      s[maxF] = n
      filter(key, '=', String(n))
    }
    return
  }

  switch (key) {
    case 'tag':
      list(r.tags, r.excludeTags, 'tag', value)
      return
    case 'checkpoint':
      list(r.checkpoints, r.excludeCheckpoints, 'checkpoint', value)
      return
    case 'lora':
      list(r.loras, r.excludeLoras, 'lora', value)
      return
    case 'prompt':
      list(r.prompts, r.excludePrompts, 'prompt', value)
      return
    case 'generator': {
      const lower = value.toLowerCase()
      const gen = GENERATOR_ALIASES[lower] ?? lower
      if (!(GENERATOR_VALUES as readonly string[]).includes(gen)) {
        warn('generator', GENERATOR_VALUES.slice(0, 6).join(', ') + '…')
        return
      }
      list(r.generators, r.excludeGenerators, 'generator', gen)
      return
    }
    case 'rating': {
      const rating = RATING_ALIASES[value.toLowerCase()] ?? RATING_ALIASES[value]
      if (!rating) {
        warn('rating', 'general / sensitive / questionable / explicit')
        return
      }
      list(r.ratings, r.excludeRatings, 'rating', rating)
      return
    }
    case 'stars': {
      const n = toNumber(value)
      if (n === null) {
        warn('number')
        return
      }
      if (op === '<=' || op === '<') {
        warn('starsMinOnly')
        return
      }
      const stars = Math.max(1, Math.min(5, Math.trunc(op === '>' ? n + 1 : n)))
      setScalar('minUserRating', stars)
      filter('stars', '≥', String(stars))
      return
    }
    case 'size': {
      const s = value.match(/^(\d+)\s*[x×*]\s*(\d+)$/i)
      if (!s) {
        warn('size')
        return
      }
      const w = Number(s[1])
      const h = Number(s[2])
      Object.assign(r.scalars, { minWidth: w, maxWidth: w, minHeight: h, maxHeight: h })
      filter('size', '=', `${w}x${h}`)
      return
    }
    case 'aspect': {
      const aspect = ASPECT_ALIASES[value.toLowerCase()] ?? ASPECT_ALIASES[value]
      if (!aspect) {
        warn('aspect', 'square / portrait / landscape')
        return
      }
      setScalar('aspectRatio', aspect)
      filter('aspect', '', aspect)
      return
    }
    case 'color': {
      const lower = value.toLowerCase()
      const temp = TEMPERATURE_ALIASES[lower] ?? TEMPERATURE_ALIASES[value]
      if (temp) {
        if (negated) {
          r.excludeColors.push(temp)
          filter('-color', '', temp)
        } else {
          setScalar('colorTemperature', temp)
          filter('color', '', temp)
        }
        return
      }
      const hue = HUE_ALIASES[lower] ?? HUE_ALIASES[value]
      if (!hue) {
        warn('color', `warm / cool / neutral / ${HUE_VALUES.join(' / ')}`)
        return
      }
      list(r.colorHues, r.excludeColorHues, 'color', hue)
      return
    }
    case 'light': {
      const dist = value.toLowerCase()
      if (!DISTRIBUTION_VALUES.includes(dist)) {
        warn('light', DISTRIBUTION_VALUES.join(' / '))
        return
      }
      setScalar('brightnessDistribution', dist)
      filter('light', '', dist)
      return
    }
    case 'seed': {
      const n = toNumber(value)
      if (n === null) {
        warn('number')
        return
      }
      setScalar('seed', Math.trunc(n))
      filter('seed', '=', String(Math.trunc(n)))
      return
    }
    case 'date': {
      const v = value.toLowerCase()
      let from: string | null = null
      let to: string | null = null
      const rel = v.match(/^(\d{1,4})d$/)
      if (v === 'today') {
        from = to = isoDay(today)
      } else if (rel) {
        to = isoDay(today)
        from = addDays(to, -(Number(rel[1]) - 1))
      } else if (v.includes('..')) {
        const [a, b] = v.split('..')
        const lo = parsePeriod(a ?? '')
        const hi = parsePeriod(b ?? '')
        if (!lo || !hi) {
          warn('date')
          return
        }
        from = lo.from
        to = hi.to
      } else {
        const p = parsePeriod(v)
        if (!p) {
          warn('date')
          return
        }
        if (op === '>=') from = p.from
        else if (op === '<=') to = p.to
        else if (op === '>') from = addDays(p.to, 1)
        else if (op === '<') to = addDays(p.from, -1)
        else {
          from = p.from
          to = p.to
        }
      }
      if (from) setScalar('dateFrom', from)
      if (to) setScalar('dateTo', to)
      filter('date', '', `${from ?? '…'}..${to ?? '…'}`)
      return
    }
    case 'artist':
      setScalar('artist', value)
      filter('artist', '', value)
      return
    case 'folder':
      setScalar('folder', value)
      filter('folder', '', value)
      return
    case 'has': {
      const what = value.toLowerCase()
      if (what === 'params' || what === 'metadata' || what === '参数') {
        setScalar('hasMetadata', true)
        filter('has', '', 'params')
        return
      }
      warn('has', 'has:params')
      return
    }
    case 'no': {
      const what = value.toLowerCase()
      if (what === 'params' || what === 'metadata' || what === '参数') {
        setScalar('hasMetadata', false)
        filter('no', '', 'params')
        return
      }
      if (what === 'caption' || what === '字幕' || what === '描述') {
        setScalar('noCaption', true)
        filter('no', '', 'caption')
        return
      }
      warn('no', 'no:params / no:caption')
      return
    }
    default:
      free(stripQuotes(token))
  }
}

/** Remove one token (a chip's `token` index) and give back the query text. */
export function withoutToken(tokens: string[], index: number): string {
  return tokens.filter((_, i) => i !== index).join(' ')
}

export interface ScopeFilter {
  generators: string[]
  folder: string | null
  favoritesCollectionId: number | null
}

export type ImageQueryParams = Record<string, string | number | boolean>

const csv = (values: string[]) => [...new Set(values)].join(',')

/** Query line + left-rail scope → /api/images parameters. */
export function toImageParams(q: ParsedQuery, scope: ScopeFilter, sort: SortKey): ImageQueryParams {
  const p: ImageQueryParams = { sort_by: sort }
  const put = (k: string, v: string | number | boolean | undefined | null) => {
    if (v === undefined || v === null || v === '') return
    p[k] = v
  }
  put('search', q.freeText.join(' ').trim())
  put('tags', csv(q.tags))
  put('exclude_tags', csv(q.excludeTags))
  put('checkpoints', csv(q.checkpoints))
  put('exclude_checkpoints', csv(q.excludeCheckpoints))
  put('loras', csv(q.loras))
  put('exclude_loras', csv(q.excludeLoras))
  put('prompts', csv(q.prompts))
  put('exclude_prompts', csv(q.excludePrompts))
  put('generators', csv([...scope.generators, ...q.generators]))
  put('exclude_generators', csv(q.excludeGenerators))
  put('ratings', csv(q.ratings))
  put('exclude_ratings', csv(q.excludeRatings))
  put('exclude_colors', csv(q.excludeColors))
  put('color_hues', csv(q.colorHues))
  put('exclude_color_hues', csv(q.excludeColorHues))
  const s = q.scalars
  put('min_aesthetic', s.minAesthetic)
  put('max_aesthetic', s.maxAesthetic)
  if (s.aestheticUnscored) put('aesthetic_unscored', true)
  put('min_user_rating', s.minUserRating)
  put('min_width', s.minWidth)
  put('max_width', s.maxWidth)
  put('min_height', s.minHeight)
  put('max_height', s.maxHeight)
  put('aspect_ratio', s.aspectRatio)
  put('color_temperature', s.colorTemperature)
  put('brightness_distribution', s.brightnessDistribution)
  put('brightness_min', s.brightnessMin)
  put('brightness_max', s.brightnessMax)
  put('min_saturation', s.minSaturation)
  put('max_saturation', s.maxSaturation)
  put('seed', s.seed)
  put('date_from', s.dateFrom)
  put('date_to', s.dateTo)
  put('artist', s.artist)
  put('folder', s.folder ?? scope.folder)
  if (s.hasMetadata !== undefined) put('has_metadata', s.hasMetadata)
  if (s.noCaption) put('no_caption', true)
  if (scope.favoritesCollectionId !== null) put('collection_id', scope.favoritesCollectionId)
  return p
}

/** Where the caret sits in a `key:partial` token, for value suggestions. */
export interface SuggestContext {
  source: 'library' | 'enum'
  endpoint?: 'tags' | 'checkpoints' | 'loras' | 'prompts'
  values?: readonly string[]
  key: QueryKey
  prefix: string
  valueStart: number
  tokenEnd: number
}

export function suggestionContext(text: string, caret: number): SuggestContext | null {
  const pos = Math.max(0, Math.min(caret, text.length))
  let start = pos
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1
  let end = pos
  while (end < text.length && !/\s/.test(text[end]!)) end += 1
  let body = text.slice(start, end)
  let lead = 0
  if (body.startsWith('-') && body.length > 1) {
    body = body.slice(1)
    lead = 1
  }
  const m = body.match(/^([^:<>=!]+?)(:|==|=)(.*)$/)
  if (!m) return null
  const key = KEY_ALIASES[m[1]!.trim().toLowerCase()] ?? KEY_ALIASES[m[1]!.trim()]
  if (!key) return null
  const prefix = stripQuotes(m[3] ?? '')
  const valueStart = start + lead + m[1]!.length + m[2]!.length
  const endpoint = AUTOCOMPLETE_KEYS[key]
  if (endpoint) return prefix ? { source: 'library', endpoint, key, prefix, valueStart, tokenEnd: end } : null
  const values = ENUM_SUGGESTIONS[key]
  if (values) return { source: 'enum', values, key, prefix, valueStart, tokenEnd: end }
  return null
}
