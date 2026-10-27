import { ApiError } from '../../api/client'
import { translate, useLang, type MessageKey } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { cancelMedia, getMediaJob } from '../censor/media/mediaApi'
import type { Job } from './jobs'
import { contactChange } from './mediaContact'

// Polls a GIF / video censor job for the Jobs drawer (read by mediaCensorJob.ts).
// A missed look keeps the last reading (mediaContact.ts says when to tell the
// user); a 404 is different: the program no longer knows the job (it was
// restarted), and the job is over.

const tell = (key: MessageKey, tone: 'info' | 'error' = 'info') => useToasts.getState().push(translate(useLang.getState().lang, key), tone)

const missed = new Map<string, number>()

function noteContact(id: string, answered: boolean): void {
  const change = contactChange(missed.get(id) ?? 0, answered)
  missed.set(id, change.next)
  if (change.say === 'lost') tell('mediacensor.job.noContact', 'error')
  if (change.say === 'back') tell('mediacensor.job.contactBack')
}

export const driveMediaCensor = {
  poll: async (job?: Job): Promise<unknown> => {
    const id = job?.ctx.mediaCensor?.jobId ?? ''
    try {
      const snapshot = await getMediaJob(id)
      noteContact(id, true)
      return snapshot
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        missed.delete(id)
        return { gone: true }
      }
      noteContact(id, false)
      return { unreachable: true }
    }
  },
  cancel: async (job: Job): Promise<unknown> => cancelMedia(job.ctx.mediaCensor?.jobId ?? ''),
}
