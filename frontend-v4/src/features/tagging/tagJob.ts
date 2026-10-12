import { api, ApiError, unwrap } from '../../api/client'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import { useToasts } from '../../ui/toasts'
import { describerCard } from '../batch/datasetTagApi'
import { trackSmartTagJob } from '../batch/trackSmartTag'
import { busyText } from '../jobs/busyText'
import { installAllThen } from '../jobs/installJob'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'
import { pushRefusal } from '../jobs/refusalToast'
import { tagRunBase } from '../jobs/progress'
import { readiness, taggerInfo, type ModelCard, type TaggerInfo } from './taggers'
import { customLabel, customPathProblem, isCustom, librarySmartTagBody, tagStartBody, type CustomPathProblem, type RunChoice, type TagOptions } from './tagOptions'

export {
  clearTagOptions,
  hasStoredTagOptions,
  loadTagOptions,
  rememberedThresholds,
  saveTagOptions,
  TAG_ONLY,
  type RunChoice,
  type TagOptions,
} from './tagOptions'

/** How a start went; `problem`: the backend refused the custom file's paths (said in the panel). */
export interface StartResult {
  ok: boolean
  problem?: CustomPathProblem
}

const fail = (error: unknown): StartResult => {
  const busy = error instanceof ApiError && error.status === 409
  pushRefusal(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), error)
  return { ok: false }
}

/**
 * A run started while another tagging run is running or waiting is queued by
 * the backend (never two on the GPU at once); the drawer follows each run by
 * its number, so several can wait in line.
 */
async function startTagJob(ids: number[] | null, o: TagOptions, count: number): Promise<StartResult> {
  try {
    // Ours comes after the run on screen and every Library run already waiting.
    const before = unwrap<Record<string, unknown>>(await api.GET('/api/tag/progress'))
    const res = unwrap<{ status?: string; duplicate?: boolean }>(await api.POST('/api/tag/start', { body: tagStartBody(ids, o) }))
    // The same run sent twice while it waits is kept once.
    if (res.duplicate === true) {
      useToasts.getState().push(tr('signals.tag.duplicate'), 'info')
      return { ok: true }
    }
    const queued = res.status === 'queued'
    addJob({
      kind: 'tag',
      count,
      ids: ids ?? [],
      label: isCustom(o) ? customLabel(o.custom.modelPath) : taggerInfo(o.model).label,
      ctx: { baseRunId: tagRunBase(before) },
      progress: startingProgress(count, queued ? 'queued' : 'running'),
    })
    if (queued) useToasts.getState().push(tr('signals.tag.queued', { n: count }), 'info')
    return { ok: true }
  } catch (error) {
    const problem = isCustom(o) && error instanceof ApiError && error.status === 400 ? customPathProblem(error.message) : null
    return problem ? { ok: false, problem } : fail(error)
  }
}

/**
 * Tagging and describing the picks, or describing them only, runs as one
 * Smart Tag run (the dataset tag step's), written to the library images.
 * Describing only leaves the tags as they are.
 */
async function startSmartJob(ids: number[], o: TagOptions, run: RunChoice): Promise<StartResult> {
  // one Smart Tag run is followed at a time (its Stop stops the running one)
  if (isQueueBusy('smarttag')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return { ok: false }
  }
  try {
    const res = unwrap<{ job_id?: string; queue_id?: string; status?: string }>(
      await api.POST('/api/smart-tag/start', { body: librarySmartTagBody(ids, o, run) as never }),
    )
    const queued = res.status === 'queued'
    trackSmartTagJob({ count: ids.length, jobId: res.job_id ?? null, queueId: res.queue_id ?? null, queued, describeOnly: !run.tagger, then: () => undefined })
    if (queued) useToasts.getState().push(tr('signals.tag.queued', { n: ids.length }), 'info')
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

/** The models this run needs from disk: the tagger (a custom file needs none) and a local describer. */
export function modelsFor(o: TagOptions, run: RunChoice): TaggerInfo[] {
  const infos: TaggerInfo[] = []
  if (run.tagger && !isCustom(o)) infos.push(taggerInfo(o.model))
  if (run.describer === 'florence2' || run.describer === 'toriigate') infos.push(describerCard(run.describer))
  return infos
}

async function modelCards(): Promise<ModelCard[] | undefined> {
  try {
    return (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    return undefined // unknown: the download step checks for itself
  }
}

/**
 * Tag `ids` with the chosen tagger and/or describe them, downloading what is
 * not on disk first. A description needs picks (the untagged run has no list).
 */
export async function startTagging(ids: number[] | null, o: TagOptions, count: number, run: RunChoice): Promise<StartResult> {
  const cards = await modelCards()
  const needed = modelsFor(o, run).map((info) => [info, readiness(info, cards)] as const)
  const restart = needed.find(([, r]) => r === 'restart')?.[0]
  if (restart) {
    useToasts.getState().push(tr('tagging.needsRestart', { name: restart.label }), 'error')
    return { ok: false }
  }
  const smart = ids !== null && (run.describer !== 'off' || !run.tagger)
  const go = () => (smart ? startSmartJob(ids, o, run) : startTagJob(ids, o, count))
  const install = needed.filter(([, r]) => r !== 'ready').map(([info]) => info)
  if (install.length === 0) return go()
  return { ok: await installAllThen(install, () => void go()) }
}
