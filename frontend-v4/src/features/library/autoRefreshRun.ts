import { create } from 'zustand'
import { api, ApiError, unwrap } from '../../api/client'
import { tailOfPath } from '../../lib/paths'
import { useToasts } from '../../ui/toasts'
import { afterImport } from '../import/afterImport'
import { addJob, isQueueBusy, startingProgress, type Job } from '../jobs/jobs'
import { asScanSource } from '../jobs/progress'
import { lt } from '../settings/libraryText'
import { autoRefreshDue, readAutoRefresh } from './autoRefresh'

// The idle check at work (opt-in, Settings › Library). After a minute without
// input, at most every five minutes, the backend quick-imports the source
// folder scanned longest ago: it never tags, and it does nothing while another
// import runs, so V3.5 doing the same at the same time is skipped quietly.

/** How often the idle clock is looked at. */
const TICK_MS = 15_000
const KEY = 'sd-v4-auto-refresh'

function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export const useAutoRefresh = create<{ on: boolean; setOn: (on: boolean) => void }>((set) => ({
  on: readOn(),
  setOn: (on) => {
    try {
      localStorage.setItem(KEY, on ? '1' : '0')
    } catch {
      // storage blocked: on for this session only
    }
    set({ on })
  },
}))

/** A check that found something speaks like an import; one that found nothing stays quiet. */
function afterCheck(job: Job): void {
  const p = job.progress
  if (p.succeeded > 0 || p.failedCount > 0) void afterImport(job, false, 0)
}

let warned = false

async function check(): Promise<void> {
  try {
    const answer = readAutoRefresh(unwrap(await api.POST('/api/library/auto-refresh')))
    if (answer.kind === 'quiet') return
    if (answer.kind === 'unexpected') throw new Error(answer.detail)
    warned = false
    addJob({
      kind: 'scan',
      destination: answer.root,
      label: tailOfPath(answer.root, 36),
      ctx: { runId: answer.runId, scanSource: asScanSource(answer.source) },
      progress: { ...startingProgress(0), phase: 'files' },
      then: afterCheck,
    })
  } catch (error) {
    // V3.5 started an import at the same moment: its turn, not a problem.
    if (error instanceof ApiError && error.status === 409) return
    // Said once until a check works again, not every five minutes.
    if (warned) return
    warned = true
    useToasts.getState().push(lt('libset.auto.failed', { reason: (error as Error).message }), 'error')
  }
}

const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll'] as const

/** Watch for idleness and check when due. Returns the cleanup (App mounts it once). */
export function startAutoRefresh(): () => void {
  let lastActivity = Date.now()
  let lastAttempt = Date.now()
  const mark = () => {
    lastActivity = Date.now()
  }
  for (const name of ACTIVITY) window.addEventListener(name, mark, { passive: true, capture: true })
  const timer = window.setInterval(() => {
    const now = Date.now()
    const state = { on: useAutoRefresh.getState().on, hidden: document.hidden, busy: isQueueBusy('scan'), now, lastActivity, lastAttempt }
    if (!autoRefreshDue(state)) return
    lastAttempt = now
    void check()
  }, TICK_MS)
  return () => {
    window.clearInterval(timer)
    for (const name of ACTIVITY) window.removeEventListener(name, mark, { capture: true })
  }
}
