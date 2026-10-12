import type { Params } from '../../../i18n'
import type { LibKey } from '../libraryText'

// Clearing a library's index is refused while work that writes to it runs
// (routers/sorting.py `_require_clear_gallery_jobs_idle`). Before asking, the
// page looks at the same three progress routes V3.5 does and names what is in
// the way, so it can be stopped from here. Its refusal lists the backend's own
// job names; they are turned into the work the user knows.

export type Work = 'scan' | 'tag' | 'aesthetic' | 'smartTag' | 'caption' | `other:${string}`

export interface BusyWork {
  work: 'scan' | 'tag' | 'aesthetic'
  /** scan: the identity the backend asks for to stop it. */
  runId?: number
  source?: string
}

const ACTIVE = new Set(['starting', 'running', 'cancelling'])
const INACTIVE = new Set(['idle', 'done', 'error', 'cancelled'])

type Raw = Record<string, unknown>

function obj(v: unknown, what: string): Raw {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`${what} progress is not an object`)
  return v as Raw
}

function running(raw: Raw, what: string): boolean {
  const status = raw.status
  if (typeof status === 'string' && ACTIVE.has(status)) return true
  if (typeof status === 'string' && INACTIVE.has(status)) return false
  throw new TypeError(`${what} progress has an unexpected status "${String(status)}"`)
}

/** What of import, tagging and scoring is running now. Throws when an answer cannot be read. */
export function readBusy(scanRaw: unknown, tagRaw: unknown, aestheticRaw: unknown): BusyWork[] {
  const scan = obj(scanRaw, 'scan')
  const tag = obj(tagRaw, 'tag')
  const aesthetic = obj(aestheticRaw, 'aesthetic')
  if (typeof aesthetic.running !== 'boolean') throw new TypeError('aesthetic progress has no running flag')
  const queue = tag.pipeline_queue && typeof tag.pipeline_queue === 'object' ? (tag.pipeline_queue as Raw) : {}
  const queued = typeof queue.total_queued === 'number' && queue.total_queued > 0
  const busy: BusyWork[] = []
  if (running(scan, 'scan')) busy.push({ work: 'scan', runId: Number(scan.run_id ?? 0), source: String(scan.source ?? 'manual') })
  if (running(tag, 'tag') || queued) busy.push({ work: 'tag' })
  if (aesthetic.running) busy.push({ work: 'aesthetic' })
  return busy
}

const REFUSED: Record<string, Work> = {
  scan: 'scan',
  gallery_tag: 'tag',
  ai_queue: 'tag',
  ai_dispatch: 'tag',
  aesthetic: 'aesthetic',
  smart_tag: 'smartTag',
  vlm_caption: 'caption',
}

/** The works named by a refused clear (`jobs` in its body), once each. */
export function refusedWorks(body: unknown): Work[] {
  const jobs = body && typeof body === 'object' ? (body as Raw).jobs : null
  if (!Array.isArray(jobs)) return []
  const works = jobs.filter((j): j is string => typeof j === 'string').map((j): Work => REFUSED[j] ?? `other:${j}`)
  return [...new Set(works)]
}

const WORK_KEYS: Record<Exclude<Work, `other:${string}`>, LibKey> = {
  scan: 'libset.work.scan',
  tag: 'libset.work.tag',
  aesthetic: 'libset.work.aesthetic',
  smartTag: 'libset.work.smartTag',
  caption: 'libset.work.caption',
}

type Translate = (key: LibKey, params?: Params) => string

export function workText(work: Work, t: Translate): string {
  if (work.startsWith('other:')) return t('libset.work.other', { name: work.slice('other:'.length) })
  return t(WORK_KEYS[work as keyof typeof WORK_KEYS])
}

export function worksText(works: readonly Work[], t: Translate): string {
  return works.map((w) => workText(w, t)).join(t('libset.work.join'))
}
