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

/** Causes the program names by `error_code`; their words come from the language pack. */
const ERROR_TEXT: Readonly<Record<string, MessageKey>> = {
  censor_detector_missing: 'mediacensor.err.censor_detector_missing',
}

/** A file's failure the program names by code is said in the user's language. */
function sayFileErrors(snapshot: unknown): unknown {
  const files = (snapshot as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) return snapshot
  const lang = useLang.getState().lang
  const said = files.map((file: unknown) => {
    const key = ERROR_TEXT[String((file as { error_code?: unknown } | null)?.error_code ?? '')]
    return key ? { ...(file as object), error: translate(lang, key) } : file
  })
  return { ...(snapshot as object), files: said }
}

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
    return sayFileErrors(snapshot)
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
