import { api, ApiError, unwrap } from '../../api/client'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy, startingProgress, tr } from './jobs'
import { readProgress } from './progress'

export type FileJobKind = 'move' | 'copy' | 'trash' | 'remove'

async function postStart(kind: FileJobKind, ids: number[], destination: string | null): Promise<unknown> {
  switch (kind) {
    case 'move':
    case 'copy':
      return unwrap(
        await api.POST('/api/move/start', {
          body: { image_ids: ids, destination_folder: destination ?? '', operation: kind },
        }),
      )
    case 'trash':
      return unwrap(
        await api.POST('/api/images/delete-selected/start', {
          body: { image_ids: ids, confirm_delete_files: true, background: false },
        }),
      )
    case 'remove':
      return unwrap(await api.POST('/api/images/remove-selected/start', { body: { image_ids: ids, background: false } }))
  }
}

/** Start a file job for `ids`. Returns false (and says why) when it could not start. */
export async function startFileJob(kind: FileJobKind, ids: number[], destination: string | null = null): Promise<boolean> {
  if (isQueueBusy(kind)) {
    useToasts.getState().push(tr('jobs.busy'), 'error')
    return false
  }
  try {
    const res = await postStart(kind, ids, destination)
    const doneAlready = !!res && typeof res === 'object' && (res as { status?: unknown }).status === 'done'
    addJob({
      kind,
      count: ids.length,
      destination,
      ids,
      progress: doneAlready ? readProgress(kind, res) : startingProgress(ids.length),
    })
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    const text = busy ? tr('jobs.busy') : tr('error.generic', { reason: (error as Error).message })
    useToasts.getState().push(text, 'error')
    return false
  }
}
