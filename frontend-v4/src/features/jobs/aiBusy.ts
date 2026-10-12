import type { MessageKey, Params } from '../../i18n'
import { taggerInfo } from '../tagging/taggers'
import type { Job } from './jobs'
import { isFinished, type JobKind } from './progress'

// What is using the AI right now, for the top bar's chip and the tag panel.
// Two sources, read together by aiBusyPoll.ts: GET /api/system/ai-jobs lists
// the leases held inside the app's own process (censor detection, similarity,
// aesthetic scoring, Smart Tag...), and GET /api/tag/progress, because the
// Library's tagging runs in a child process whose leases that list cannot see.
// Pure.

export type Translate = (key: MessageKey, params?: Params) => string
export type Device = 'gpu' | 'cpu'

export interface AiLease {
  label: string
  elapsedSeconds: number
  /** The backend's own "held abnormally long" flag. */
  stuck: boolean
  vramMb: number | null
}

export interface AiSnapshot {
  leases: AiLease[]
}

export interface TagRunState {
  runId: number
  /** Running or stopping. */
  running: boolean
  device: Device | null
  current: number
  total: number
  /** Library tagging runs waiting in the AI queue. */
  queued: number
  /** The tagger the run uses (the progress's `model`); null when it says none. */
  model: string | null
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function readSnapshot(raw: unknown): AiSnapshot {
  const leases = rows(obj(raw).jobs).map((j) => ({
    label: str(j.label) || '?',
    elapsedSeconds: num(j.elapsed_seconds),
    stuck: j.stuck === true,
    vramMb: typeof j.estimated_vram_mb === 'number' ? j.estimated_vram_mb : null,
  }))
  return { leases }
}

export function readTagRun(raw: unknown): TagRunState {
  const r = obj(raw)
  const status = str(r.status)
  const device = str(r.runtime_backend_actual) || str(r.runtime_backend_target)
  return {
    runId: num(r.run_id),
    running: status === 'running' || status === 'cancelling',
    device: device === 'gpu' || device === 'cpu' ? device : null,
    current: num(r.current),
    total: num(r.total),
    queued: rows(obj(r.pipeline_queue).queued).length,
    model: str(r.model) || null,
  }
}

// ---- naming the work ----

export type Work = 'tag' | 'aesthetic' | 'artist' | 'censor' | 'refine' | 'similar' | 'textSearch' | 'caption' | 'matting' | 'modelCheck' | 'other'

export interface WorkOf {
  work: Work
  model: string | null
  loading: boolean
}

/** Lease labels the backend uses (ai_runtime_guard callers), by prefix; the first match wins. */
const WORKS: [prefix: string, work: Work, model: string | null][] = [
  ['wd14-tagger', 'tag', null],
  ['cl-tagger-v2', 'tag', 'CL Tagger v2'],
  ['oppai-oracle', 'tag', 'OppaiOracle'],
  ['aesthetic', 'aesthetic', null],
  ['artist-kaloscope', 'artist', 'Kaloscope'],
  ['artist-', 'artist', null],
  ['censor-', 'censor', 'YOLO'],
  ['nudenet', 'censor', 'NudeNet'],
  ['sam3', 'refine', 'SAM3'],
  ['clip-text', 'textSearch', 'CLIP'],
  ['clip-', 'similar', 'CLIP'],
  ['florence2', 'caption', 'Florence-2'],
  ['lucida', 'matting', 'Lucida'],
  ['model-health', 'modelCheck', null],
]

/** A tagging run loading its tagger names it: "tagger-load:<model name>". */
const TAGGER_LOAD = 'tagger-load:'

export function leaseWork(label: string): WorkOf {
  if (label.startsWith(TAGGER_LOAD)) return { work: 'tag', model: taggerInfo(label.slice(TAGGER_LOAD.length)).label, loading: true }
  const loading = label.endsWith('-load')
  const hit = WORKS.find(([prefix]) => label.startsWith(prefix))
  return hit ? { work: hit[1], model: hit[2], loading } : { work: 'other', model: null, loading }
}

const WORK_KEY: Record<Work, MessageKey> = {
  tag: 'signals.work.tag',
  aesthetic: 'signals.work.aesthetic',
  artist: 'signals.work.artist',
  censor: 'signals.work.censor',
  refine: 'signals.work.refine',
  similar: 'signals.work.similar',
  textSearch: 'signals.work.textSearch',
  caption: 'signals.work.caption',
  matting: 'signals.work.matting',
  modelCheck: 'signals.work.modelCheck',
  other: 'signals.work.other',
}

export function workName(w: WorkOf, t: Translate): string {
  const work = t(WORK_KEY[w.work])
  const named = w.model ? t('signals.work.named', { work, model: w.model }) : work
  return w.loading ? t('signals.work.loading', { work: named }) : named
}

/** For the chip, where room is short: the model when it is known (that is what the user asks about), else the work. */
export function shortName(w: WorkOf, t: Translate): string {
  return w.model ?? t(WORK_KEY[w.work])
}

/** 7 -> 0:07, 724 -> 12:04, 3723 -> 1:02:03. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** A duration for a sentence: seconds up to a minute and a half, then minutes, then hours. */
export function spoken(seconds: number, t: Translate): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return t('signals.time.s', { n: s })
  const m = Math.round(s / 60)
  if (m < 90) return t('signals.time.m', { n: m })
  return t('signals.time.hm', { h: Math.floor(m / 60), m: m % 60 })
}

