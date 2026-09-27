import { api, unwrap } from '../../../api/client'
import type { TargetModel } from '../../batch/datasetSettings'
import { queuedRunAnswer, smartTagCancelQuery } from '../../jobs/smartTagJob'
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

/** Stops our run only: its job, or its place in the AI queue while it waits. */
async function cancelOurs(jobId: string | null, queueId: string): Promise<void> {
  try {
    await api.POST('/api/smart-tag/cancel', { params: { query: smartTagCancelQuery(jobId ?? undefined, queueId || undefined) } })
  } catch {
    // it ended on its own in the meantime
  }
}

/**
 * Poll until our job has finished. A run that waits in the AI queue is asked
 * for by its queue place (?queue_id=) until it has a job id, so a run that
 * started and ended between two polls is still found, and a place the backend
 * no longer knows is said plainly. Cancel stops our run only, at once: its
 * job, or its place in the queue while it still waits.
 */
async function follow(start: Raw, hooks: Hooks): Promise<{ jobId: string; last: Raw }> {
  const queueId = str(start.queue_id)
  const enqueuedAt = str(start.enqueued_at) || undefined
  let jobId = str(start.job_id) || null
  if (!jobId && !queueId) throw new Error(tt('reverse.lost'))
  let last = start
  hooks.onPhase(jobId ? 'running' : 'queued')
  for (;;) {
    if (jobId && TERMINAL.has(str(last.status))) return { jobId, last }
    if (hooks.signal.aborted) {
      hooks.onPhase('cancelling')
      await cancelOurs(jobId, queueId)
      throw new Cancelled()
    }
    await wait(POLL_MS)
    last = unwrap<Raw>(await api.GET('/api/smart-tag/progress', { params: { query: jobId ? { job_id: jobId } : { queue_id: queueId } } }))
    if (!jobId) {
      jobId = jobOfPlace(last, queueId, enqueuedAt, hooks.signal)
      if (!jobId) {
        hooks.onPhase(hooks.signal.aborted ? 'cancelling' : 'queued')
        continue
      }
    }
    if (!hooks.signal.aborted) hooks.onPhase('running')
  }
}

/** The job our queue place became, or null while it still waits; a place that ended without a job, or is unknown, throws. */
function jobOfPlace(raw: Raw, queueId: string, enqueuedAt: string | undefined, signal: AbortSignal): string | null {
  const now = queuedRunAnswer(raw, queueId, enqueuedAt)
  if (now.state === 'waiting') return null
  if (now.state === 'running' || now.state === 'done') return now.jobId
  if (signal.aborted) throw new Cancelled()
  if (now.state === 'lost') throw new Error(tt('reverse.lost'))
  const errors = Array.isArray(raw.errors) ? (raw.errors as Raw[]) : []
  throw new Error(str(raw.message) || str(errors[0]?.error) || str(raw.status))
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
