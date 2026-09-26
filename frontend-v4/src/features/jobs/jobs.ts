import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { isFinished, readProgress, type JobKind, type JobProgress, type ReadContext } from './progress'
import { driveSmartTag } from './smartTagDriver'
import { drivePurity, drivePurityDownload } from './purityDriver'
import { driveMasks } from './maskDriver'
import { adoptAesthetic, driveAesthetic } from './aestheticDriver'
import { driveDatasetExport } from './datasetExportDriver'
import { adoptReparse, driveReparse } from './reparseDriver' // reparse/reread
import { adoptSortRules, driveSortRules } from './sortRulesDriver' // sortrules/sortundo
import { queuedKey } from './queued'

// Every long job the user started (or that was already running when V4
// opened) lives here until dismissed. The backend runs one job per queue
// (move and copy share one), so progress is polled per queue.

export interface Job {
  id: string
  kind: JobKind
  /** How many images were sent (0 for a model download). */
  count: number
  destination: string | null
  /** The ids sent, in order; empty for a job found running at start-up. */
  ids: number[]
  progress: JobProgress
  adopted: boolean
  pollErrors: number
  ctx: ReadContext
  /** A model download: the model's display name. */
  label: string | null
  /** Runs once if the job ends well (a download, then the work that needed it). */
  then?: (job: Job) => void | Promise<void>
  /** A bulk tag edit that can be undone once. */
  undo?: { opId: string; done: boolean }
}

interface JobsState {
  jobs: Job[]
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  dismiss: (id: string) => void
  clearFinished: () => void
}

export const useJobs = create<JobsState>((set, get) => ({
  jobs: [],
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  dismiss: (id) => set({ jobs: get().jobs.filter((j) => j.id !== id) }),
  clearFinished: () => set({ jobs: get().jobs.filter((j) => !isFinished(j.progress.status)) }),
}))

type Queue = 'move' | 'trash' | 'remove' | 'tag' | 'install' | 'tags' | 'colors' | 'reconnect' | 'scan' | 'detect' | 'embed' | 'dupscan'
  | 'smarttag'
  | 'purity' | 'purityget'
  | 'masks'
  | 'aesthetic'
  | 'dsexport'
  | 'reparse' | 'reread'
  | 'sortrules' | 'sortundo' // sortrules/sortundo

// Censor work over a batch (detecting, SAM3 refining, filters) runs one at a time.
const queueOf = (kind: JobKind): Queue => (kind === 'copy' ? 'move' : kind === 'refine' || kind === 'adjust' ? 'detect' : kind)

/**
 * A job that runs in this page instead of on the backend reports through the
 * feature that runs it (registered here, so this core stays feature-free).
 * `snapshot` answers in the shape its progress reader expects.
 */
export interface LocalJobSource {
  snapshot: () => unknown
  cancel: () => void
}

let detectSource: LocalJobSource | null = null

export function setDetectSource(source: LocalJobSource): void {
  detectSource = source
}

interface Driver {
  /** `job` is absent when looking for a job that was already running. */
  poll: (job?: Job) => Promise<unknown>
  /** null: the backend cannot stop this kind of job. */
  cancel: ((job: Job) => Promise<unknown>) | null
  /** After the job ends (an import clears its finished run so the next one may start). */
  settle?: (job: Job) => Promise<unknown>
  /** Refreshed while the job runs, whenever more images have arrived. */
  liveKeys?: string[]
}

