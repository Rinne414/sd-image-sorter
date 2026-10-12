import type { Job } from './jobs'

// What the Jobs drawer offers once a job is done. A tagging run of ours on
// picked images: pick the images it tagged, add them to a batch, or edit their
// tags. (An import has its own in ImportJobParts; a sort ends on the Sort page's
// summary.) Pure: JobsMenu.tsx draws the buttons.

/** The images a finished tagging run tagged, or null when it has nothing to offer. */
export function tagNextSteps(job: Job): number[] | null {
  const p = job.progress
  if (job.kind !== 'tag' || p.status !== 'done' || job.adopted || job.ids.length === 0 || p.succeeded === 0) return null
  const failed = new Set(p.failures.map((f) => f.id))
  return job.ids.filter((id) => !failed.has(id))
}
