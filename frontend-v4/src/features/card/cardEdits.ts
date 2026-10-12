import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { postBulk } from '../tagedit/tagEdit'

// Edits to one image from its generation card. Tags go through the journaled
// bulk endpoints with a single id, so every change can be undone once.

function refresh(id: number): void {
  void queryClient.invalidateQueries({ queryKey: ['image', id] })
  for (const key of ['images', 'suggest', 'image-count']) void queryClient.invalidateQueries({ queryKey: [key] })
}

function fail(error: unknown): false {
  useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  return false
}

async function undoOp(opId: string, id: number): Promise<void> {
  try {
    const res = unwrap<{ restored?: number; skipped_conflicts?: unknown[] }>(
      await api.POST('/api/tags/bulk/undo/{op_id}', { params: { path: { op_id: opId } }, body: { force: false } }),
    )
    refresh(id)
    // The backend skips an image whose tags changed after the edit; say so instead of staying silent.
    const skipped = Array.isArray(res.skipped_conflicts) ? res.skipped_conflicts.length : 0
    useToasts.getState().push(
      skipped ? tr('card.undoSkipped') : tr('tagedit.undone', { n: res.restored ?? 0 }),
      skipped ? 'error' : 'info',
    )
  } catch (error) {
    fail(error)
  }
}

async function tagOp(id: number, op: 'add' | 'remove', tags: string[], toast: string): Promise<boolean> {
  try {
    const path = op === 'add' ? '/api/tags/bulk/add' : '/api/tags/bulk/remove'
    const res = await postBulk(path, { image_ids: [id], tags, dry_run: false })
    refresh(id)
    const opId = typeof res.op_id === 'string' && res.undo_available === true ? res.op_id : null
    useToasts.getState().push(toast, 'info', opId ? { label: tr('toast.undo'), run: () => void undoOp(opId, id) } : undefined)
    return true
  } catch (error) {
    return fail(error)
  }
}

export const addTags = (id: number, tags: string[]) => tagOp(id, 'add', tags, tr('card.tagsAdded', { tags: tags.join(', ') }))

export const removeTag = (id: number, tag: string) => tagOp(id, 'remove', [tag], tr('card.tagRemoved', { tag }))

/** Write the captions that changed (an empty string clears one). */
export async function saveCaptions(id: number, patch: { ai_caption?: string; nl_caption?: string }): Promise<boolean> {
  if (!Object.keys(patch).length) return true
  try {
    unwrap(await api.PATCH('/api/images/{image_id}/caption', { params: { path: { image_id: id } }, body: patch }))
    refresh(id)
    return true
  } catch (error) {
    return fail(error)
  }
}

/** Read the file's generation details again with the current parser. */
export async function reparse(id: number): Promise<boolean> {
  try {
    unwrap(await api.POST('/api/images/{image_id}/reparse', { params: { path: { image_id: id } } }))
    refresh(id)
    useToasts.getState().push(tr('card.reparsed'), 'info')
    return true
  } catch (error) {
    return fail(error)
  }
}
