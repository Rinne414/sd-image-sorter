import type { BatchStep } from '../../api/types'
import type { Lang } from '../../i18n'

// Pure rules for batches: step list edits, default names, undo order, the
// pick grid cursor. Every function returns new data and leaves its input alone.

export type StepState = 'current' | 'done' | 'todo'

/** Steps the rail shows outside edit mode, in order. */
export function enabledSteps(steps: readonly BatchStep[]): BatchStep[] {
  return steps.filter((s) => s.enabled)
}

/** Where a step stands: switched-on steps before the current one are done. */
export function stepState(steps: readonly BatchStep[], current: string | null, id: string): StepState {
  const on = enabledSteps(steps).map((s) => s.id)
  const here = current !== null && on.includes(current) ? on.indexOf(current) : 0
  const at = on.indexOf(id)
  if (at === here) return 'current'
  return at >= 0 && at < here ? 'done' : 'todo'
}

/** Move a step one place up (-1) or down (+1). Returns the same list when it cannot move. */
export function moveStep(steps: readonly BatchStep[], id: string, delta: -1 | 1): readonly BatchStep[] {
  const from = steps.findIndex((s) => s.id === id)
  if (from < 0) return steps
  return moveStepTo(steps, id, from + delta)
}

/** Put a step at `to` (a drop). Returns the same list when nothing changes. */
export function moveStepTo(steps: readonly BatchStep[], id: string, to: number): readonly BatchStep[] {
  const from = steps.findIndex((s) => s.id === id)
  if (from < 0 || to < 0 || to >= steps.length || to === from) return steps
  const next = steps.filter((s) => s.id !== id)
  next.splice(to, 0, steps[from] as BatchStep)
  return next
}

export function toggleStep(steps: readonly BatchStep[], id: string): BatchStep[] {
  return steps.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s))
}

/** The current step after an edit: kept while it is switched on, else the first switched-on step. */
export function currentAfterEdit(steps: readonly BatchStep[], current: string | null): string | null {
  const on = enabledSteps(steps)
  if (current !== null && on.some((s) => s.id === current)) return current
  return on[0]?.id ?? current
}

function shortDate(date: Date, lang: Lang): string {
  if (lang === 'zh-CN') return `${date.getMonth() + 1}月${date.getDate()}日`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** "Pixiv post Sep 25", then "(2)", "(3)" when that name is already taken. */
export function defaultBatchName(base: string, date: Date, lang: Lang, taken: readonly string[]): string {
  const stem = `${base} ${shortDate(date, lang)}`
  const used = new Set(taken)
  if (!used.has(stem)) return stem
  let n = 2
  while (used.has(`${stem} (${n})`)) n += 1
  return `${stem} (${n})`
}

/** Settings that describe one batch only (where it came from), never carried into a template. */
const PER_BATCH_SETTINGS = ['source_collection_id']

/** A batch's settings as a template keeps them. */
export function templateSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !PER_BATCH_SETTINGS.includes(key)))
}

/**
 * The order after an undo put removed items back (the server appends them):
 * everything in its old place, anything added meanwhile at the end.
 */
export function restoreOrder(before: readonly number[], present: readonly number[]): number[] {
  const here = new Set(present)
  const known = new Set(before)
  return [...before.filter((id) => here.has(id)), ...present.filter((id) => !known.has(id))]
}

/** Next cursor index in a grid of `count` items, `cols` per row. -1 means none. */
export function moveCursor(index: number, count: number, cols: number, key: string): number {
  if (count === 0) return -1
  if (index < 0) return 0
  const last = count - 1
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'ArrowRight':
      return Math.min(last, index + 1)
    case 'ArrowUp':
      return index - cols >= 0 ? index - cols : index
    case 'ArrowDown':
      // The last row may be short: step onto its last item instead of stopping.
      return index + cols <= last ? index + cols : Math.floor(index / cols) < Math.floor(last / cols) ? last : index
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return index
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "3 hours ago" in the UI language; empty for a missing or broken time. */
export function timeAgo(iso: string | null, lang: Lang, now: Date = new Date()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = now.getTime() - then
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  if (diff < MINUTE) return lang === 'zh-CN' ? '刚刚' : 'just now'
  if (diff < HOUR) return rtf.format(-Math.round(diff / MINUTE), 'minute')
  if (diff < DAY) return rtf.format(-Math.round(diff / HOUR), 'hour')
  return rtf.format(-Math.round(diff / DAY), 'day')
}
