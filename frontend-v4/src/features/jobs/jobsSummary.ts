import { isFinished, type JobProgress } from './progress'

// The number on the Jobs top-bar button. Jobs count in different units
// (images, bytes of a download, a pull's percent), so they are never added
// together: images alone read "done/all", one download or pull alone its
// percent, anything else how many are running. The meter under it is the
// average share done, which means the same whatever the unit.

interface JobLike {
  count: number
  progress: Pick<JobProgress, 'unit' | 'current' | 'total' | 'status'>
}

export interface ButtonSummary {
  text: string
  /** 0–1 for the meter; null when nothing is running. */
  fraction: number | null
}

const share = (j: JobLike) => {
  const total = j.progress.total || j.count
  return total > 0 ? Math.min(1, j.progress.current / total) : 0
}

export function buttonSummary(jobs: readonly JobLike[]): ButtonSummary {
  const running = jobs.filter((j) => !isFinished(j.progress.status))
  if (running.length === 0) return { text: String(jobs.length), fraction: null }
  const fraction = running.reduce((sum, j) => sum + share(j), 0) / running.length
  if (running.every((j) => j.progress.unit === 'images')) {
    const current = running.reduce((n, j) => n + j.progress.current, 0)
    const total = running.reduce((n, j) => n + (j.progress.total || j.count), 0)
    return { text: `${current}/${total}`, fraction: total ? current / total : 0 }
  }
  if (running.length === 1) return { text: `${Math.round(fraction * 100)}%`, fraction }
  return { text: String(running.length), fraction }
}
