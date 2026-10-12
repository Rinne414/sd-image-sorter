import { modelFilterValue } from '../../../lib/imageInfo'
import { normalize, type LexTab } from './lexiconQuery'

// Pure: the four library endpoints as one row shape, and the rows a search,
// a sort and a category choice leave (the whole list, no cap).

export interface LexRow {
  /** As the library shows it. */
  name: string
  /** What the search filter is written with (a model's short name). */
  value: string
  count: number
}

export type LexSort = 'count' | 'name'

type Raw = Record<string, unknown>

const rowsOf = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const FIELD: Record<LexTab, [list: string, name: string]> = {
  tags: ['tags', 'tag'],
  prompts: ['prompts', 'prompt'],
  loras: ['loras', 'lora'],
  checkpoints: ['checkpoints', 'checkpoint'],
}

/** GET /api/{tags,prompts,loras,checkpoints}/library as rows; a row without a name is left out. */
export function fromPayload(tab: LexTab, body: unknown): LexRow[] {
  const [list, field] = FIELD[tab]
  const raw = rowsOf((body as Raw | null)?.[list])
  return raw.flatMap((r) => {
    const name = str(r[field]) || str(r.checkpoint_normalized)
    const value = tab === 'checkpoints' ? modelFilterValue(str(r.checkpoint_normalized) || name) : name
    return name && value ? [{ name, value, count: num(r.count) }] : []
  })
}

const byCount = (a: LexRow, b: LexRow) => b.count - a.count || a.name.localeCompare(b.name)
const byName = (a: LexRow, b: LexRow) => normalize(a.name).localeCompare(normalize(b.name)) || b.count - a.count

export interface Shown {
  find: string
  sort: LexSort
  /** Tags only: keep the ones whose category is this. */
  category?: string | null
  categories?: ReadonlyMap<string, string>
}

/** The rows to list: those whose name has the searched text, in the chosen order. */
export function shownRows(rows: readonly LexRow[], { find, sort, category = null, categories }: Shown): LexRow[] {
  const needle = normalize(find)
  const kept = rows.filter((r) => (!needle || normalize(r.name).includes(needle)) && (!category || categories?.get(r.name) === category))
  return kept.sort(sort === 'name' ? byName : byCount)
}