const DRIVERS: Record<Queue, Driver> = {
  move: {
    poll: async () => unwrap(await api.GET('/api/move/progress')),
    cancel: async () => unwrap(await api.POST('/api/move/cancel')),
  },
  trash: {
    poll: async () => unwrap(await api.GET('/api/images/delete-selected/progress')),
    cancel: async () => unwrap(await api.POST('/api/images/delete-selected/cancel')),
  },
  remove: {
    poll: async () => unwrap(await api.GET('/api/images/remove-selected/progress')),
    cancel: async () => unwrap(await api.POST('/api/images/remove-selected/cancel')),
  },
  tag: {
    poll: async () => unwrap(await api.GET('/api/tag/progress')),
    cancel: async () => unwrap(await api.POST('/api/tag/cancel')),
  },
  install: {
    poll: async () => unwrap(await api.GET('/api/models/download-progress')),
    cancel: null,
  },
  colors: {
    poll: async () => unwrap(await api.GET('/api/colors/progress')),
    cancel: async () => unwrap(await api.POST('/api/colors/cancel')),
  },
  reconnect: {
    poll: async () => unwrap(await api.GET('/api/images/reconnect-missing/progress')),
    cancel: async () => unwrap(await api.POST('/api/images/reconnect-missing/cancel')),
  },
  scan: {
    poll: async () => unwrap(await api.GET('/api/scan/progress')),
    cancel: async (job) => unwrap(await api.POST('/api/scan/cancel', { body: { run_id: job.ctx.runId ?? 0, source: 'manual' } })),
    settle: async (job) => unwrap(await api.POST('/api/scan/acknowledge', { body: { run_id: job.ctx.runId ?? 0, source: 'manual' } })),
    liveKeys: ['images', 'generators', 'folders', 'libraries'],
  },
  // Bulk tag edits finish inside their request; they are never polled.
  tags: {
    poll: async () => ({ status: 'done' }),
    cancel: null,
  },
  // Censor detection over a batch runs in this page; a reload ends it (the poll then reports an error).
  detect: {
    poll: async () => detectSource?.snapshot() ?? null,
    cancel: async () => detectSource?.cancel(),
  },
  embed: {
    poll: async () => unwrap(await api.GET('/api/similarity/progress')),
    cancel: async () => unwrap(await api.POST('/api/similarity/cancel')),
  },
  // The duplicate scan is a bulk job; its id comes back when it starts.
  dupscan: {
    poll: async (job) => {
      const id = job?.ctx.bulkJobId ?? ''
      return unwrap(await api.GET('/api/bulk-jobs/{job_id}', { params: { path: { job_id: id } } }))
    },
    cancel: async (job) =>
      unwrap(await api.POST('/api/bulk-jobs/{job_id}/cancel', { params: { path: { job_id: job.ctx.bulkJobId ?? '' } } })),
  },
  smarttag: driveSmartTag,
  purity: drivePurity,
  purityget: drivePurityDownload,
  masks: driveMasks,
  aesthetic: driveAesthetic,
  dsexport: driveDatasetExport,
  reparse: driveReparse,
  reread: driveReparse, // reparse/reread share the backend's one slot (409 while either runs)
  sortrules: driveSortRules, // sortrules
  sortundo: driveSortRules, // sortundo (the same batch-move slot)
}

export const canStop = (kind: JobKind) => DRIVERS[queueOf(kind)].cancel !== null

/** Polls in a row that may fail before a job is reported as lost. */
const MAX_POLL_ERRORS = 5

let seq = 0

export const tr = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

export function patchJob(id: string, patch: Partial<Job>): void {
  useJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }))
}

export function startingProgress(total: number, status: JobProgress['status'] = 'running'): JobProgress {
  return {
    status,
    current: 0,
    total,
    unit: 'images',
    succeeded: 0,
    failedCount: 0,
    failures: [],
    alreadyGone: 0,
    topTags: [],
    needsRestart: false,
    restartAdvised: false,
    toReview: 0,
    phase: null,
    updated: 0,
    currentItem: null,
    message: '',
  }
}

export function isQueueBusy(kind: JobKind): boolean {
  return useJobs.getState().jobs.some((j) => queueOf(j.kind) === queueOf(kind) && !isFinished(j.progress.status))
}

type NewJob = Pick<Job, 'kind' | 'progress'> & Partial<Omit<Job, 'id' | 'kind' | 'progress'>>

/** Put a job the backend has accepted into the list; it is polled from then on. */
export function addJob(fields: NewJob): Job {
  const job: Job = {
    count: 0,
    destination: null,
    ids: [],
    adopted: false,
    pollErrors: 0,
    ctx: {},
    label: null,
    ...fields,
    id: `${fields.kind}-${++seq}`,
  }
  useJobs.setState((s) => ({ jobs: [job, ...s.jobs] }))
  if (isFinished(job.progress.status)) finish(job)
  return job
}

