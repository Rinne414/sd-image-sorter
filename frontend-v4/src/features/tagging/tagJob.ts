import { api, ApiError, unwrap } from '../../api/client'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import { useToasts } from '../../ui/toasts'
import { installThen } from '../jobs/installJob'
import { addJob, isQueueBusy, startingProgress, tr } from '../jobs/jobs'
import { readiness, taggerInfo, type ModelCard } from './taggers'

export interface TagOptions {
  model: string
  /** null: the model's own default. */
  threshold: number | null
  characterThreshold: number | null
  useGpu: boolean
  /** Tags dropped before they are written; they never reach the library. */
  blacklist: string[]
  /** 0 = keep every tag above the threshold. */
  maxTags: number
}

const fail = (error: unknown) => {
  const busy = error instanceof ApiError && error.status === 409
  useToasts.getState().push(busy ? tr('jobs.busy') : tr('error.generic', { reason: (error as Error).message }), 'error')
  return false
}

async function startTagJob(ids: number[] | null, o: TagOptions, count: number): Promise<boolean> {
  if (isQueueBusy('tag')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    // The run the backend shows now is not ours; ours is any later one.
    const before = unwrap<{ run_id?: number }>(await api.GET('/api/tag/progress'))
    const res = unwrap<{ status?: string }>(
      await api.POST('/api/tag/start', {
        body: {
          // No ids: the backend tags every image that has no tags yet.
          ...(ids ? { image_ids: ids } : {}),
          model_name: o.model,
          threshold: o.threshold,
          character_threshold: o.characterThreshold,
          use_gpu: o.useGpu,
          pre_tag_blacklist: o.blacklist,
          max_tags_per_image: o.maxTags,
          retag_all: false,
          allow_unsafe_acceleration: false,
        },
      }),
    )
    addJob({
      kind: 'tag',
      count,
      ids: ids ?? [],
      ctx: { baseRunId: before.run_id ?? 0 },
      progress: startingProgress(count, res.status === 'queued' ? 'queued' : 'running'),
    })
    return true
  } catch (error) {
    return fail(error)
  }
}

/** Tag `ids` with the chosen tagger, downloading it first when it is not on disk. */
export async function startTagging(ids: number[] | null, o: TagOptions, count: number): Promise<boolean> {
  const info = taggerInfo(o.model)
  let cards: ModelCard[] | undefined
  try {
    cards = (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    cards = undefined // unknown: the download step checks for itself
  }
  const state = readiness(info, cards)
  if (state === 'restart') {
    useToasts.getState().push(tr('tagging.needsRestart', { name: info.label }), 'error')
    return false
  }
  if (state === 'ready') return startTagJob(ids, o, count)
  return installThen(info, () => void startTagJob(ids, o, count))
}

const OPTIONS_KEY = 'sd-v4-tag-options'

type Stored = Partial<Omit<TagOptions, 'threshold' | 'characterThreshold'>> & {
  thresholds?: Record<string, { general: number | null; character: number | null }>
}

/** Last choices, so the next run starts where this one left off. Thresholds are per tagger. */
export function loadTagOptions(fallbackModel: string): TagOptions {
  let s: Stored = {}
  try {
    s = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Stored
  } catch {
    s = {}
  }
  const model = typeof s.model === 'string' && s.model ? s.model : fallbackModel
  const t = s.thresholds?.[model]
  return {
    model,
    threshold: t?.general ?? null,
    characterThreshold: t?.character ?? null,
    useGpu: s.useGpu ?? true,
    blacklist: Array.isArray(s.blacklist) ? s.blacklist.filter((x) => typeof x === 'string') : [],
    maxTags: typeof s.maxTags === 'number' && s.maxTags >= 0 ? s.maxTags : 0,
  }
}

export function saveTagOptions(o: TagOptions): void {
  try {
    const prev = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Stored
    const thresholds = { ...(prev.thresholds ?? {}), [o.model]: { general: o.threshold, character: o.characterThreshold } }
    const next: Stored = { model: o.model, useGpu: o.useGpu, blacklist: o.blacklist, maxTags: o.maxTags, thresholds }
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(next))
  } catch {
    // storage blocked: the choices just won't be remembered
  }
}

/** The thresholds remembered for one tagger (null = its default). */
export function rememberedThresholds(model: string): { general: number | null; character: number | null } {
  try {
    const s = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Stored
    return s.thresholds?.[model] ?? { general: null, character: null }
  } catch {
    return { general: null, character: null }
  }
}
