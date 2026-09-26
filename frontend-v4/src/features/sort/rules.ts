import { parseSearch, toImageParams, type ImageQueryParams } from '../../lib/searchQuery'
import type { FileOperation } from './sortSession'

// Sort by condition (按条件分): every image a condition matches (or the picks)
// goes into one folder at once, optionally split into subfolders, as one
// background run of the backend's batch move; the run can be undone. The
// condition is the library's search language. Pure: rulesRun.ts runs it.

export const SPLITS = ['none', 'generator', 'checkpoint', 'rating'] as const
export type SplitBy = (typeof SPLITS)[number]

export interface RuleSetup {
  /** The condition, in the library's search language ('' = no condition). */
  query: string
  destination: string | null
  splitBy: SplitBy
}

export const EMPTY_RULE: RuleSetup = { query: '', destination: null, splitBy: 'none' }

/** A stored rule made safe. */
export function cleanRule(raw: unknown): RuleSetup {
  if (!raw || typeof raw !== 'object') return EMPTY_RULE
  const { query, destination, splitBy } = raw as Record<string, unknown>
  return {
    query: typeof query === 'string' ? query : '',
    destination: typeof destination === 'string' && destination.trim() ? destination : null,
    splitBy: SPLITS.includes(splitBy as SplitBy) ? (splitBy as SplitBy) : 'none',
  }
}

/** The condition as the library's /api/images parameters (no rail scope: the text says it all). */
export function conditionParams(query: string, sortBy: string): ImageQueryParams {
  return toImageParams(parseSearch(query), { generators: [], folder: null, favoritesCollectionId: null }, sortBy)
}

/** A condition that narrows nothing would sort the whole library out. */
export function isEverything(query: string): boolean {
  const parsed = parseSearch(query)
  return parsed.parts.filter((p) => p.kind !== 'warn').length === 0
}

/** Body of POST /api/batch-move for these images. */
export function runBody(ids: number[], rule: RuleSetup, operation: FileOperation) {
  return {
    image_ids: ids,
    destination_folder: rule.destination ?? '',
    operation,
    split_by: rule.splitBy === 'none' ? null : rule.splitBy,
    // Filter settings the request model requires; unused when image_ids is given.
    tag_mode: 'and',
    prompt_match_mode: 'exact',
  }
}

// ---- the last run of this library, kept so it can be seen and undone after a reload ----

export type RunPhase = 'sort' | 'undo' | 'undone'

export interface RunRecord {
  token: string
  operation: FileOperation
  destination: string
  splitBy: SplitBy
  total: number
  phase: RunPhase
  /** The Sort tab shows this run (its progress, then its summary). */
  open: boolean
}

const recordKey = (libraryId: string) => `sd-v4-sort-rules-run:${libraryId}`

export function loadRecord(libraryId: string): RunRecord | null {
  try {
    const raw = JSON.parse(localStorage.getItem(recordKey(libraryId)) ?? 'null') as Record<string, unknown> | null
    if (!raw || typeof raw.token !== 'string' || !/^[0-9a-f]{32}$/.test(raw.token)) return null
    return {
      token: raw.token,
      operation: raw.operation === 'copy' ? 'copy' : 'move',
      destination: typeof raw.destination === 'string' ? raw.destination : '',
      splitBy: cleanRule({ splitBy: raw.splitBy }).splitBy,
      total: typeof raw.total === 'number' ? raw.total : 0,
      phase: raw.phase === 'undo' || raw.phase === 'undone' ? raw.phase : 'sort',
      open: raw.open === true,
    }
  } catch {
    return null
  }
}

export function saveRecord(libraryId: string, record: RunRecord | null): void {
  try {
    if (record) localStorage.setItem(recordKey(libraryId), JSON.stringify(record))
    else localStorage.removeItem(recordKey(libraryId))
  } catch {
    // storage blocked: the run is still in the Jobs list, just not remembered here
  }
}

// ---- what the batch-move progress says about our run ----

export interface RunFailure {
  name: string
  reason: string
}

export interface RunState {
  /** 'lost': the backend now shows another run; this one's numbers are gone. */
  status: 'running' | 'cancelling' | 'done' | 'cancelled' | 'error' | 'lost'
  kind: 'sort' | 'undo'
  current: number
  total: number
  succeeded: number
  failed: number
  failures: RunFailure[]
  message: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const RUN_STATUSES = new Set(['running', 'cancelling', 'done', 'cancelled', 'error'])

/** GET /api/batch-move/progress as the state of the run named `token`. */
export function readRun(payload: unknown, token: string): RunState {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const items = Array.isArray(p.error_items) ? (p.error_items as Record<string, unknown>[]) : []
  const failures = items.map((r) => ({ name: String(r.filename ?? ''), reason: String(r.error ?? '') }))
  const ours = p.run_token === token && RUN_STATUSES.has(String(p.status))
  return {
    status: ours ? (p.status as RunState['status']) : 'lost',
    kind: p.run_kind === 'undo' ? 'undo' : 'sort',
    current: num(p.current),
    total: num(p.total),
    succeeded: num(p.moved),
    failed: Math.max(num(p.errors), num(p.error_items_total), failures.length),
    failures,
    message: typeof p.message === 'string' ? p.message : '',
  }
}

export const isRunning = (run: RunState) => run.status === 'running' || run.status === 'cancelling'

/** Backend reasons an undo gives, by the words the page shows instead. */
export type ReasonKey = 'movedAgain' | 'notInLibrary' | 'copyChanged' | 'copyIndexed' | 'occupied'

/** A backend reason the page can word itself (with the folder it names), or null to show it as sent. */
export function knownReason(reason: string): { key: ReasonKey; folder?: string } | null {
  if (reason.startsWith('It was moved again since')) return { key: 'movedAgain' }
  if (reason.startsWith('It is no longer in the library')) return { key: 'notInLibrary' }
  if (reason.startsWith('The copy was changed since')) return { key: 'copyChanged' }
  if (reason.startsWith('The copy has been imported')) return { key: 'copyIndexed' }
  const occupied = /another file named '.*' is already in '(.*)'/.exec(reason)
  return occupied ? { key: 'occupied', folder: occupied[1] } : null
}
