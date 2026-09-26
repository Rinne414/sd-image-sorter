import { api, ApiError, unwrap } from '../../../api/client'
import { fetchModelStatus } from '../../../api/queries'
import { queryClient } from '../../../api/queryClient'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { adoptArtist, driveArtist } from '../../jobs/artistDriver'
import { installThen } from '../../jobs/installJob'
import { addJob, isQueueBusy, startingProgress, tr, type Job } from '../../jobs/jobs'
import { artistModelState, type ModelState } from './artistModel'
import { modelConfig, useArtistPrefs } from './artistPrefs'
import { summarize } from './artistSummary'
import { art } from './artistText'
import type { BatchResult, BatchStart } from './types'

// Identify the style of these images as a job in the Jobs drawer, with the
// remembered settings: the style page and right-click "识别画风" both start
// here. Kaloscope downloads first (its own job) when it is not on disk.

type Action = { label: string; run: () => void }

const toast = (text: string, tone: 'info' | 'error' = 'info', action?: Action) => useToasts.getState().push(text, tone, action)

/** The toast's way to the style page (its lists now include the run). */
const seeResults = (): Action => ({ label: art('artist.job.show'), run: () => useApp.getState().openTool('artist') })

async function modelState(): Promise<ModelState> {
  try {
    const status = await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })
    return artistModelState(status.models)
  } catch {
    return 'ready'
  }
}

/** The run ended well: say what it found (the result list is read once, here). */
async function summarizeRun(job: Job): Promise<void> {
  try {
    const raw = unwrap<{ results?: BatchResult[]; errors?: number }>(await api.GET('/api/artists/batch-progress'))
    const said = summarize(raw.results ?? [], raw.errors ?? 0, art)
    toast(said.text, said.tone, seeResults())
  } catch {
    // the results could not be read: say what the drawer knows
    toast(tr('tools.artist.job.done', { n: job.progress.succeeded }), 'info', seeResults())
  }
}

/** A run someone else started (V3.5, another tab): follow it in the drawer. */
async function followRunning(): Promise<void> {
  try {
    const found = adoptArtist((await driveArtist.poll()) as Record<string, unknown>)
    if (found && !isQueueBusy('artist')) addJob({ ...found, adopted: true })
  } catch {
    // the drawer picks it up on the next start-up
  }
}

async function start(ids: number[]): Promise<void> {
  const prefs = useArtistPrefs.getState()
  const config = modelConfig(prefs)
  if (!config) return void toast(art('artist.path.missing'), 'error')
  try {
    const body = { image_ids: ids, threshold: prefs.threshold, top_k: 5, ...config, skip_existing: prefs.skipExisting }
    const res = unwrap<BatchStart>(await api.POST('/api/artists/identify-batch', { body }))
    if (res.started === false) return void toast(art('artist.job.allSkipped', { n: res.skipped ?? ids.length }))
    if (res.skipped) toast(art('artist.job.skipped', { n: res.skipped }))
    addJob({ kind: 'artist', count: res.total, progress: startingProgress(res.total), then: summarizeRun })
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      toast(art('artist.job.busy'), 'error')
      return followRunning()
    }
    toast(art('artist.job.startFailed', { reason: (error as Error).message }), 'error')
  }
}

/** Identify these images; false (with the reason said) when nothing could start. */
export async function identifyArtists(ids: readonly number[]): Promise<boolean> {
  if (ids.length === 0) return false
  if (isQueueBusy('artist')) {
    toast(art('artist.job.busy'), 'error')
    return false
  }
  const config = modelConfig(useArtistPrefs.getState())
  if (!config) {
    toast(art('artist.path.missing'), 'error')
    return false
  }
  const state = await modelState()
  if (state === 'restart') {
    toast(art('artist.model.restart'), 'error')
    return false
  }
  const list = [...ids]
  const run = () => void start(list)
  if (state === 'ready') {
    run()
    return true
  }
  // A local file needs only the packages it runs on; the others download Kaloscope from their source.
  return installThen({ card: 'artist', variant: null, label: art('artist.model.name'), source: config.model_source }, run)
}
