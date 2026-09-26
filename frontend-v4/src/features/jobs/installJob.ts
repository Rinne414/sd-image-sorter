import { api, ApiError, unwrap } from '../../api/client'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from './jobs'
import { busyText } from './busyText'

// First use of a model: download it as a job in the Jobs drawer, then run the
// work that needed it. Shared by tagging and censor detection.

export interface InstallTarget {
  /** Model card in /api/models/status. */
  card: string
  variant: string | null
  /** What the drawer calls it. */
  label: string
}

const fail = (error: unknown) => {
  const busy = error instanceof ApiError && error.status === 409
  useToasts.getState().push(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), 'error')
  return false
}

/** Download a model, then run `then`. False (with the reason said) when the download could not start. */
export async function installThen(target: InstallTarget, then: () => void): Promise<boolean> {
  if (isQueueBusy('install')) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const res = unwrap<{ model_id?: string }>(
      await api.POST('/api/models/prepare', { body: { model_id: target.card, variant: target.variant } }),
    )
    if (res.model_id && res.model_id !== target.card) {
      useToasts.getState().push(tr('tagging.otherDownload', { name: res.model_id }), 'error')
      return false
    }
    addJob({
      kind: 'install',
      label: target.label,
      ctx: { modelId: target.card },
      progress: { ...startingProgress(0), unit: 'bytes' },
      then,
    })
    return true
  } catch (error) {
    return fail(error)
  }
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
