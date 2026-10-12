import { api, ApiError, unwrap } from '../../api/client'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr, useJobs, type Job } from './jobs'
import { busyText } from './busyText'
import { pushRefusal } from './refusalToast'
import { installRunOf, isFinished, type JobProgress } from './progress'

// First use of a model: download it as a job in the Jobs drawer, then run the
// work that needed it. Shared by tagging and censor detection. The Model
// Center also downloads several models in a row here (installQueue), and
// continues them after a restart (installResume.ts).

export interface InstallTarget {
  /** Model card in /api/models/status. */
  card: string
  variant: string | null
  /** What the drawer calls it. */
  label: string
  /** Where to download from, for a card that offers a choice (Kaloscope). */
  source?: string | null
}

const fail = (error: unknown) => {
  const busy = error instanceof ApiError && error.status === 409
  pushRefusal(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), error)
  return null
}

/** Ask the backend to prepare a model and follow the download in the drawer. The job's id, or null (with the reason said). */
export async function startInstall(target: InstallTarget, then?: () => void): Promise<string | null> {
  if (isQueueBusy('install')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return null
  }
  try {
    const body = { model_id: target.card, variant: target.variant, ...(target.source ? { source: target.source } : {}) }
    const res = unwrap<{ model_id?: string; run_id?: unknown }>(await api.POST('/api/models/prepare', { body }))
    if (res.model_id && res.model_id !== target.card) {
      useToasts.getState().push(tr('tagging.otherDownload', { name: res.model_id }), 'error')
      return null
    }
    const job = addJob({
      kind: 'install',
      label: target.label,
      ctx: { modelId: target.card, ...installRunOf(res.run_id) },
      progress: { ...startingProgress(0), unit: 'bytes' },
      then,
    })
    return job.id
  } catch (error) {
    return fail(error)
  }
}

/** Download a model, then run `then`. False (with the reason said) when the download could not start. */
export async function installThen(target: InstallTarget, then: () => void): Promise<boolean> {
  return (await startInstall(target, then)) !== null
}

/** Download each model in turn (one download at a time), then run `then`. */
export async function installAllThen(targets: readonly InstallTarget[], then: () => void): Promise<boolean> {
  const [first, ...rest] = targets
  if (!first) {
    then()
    return true
  }
  return installThen(first, () => void installAllThen(rest, then))
}

/** Resolves once `test` holds for the jobs list (checked now and on every change). */
function whenJobs(test: (jobs: Job[]) => boolean): Promise<Job[]> {
  return new Promise((resolve) => {
    if (test(useJobs.getState().jobs)) return resolve(useJobs.getState().jobs)
    const stop = useJobs.subscribe((s) => {
      if (!test(s.jobs)) return
      stop()
      resolve(s.jobs)
    })
  })
}

const running = (j: Job) => j.kind === 'install' && !isFinished(j.progress.status)

/** The job's last progress once it has ended (null if it left the list first). */
async function ended(id: string): Promise<JobProgress | null> {
  const jobs = await whenJobs((list) => !list.some((j) => j.id === id && !isFinished(j.progress.status)))
  return jobs.find((j) => j.id === id)?.progress ?? null
}

export interface QueueHooks {
  /** Before each download: its place (from 0) and the model. */
  onStep?: (index: number, target: InstallTarget) => void
  /** A model needs an app restart first: it and everything after it are `rest`. The queue stops. */
  onRestart: (rest: InstallTarget[], target: InstallTarget) => void | Promise<void>
  /** A download could not start (its reason was said): it and everything after it are `rest`. The queue stops. */
  onBlocked: (rest: InstallTarget[]) => void | Promise<void>
  /** Every model was tried; `failed` did not end well. */
  onEnd: (failed: InstallTarget[]) => void | Promise<void>
}

/**
 * Download several models one after another, each its own job in the drawer.
 * A download already running (another feature's first use) is waited for.
 */
export async function installQueue(targets: readonly InstallTarget[], hooks: QueueHooks): Promise<void> {
  const failed: InstallTarget[] = []
  for (const [index, target] of targets.entries()) {
    hooks.onStep?.(index, target)
    await whenJobs((jobs) => !jobs.some(running))
    const id = await startInstall(target)
    if (!id) return await hooks.onBlocked(targets.slice(index))
    const p = await ended(id)
    if (p?.status === 'done' && p.needsRestart) return await hooks.onRestart(targets.slice(index), target)
    if (p?.status !== 'done') failed.push(target)
  }
  await hooks.onEnd(failed)
}