export async function stopJob(job: Job): Promise<void> {
  const cancel = DRIVERS[queueOf(job.kind)].cancel
  if (!cancel) return
  try {
    await cancel(job)
    patchJob(job.id, { progress: { ...job.progress, status: 'cancelling' } })
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}

/** Live refreshes are at most this often, however fast images arrive. */
const LIVE_REFRESH_MS = 3000
let lastLiveRefresh = 0

async function pollOne(job: Job): Promise<void> {
  try {
    const driver = DRIVERS[queueOf(job.kind)]
    const progress = readProgress(job.kind, await driver.poll(job), job.ctx, job.progress) // signals: the last reading, for a run that ended between two looks
    patchJob(job.id, { progress, pollErrors: 0 })
    if (driver.liveKeys && progress.succeeded > job.progress.succeeded && Date.now() - lastLiveRefresh > LIVE_REFRESH_MS) {
      lastLiveRefresh = Date.now()
      for (const key of driver.liveKeys) void queryClient.invalidateQueries({ queryKey: [key] })
    }
    if (isFinished(progress.status)) finish({ ...job, progress })
  } catch (error) {
    const pollErrors = job.pollErrors + 1
    if (pollErrors < MAX_POLL_ERRORS) {
      patchJob(job.id, { pollErrors })
      return
    }
    const progress: JobProgress = {
      ...job.progress,
      status: 'error',
      message: tr('jobs.lost', { reason: (error as Error).message }),
    }
    patchJob(job.id, { progress, pollErrors })
    finish({ ...job, progress })
  }
}

let polling = false

/** One polling round over every unfinished job. Overlapping rounds are skipped. */
export async function pollJobs(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const active = useJobs.getState().jobs.filter((j) => !isFinished(j.progress.status))
    await Promise.all(active.map(pollOne))
  } finally {
    polling = false
  }
}

type Raw = Record<string, unknown> | null

/** Pick up jobs that were already running when V4 opened (a reload, or V3.5 on the same app). */
export async function adoptRunningJobs(): Promise<void> {
  const adopt = async (queue: Queue, toJob: (raw: NonNullable<Raw>) => NewJob | null) => {
    try {
      const raw = (await DRIVERS[queue].poll()) as Raw
      if (!raw || isQueueBusy(queue)) return
      const job = toJob(raw)
      if (job) addJob({ ...job, adopted: true })
    } catch {
      // the app is still starting or unreachable: nothing to adopt
    }
  }
  const running = (raw: NonNullable<Raw>) => raw.status === 'running' || raw.status === 'cancelling'
  const fileJob = (kind: JobKind) => (raw: NonNullable<Raw>) => {
    if (!running(raw)) return null
    const progress = readProgress(kind, raw)
    return { kind, progress, count: progress.total }
  }
  await Promise.all([
    adopt('move', (raw) => fileJob(raw.operation === 'copy' ? 'copy' : 'move')(raw)),
    adopt('trash', fileJob('trash')),
    adopt('remove', fileJob('remove')),
    adopt('tag', (raw) => {
      if (!running(raw)) return null
      const ctx = { baseRunId: Number(raw.run_id ?? 0) - 1 }
      const progress = readProgress('tag', raw, ctx)
      return { kind: 'tag', progress, ctx, count: progress.total }
    }),
    adopt('scan', (raw) => {
      if (!['starting', 'running', 'cancelling'].includes(String(raw.status))) return null
      const ctx = { runId: Number(raw.run_id ?? 0) }
      return { kind: 'scan', progress: readProgress('scan', raw, ctx), ctx }
    }),
    adopt('embed', (raw) => (raw.running === true ? { kind: 'embed', progress: readProgress('embed', raw) } : null)),
    adoptDuplicateScan(),
    adopt('aesthetic', adoptAesthetic),
    adopt('reparse', adoptReparse), // reparse/reread
    adopt('sortrules', adoptSortRules), // sortrules/sortundo
    adopt('install', (raw) => {
      const result = (raw.prepare_result ?? {}) as Record<string, unknown>
      if (result.active !== true || typeof result.model_id !== 'string') return null
      const ctx = { modelId: result.model_id }
      return { kind: 'install', progress: readProgress('install', raw, ctx), ctx, label: result.model_id }
    }),
  ])
}

