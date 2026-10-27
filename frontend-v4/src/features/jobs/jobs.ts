import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { asScanSource, installRunOf, isFinished, readProgress, scanIdentity, type JobKind, type JobProgress, type ReadContext } from './progress'
import { adoptSmartTag, driveSmartTag } from './smartTagDriver'
import { drivePurity, drivePurityDownload } from './purityDriver'
import { driveMasks } from './maskDriver'
import { adoptAesthetic, driveAesthetic } from './aestheticDriver'
import { driveDatasetExport } from './datasetExportDriver'
import { adoptReparse, driveReparse } from './reparseDriver' // reparse/reread
import { adoptSortRules, driveSortRules } from './sortRulesDriver' // sortrules/sortundo
import { driveOllama, ollamaAdoption } from './ollamaDriver' // ollama
import { adoptArtist, driveArtist } from './artistDriver' // artist
import { driveVideo } from './videoDriver' // video
import { adoptVideoInstall } from './videoJob' // video
import { driveMediaCensor, lookAtMediaJob } from './mediaCensorDriver' // mediacensor
import { trackedMediaJobs } from '../censor/media/mediaTracked' // mediacensor
import { adoptStyleMap, driveStyleMap } from './styleMapDriver' // stylemap
import { driveColors } from './colorsDriver' // partialsa
import { jobHeadline } from './headline'

// Every long job the user started (or that was already running when V4
// opened) lives here until dismissed. The backend runs one job per queue
// (move and copy share one), so progress is polled per queue.

export { jobHeadline } from './headline'

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
  /** Its own words instead of its kind's (a Smart Tag run that only describes). */
  words?: { running: MessageKey; done: MessageKey }
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
  | 'ollama'
  | 'artist' // artist
  | 'video' // video
  | 'mediacensor' // mediacensor
  | 'stylemap' // stylemap
  | 'recomfy' // partialsa: every ComfyUI prompt read again

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
  /** stylemap: a job the backend can pause and resume. */
  pause?: { pause: (job: Job) => Promise<unknown>; resume: (job: Job) => Promise<unknown> }
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
  colors: driveColors, // partialsa: colour analysis (pause, resume, stop)
  reconnect: {
    poll: async () => unwrap(await api.GET('/api/images/reconnect-missing/progress')),
    cancel: async () => unwrap(await api.POST('/api/images/reconnect-missing/cancel')),
  },
  scan: {
    poll: async () => unwrap(await api.GET('/api/scan/progress')),
    // A rescan or an idle check is stopped under its own source; only a manual import is confirmed.
    cancel: async (job) => unwrap(await api.POST('/api/scan/cancel', { body: scanIdentity(job.ctx) })),
    settle: async (job) =>
      job.ctx.scanSource && job.ctx.scanSource !== 'manual'
        ? null
        : unwrap(await api.POST('/api/scan/acknowledge', { body: { run_id: job.ctx.runId ?? 0, source: 'manual' } })),
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
  recomfy: driveReparse, // partialsa: the same slot
  sortrules: driveSortRules, // sortrules
  sortundo: driveSortRules, // sortundo (the same batch-move slot)
  ollama: driveOllama, // ollama: an Ollama model download (it cannot be stopped)
  video: driveVideo, // video: the ffmpeg download for video support (it cannot be stopped)
  mediacensor: driveMediaCensor, // mediacensor: GIF and video censoring (the backend runs one job at a time)
  artist: driveArtist, // artist: style identification (the backend runs one batch at a time)
  stylemap: driveStyleMap, // stylemap: the Style Map's index (pause, resume, stop)
}

export const canStop = (kind: JobKind) => DRIVERS[queueOf(kind)].cancel !== null

/** stylemap: whether the drawer offers Pause / Resume for this kind of job. */
export const canPause = (kind: JobKind) => DRIVERS[queueOf(kind)].pause !== undefined

/** stylemap: pause or resume a job; the next poll shows the new state (the reason is said on failure). */
export async function pauseJob(job: Job, pause: boolean): Promise<boolean> {
  const control = DRIVERS[queueOf(job.kind)].pause
  if (!control) return false
  try {
    await (pause ? control.pause(job) : control.resume(job))
    // Only the flag: the job's counts may have moved on since this row was drawn.
    useJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === job.id ? { ...j, progress: { ...j.progress, paused: pause } } : j)) }))
    return true
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

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
      const ctx = { runId: Number(raw.run_id ?? 0), scanSource: asScanSource(raw.source) }
      return { kind: 'scan', progress: readProgress('scan', raw, ctx), ctx }
    }),
    adopt('embed', (raw) => (raw.running === true ? { kind: 'embed', progress: readProgress('embed', raw) } : null)),
    adoptDuplicateScan(),
    adoptMediaCensor(), // mediacensor
    adopt('aesthetic', adoptAesthetic),
    adopt('reparse', adoptReparse), // reparse/reread
    adopt('sortrules', adoptSortRules), // sortrules/sortundo
    adopt('ollama', ollamaAdoption), // ollama
    adopt('artist', adoptArtist), // artist
    adopt('video', adoptVideoInstall), // video
    adopt('stylemap', adoptStyleMap), // stylemap
    adopt('colors', adoptColors), // partialsa
    adopt('smarttag', adoptSmartTag),
    adopt('install', (raw) => {
      const result = (raw.prepare_result ?? {}) as Record<string, unknown>
      if (result.active !== true || typeof result.model_id !== 'string') return null
      const ctx = { modelId: result.model_id, ...installRunOf(result.run_id) }
      return { kind: 'install', progress: readProgress('install', raw, ctx), ctx, label: result.model_id }
    }),
  ])
}

/**
 * GIF / video censor jobs this browser started before a reload (mediaTracked.ts).
 * A job the program still knows comes back with its progress (or its end, if it
 * ended while the page was away); one it no longer knows (it was restarted) comes
 * back saying so.
 */
async function adoptMediaCensor(): Promise<void> {
  for (const tracked of trackedMediaJobs()) {
    if (useJobs.getState().jobs.some((j) => j.kind === 'mediacensor' && j.ctx.mediaCensor?.jobId === tracked.id)) continue
    const ctx = { mediaCensor: { jobId: tracked.id, folder: tracked.folder } }
    // An unanswered look reads as "still running, no contact": the polling goes on and says so.
    const progress = readProgress('mediacensor', await lookAtMediaJob(tracked.id), ctx)
    addJob({ kind: 'mediacensor', count: tracked.count, label: tracked.label, destination: tracked.folder, ctx, progress })
  }
}

/** partialsa: a colour analysis already running when V4 opened (a reload, or the classic page started it). */
function adoptColors(raw: NonNullable<Raw>): NewJob | null {
  if (raw.running !== true) return null
  const progress = readProgress('colors', raw)
  return { kind: 'colors', progress, count: progress.total }
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
  ollama: ['vlm-local-models'], // ollama: the AI services page lists what Ollama has
  video: ['video-support', 'media-censor-status', 'image-count', 'images', 'image'], // video: video support turns the library's videos into readable items
  artist: ['artist-stats', 'artist-images', 'images', 'image-count'], // artist: the style tool's numbers and lists, an artist: search
  mediacensor: [], // mediacensor: the results are new files outside the library
  stylemap: ['artist-stats', 'artist-images', 'images', 'image-count'], // stylemap: the index also stores each picture's artist guess
  recomfy: ['images', 'image', 'image-count', 'library-health'], // partialsa: re-read prompts change gallery rows
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
