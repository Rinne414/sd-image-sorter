import type { JobKind, JobStatus } from './progress'

// A job stranded in "stopping". Stopping only asks the worker to finish; a
// worker that died first leaves the backend saying "cancelling" forever, and
// every later job of that kind is refused until the app restarts. The backend
// can clear that state (409 while the worker is really alive). It is never
// done by itself: only the user can tell "gone" from "slow", so the drawer
// offers it once the job has sat in "stopping" past the stall window
// (stuckReset.ts asks the backend).

/** A live worker reaches its next image well within this. */
export const STALL_MS = 15_000

/** When the job began stopping, or null when it is not stopping. */
export function nextStall(since: number | null, status: JobStatus, now: number): number | null {
  if (status !== 'cancelling') return null
  return since ?? now
}

export const isStalled = (since: number | null, now: number) => since !== null && now - since >= STALL_MS

export type ResetKind = 'move' | 'copy' | 'trash' | 'remove'

const RESETTABLE: ReadonlySet<JobKind> = new Set<ResetKind>(['move', 'copy', 'trash', 'remove'])

export const canResetStuck = (kind: JobKind): kind is ResetKind => RESETTABLE.has(kind)
