import { translate, useLang } from '../../i18n'
import { leaseWork, spoken, workName, type Translate } from './aiBusy'

// What a 409 refusal tells the user. A refused AI start carries who holds the
// AI (main.py's AiRuntimeBusyError handler: reason, and blocker {label,
// elapsed_seconds, scope, pid, stuck}), and "something is working" needs
// different advice from "the lock outlived its job" (restart, not wait). Any
// other 409 is a queue of the same kind that is busy: the old sentence.

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)

/** The sentence for a refused AI start, or null when `body` is not one. */
export function explainBusy(body: unknown, t: Translate): string | null {
  const b = obj(body)
  if (b?.type !== 'AiRuntimeBusyError') return null
  const blocker = obj(b.blocker)
  const label = typeof blocker?.label === 'string' && blocker.label ? blocker.label : null
  const who = label ? workName(leaseWork(label), t) : null
  if (b.reason === 'stale_lock_holder_gone') return who ? t('signals.busy.stale', { who }) : t('signals.busy.staleUnnamed')
  if (!who) return t('signals.busy.unnamed')
  const elapsed = blocker?.elapsed_seconds
  const running = typeof elapsed === 'number' ? t('signals.busy.running', { time: spoken(elapsed, t) }) : ''
  const text = t(blocker?.scope === 'process' ? 'signals.busy.process' : 'signals.busy.thread', { who, running })
  return blocker?.stuck === true ? text + t('signals.busy.stuck') : text
}

/** A refusal because the AI lock outlived the job that took it: only a restart clears that. */
export function isStaleLock(error: unknown): boolean {
  const body = obj(error && typeof error === 'object' ? (error as { body?: unknown }).body : null)
  return body?.type === 'AiRuntimeBusyError' && body.reason === 'stale_lock_holder_gone'
}

let onRefused: (() => void) | null = null

/** A refusal is fresher news than any poll: the AI-busy chip registers here to look again (and pick up work started elsewhere). */
export function setRefusalListener(listener: () => void): void {
  onRefused = listener
}

/** What to say about a 409 (`error` is the ApiError the request threw). */
export function busyText(error: unknown): string {
  onRefused?.()
  const lang = useLang.getState().lang
  const t: Translate = (key, params) => translate(lang, key, params)
  const body = error && typeof error === 'object' ? (error as { body?: unknown }).body : null
  return explainBusy(body, t) ?? t('jobs.busy')
}
