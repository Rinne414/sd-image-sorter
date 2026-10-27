import { ApiError } from '../../api/client'
import { translate, useLang, type MessageKey } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { cancelMedia, getMediaJob } from '../censor/media/mediaApi'
import { untrackMediaJob } from '../censor/media/mediaTracked'
import type { Job } from './jobs'
import { contactChange } from './mediaContact'

// Polls a GIF / video censor job for the Jobs drawer (read by mediaCensorJob.ts).
// A missed look keeps the last reading (mediaContact.ts says when to tell the
// user); a 404 is different: the program no longer knows the job (it was
// restarted), and the job is over.

const tell = (key: MessageKey, tone: 'info' | 'error' = 'info') => useToasts.getState().push(translate(useLang.getState().lang, key), tone)

const missed = new Map<string, number>()

const ENDED = new Set(['done', 'done_with_errors', 'cancelled'])

/** The program says the job is over (finished, or stopped). */
const isEnded = (snapshot: unknown) => ENDED.has(String((snapshot as { status?: unknown } | null)?.status))

function noteContact(id: string, answered: boolean): void {
  const change = contactChange(missed.get(id) ?? 0, answered)
  missed.set(id, change.next)
  if (change.say === 'lost') tell('mediacensor.job.noContact', 'error')
  if (change.say === 'back') tell('mediacensor.job.contactBack')
}

/** One look at a job: its snapshot, { gone: true } (the program does not know it), or { unreachable: true }. */
export async function lookAtMediaJob(id: string): Promise<unknown> {
  try {
    const snapshot = await getMediaJob(id)
    noteContact(id, true)
    if (isEnded(snapshot)) untrackMediaJob(id)
    return snapshot
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      missed.delete(id)
      untrackMediaJob(id)
      return { gone: true }
    }
    noteContact(id, false)
    return { unreachable: true }
  }
}

export const driveMediaCensor = {
  poll: async (job?: Job): Promise<unknown> => lookAtMediaJob(job?.ctx.mediaCensor?.jobId ?? ''),
  cancel: async (job: Job): Promise<unknown> => cancelMedia(job.ctx.mediaCensor?.jobId ?? ''),
}
