import type { JobFailure, JobProgress } from './progress'

// Reads a sort-by-condition run for the Jobs drawer (sortrules), and its undo
// (sortundo): both run in the backend's batch-move slot, GET
// /api/batch-move/progress, which names the run it is showing (run_token). A
// progress that names another run (a newer one, or one V3.5 started) is not
// ours: the job then ends as "idle" instead of showing someone else's numbers.
// Pure: sortRulesDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

/** Every failure the run kept (the backend keeps the first 200 by name, and counts all). */
function failures(raw: Raw): JobFailure[] {
  const list = rows(raw.error_items).length ? rows(raw.error_items) : rows(raw.recent_errors)
  return list.map((r) => ({ id: typeof r.image_id === 'number' ? r.image_id : null, name: str(r.filename), reason: str(r.error) || 'Failed' }))
}

export function readSortRules(base: JobProgress, raw: Raw, runToken: string | undefined): JobProgress {
  if (runToken && str(raw.run_token) !== runToken) return { ...base, status: 'idle' }
  const failed = failures(raw)
  return {
    ...base,
    succeeded: num(raw.moved),
    failures: failed,
    failedCount: Math.max(num(raw.errors), num(raw.error_items_total), failed.length),
  }
}

/** Which of the two a running batch-move progress is: a sort run, its undo, or neither (not one of V4's). */
export function sortRunKind(raw: Raw): 'sortrules' | 'sortundo' | null {
  if (raw.run_kind === 'undo') return 'sortundo'
  return raw.run_kind === 'sort' ? 'sortrules' : null
}
