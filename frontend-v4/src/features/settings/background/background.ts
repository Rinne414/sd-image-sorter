import type { MessageKey } from '../../../i18n'

// What the Background line shows: which AI models are loaded, when an unused
// one is freed, and what the last release or GPU fallback was. Pure, so the
// wording rules are tested; the component only draws them.

export interface LoadedModel {
  key: string
  device: string
  in_use: boolean
  idle_seconds: number
}

export interface BackgroundState {
  idle_unload_minutes: number
  models: LoadedModel[]
  last_release: { at: number; keys: string[] } | null
  gpu_busy_fallbacks: { at: number; label?: string }[]
}

export interface UnloadResult extends BackgroundState {
  released?: string[]
  busy?: string[]
}

type Text = (key: MessageKey, params?: Record<string, string | number>) => string

/** The idle choices the backend has always offered; any other stored value is shown as an extra choice. */
export const IDLE_CHOICES: readonly { minutes: number; label: MessageKey }[] = [
  { minutes: 5, label: 'desktop.bg.idle5' },
  { minutes: 10, label: 'desktop.bg.idle10' },
  { minutes: 30, label: 'desktop.bg.idle30' },
  { minutes: 0, label: 'desktop.bg.idleNever' },
]

export const MODEL_LABELS: Readonly<Record<string, MessageKey>> = {
  tagger: 'desktop.bg.model.tagger',
  'cl-tagger': 'desktop.bg.model.cl-tagger',
  'oppai-tagger': 'desktop.bg.model.oppai-tagger',
  clip: 'desktop.bg.model.clip',
  aesthetic: 'desktop.bg.model.aesthetic',
  artist: 'desktop.bg.model.artist',
  style: 'desktop.bg.model.style',
  censor: 'desktop.bg.model.censor',
  nudenet: 'desktop.bg.model.nudenet',
  toriigate: 'desktop.bg.model.toriigate',
  florence2: 'desktop.bg.model.florence2',
}

/** A model's name for the user; a model the interface does not know yet is shown by its own key. */
export function modelName(key: string, t: Text): string {
  const label = MODEL_LABELS[key]
  return label ? t(label) : key
}

/** The options of the idle select: the four standard ones, plus the stored value when it is none of them. */
export function idleOptions(minutes: number): { value: number; label: MessageKey; custom?: boolean }[] {
  const standard = IDLE_CHOICES.map((c) => ({ value: c.minutes, label: c.label }))
  if (IDLE_CHOICES.some((c) => c.minutes === minutes)) return standard
  return [...standard, { value: minutes, label: 'desktop.bg.idleCustom' as MessageKey, custom: true }]
}

export function describeModel(model: LoadedModel, t: Text): string {
  const device = model.device === 'gpu' ? 'GPU' : 'CPU'
  const state = model.in_use ? t('desktop.bg.inUse') : t('desktop.bg.idleFor', { minutes: Math.floor(model.idle_seconds / 60) })
  return `${modelName(model.key, t)} (${device}, ${state})`
}

/** The line under the loaded models: a recent GPU fallback first, else the last release. */
export function describeNote(state: BackgroundState, t: Text, clock: (epochSeconds: number) => string): string {
  const fallback = state.gpu_busy_fallbacks[0]
  if (fallback) {
    return t('desktop.bg.gpuBusy', { time: clock(fallback.at), model: String(fallback.label ?? '').replace(/^tagger:/, '') })
  }
  const last = state.last_release
  if (!last) return ''
  return t('desktop.bg.lastRelease', { time: clock(last.at), list: last.keys.map((k) => modelName(k, t)).join(t('batch.listSep')) })
}

/** "Loaded now: ..." or "No AI model is loaded right now." */
export function describeLoaded(state: BackgroundState, t: Text): string {
  if (state.models.length === 0) return t('desktop.bg.none')
  return t('desktop.bg.loaded', { list: state.models.map((m) => describeModel(m, t)).join(t('batch.listSep')) })
}

/** What the toasts after "Unload now" say: what was freed, what a running job kept, or that there was nothing. */
export function unloadMessages(result: UnloadResult, t: Text): string[] {
  const released = (result.released ?? []).map((k) => modelName(k, t))
  const busy = (result.busy ?? []).map((k) => modelName(k, t))
  const sep = t('batch.listSep')
  const out: string[] = []
  if (released.length) out.push(t('desktop.bg.unloaded', { list: released.join(sep) }))
  if (busy.length) out.push(t('desktop.bg.busyKept', { list: busy.join(sep) }))
  if (!out.length) out.push(t('desktop.bg.nothing'))
  return out
}

/** The server's answer as a BackgroundState; null when it is not one (so a half answer is never drawn as "nothing loaded"). */
export function readBackground(raw: unknown): BackgroundState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.idle_unload_minutes !== 'number' || !Array.isArray(r.models)) return null
  const models = r.models.filter((m): m is LoadedModel => !!m && typeof m === 'object' && typeof (m as LoadedModel).key === 'string')
  const last = r.last_release as { at?: unknown; keys?: unknown } | null | undefined
  return {
    idle_unload_minutes: r.idle_unload_minutes,
    models: models.map((m) => ({ key: m.key, device: String(m.device ?? ''), in_use: Boolean(m.in_use), idle_seconds: Number(m.idle_seconds) || 0 })),
    last_release: last && typeof last.at === 'number' && Array.isArray(last.keys) ? { at: last.at, keys: last.keys.map(String) } : null,
    gpu_busy_fallbacks: Array.isArray(r.gpu_busy_fallbacks) ? (r.gpu_busy_fallbacks as { at: number; label?: string }[]).filter((f) => typeof f?.at === 'number') : [],
  }
}
