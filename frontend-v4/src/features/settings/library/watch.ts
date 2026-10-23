import type { Params } from '../../../i18n'
import type { LibKey } from '../libraryText'
import type { LibraryRoot } from './types'

// Folder watching, read side: what GET /api/watch/status says and the line
// each watched folder shows (backend/services/folder_watch.py). The polling
// and the switch live in watchApi.ts.

/** One watched folder in GET /api/watch/status (`RootStatus.as_dict`). */
export interface RootWatchState {
  root_id: number
  path: string
  /** native = file-system events; polling = a network folder checked every 15 s. */
  mode: string
  /** starting, catching_up, watching, missing, error. */
  state: string
  error: string | null
  imported: number
  last_import_at: string | null
}

export interface WatchStatus {
  paused: boolean
  /** Grows whenever pictures arrive; starts again at 0 when the program restarts. */
  generation: number
  roots: RootWatchState[]
}

export interface WatchLine {
  key: LibKey
  params?: Params
}

/** Poll quickly while something is watched, rarely otherwise (a switch flipped elsewhere is still noticed). */
export const ACTIVE_POLL_MS = 4_000
export const IDLE_POLL_MS = 30_000

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

function readRoot(raw: unknown): RootWatchState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.root_id !== 'number') return null
  return {
    root_id: r.root_id,
    path: String(r.path ?? ''),
    mode: String(r.mode ?? 'native'),
    state: String(r.state ?? 'starting'),
    error: textOrNull(r.error),
    imported: num(r.imported),
    last_import_at: textOrNull(r.last_import_at),
  }
}

/** What GET /api/watch/status answered; null when it is not a status at all. */
export function readWatchStatus(raw: unknown): WatchStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.roots)) return null
  return {
    paused: r.paused === true,
    generation: num(r.generation),
    roots: r.roots.map(readRoot).filter((root): root is RootWatchState => root !== null),
  }
}

/** The backend stores the switch as 0/1. */
export function isWatched(root: Pick<LibraryRoot, 'watch'>): boolean {
  return root.watch === true || Number(root.watch) === 1
}

export function watchStateFor(status: WatchStatus | null, rootId: number): RootWatchState | undefined {
  return status?.roots.find((root) => root.root_id === rootId)
}

/** "Changed", not "grew": the counter starts again at 0 when the program restarts while the page stays open. */
export function picturesArrived(previous: number | null, next: number): boolean {
  return previous !== null && previous !== next
}

export function pollDelay(status: WatchStatus | null): number {
  return status && status.roots.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS
}

function baseLine(state: RootWatchState | undefined, paused: boolean): WatchLine {
  if (paused) return { key: 'libset.watch.paused' }
  if (!state) return { key: 'libset.watch.starting' }
  if (state.state === 'missing') return { key: 'libset.watch.missing' }
  if (state.state === 'error') return { key: 'libset.watch.error', params: { error: state.error ?? '' } }
  if (state.state === 'catching_up' || state.state === 'starting') return { key: 'libset.watch.catchingUp' }
  return { key: state.mode === 'polling' ? 'libset.watch.polling' : 'libset.watch.active' }
}

/** The live state of one watched folder: what it is doing, then how many pictures it added and when. */
export function watchLines(state: RootWatchState | undefined, paused: boolean): WatchLine[] {
  const base = baseLine(state, paused)
  const running = base.key === 'libset.watch.active' || base.key === 'libset.watch.polling'
  if (!running || !state || state.imported <= 0) return [base]
  const when = (state.last_import_at ?? '').replace('T', ' ').slice(0, 19)
  return [base, { key: 'libset.watch.imported', params: { n: state.imported, when } }]
}
