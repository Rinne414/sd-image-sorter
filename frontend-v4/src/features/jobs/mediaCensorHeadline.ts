import type { MessageKey, Params } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import type { JobProgress } from './progress'

// What the Jobs drawer says about a GIF / video censor job. It says what really
// happened: files covered, files where nothing was found (saved unchanged),
// files that failed, a stop, a job the program no longer knows. Pure.

type Say = (key: MessageKey, params?: Params) => string

interface JobLike {
  label: string | null
  count: number
  progress: JobProgress
}

const FOLDER_CHARS = 44

export function mediaCensorHeadline(job: JobLike, say: Say): string {
  const p = job.progress
  const media = p.media
  const folder = tailOfPath(media?.folder ?? '', FOLDER_CHARS)
  const name = job.label ?? ''
  switch (p.status) {
    case 'queued':
    case 'running':
      return say('mediacensor.job.running', { name }) + (media?.unreachable ? say('mediacensor.job.noContactSuffix') : '')
    case 'cancelling':
      return `${say('mediacensor.job.running', { name })} · ${say('jobs.stopping')}`
    case 'cancelled':
      if (!media?.filesDone) return say('mediacensor.job.stoppedNone')
      return say('mediacensor.job.stopped', { done: media.filesDone, total: media.files.length || job.count, folder })
    case 'error':
      if (p.lost) return say('mediacensor.job.gone')
      return say('mediacensor.job.failed', { reason: p.message || '?' })
    case 'idle':
      return say('jobs.reset')
    case 'done': {
      const made = p.succeeded
      const covered = made - (media?.untouched ?? 0)
      let text: string
      if (covered === made) text = say('mediacensor.job.doneAll', { n: made, folder })
      else if (covered === 0) text = say('mediacensor.job.doneNothing', { n: made, folder })
      else text = say('mediacensor.job.doneSome', { covered, plain: made - covered, folder })
      if (p.failedCount) text += say('mediacensor.job.failedPart', { failed: p.failedCount })
      return text
    }
  }
}
