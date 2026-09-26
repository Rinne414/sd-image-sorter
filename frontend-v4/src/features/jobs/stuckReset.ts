import { useEffect, useState } from 'react'
import { api, ApiError, unwrap } from '../../api/client'
import type { Job } from './jobs'
import type { JobKind } from './progress'
import { canResetStuck, isStalled, nextStall, type ResetKind } from './stuck'

// Clears a file job stranded in "stopping" (see stuck.ts). Only on the user's click.

async function postReset(kind: ResetKind): Promise<unknown> {
  switch (kind) {
    case 'move':
    case 'copy':
      return unwrap(await api.POST('/api/move/reset'))
    case 'trash':
      return unwrap(await api.POST('/api/images/delete-selected/reset'))
    case 'remove':
      return unwrap(await api.POST('/api/images/remove-selected/reset'))
  }
}

/** cleared: usable again (the next poll ends the job). running: refused, the worker is alive. */
export type ResetOutcome = 'cleared' | 'running' | 'failed'

export async function resetStuck(kind: JobKind): Promise<{ outcome: ResetOutcome; reason?: string }> {
  if (!canResetStuck(kind)) return { outcome: 'failed' }
  try {
    await postReset(kind)
    return { outcome: 'cleared' }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { outcome: 'running' }
    return { outcome: 'failed', reason: (error as Error).message }
  }
}

const since = new Map<string, number>()
const TICK_MS = 1000

/** True once `job` has been stopping for longer than the stall window. */
export function useStalled(job: Job): boolean {
  const status = job.progress.status
  // Re-render every second while stopping, so the offer appears on time.
  const [, tick] = useState(0)
  useEffect(() => {
    if (status !== 'cancelling') return
    const timer = window.setInterval(() => tick((n) => n + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [status])

  // Kept per job outside the component: closing the drawer must not restart the clock.
  const now = Date.now()
  const started = nextStall(since.get(job.id) ?? null, status, now)
  if (started === null) since.delete(job.id)
  else since.set(job.id, started)
  return canResetStuck(job.kind) && isStalled(started, now)
}