// ---- who holds the AI ----

export interface Observed extends WorkOf {
  /** run:<id> for a Library tagging run, lease:<work> for work inside the app. */
  key: string
  device: Device | null
  stuck: boolean
  vramMb: number | null
  progress: { current: number; total: number } | null
  /** The drawer job that is this work, when there is one. */
  jobId: string | null
  /** How long the backend says it has held the AI already. */
  seconds: number
}

/** The drawer's jobs that are each kind of work inside the app. */
const WORK_JOBS: Partial<Record<Work, JobKind[]>> = {
  tag: ['smarttag'],
  aesthetic: ['aesthetic'],
  similar: ['embed'],
  censor: ['detect'],
  refine: ['refine'],
  matting: ['masks'],
}

const working = (j: Job) => !isFinished(j.progress.status) && j.progress.status !== 'queued'

function runHolder(run: TagRunState, jobs: readonly Job[]): Observed {
  // Each tagging job in the drawer waits for the run right after its base.
  const job = jobs.find((j) => j.kind === 'tag' && !isFinished(j.progress.status) && (j.ctx.baseRunId ?? -2) + 1 === run.runId) ?? null
  return {
    key: `run:${run.runId}`,
    work: 'tag',
    // A run started elsewhere (V3.5, another window) has no drawer job: the progress names its tagger.
    model: job?.label ?? (run.model ? taggerInfo(run.model).label : null),
    loading: false,
    device: run.device,
    stuck: false,
    vramMb: null,
    progress: run.total > 0 ? { current: run.current, total: run.total } : null,
    jobId: job?.id ?? null,
    seconds: 0,
  }
}

/** What holds the AI in this poll. A batch takes and returns its lease image by image, so leases count once per kind of work. */
export function observe(snapshot: AiSnapshot | null, run: TagRunState | null, jobs: readonly Job[]): Observed[] {
  const byWork = new Map<string, Observed>()
  for (const lease of snapshot?.leases ?? []) {
    const w = leaseWork(lease.label)
    const key = `lease:${w.work}`
    const prev = byWork.get(key)
    const job = jobs.find((j) => working(j) && WORK_JOBS[w.work]?.includes(j.kind)) ?? null
    byWork.set(key, {
      key,
      work: w.work,
      model: prev?.model ?? w.model,
      loading: (prev?.loading ?? true) && w.loading,
      device: null,
      stuck: (prev?.stuck ?? false) || lease.stuck,
      vramMb: lease.vramMb === null ? (prev?.vramMb ?? null) : (prev?.vramMb ?? 0) + lease.vramMb,
      progress: null,
      jobId: job?.id ?? null,
      seconds: Math.max(prev?.seconds ?? 0, lease.elapsedSeconds),
    })
  }
  return [...(run?.running ? [runHolder(run, jobs)] : []), ...byWork.values()]
}

