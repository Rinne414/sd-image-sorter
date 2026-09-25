import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { isFinished, readProgress, type JobKind, type JobProgress } from './progress'

// Every long file job the user started (or that was already running when V4
// opened) lives here until dismissed. The backend runs one job per queue
// (move+copy share one), so progress is polled per queue.

export interface Job {
  id: string
  kind: JobKind
  /** How many images were sent. */
  count: number
  destination: string | null
  /** The ids sent, in order; empty for a job found running at start-up. */
  ids: number[]
  progress: JobProgress
  adopted: boolean
  pollErrors: number
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

type Queue = 'move' | 'trash' | 'remove'

const queueOf = (kind: JobKind): Queue => (kind === 'copy' ? 'move' : kind)

/** Polls in a row that may fail before a job is reported as lost. */
const MAX_POLL_ERRORS = 5

let seq = 0

const tr = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

function patchJob(id: string, patch: Partial<Job>): void {
  useJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }))
}

function startingProgress(total: number): JobProgress {
  return {
    status: 'running',
    current: 0,
    total,
    succeeded: 0,
    failedCount: 0,
    failures: [],
    alreadyGone: 0,
    currentItem: null,
    message: '',
  }
}

export function isQueueBusy(kind: JobKind): boolean {
  return useJobs.getState().jobs.some((j) => queueOf(j.kind) === queueOf(kind) && !isFinished(j.progress.status))
}

async function postStart(kind: JobKind, ids: number[], destination: string | null): Promise<unknown> {
  switch (kind) {
    case 'move':
    case 'copy':
      return unwrap(
        await api.POST('/api/move/start', {
          body: { image_ids: ids, destination_folder: destination ?? '', operation: kind },
        }),
      )
    case 'trash':
      return unwrap(
        await api.POST('/api/images/delete-selected/start', {
          body: { image_ids: ids, confirm_delete_files: true, background: false },
        }),
      )
    case 'remove':
      return unwrap(await api.POST('/api/images/remove-selected/start', { body: { image_ids: ids, background: false } }))
  }
}

async function getProgress(queue: Queue): Promise<unknown> {
  switch (queue) {
    case 'move':
      return unwrap(await api.GET('/api/move/progress'))
    case 'trash':
      return unwrap(await api.GET('/api/images/delete-selected/progress'))
    case 'remove':
      return unwrap(await api.GET('/api/images/remove-selected/progress'))
  }
}

async function postCancel(queue: Queue): Promise<void> {
  switch (queue) {
    case 'move':
      unwrap(await api.POST('/api/move/cancel'))
      return
    case 'trash':
      unwrap(await api.POST('/api/images/delete-selected/cancel'))
      return
    case 'remove':
      unwrap(await api.POST('/api/images/remove-selected/cancel'))
  }
}

/** Start a file job for `ids`. Returns false (and says why) when it could not start. */
export async function startFileJob(kind: JobKind, ids: number[], destination: string | null = null): Promise<boolean> {
  if (isQueueBusy(kind)) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const res = await postStart(kind, ids, destination)
    const doneAlready = !!res && typeof res === 'object' && (res as { status?: unknown }).status === 'done'
    const job: Job = {
      id: `${kind}-${++seq}`,
      kind,
      count: ids.length,
      destination,
      ids,
      progress: doneAlready ? readProgress(kind, res) : startingProgress(ids.length),
      adopted: false,
      pollErrors: 0,
    }
    useJobs.setState((s) => ({ jobs: [job, ...s.jobs] }))
    if (doneAlready) finish(job)
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    const text = busy ? tr('jobs.busy') : tr('error.generic', { reason: (error as Error).message })
    useToasts.getState().push(text, 'error')
    return false
  }
}

export async function stopJob(job: Job): Promise<void> {
  try {
    await postCancel(queueOf(job.kind))
    patchJob(job.id, { progress: { ...job.progress, status: 'cancelling' } })
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}

async function pollOne(job: Job): Promise<void> {
  try {
    const progress = readProgress(job.kind, await getProgress(queueOf(job.kind)))
    const next = { ...job, progress, pollErrors: 0 }
    patchJob(job.id, { progress, pollErrors: 0 })
    if (isFinished(progress.status)) finish(next)
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

/** Pick up jobs that were already running when V4 opened (a reload, or V3.5 on the same app). */
export async function adoptRunningJobs(): Promise<void> {
  const queues: Queue[] = ['move', 'trash', 'remove']
  await Promise.all(
    queues.map(async (queue) => {
      try {
        const raw = (await getProgress(queue)) as { status?: unknown; operation?: unknown } | null
        if (raw?.status !== 'running' && raw?.status !== 'cancelling') return
        if (useJobs.getState().jobs.some((j) => queueOf(j.kind) === queue && !isFinished(j.progress.status))) return
        const kind: JobKind = queue === 'move' ? (raw.operation === 'copy' ? 'copy' : 'move') : queue
        const progress = readProgress(kind, raw)
        const job: Job = {
          id: `${kind}-${++seq}`,
          kind,
          count: progress.total,
          destination: null,
          ids: [],
          progress,
          adopted: true,
          pollErrors: 0,
        }
        useJobs.setState((s) => ({ jobs: [job, ...s.jobs] }))
      } catch {
        // the app is still starting or unreachable: nothing to adopt
      }
    }),
  )
}

// What each job changes in the library. Copies are not indexed, so they change nothing;
// removed or trashed images are not re-read (they are gone).
const GONE_KEYS = ['images', 'folders', 'generators', 'image-count', 'library-health', 'missing-summary', 'favorites', 'libraries']
const REFRESH_KEYS: Record<JobKind, string[]> = {
  move: ['images', 'image', 'folders', 'image-count', 'library-health', 'missing-summary'],
  copy: [],
  trash: GONE_KEYS,
  remove: GONE_KEYS,
}

/** The job ended: refresh what it changed, drop vanished picks, tell the user. */
function finish(job: Job): void {
  const p = job.progress
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
  useToasts.getState().push(jobHeadline(job), failedSomething ? 'error' : 'info', failedSomething ? show : undefined)
}

const RUNNING: Record<JobKind, MessageKey> = {
  move: 'jobs.running.move',
  copy: 'jobs.running.copy',
  trash: 'jobs.running.trash',
  remove: 'jobs.running.remove',
}

const DONE: Record<JobKind, MessageKey> = {
  move: 'jobs.done.move',
  copy: 'jobs.done.copy',
  trash: 'jobs.done.trash',
  remove: 'jobs.done.remove',
}

/** One line that says what happened (or is happening) to this job. */
export function jobHeadline(job: Job): string {
  const p = job.progress
  switch (p.status) {
    case 'running':
      return tr(RUNNING[job.kind], { n: p.total || job.count })
    case 'cancelling':
      return `${tr(RUNNING[job.kind], { n: p.total || job.count })} · ${tr('jobs.stopping')}`
    case 'cancelled':
      return tr('jobs.stopped', { done: p.current, total: p.total || job.count })
    case 'error':
      return tr('jobs.error', { reason: p.message || '?' })
    case 'idle':
      return tr('jobs.reset')
    case 'done': {
      // Chinese joins the destination without a space; English carries its own.
      let text = tr(DONE[job.kind], { n: p.succeeded })
      if (job.destination) text += tr('jobs.to', { path: tailOfPath(job.destination, 40) })
      if (p.failedCount) text += tr('jobs.failedSuffix', { n: p.failedCount })
      if (p.alreadyGone) text += tr('jobs.alreadyGone', { n: p.alreadyGone })
      return text
    }
  }
}
