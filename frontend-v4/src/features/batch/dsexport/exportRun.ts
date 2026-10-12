import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { setDatasetExportSource } from '../../jobs/datasetExportDriver'
import { addJob, isQueueBusy, startingProgress, tr } from '../../jobs/jobs'
import { projectKey } from '../datasetApi'
import { fetchHeads } from '../datasetTagApi'
import { entriesFromProject } from '../entries'
import { exportBody, readV4Options, splitEntries, type Choices, type ExportBody } from './plan'
import { fileName, refusedKey, type DatasetExportResult, type ReadinessIssue, type ReadinessReport } from './report'
import { flushExportOptions } from './useExportOptions'

// "Check and export" is one job in the Jobs drawer. The backend's check
// (Readiness) runs over exactly the body the export will send; when nothing
// stops it the export starts at once with the check's proof. Both are bulk
// jobs this page follows. Nothing is written when the check finds a problem
// that stops the export: the step shows it with what can be done. A reload
// picks a run up again when the export step opens.

const POLL_MS = 500
const MAX_POLL_ERRORS = 5

export type DsRun =
  | { state: 'running'; phase: 'check' | 'export'; current: number; total: number; item: string | null; cancelling: boolean }
  | { state: 'blocked'; report: ReadinessReport; choices: Choices }
  | { state: 'refused'; key: string | null; message: string }
  | { state: 'failed'; message: string }
  | { state: 'done'; result: DatasetExportResult; warnings: ReadinessIssue[] }

interface RunsState {
  runs: Record<number, DsRun | undefined>
  /** Images the user agreed to leave out after the backend refused them (this visit). */
  leftOut: Record<number, string[] | undefined>
}

export const useDsRuns = create<RunsState>(() => ({ runs: {}, leftOut: {} }))

function setRun(batchId: number, run: DsRun | null): void {
  useDsRuns.setState((s) => ({ runs: { ...s.runs, [batchId]: run ?? undefined } }))
}

export const clearDsRun = (batchId: number) => setRun(batchId, null)

export function leaveOut(batchId: number, key: string): void {
  useDsRuns.setState((s) => ({ leftOut: { ...s.leftOut, [batchId]: [...new Set([...(s.leftOut[batchId] ?? []), key])] } }))
}

// ---- what the drawer reads (datasetExportJob.ts) ----

type Raw = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})

interface Snapshot {
  status: 'running' | 'cancelling' | 'done' | 'cancelled' | 'error'
  phase: 'check' | 'export'
  current: number
  total: number
  exported: number
  failed: number
  failures: { name: string; reason: string }[]
  current_item: string | null
  message: string
}

let snapshot: Snapshot | null = null
let following: { batchId: number; bulkId: string } | null = null

const publish = (change: Partial<Snapshot>) => {
  if (snapshot) snapshot = { ...snapshot, ...change }
}

setDatasetExportSource({ snapshot: () => snapshot, cancel: () => void stopFollowed() })

function tick(batchId: number, phase: 'check' | 'export', raw: Raw): void {
  const progress = obj(obj(raw.result).progress)
  const current = phase === 'check' ? num(raw.processed) : num(progress.current)
  const total = (phase === 'check' ? num(raw.total) : num(progress.total)) || num(raw.total)
  const name = str(progress.current_item)
  const item = `${tr(phase === 'check' ? 'dataset.export.phase.check' : 'dataset.export.phase.export')}${name ? ` · ${name}` : ''}`
  const cancelling = str(raw.status) === 'cancelling' || snapshot?.status === 'cancelling'
  publish({ phase, current, total, current_item: item, exported: num(progress.exported), failed: num(progress.errors) })
  setRun(batchId, { state: 'running', phase, current, total, item, cancelling })
}

