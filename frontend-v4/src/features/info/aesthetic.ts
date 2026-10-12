import { api, ApiError, unwrap } from '../../api/client'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useToasts } from '../../ui/toasts'
import { isPageRunActive, startPageRun } from '../jobs/aestheticDriver'
import { installThen } from '../jobs/installJob'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'
import { busyText } from '../jobs/busyText'
import { pushRefusal } from '../jobs/refusalToast'
import { readProgress } from '../jobs/progress'
import { matchingIds } from '../selection/invert'
import type { ModelCard } from '../tagging/taggers'
import { aestheticModelState, unscoredParams } from './scoring'

// Aesthetic scoring (LAION aesthetic predictor on CLIP ViT-L/14, a score of
// about 1-10) as a job in the Jobs drawer: for picked images, one image, a
// filter's unscored images, or every unscored image of the library. The model
// (about 1.7 GB) downloads as a job first, the same first-use flow as taggers.

const CARD = 'aesthetic'

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

/** Run `work` now if the model is on disk, else download it first. False when neither can happen. */
async function withModel(work: () => void): Promise<boolean> {
  let cards: ModelCard[] | undefined
  try {
    cards = (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    cards = undefined
  }
  const state = aestheticModelState(cards)
  if (state === 'restart') {
    toast(tr('tagging.needsRestart', { name: tr('info.aes.model') }), 'error')
    return false
  }
  if (state === 'ready') {
    work()
    return true
  }
  return installThen({ card: CARD, variant: null, label: tr('info.aes.model') }, work)
}

function busy(): boolean {
  if (!isQueueBusy('aesthetic') && !isPageRunActive()) return false
  toast(tr('jobs.busy'), 'error')
  return true
}

/** Score these images, in order (the picks, one image, a filter's unscored ones). */
export async function scoreImages(ids: readonly number[]): Promise<boolean> {
  if (ids.length === 0 || busy()) return false
  return withModel(() => {
    if (busy()) return
    startPageRun(ids)
    addJob({ kind: 'aesthetic', ids: [...ids], count: ids.length, progress: startingProgress(ids.length) })
  })
}

function failed(error: unknown): void {
  if (error instanceof ApiError && error.status === 503) toast(tr('info.aes.unavailable', { reason: error.message }), 'error')
  else if (error instanceof ApiError && error.status === 409) pushRefusal(busyText(error), error)
  else toast(tr('error.generic', { reason: (error as Error).message }), 'error')
}

async function startLibraryRun(): Promise<void> {
  try {
    const res = unwrap<Record<string, unknown>>(await api.POST('/api/aesthetic/score-all', { params: { query: { force: false } } }))
    if (res.status === 'already_running') {
      addJob({ kind: 'aesthetic', progress: readProgress('aesthetic', res), adopted: true })
      return
    }
    const total = typeof res.total === 'number' ? res.total : 0
    if (total === 0) {
      void queryClient.invalidateQueries({ queryKey: ['library-health'] })
      toast(tr('info.aes.nothing'))
      return
    }
    addJob({ kind: 'aesthetic', count: total, progress: startingProgress(total) })
  } catch (error) {
    failed(error)
  }
}

/** Score every image of the library that has no score yet (the backend's run). */
export async function scoreLibrary(): Promise<boolean> {
  if (busy()) return false
  return withModel(() => void startLibraryRun())
}

/** Score the images of this filter that have no score. */
export async function scoreUnscoredIn(params: ImageQueryParams): Promise<boolean> {
  if (busy()) return false
  try {
    return await scoreImages(await matchingIds(unscoredParams(params)))
  } catch (error) {
    failed(error)
    return false
  }
}
