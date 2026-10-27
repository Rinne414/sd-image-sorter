import { translate, useLang, type MessageKey, type Params } from '../../../i18n'
import { useToasts } from '../../../ui/toasts'
import { addJob, startingProgress, useJobs } from '../../jobs/jobs'
import { mediaStartBody, type MediaDetection, type MediaOptions, type MediaSource } from './mediaBody'
import { startMedia } from './mediaApi'
import { trackMediaJob } from './mediaTracked'

// Starting the GIF / video censor: the request, then a job in the Jobs drawer
// that follows it. A refusal is said in the toast with the backend's reason.

const say = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

export interface MediaRun {
  source: MediaSource
  detection: MediaDetection
  options: MediaOptions
  /** How many files the run was asked for (the job's size until the first look). */
  count: number
  /** A name for the headline: the file's name, or how many files. */
  label: string
}

/** true: the job is running and the drawer shows it. */
export async function beginMediaJob(run: MediaRun): Promise<boolean> {
  try {
    const started = await startMedia(mediaStartBody(run.source, run.detection, run.options))
    addJob({
      kind: 'mediacensor',
      progress: { ...startingProgress(100), unit: 'percent' },
      count: run.count,
      label: run.label,
      destination: started.output_folder,
      ctx: { mediaCensor: { jobId: started.job_id, folder: started.output_folder } },
    })
    // So a reload finds the job again (mediaTracked.ts).
    trackMediaJob({ id: started.job_id, label: run.label, folder: started.output_folder, count: run.count })
    useJobs.getState().setDrawerOpen(true)
    return true
  } catch (error) {
    useToasts.getState().push(say('mediacensor.startFailed', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** The headline name of a run: one file by its name, several by their number. */
export function runLabel(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? '') : say('mediacensor.job.files', { n: names.length })
}
