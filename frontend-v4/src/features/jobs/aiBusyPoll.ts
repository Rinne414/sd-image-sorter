import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import { holdersOf, observe, pollDelay, readSnapshot, readTagRun, track, unclaimed, type Holder, type SeenMap } from './aiBusy'
import { setRefusalListener } from './busyText'
import { adoptRunningJobs, useJobs, type Job } from './jobs'
import { isFinished, type JobKind } from './progress'

// Keeps the AI-busy picture current (aiBusy.ts reads it): polls
// GET /api/system/ai-jobs and GET /api/tag/progress (1.5 s while busy, 6 s idle,
// 15 s in a background tab), and looks again at once after a 409 refusal or
// when a job of ours starts. Work the drawer does not show (V3.5 or another
// window started it after this page opened) makes it pick up running jobs.

interface AiBusyState {
  seen: SeenMap
  /** Library tagging runs waiting in the AI queue. */
  tagQueued: number
}

export const useAiBusy = create<AiBusyState>(() => ({ seen: {}, tagQueued: 0 }))

/** Same unclaimed work is looked for again after this long (the first look can race its start). */
const ADOPT_RETRY_MS = 30_000
/** A refusal asks for a fresh look at every queue, but not more often than this. */
const REFUSAL_ADOPT_MS = 5000

let timer = 0
let inFlight = false
/** Asked for while a look was on its way: that look may predate the news, so look once more right after. */
let again = false
let firstLook = true
let lastAdopt = { sig: '', at: 0 }
let lastRefusalAdopt = 0

const hidden = () => document.visibilityState === 'hidden'
const busyNow = () => holdersOf(useAiBusy.getState().seen, Date.now()).length > 0

async function read<T>(request: Promise<{ data?: unknown; error?: unknown; response: Response }>): Promise<T | null> {
  try {
    return unwrap<T>(await request)
  } catch {
    return null
  }
}

function maybeAdopt(sig: string, now: number): void {
  if (!sig || (sig === lastAdopt.sig && now - lastAdopt.at < ADOPT_RETRY_MS)) return
  lastAdopt = { sig, at: now }
  void adoptRunningJobs()
}

async function poll(): Promise<void> {
  if (inFlight) {
    again = true
    return
  }
  inFlight = true
  window.clearTimeout(timer)
  try {
    const [snapshot, tag] = await Promise.all([read<unknown>(api.GET('/api/system/ai-jobs')), read<unknown>(api.GET('/api/tag/progress'))])
    // Unreachable (restarting, offline): keep what is known; it fades after the linger window.
    if (snapshot === null && tag === null) return
    const now = Date.now()
    const run = tag === null ? null : readTagRun(tag)
    const current = observe(snapshot === null ? null : readSnapshot(snapshot), run, useJobs.getState().jobs)
    useAiBusy.setState((s) => ({ seen: track(s.seen, current, now, firstLook, run !== null), tagQueued: run?.queued ?? s.tagQueued }))
    firstLook = false
    maybeAdopt(unclaimed(current), now)
  } finally {
    inFlight = false
    timer = window.setTimeout(() => void poll(), again ? 0 : pollDelay(hidden(), busyNow()))
    again = false
  }
}

/** Kinds of work that use the AI: when one of ours starts or ends, the chip says so without waiting for the next poll. */
const AI_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['tag', 'smarttag', 'embed', 'aesthetic', 'detect', 'refine', 'masks'])
const openAiJobs = (jobs: readonly Job[]) =>
  jobs.filter((j) => AI_KINDS.has(j.kind) && !isFinished(j.progress.status) && j.progress.status !== 'queued').length

let started = false

/** Start watching (once for the app); returns the function that stops it. */
export function startAiBusy(): () => void {
  if (started) return () => undefined
  started = true
  setRefusalListener(() => {
    // The chip's two requests go first: the pick-up asks every queue at once.
    void poll()
    const now = Date.now()
    if (now - lastRefusalAdopt >= REFUSAL_ADOPT_MS) {
      lastRefusalAdopt = now
      void adoptRunningJobs()
    }
  })
  const onVisible = () => {
    if (!hidden()) void poll()
  }
  document.addEventListener('visibilitychange', onVisible)
  const unsubscribe = useJobs.subscribe((s, prev) => {
    if (openAiJobs(s.jobs) !== openAiJobs(prev.jobs)) void poll()
  })
  void poll()
  return () => {
    started = false
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    unsubscribe()
    setRefusalListener(() => undefined)
  }
}

const TICK_MS = 1000

/** Everything holding the AI now, re-read every second while anything does (the clocks tick). */
export function useAiHolders(): Holder[] {
  const seen = useAiBusy((s) => s.seen)
  const [, tick] = useState(0)
  const any = Object.keys(seen).length > 0
  useEffect(() => {
    if (!any) return
    const id = window.setInterval(() => tick((n) => n + 1), TICK_MS)
    return () => window.clearInterval(id)
  }, [any])
  return holdersOf(seen, Date.now())
}
