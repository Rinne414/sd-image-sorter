// The GIF / video censor jobs this browser started and has not yet seen end.
// The program keeps running a job when the page reloads; this list (in the
// browser, since the program has no "which jobs were mine" answer) is how the
// Jobs drawer finds them again. A job leaves the list when the page has seen it
// end, or has been told the program no longer knows it. Not a setting: "Reset
// all settings" leaves it, like the other work in progress.

export interface TrackedMediaJob {
  id: string
  /** The headline name (a file name, or how many files). */
  label: string
  /** Where the results go. */
  folder: string
  count: number
}

export const TRACKED_KEY = 'sd-v4-media-jobs'

/** The list as stored; anything unreadable or of the wrong shape is dropped. */
export function parseTracked(raw: string | null): TrackedMediaJob[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.flatMap((item): TrackedMediaJob[] => {
      if (!item || typeof item !== 'object') return []
      const { id, label, folder, count } = item as Record<string, unknown>
      if (typeof id !== 'string' || id === '') return []
      return [{ id, label: typeof label === 'string' ? label : '', folder: typeof folder === 'string' ? folder : '', count: typeof count === 'number' && Number.isFinite(count) ? count : 0 }]
    })
  } catch {
    return []
  }
}

export const withTracked = (list: readonly TrackedMediaJob[], job: TrackedMediaJob): TrackedMediaJob[] => [...list.filter((j) => j.id !== job.id), job]

export const withoutTracked = (list: readonly TrackedMediaJob[], id: string): TrackedMediaJob[] => list.filter((j) => j.id !== id)

function read(): TrackedMediaJob[] {
  try {
    return parseTracked(localStorage.getItem(TRACKED_KEY))
  } catch {
    return []
  }
}

function write(list: readonly TrackedMediaJob[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(TRACKED_KEY)
    else localStorage.setItem(TRACKED_KEY, JSON.stringify(list))
  } catch {
    // storage blocked: the job just will not come back after a reload
  }
}

export const trackedMediaJobs = read
export const trackMediaJob = (job: TrackedMediaJob) => write(withTracked(read(), job))
export const untrackMediaJob = (id: string) => write(withoutTracked(read(), id))
