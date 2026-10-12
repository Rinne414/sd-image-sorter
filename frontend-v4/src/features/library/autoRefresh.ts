// Checking the source folders for new images while the user is away (opt-in,
// Settings › Library): when a check is due, and what the backend's answer
// means. The clock and the requests live in autoRefreshRun.ts.

export const IDLE_MS = 60_000
export const EVERY_MS = 5 * 60_000

export interface IdleState {
  on: boolean
  hidden: boolean
  /** An import of ours is running (the backend would skip anyway). */
  busy: boolean
  now: number
  lastActivity: number
  lastAttempt: number
}

export function autoRefreshDue(s: IdleState): boolean {
  if (!s.on || s.hidden || s.busy) return false
  return s.now - s.lastActivity >= IDLE_MS && s.now - s.lastAttempt >= EVERY_MS
}

export type AutoRefreshAnswer =
  | { kind: 'started'; runId: number; source: string; root: string }
  | { kind: 'quiet' }
  | { kind: 'unexpected'; detail: string }

const QUIET = new Set(['skipped:scan_in_progress', 'skipped:manual_completion_pending', 'idle:no_enabled_roots'])

/** What POST /api/library/auto-refresh answered. */
export function readAutoRefresh(raw: unknown): AutoRefreshAnswer {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const status = typeof r.status === 'string' ? r.status : ''
  if (QUIET.has(`${status}:${String(r.reason ?? '')}`)) return { kind: 'quiet' }
  const scan = r.scan && typeof r.scan === 'object' ? (r.scan as Record<string, unknown>) : {}
  if (status === 'started' && typeof scan.run_id === 'number' && scan.run_id > 0) {
    return { kind: 'started', runId: scan.run_id, source: String(scan.source ?? ''), root: String(r.root ?? '') }
  }
  const detail = typeof r.detail === 'string' && r.detail ? r.detail : status
  return { kind: 'unexpected', detail }
}