async function stopFollowed(): Promise<void> {
  if (!following) return
  publish({ status: 'cancelling' })
  try {
    unwrap(await api.POST('/api/bulk-jobs/{job_id}/cancel', { params: { path: { job_id: following.bulkId } } }))
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}

export function stopDsRun(batchId: number): void {
  if (following?.batchId === batchId) void stopFollowed()
}

// ---- a run that outlives a reload ----

const KEY = 'sd-v4-dataset-export-run'

interface Pending {
  batchId: number
  phase: 'check' | 'export'
  bulkId: string
  total: number
  body?: ExportBody
  choices?: Choices
  warnings?: ReadinessIssue[]
}

function remember(p: Pending): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage blocked or full: a reload then loses the run (the files still get written)
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // storage blocked
  }
}

function pending(batchId: number): Pending | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Pending | null
    return p && p.batchId === batchId && typeof p.bulkId === 'string' ? p : null
  } catch {
    return null
  }
}

// ---- the run ----

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Poll one bulk job until it ends; a few failed polls in a row are forgiven. */
async function follow(batchId: number, bulkId: string, phase: 'check' | 'export'): Promise<Raw> {
  following = { batchId, bulkId }
  let errors = 0
  for (;;) {
    try {
      const raw = unwrap<Raw>(await api.GET('/api/bulk-jobs/{job_id}', { params: { path: { job_id: bulkId } } }))
      errors = 0
      tick(batchId, phase, raw)
      if (['done', 'error', 'cancelled'].includes(str(raw.status))) return raw
    } catch (error) {
      errors += 1
      if (errors >= MAX_POLL_ERRORS) throw error
    }
    await sleep(POLL_MS)
  }
}

async function readView(batchId: number): Promise<BatchProjectView> {
  return queryClient.fetchQuery({
    queryKey: projectKey(useApp.getState().libraryId, batchId),
    queryFn: async () => unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } } })),
    staleTime: 0,
  })
}

/** The body from the project and caption versions as they are now (a stale version would be refused). */
async function buildBody(batch: Batch, choices: Choices): Promise<ExportBody> {
  const view = await readView(batch.id)
  const heads = await fetchHeads(view)
  const { send } = splitEntries(entriesFromProject(view), new Set(useDsRuns.getState().leftOut[batch.id] ?? []))
  return exportBody({ settings: view.project.settings, batchSettings: batch.settings, project: view.project, send, heads, options: readV4Options(batch.settings), choices })
}

function beginJob(batch: Batch, destination: string, total: number, adopted = false): void {
  snapshot = { status: 'running', phase: 'check', current: 0, total, exported: 0, failed: 0, failures: [], current_item: null, message: '' }
  addJob({ kind: 'dsexport', count: total, destination: destination || null, label: batch.name, adopted, progress: startingProgress(total) })
}

function finishBlocked(batchId: number, report: ReadinessReport, choices: Choices): void {
  forget()
  publish({ status: 'error', message: tr('dataset.export.job.blocked', { n: report.summary.blocker_count }) })
  setRun(batchId, { state: 'blocked', report, choices })
}

function finishFailed(batchId: number, message: string, key: string | null = null): void {
  forget()
  publish({ status: 'error', message: key ? tr('dataset.export.job.refused') : message })
  setRun(batchId, key ? { state: 'refused', key, message } : { state: 'failed', message })
}

function finishDone(batchId: number, result: DatasetExportResult, warnings: ReadinessIssue[]): void {
  forget()
  const failures = (result.items ?? []).filter((i) => i.error).map((i) => ({ name: fileName(i.src_image_path ?? ''), reason: i.error ?? '' }))
  const status = result.status === 'cancelled' ? 'cancelled' : result.status === 'failed' ? 'error' : 'done'
  publish({ status, current: result.total_items, exported: result.exported, failed: result.error_count, failures, message: result.error_messages?.[0] ?? '' })
  setRun(batchId, { state: 'done', result, warnings })
}

