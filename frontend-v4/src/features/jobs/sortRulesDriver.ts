import { api, unwrap } from '../../api/client'
import { readProgress } from './progress'
import { sortRunKind } from './sortRulesJob'

// Polls and stops a sort-by-condition run and its undo (sortrules/sortundo) for
// the Jobs drawer. Both run in the backend's one batch-move slot (read by
// sortRulesJob.ts); features/sort/rulesActions.ts starts them.

export const driveSortRules = {
  poll: async (): Promise<unknown> => unwrap(await api.GET('/api/batch-move/progress')),
  cancel: async (): Promise<unknown> => unwrap(await api.POST('/api/batch-move/cancel')),
}

/** A sort run (or its undo) the backend is still working on when V4 opens. */
export function adoptSortRules(raw: Record<string, unknown>) {
  const kind = sortRunKind(raw)
  if (!kind || (raw.status !== 'running' && raw.status !== 'cancelling')) return null
  const ctx = { runToken: String(raw.run_token ?? '') }
  const progress = readProgress(kind, raw, ctx)
  return { kind, progress, ctx, count: progress.total }
}
