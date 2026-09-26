import { api, ApiError, unwrap } from '../../api/client'
import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import { useToasts } from '../../ui/toasts'
import { busyText } from '../jobs/busyText'
import { installThen } from '../jobs/installJob'
import { addJob, startingProgress, tr } from '../jobs/jobs'
import { tagRunBase } from '../jobs/progress'
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
  useToasts.getState().push(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), 'error')
  return false
}

/**
 * A run started while another tagging run is running or waiting is queued by
 * the backend (never two on the GPU at once); the drawer follows each run by
 * its number, so several can wait in line.
 */
async function startTagJob(ids: number[] | null, o: TagOptions, count: number): Promise<boolean> {
  try {
    // Ours comes after the run on screen and every Library run already waiting.
    const before = unwrap<Record<string, unknown>>(await api.GET('/api/tag/progress'))
    const res = unwrap<{ status?: string; duplicate?: boolean }>(
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
    // The same run sent twice while it waits is kept once.
    if (res.duplicate === true) {
      useToasts.getState().push(tr('signals.tag.duplicate'), 'info')
      return true
    }
    const queued = res.status === 'queued'
    addJob({
      kind: 'tag',
      count,
      ids: ids ?? [],
      label: taggerInfo(o.model).label,
      ctx: { baseRunId: tagRunBase(before) },
      progress: startingProgress(count, queued ? 'queued' : 'running'),
    })
    if (queued) useToasts.getState().push(tr('signals.tag.queued', { n: count }), 'info')
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

/** Something is remembered (the tag panel then offers to forget it). */
export function hasStoredTagOptions(): boolean {
  try {
    return localStorage.getItem(OPTIONS_KEY) !== null
  } catch {
    return false
  }
}

/** Forget every remembered choice: the next run starts from the defaults. Only V4 keeps these. */
export function clearTagOptions(): void {
  try {
    localStorage.removeItem(OPTIONS_KEY)
  } catch {
    // storage blocked: nothing was remembered either
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