/** A duplicate scan the backend is still running (it keeps its bulk job id for us). */
async function adoptDuplicateScan(): Promise<void> {
  try {
    const raw = unwrap<{ active?: boolean; job_id?: string | null; job?: unknown }>(await api.GET('/api/duplicates/scan-status'))
    if (!raw.active || !raw.job_id || isQueueBusy('dupscan')) return
    const ctx = { bulkJobId: raw.job_id }
    addJob({ kind: 'dupscan', progress: readProgress('dupscan', raw.job, ctx), ctx, adopted: true })
  } catch {
    // the app is still starting or unreachable: nothing to adopt
  }
}

// What each job changes in the library. Copies are not indexed, so they change
// nothing; removed or trashed images are not re-read (they are gone).
const GONE_KEYS = ['images', 'folders', 'generators', 'image-count', 'library-health', 'missing-summary', 'favorites', 'libraries', 'duplicates', 'similar', 'similarity-stats']
const REFRESH_KEYS: Record<JobKind, string[]> = {
  move: ['images', 'image', 'folders', 'image-count', 'library-health', 'missing-summary'],
  copy: [],
  trash: GONE_KEYS,
  remove: GONE_KEYS,
  tag: ['images', 'image', 'suggest', 'image-count', 'library-health'],
  install: ['model-status'],
  tags: ['images', 'image', 'suggest', 'image-count', 'library-health'],
  colors: ['images', 'image', 'image-count', 'colors-missing'],
  scan: ['images', 'image', 'generators', 'folders', 'libraries', 'library-health', 'missing-summary', 'missing-groups', 'colors-missing', 'image-count'],
  reconnect: ['images', 'image', 'missing-summary', 'missing-groups', 'repair-candidates', 'library-health', 'folders', 'reconnect-result'],
  // Each image's result is saved (and the batch refreshed) as it arrives.
  detect: [],
  refine: [],
  adjust: [],
  embed: ['similarity-stats', 'similar'],
  dupscan: ['duplicates'],
  smarttag: ['images', 'image', 'suggest', 'image-count', 'library-health', 'batch-project', 'batch-heads', 'dataset-preview'],
  purity: [],
  purityget: ['purity-status'],
  masks: ['mask-status'],
  aesthetic: ['images', 'image', 'image-count', 'library-health'],
  dsexport: ['images', 'image', 'batch-project'],
  reparse: ['images', 'image', 'image-count', 'library-health'],
  reread: ['images', 'image', 'image-count', 'library-health', 'missing-summary', 'missing-groups'], // reread: a file that no longer opens joins the missing files
  sortrules: ['images', 'image', 'folders', 'image-count', 'library-health', 'missing-summary'], // sortrules
  sortundo: ['images', 'image', 'folders', 'image-count', 'library-health', 'missing-summary'], // sortundo
}

let onUndo: ((job: Job) => Promise<void>) | null = null

/** The feature that knows how to undo a `tags` job registers here (keeps this core feature-free). */
export function setUndoHandler(handler: (job: Job) => Promise<void>): void {
  onUndo = handler
}

export function undoJob(job: Job): Promise<void> {
  return onUndo ? onUndo(job) : Promise.resolve()
}

/** The job ended: refresh what it changed, drop vanished picks, tell the user, run what waited. */
function finish(job: Job): void {
  const p = job.progress
  const settle = DRIVERS[queueOf(job.kind)].settle
  if (settle && !job.adopted) void settle(job).catch(() => undefined)
  if (job.kind === 'trash' || job.kind === 'remove') {
    // The backend works through the ids in the order sent, so the first
    // `current` were handled; failures among them are still there.
    const failed = new Set(p.failures.map((f) => f.id))
    const gone = new Set(job.ids.slice(0, p.current).filter((id) => !failed.has(id)))
    if (gone.size) {
      const s = useApp.getState()
      s.setSelection(s.selection.filter((id) => !gone.has(id)))
      if (s.inspectedId !== null && gone.has(s.inspectedId)) s.inspect(null)
    }
  }
  // After the picks are cleaned up, so nothing asks for an image that is gone.
  for (const key of REFRESH_KEYS[job.kind]) void queryClient.invalidateQueries({ queryKey: [key] })

  const failedSomething = p.failedCount > 0 || p.status === 'error'
  const show = { label: tr('jobs.show'), run: () => useJobs.getState().setDrawerOpen(true) }
  // A model that cannot be used before a restart must not start the work waiting for it.
  const blocked = p.status === 'done' && p.needsRestart
  if (blocked && job.then) {
    useToasts.getState().push(tr('jobs.mustRestart', { name: job.label ?? '' }), 'error', show)
    return
  }
  // A download that leads straight into other work speaks through that work.
  if (!(job.then && p.status === 'done')) {
    const undo = job.undo && onUndo ? { label: tr('toast.undo'), run: () => void onUndo?.(job) } : undefined
    useToasts.getState().push(jobHeadline(job), failedSomething ? 'error' : 'info', failedSomething ? show : undo)
  }
  if (p.status === 'done') void job.then?.(job)
}

