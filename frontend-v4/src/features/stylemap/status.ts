import type { MessageKey, Params } from '../../i18n'
import type { PointsAnswer, Space, UmapState } from './types'

// What the page says about the map on screen: the layout line, the scope
// sentence, the start card and the index button. Pure, so every state is
// tested without a browser.

/** Spaces with their own index job (CLIP reads the similarity index). */
export const INDEXED_SPACES: readonly Space[] = ['kaloscope', 'csd']

export const isIndexed = (space: Space): boolean => INDEXED_SPACES.includes(space)

export type Tone = 'plain' | 'busy' | 'ready' | 'failed'

export interface LayoutLine {
  status: string
  key: MessageKey
  /** The whole sentence for the tooltip (the line itself is short). */
  tip: MessageKey
  tone: Tone
  /** Offer to install UMAP. */
  install: boolean
  /** Offer to try the fit again. */
  retry: boolean
}

const LAYOUT: Record<string, Pick<LayoutLine, 'key' | 'tone'>> = {
  unavailable: { key: 'stylemap.layout.unavailable', tone: 'plain' },
  too_few_points: { key: 'stylemap.layout.tooFew', tone: 'plain' },
  not_started: { key: 'stylemap.layout.pca', tone: 'plain' },
  queued: { key: 'stylemap.layout.queued', tone: 'busy' },
  computing: { key: 'stylemap.layout.computing', tone: 'busy' },
  ready: { key: 'stylemap.layout.ready', tone: 'ready' },
  failed: { key: 'stylemap.layout.failed', tone: 'failed' },
}

/** The layout line for the UMAP state of a points answer. */
export function layoutLine(umap: UmapState | undefined, method: string | undefined): LayoutLine {
  const status = umap?.status ?? (method === 'umap' ? 'ready' : 'not_started')
  const known = LAYOUT[status] ?? LAYOUT.not_started!
  return {
    status,
    key: known.key,
    tip: status === 'unavailable' ? 'stylemap.layout.unavailableTip' : known.key,
    tone: known.tone,
    install: status === 'unavailable',
    retry: status === 'failed',
  }
}

/** The layout keeps changing: ask again in a moment. */
export const layoutPending = (status: string | undefined): boolean => status === 'queued' || status === 'computing'

export const hasPoints = (points: PointsAnswer | null): boolean =>
  points?.status === 'ok' && Array.isArray(points.points) && points.points.length > 0

export interface Sentence {
  key: MessageKey
  params?: Params
}

/** What the map covers: the scope sentence (`filtered`: a library filter is on). */
export function scopeSentence(points: PointsAnswer, filtered: boolean): Sentence {
  const total = Number(points.total_images ?? 0)
  const missing = Number(points.missing_vectors ?? 0)
  if (points.status === 'empty' || total === 0) return { key: filtered ? 'stylemap.scope.empty' : 'stylemap.scope.emptyAll' }
  if (missing === 0) return { key: filtered ? 'stylemap.scope.all' : 'stylemap.scope.allLibrary', params: { total } }
  return { key: filtered ? 'stylemap.scope.some' : 'stylemap.scope.someLibrary', params: { total, missing } }
}

export const unlocatableCount = (points: PointsAnswer): number => (Array.isArray(points.unlocatable) ? points.unlocatable.length : 0)

/** The index button: build while pictures lack data, refresh once every picture has it; null when there is none. */
export function indexButton(points: PointsAnswer | null, space: Space, running: boolean): { key: MessageKey; primary: boolean } | null {
  if (!isIndexed(space) || running || !points || points.status === 'empty') return null
  const pending = Number(points.missing_vectors ?? 0) > 0 || points.status !== 'ok'
  const csd = space === 'csd'
  if (pending) return { key: csd ? 'stylemap.index.buildCsd' : 'stylemap.index.build', primary: true }
  return { key: csd ? 'stylemap.index.refreshCsd' : 'stylemap.index.refresh', primary: false }
}

export interface StartCard {
  eyebrow: MessageKey
  title: MessageKey
  text: MessageKey
  /** Which button the card offers. */
  action: 'build' | 'buildClip' | null
}

/** The start card shown instead of an empty map; null when there is a map (or no picture at all). */
export function startCard(points: PointsAnswer | null, space: Space, running: boolean): StartCard | null {
  if (!points || hasPoints(points) || points.status === 'empty') return null
  const eyebrow: MessageKey = running ? 'stylemap.empty.eyebrowRunning' : 'stylemap.empty.eyebrow'
  if (space === 'clip') return { eyebrow, title: 'stylemap.empty.titleClip', text: 'stylemap.empty.textClip', action: running ? null : 'buildClip' }
  if (running) return { eyebrow, title: 'stylemap.empty.titleRunning', text: 'stylemap.empty.textRunning', action: null }
  if (space === 'csd') return { eyebrow, title: 'stylemap.empty.titleCsd', text: 'stylemap.empty.textCsd', action: 'build' }
  return { eyebrow, title: 'stylemap.empty.title', text: 'stylemap.empty.text', action: 'build' }
}

/** The plain line that says what a space does. */
export const SPACE_WHAT: Record<Space, MessageKey> = {
  kaloscope: 'stylemap.space.kaloscopeWhat',
  clip: 'stylemap.space.clipWhat',
  csd: 'stylemap.space.csdWhat',
}

export const SPACE_LABEL: Record<Space, MessageKey> = {
  kaloscope: 'stylemap.space.kaloscope',
  clip: 'stylemap.space.clip',
  csd: 'stylemap.space.csd',
}

/** A remaining time in the user's language: "2 分 05 秒" / "2m 05s" (the words live in the packs). */
export function remainingText(ms: number): Sentence {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return { key: 'stylemap.time.seconds', params: { s: seconds } }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { key: 'stylemap.time.minutes', params: { m: minutes, s: String(seconds % 60).padStart(2, '0') } }
  const hours = Math.floor(minutes / 60)
  return { key: 'stylemap.time.hours', params: { h: hours, m: String(minutes % 60).padStart(2, '0') } }
}

/**
 * How long an index job has really been working: from its start, minus the
 * time it sat paused (a pause is not slow work, so it must not stretch the
 * time left).
 */
export interface RunClock {
  startedAt: number
  /** Paused time of pauses that already ended. */
  pausedMs: number
  /** When the pause going on now began; null while it runs. */
  pausedSince: number | null
}

export const startClock = (now: number, paused = false): RunClock => ({ startedAt: now, pausedMs: 0, pausedSince: paused ? now : null })

/** The clock after the job was seen paused or running at `now` (the same clock when nothing changed). */
export function followPause(clock: RunClock, paused: boolean, now: number): RunClock {
  if (paused && clock.pausedSince === null) return { ...clock, pausedSince: now }
  if (!paused && clock.pausedSince !== null) return { ...clock, pausedMs: clock.pausedMs + Math.max(0, now - clock.pausedSince), pausedSince: null }
  return clock
}

/** Working time so far (paused time left out). */
export function workingMs(clock: RunClock, now: number): number {
  const pausing = clock.pausedSince === null ? 0 : Math.max(0, now - clock.pausedSince)
  return Math.max(0, now - clock.startedAt - clock.pausedMs - pausing)
}

/** Time left from the pace so far (working time only); null until the pace is known (2 s of work, something done). */
export function remainingMs(processed: number, total: number, workedMs: number | null): number | null {
  if (workedMs === null || processed <= 0 || total <= processed) return null
  if (workedMs < 2000) return null
  return (workedMs / processed) * (total - processed)
}
