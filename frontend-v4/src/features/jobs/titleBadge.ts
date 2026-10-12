import type { Job } from './jobs'
import { isFinished } from './progress'

// A job that ends while the tab is in the background puts a count in the tab
// title ("(2) SD Image Sorter", "(1!)" when one went wrong); coming back to the
// tab clears it. The details are in the Jobs drawer and its toasts.

export function badgeTitle(base: string, ended: number, failed: boolean): string {
  return ended > 0 ? `(${ended}${failed ? '!' : ''}) ${base}` : base
}

/** Jobs that were running (or waiting) before and have ended now. */
export function endedJobs(before: readonly Job[], after: readonly Job[]): Job[] {
  const wasOpen = new Set(before.filter((j) => !isFinished(j.progress.status)).map((j) => j.id))
  return after.filter((j) => wasOpen.has(j.id) && isFinished(j.progress.status))
}

const wentWrong = (j: Job) => j.progress.status === 'error' || j.progress.failedCount > 0

type Subscribe = (listener: (after: readonly Job[], before: readonly Job[]) => void) => () => void

/** Count jobs that end while the tab is hidden; returns the function that stops watching. */
export function watchTitle(subscribe: Subscribe): () => void {
  const base = document.title
  let ended = 0
  let failed = false
  const show = () => {
    document.title = badgeTitle(base, ended, failed)
  }
  const unsubscribe = subscribe((after, before) => {
    if (document.visibilityState !== 'hidden') return
    const done = endedJobs(before, after)
    if (!done.length) return
    ended += done.length
    failed = failed || done.some(wentWrong)
    show()
  })
  const back = () => {
    if (document.visibilityState !== 'visible' || ended === 0) return
    ended = 0
    failed = false
    show()
  }
  document.addEventListener('visibilitychange', back)
  return () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', back)
    document.title = base
  }
}
