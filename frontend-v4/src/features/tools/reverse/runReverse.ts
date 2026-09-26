import { api, unwrap } from '../../../api/client'
import type { TargetModel } from '../../batch/datasetSettings'
import { startedJobId } from '../../jobs/smartTagJob'
import type { TagOptions } from '../../tagging/tagJob'
import { tt } from '../toolText'
import { captionOf, promptToTags, smartTagBody, tagSingleBody, tagsToPrompt, type ReverseMode } from './reverseModes'

// One reverse-prompt run over one file, whichever transport its mode needs:
// the tagger answers the request itself; a vision-model run is a Smart Tag job
// that may wait in the AI queue, is polled, and is read back. Nothing is
// written to the library either way.

export interface ReverseResult {
  mode: ReverseMode
  prompt: string
  /** The tags behind it (the tagger's, or the ones the vision model was given). */
  tags: string[]
}

/** Where a run is: working, waiting its turn for the shared AI, or stopping. */
export type RunPhase = 'running' | 'queued' | 'cancelling'

export class Cancelled extends Error {}

interface Hooks {
  signal: AbortSignal
  onPhase: (p: RunPhase) => void
}

type Raw = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const POLL_MS = 900
/** Polls in a row that find our queued run neither waiting nor started: it was taken out of the queue. */
const GONE_AFTER = 3
const TERMINAL = new Set(['completed', 'done', 'warning', 'failed', 'error', 'cancelled', 'idle'])

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** The tagger alone: one request; Cancel drops the answer (nothing is stored either way). */
export async function runTagger(path: string, o: TagOptions, hooks: Hooks): Promise<ReverseResult> {
  hooks.onPhase('running')
  try {
    const res = unwrap<{ all_tags?: { tag?: string }[]; tags?: string[] }>(
      await api.POST('/api/tag/single', { body: tagSingleBody(path, o), signal: hooks.signal }),
    )
    const tags = res.all_tags?.map((e) => str(e.tag)).filter(Boolean) ?? res.tags ?? []
    if (tags.length === 0) throw new Error(tt('reverse.noTags'))
    return { mode: 'tagger', prompt: tagsToPrompt(tags), tags }
  } catch (error) {
    if (hooks.signal.aborted) throw new Cancelled()
    throw error
  }
}

async function cancelActive(): Promise<void> {
  try {
    await api.POST('/api/smart-tag/cancel')
  } catch {
    // it ended on its own in the meantime
  }
}

/**
 * Poll until our job has finished. A run that waited in the queue gets its job
 * id when it starts. Cancel stops our job only: while it still waits, the
 * backend's cancel would stop whatever else is running, so it waits for its
 * turn and is stopped then.
 */
/** Our queue entry is still in the AI queue. */
function waiting(raw: Raw, queueId: string | undefined): boolean {
  const queue = raw.pipeline_queue && typeof raw.pipeline_queue === 'object' ? (raw.pipeline_queue as Raw).queued : null
  return Array.isArray(queue) && queue.some((q) => !!q && typeof q === 'object' && (q as Raw).queue_id === queueId)
}

async function follow(start: Raw, hooks: Hooks): Promise<{ jobId: string; last: Raw }> {
  const queueId = str(start.queue_id) || undefined
  let jobId = str(start.job_id) || null
  let last = start
  let gone = 0
  hooks.onPhase(jobId ? 'running' : 'queued')
  for (;;) {
    if (jobId && TERMINAL.has(str(last.status))) return { jobId, last }
    if (jobId && hooks.signal.aborted) {
      hooks.onPhase('cancelling')
      await cancelActive()
      throw new Cancelled()
    }
    await wait(POLL_MS)
    last = unwrap<Raw>(await api.GET('/api/smart-tag/progress', { params: { query: jobId ? { job_id: jobId } : {} } }))
    if (!jobId) {
      jobId = startedJobId(last, queueId)
      if (!jobId) {
        gone = waiting(last, queueId) ? 0 : gone + 1
        if (gone >= GONE_AFTER) {
          if (hooks.signal.aborted) throw new Cancelled()
          throw new Error(tt('reverse.queueGone'))
        }
        hooks.onPhase(hooks.signal.aborted ? 'cancelling' : 'queued')
        continue
      }
    }
    if (!hooks.signal.aborted) hooks.onPhase('running')
  }
}

/** The vision model, alone or given the tagger's tags. */
export async function runSmartTag(mode: Exclude<ReverseMode, 'tagger'>, path: string, target: TargetModel, o: TagOptions, hooks: Hooks): Promise<ReverseResult> {
  const start = unwrap<Raw>(await api.POST('/api/smart-tag/start', { body: smartTagBody(mode, path, target, o) }))
  const { jobId, last } = await follow(start, hooks)
  const status = str(last.status)
  if (status === 'cancelled' && hooks.signal.aborted) throw new Cancelled()
  if (status === 'failed' || status === 'error' || status === 'cancelled') {
    const errors = Array.isArray(last.errors) ? (last.errors as Raw[]) : []
    throw new Error(str(last.message) || str(errors[0]?.error) || status)
  }
  const page = unwrap<Raw>(await api.GET('/api/smart-tag/results', { params: { query: { job_id: jobId, offset: 0, limit: 1 } } }))
  const out = captionOf(page, last)
  if (!('prompt' in out)) throw new Error(out.error ?? tt('reverse.noPrompt'))
  const row = (Array.isArray(page.results) ? (page.results[0] as Raw | undefined) : undefined) ?? {}
  return { mode, prompt: out.prompt, tags: promptToTags(str(row.booru_text)) }
}