export interface Seen {
  since: number
  lastSeen: number
  /** It was already running when this page first looked: its real start is earlier. */
  atLeast: boolean
  obs: Observed
}

export type SeenMap = Readonly<Record<string, Seen>>

/** Work missing for less than this (the pause between two batches) is the same work going on. */
export const LINGER_MS = 5000

/**
 * Fold one poll into what has been seen. A lease missing for a moment lingers;
 * a tagging run that is no longer running has ended (`runRead`: the tagging
 * progress was read in this poll), so it goes at once.
 */
export function track(prev: SeenMap, current: readonly Observed[], now: number, firstLook: boolean, runRead = true): SeenMap {
  const here = new Set(current.map((o) => o.key))
  const next: Record<string, Seen> = {}
  for (const [key, seen] of Object.entries(prev)) {
    const ended = runRead && key.startsWith('run:') && !here.has(key)
    if (!ended && now - seen.lastSeen <= LINGER_MS) next[key] = seen
  }
  for (const obs of current) {
    const old = next[obs.key]
    const byBackend = now - obs.seconds * 1000
    next[obs.key] = { since: Math.min(old?.since ?? byBackend, byBackend), lastSeen: now, atLeast: old?.atLeast ?? firstLook, obs }
  }
  return next
}

export interface Holder extends Observed {
  atLeast: boolean
}

const weight = (h: Holder) => (h.stuck ? 2 : 0) + (h.key.startsWith('run:') ? 1 : 0)

/** Everything holding the AI now: stuck work first, then a tagging run, then the longest running. */
export function holdersOf(seen: SeenMap, now: number): Holder[] {
  return Object.values(seen)
    .filter((s) => now - s.lastSeen <= LINGER_MS)
    .map((s) => ({ ...s.obs, seconds: Math.max(0, Math.round((now - s.since) / 1000)), atLeast: s.atLeast }))
    .sort((a, b) => weight(b) - weight(a) || b.seconds - a.seconds)
}

export const POLL_BUSY_MS = 1500
export const POLL_IDLE_MS = 6000
export const POLL_HIDDEN_MS = 15000

export const pollDelay = (hidden: boolean, busy: boolean) => (hidden ? POLL_HIDDEN_MS : busy ? POLL_BUSY_MS : POLL_IDLE_MS)

/** Work the drawer can pick up (a tagging run, aesthetic scoring, a similarity index) but does not show: '' when there is none. */
export function unclaimed(current: readonly Observed[]): string {
  const adoptable = (o: Observed) => o.key.startsWith('run:') || o.work === 'aesthetic' || o.work === 'similar'
  return current
    .filter((o) => o.jobId === null && adoptable(o))
    .map((o) => o.key)
    .sort()
    .join(' ')
}

// ---- starting a tagging run ----

export type TagStartPlan = { mode: 'free' } | { mode: 'queue'; who: Holder | null } | { mode: 'share'; who: Holder }

/**
 * What starting a Library tagging run does now. The backend queues it behind
 * tagging (a Library run, Smart Tag, captions); beside other AI work it starts
 * and the two take turns on the GPU. `tagWaiting`: tagging queued or started
 * here that has not reached the GPU yet.
 */
export function tagStartPlan(holders: readonly Holder[], tagWaiting: boolean): TagStartPlan {
  const tagging = holders.find((h) => h.work === 'tag')
  if (tagging || tagWaiting) return { mode: 'queue', who: tagging ?? null }
  const other = holders[0]
  return other ? { mode: 'share', who: other } : { mode: 'free' }
}