async function afterCheck(batchId: number, bulkId: string, body: ExportBody, choices: Choices): Promise<void> {
  const raw = await follow(batchId, bulkId, 'check')
  if (str(raw.status) === 'cancelled') {
    forget()
    publish({ status: 'cancelled' })
    return setRun(batchId, null)
  }
  if (str(raw.status) !== 'done') {
    const message = (Array.isArray(raw.error_samples) ? str(raw.error_samples[0]) : '') || str(raw.message)
    return finishFailed(batchId, message, refusedKey(message))
  }
  const report = raw.result as unknown as ReadinessReport
  if (report.summary.blocker_count > 0) return finishBlocked(batchId, report, choices)
  const warnings = report.issues.filter((i) => i.severity === 'warning')
  const proof = { readiness_report_id: report.report_id, readiness_input_fingerprint: report.input_fingerprint }
  const started = unwrap<{ job_id: string; total: number }>(await api.POST('/api/dataset/export/start', { body: { ...body, ...proof } as never }))
  remember({ batchId, phase: 'export', bulkId: started.job_id, total: started.total, warnings })
  await afterExport(batchId, started.job_id, warnings)
}

async function afterExport(batchId: number, bulkId: string, warnings: ReadinessIssue[]): Promise<void> {
  const raw = await follow(batchId, bulkId, 'export')
  const result = obj(raw.result)
  if (typeof result.status !== 'string' || !Array.isArray(result.items)) {
    return finishFailed(batchId, (Array.isArray(raw.error_samples) ? str(raw.error_samples[0]) : '') || str(raw.message))
  }
  finishDone(batchId, result as unknown as DatasetExportResult, warnings)
}

/** Why the backend refused a start: in the user's words where it has some. */
function failure(error: unknown): string {
  if (!(error instanceof ApiError)) return tr('jobs.lost', { reason: (error as Error)?.message ?? String(error) })
  if (error.code?.startsWith('readiness_')) return tr('dataset.export.fail.changed')
  if (error.status === 409) return tr('dataset.export.fail.busy')
  return tr('dataset.export.fail.refusedSettings', { reason: error.message })
}

/** Check, then export when nothing stops it: one job. */
export async function checkAndExport(batch: Batch, choices: Choices): Promise<void> {
  if (useDsRuns.getState().runs[batch.id]?.state === 'running') return
  if (isQueueBusy('dsexport')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return
  }
  setRun(batch.id, { state: 'running', phase: 'check', current: 0, total: 0, item: null, cancelling: false })
  let begun = false
  try {
    await flushExportOptions(batch.id)
    const body = await buildBody(batch, choices)
    const started = unwrap<{ job_id: string; total: number }>(await api.POST('/api/dataset/readiness/start', { body: body as never }))
    beginJob(batch, body.output_folder, started.total)
    begun = true
    setRun(batch.id, { state: 'running', phase: 'check', current: 0, total: started.total, item: null, cancelling: false })
    remember({ batchId: batch.id, phase: 'check', bulkId: started.job_id, total: started.total, body, choices })
    await afterCheck(batch.id, started.job_id, body, choices)
  } catch (error) {
    // Refused before a job began: nothing to put in the drawer, the step says why.
    if (begun) finishFailed(batch.id, failure(error))
    else setRun(batch.id, { state: 'failed', message: failure(error) })
  } finally {
    following = null
  }
}

/** The export step opened after a reload: follow the run this tab started, if it has not ended. */
export async function resumeDsRun(batch: Batch): Promise<void> {
  const p = pending(batch.id)
  if (!p || useDsRuns.getState().runs[batch.id] || isQueueBusy('dsexport')) return
  setRun(batch.id, { state: 'running', phase: p.phase, current: 0, total: p.total, item: null, cancelling: false })
  beginJob(batch, '', p.total, true)
  try {
    if (p.phase === 'export') await afterExport(batch.id, p.bulkId, p.warnings ?? [])
    else if (p.body && p.choices) await afterCheck(batch.id, p.bulkId, p.body, p.choices)
    else finishFailed(batch.id, tr('dataset.export.fail.changed'))
  } catch (error) {
    finishFailed(batch.id, failure(error))
  } finally {
    following = null
  }
}
