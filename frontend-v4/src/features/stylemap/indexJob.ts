import { ApiError } from '../../api/client'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import { rawJson } from '../../api/raw'
import { useToasts } from '../../ui/toasts'
import { installThen } from '../jobs/installJob'
import { addJob, isQueueBusy, startingProgress, tr, useJobs, type Job } from '../jobs/jobs'
import { isFinished, readProgress } from '../jobs/progress'
import type { ModelCard } from '../tagging/taggers'
import { modelConfig, useArtistPrefs } from '../tools/artist/artistPrefs'
import { followPause, startClock, type RunClock } from './status'
import type { Space } from './types'

// "Build style index": POST /api/style-map/vectors/start over the map's scope,
// followed as a job in the Jobs drawer (pause, resume, stop there and on the
// page). Kaloscope runs the Style Finder tool's model settings (source, local
// file, graphics card, confidence floor), so both write the same rows; CSD
// has one pinned file and only takes the graphics-card choice. A model that
// is not on disk downloads first, as its own job, and the index starts after.

const VECTORS = '/api/style-map/vectors'

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

/**
 * Each index job's working time (job id -> clock), for the time left: when it
 * began (a job found running uses the backend's start) and how long it sat
 * paused, so a pause never stretches the estimate.
 */
export const indexClocks = new Map<string, RunClock>()

// Pause and resume (on the page or in the Jobs drawer) move the clocks.
useJobs.subscribe((s) => {
  const now = Date.now()
  for (const job of s.jobs) {
    const clock = job.kind === 'stylemap' ? indexClocks.get(job.id) : undefined
    if (!clock) continue
    const next = followPause(clock, job.progress.paused === true, now)
    if (next !== clock) indexClocks.set(job.id, next)
  }
})

/** The running (or last) index job in the drawer. */
export const latestIndexJob = (jobs: readonly Job[]): Job | null => jobs.find((j) => j.kind === 'stylemap') ?? null

export const indexRunning = (jobs: readonly Job[]): boolean => jobs.some((j) => j.kind === 'stylemap' && !isFinished(j.progress.status))

type ModelState = 'ready' | 'download' | 'restart'

function cardState(cards: readonly ModelCard[] | undefined, id: string): ModelState {
  const card = cards?.find((c) => c.id === id)
  // Unknown: let the job try; the backend says what is missing.
  if (!card) return 'ready'
  if (card.status === 'needs_restart') return 'restart'
  return card.status === 'ready' || card.available === true ? 'ready' : 'download'
}

async function modelState(card: string): Promise<ModelState> {
  try {
    const status = await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })
    return cardState(status.models, card)
  } catch {
    return 'ready'
  }
}

interface StartAnswer {
  status?: string
  total?: number
}

async function post(space: Space, token: string | null, settings: Record<string, unknown>): Promise<void> {
  try {
    const body = { space, ...settings, ...(token ? { selection_token: token } : {}) }
    const answer = await rawJson<StartAnswer>('POST', `${VECTORS}/start`, { body })
    if (answer?.status === 'idle') {
      toast(tr('stylemap.index.nothing'))
      return
    }
    const total = Number(answer?.total ?? 0)
    const job = addJob({ kind: 'stylemap', progress: startingProgress(total), count: total })
    indexClocks.set(job.id, startClock(Date.now()))
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) toast(tr('stylemap.index.busy'), 'error')
    else toast(tr('stylemap.index.startFailed', { reason: (error as Error).message }), 'error')
  }
}

/** A start in progress (the model check takes a moment): a second click does not start a second job. */
let starting = false

/** Build the index of `space` over the map's scope; false (with the reason said) when nothing started. */
export async function startStyleIndex(space: Space, token: string | null): Promise<boolean> {
  if (space === 'clip' || starting) return false
  starting = true
  try {
    return await startNow(space, token)
  } finally {
    starting = false
  }
}

async function startNow(space: Space, token: string | null): Promise<boolean> {
  if (isQueueBusy('stylemap')) {
    toast(tr('stylemap.index.busy'), 'error')
    return false
  }
  const prefs = useArtistPrefs.getState()
  let settings: Record<string, unknown>
  let source: string | null = null
  if (space === 'csd') {
    settings = { use_gpu: prefs.useGpu }
  } else {
    const config = modelConfig(prefs)
    if (!config) {
      toast(tr('stylemap.index.needsPath'), 'error')
      return false
    }
    settings = { ...config, threshold: prefs.threshold }
    source = config.model_source
  }
  const card = space === 'csd' ? 'csd' : 'artist'
  const state = await modelState(card)
  if (state === 'restart') {
    toast(tr('stylemap.index.needsRestart'), 'error')
    return false
  }
  const run = () => void post(space, token, settings)
  if (state === 'ready') {
    run()
    return true
  }
  const label = tr(space === 'csd' ? 'stylemap.index.csdModel' : 'stylemap.index.kaloscopeModel')
  return installThen({ card, variant: null, label, source }, run)
}

/** An index job that is running on the backend but not in the drawer (the classic page or a reload started it). */
export async function followRunningIndex(): Promise<void> {
  if (useJobs.getState().jobs.some((j) => j.kind === 'stylemap' && !isFinished(j.progress.status))) return
  try {
    const raw = await rawJson<Record<string, unknown>>('GET', `${VECTORS}/progress`)
    if (raw?.running !== true || isQueueBusy('stylemap')) return
    const progress = readProgress('stylemap', raw)
    const job = addJob({ kind: 'stylemap', progress, count: progress.total, adopted: true })
    // The backend says when it began, not how long it was paused: a pause now starts counting from here.
    if (typeof raw.started_at === 'number') indexClocks.set(job.id, startClock(raw.started_at * 1000, progress.paused === true))
  } catch {
    // unreachable for now: the page shows what it can
  }
}