const RUNNING: Record<JobKind, MessageKey> = {
  move: 'jobs.running.move',
  copy: 'jobs.running.copy',
  trash: 'jobs.running.trash',
  remove: 'jobs.running.remove',
  tag: 'jobs.running.tag',
  install: 'jobs.running.install',
  tags: 'jobs.done.tags',
  colors: 'jobs.running.colors',
  reconnect: 'jobs.running.reconnect',
  scan: 'jobs.running.scan',
  detect: 'jobs.running.detect',
  refine: 'jobs.running.refine',
  adjust: 'jobs.running.adjust',
  embed: 'sim.job.running.embed',
  dupscan: 'sim.job.running.dupscan',
  smarttag: 'dataset.job.running',
  purity: 'dataset.check.purity.running',
  purityget: 'dataset.check.purity.downloading',
  masks: 'dataset.masks.job.running',
  aesthetic: 'info.aes.job.running',
  dsexport: 'dataset.export.job.running',
  reparse: 'status.reparse.running',
  reread: 'status.reread.running',
  sortrules: 'sort.rules.job.running', // sortrules
  sortundo: 'sort.rules.job.undoing', // sortundo
}

const DONE: Record<JobKind, MessageKey> = {
  move: 'jobs.done.move',
  copy: 'jobs.done.copy',
  trash: 'jobs.done.trash',
  remove: 'jobs.done.remove',
  tag: 'jobs.done.tag',
  install: 'jobs.done.install',
  tags: 'jobs.done.tags',
  colors: 'jobs.done.colors',
  reconnect: 'jobs.done.reconnect',
  scan: 'jobs.done.scan',
  detect: 'jobs.done.detect',
  refine: 'jobs.done.refine',
  adjust: 'jobs.done.adjust',
  embed: 'sim.job.done.embed',
  dupscan: 'sim.job.done.dupscan',
  smarttag: 'dataset.job.done',
  purity: 'dataset.check.purity.done',
  purityget: 'dataset.check.purity.downloaded',
  masks: 'dataset.masks.job.done',
  aesthetic: 'info.aes.job.done',
  dsexport: 'dataset.export.job.done',
  reparse: 'status.reparse.done',
  reread: 'status.reread.done',
  sortrules: 'sort.rules.job.done', // sortrules
  sortundo: 'sort.rules.job.undone', // sortundo
}

/** One line that says what happened (or is happening) to this job. */
export function jobHeadline(job: Job): string {
  const p = job.progress
  const params = { n: p.total || job.count, name: job.label ?? '' }
  switch (p.status) {
    case 'queued':
      return tr(queuedKey(job.kind), { what: tr(RUNNING[job.kind], params) })
    case 'running':
      return tr(RUNNING[job.kind], params)
    case 'cancelling':
      return `${tr(RUNNING[job.kind], params)} · ${tr('jobs.stopping')}`
    case 'cancelled':
      return tr('jobs.stopped', { done: p.current, total: p.total || job.count })
    case 'error':
      return tr('jobs.error', { reason: p.message || '?' })
    case 'idle':
      return tr('jobs.reset')
    case 'done': {
      // Chinese joins the destination without a space; English carries its own.
      let text = tr(DONE[job.kind], { n: p.succeeded, name: job.label ?? '' })
      if (job.destination && (job.kind === 'move' || job.kind === 'copy')) text += tr('jobs.to', { path: tailOfPath(job.destination, 40) })
      if (p.updated) text += tr('jobs.updatedSuffix', { n: p.updated })
      if (p.failedCount) text += tr('jobs.failedSuffix', { n: p.failedCount })
      if (p.alreadyGone) text += tr('jobs.alreadyGone', { n: p.alreadyGone })
      return text
    }
  }
}
