import { useEffect } from 'react'
import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../api/client'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'
import { loadRecord, runBody, saveRecord, type RunRecord } from './rules'
import { groupsBody, type RuleGroup } from './ruleSet'
import type { SortSetup } from './savedSetup'

// Starts a sort-by-condition run and its undo (both background runs of the
// backend's batch move, followed in the Jobs drawer as sortrules/sortundo)
// and remembers the library's last run, so the Sort tab can show it and undo
// it after a reload.

interface RulesState {
  libraryId: string | null
  record: RunRecord | null
  /** Read the remembered run of this library (once per library). */
  use: (libraryId: string) => void
  set: (record: RunRecord | null) => void
}

export const useRules = create<RulesState>((set, get) => ({
  libraryId: null,
  record: null,
  use: (libraryId) => {
    if (get().libraryId !== libraryId) set({ libraryId, record: loadRecord(libraryId) })
  },
  set: (record) => {
    const { libraryId } = get()
    if (libraryId) saveRecord(libraryId, record)
    set({ record })
  },
}))

/** The last sort-by-condition run of this library (null: none remembered). */
export function useRulesRecord(libraryId: string): RunRecord | null {
  const record = useRules((s) => (s.libraryId === libraryId ? s.record : null))
  useEffect(() => useRules.getState().use(libraryId), [libraryId])
  return record
}

function reasonOf(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return tr('sort.rules.busy')
  return (error as Error).message
}

/** Start the run over these images; null when it runs, else why it did not start. */
export async function startRulesRun(ids: number[], setup: SortSetup): Promise<string | null> {
  if (isQueueBusy('sortrules') || isQueueBusy('sortundo')) return tr('sort.rules.busy')
  let answer: { run_token?: string; total?: number; count?: number }
  try {
    answer = unwrap(await api.POST('/api/batch-move', { body: runBody(ids, setup.rule, setup.operation) }))
  } catch (error) {
    return tr('sort.start.failed', { reason: reasonOf(error) })
  }
  const total = answer.total ?? answer.count ?? 0
  if (!answer.run_token || total === 0) return tr('sort.start.empty')
  const destination = setup.rule.destination ?? ''
  addJob({ kind: 'sortrules', count: total, destination, ids, ctx: { runToken: answer.run_token }, progress: startingProgress(total) })
  useRules.getState().set({ token: answer.run_token, operation: setup.operation, destination, splitBy: setup.rule.splitBy, total, phase: 'sort', open: true, groups: [] })
  return null
}

/**
 * Start one run over several rules' images, each group into its own rule's
 * folder (one Jobs entry, one undo); null when it runs, else why it did not start.
 */
export async function startRulesGroups(groups: readonly RuleGroup[], setup: SortSetup): Promise<string | null> {
  if (isQueueBusy('sortrules') || isQueueBusy('sortundo')) return tr('sort.rules.busy')
  const body = groupsBody(groups, setup.operation)
  let answer: { run_token?: string; total?: number; count?: number }
  try {
    answer = unwrap(await api.POST('/api/batch-move', { body }))
  } catch (error) {
    return tr('sort.start.failed', { reason: reasonOf(error) })
  }
  const total = answer.total ?? answer.count ?? 0
  if (!answer.run_token || total === 0) return tr('sort.start.empty')
  const used = groups.filter((g) => g.ids.length > 0)
  const first = used[0]?.rule
  const destination = first?.destination ?? ''
  addJob({ kind: 'sortrules', count: total, destination, ids: body.image_ids, ctx: { runToken: answer.run_token }, progress: startingProgress(total) })
  useRules.getState().set({
    token: answer.run_token,
    operation: setup.operation,
    destination,
    splitBy: first?.splitBy ?? 'none',
    total,
    phase: 'sort',
    open: true,
    groups: used.map((g) => ({ destination: g.rule.destination ?? '', splitBy: g.rule.splitBy, count: g.ids.length })),
  })
  return null
}

/** Undo the remembered run; null when the undo runs, else why it did not start. */
export async function undoRulesRun(record: RunRecord): Promise<string | null> {
  if (isQueueBusy('sortrules') || isQueueBusy('sortundo')) return tr('sort.rules.busy')
  let answer: { total?: number }
  try {
    answer = unwrap(await api.POST('/api/batch-move/undo', { body: { run_token: record.token } }))
  } catch (error) {
    return tr('sort.start.failed', { reason: reasonOf(error) })
  }
  const total = answer.total ?? record.total
  addJob({ kind: 'sortundo', count: total, destination: record.destination, ctx: { runToken: record.token }, progress: startingProgress(total) })
  useRules.getState().set({ ...record, phase: 'undo', open: true })
  return null
}
