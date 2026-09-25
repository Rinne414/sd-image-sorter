import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import type { Library } from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'

// Libraries are views over one database: each image belongs to one library.
// Deleting a library drops its image records, collections and dataset
// projects; files on disk are never touched.

/** The backend takes at most this many ids per move; bigger selections go in several requests. */
const MOVE_BATCH = 5000

const EVERYTHING = ['libraries', 'images', 'image', 'generators', 'folders', 'favorites', 'library-health', 'missing-summary', 'missing-groups', 'colors-missing', 'image-count']

function refresh(): void {
  for (const key of EVERYTHING) void queryClient.invalidateQueries({ queryKey: [key] })
}

function fail(error: unknown): null {
  useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  return null
}

export async function createLibrary(name: string): Promise<Library | null> {
  try {
    const res = unwrap<{ library: Library }>(await api.POST('/api/libraries', { body: { name: name.trim() } }))
    refresh()
    return res.library
  } catch (error) {
    return fail(error)
  }
}

export async function renameLibrary(id: string, name: string): Promise<boolean> {
  try {
    unwrap(await api.PATCH('/api/libraries/{library_id}', { params: { path: { library_id: id } }, body: { name: name.trim() } }))
    refresh()
    return true
  } catch (error) {
    return fail(error) ?? false
  }
}

export async function deleteLibrary(id: string): Promise<boolean> {
  try {
    const res = unwrap<{ removed_images?: number; name?: string }>(
      await api.DELETE('/api/libraries/{library_id}', { params: { path: { library_id: id } } }),
    )
    if (useApp.getState().libraryId === id) useApp.getState().setLibrary('main')
    refresh()
    useToasts.getState().push(tr('libraries.deleted', { name: res.name ?? id, n: res.removed_images ?? 0 }), 'info')
    return true
  } catch (error) {
    return fail(error) ?? false
  }
}

/** Move images into another library, in as many requests as it takes. */
export async function moveToLibrary(ids: number[], target: string): Promise<number | null> {
  let moved = 0
  // Each batch that went through leaves the picks at once, so a later failure
  // cannot leave images of another library in this library's selection.
  const leave = (batch: number[]) => {
    const s = useApp.getState()
    const gone = new Set(batch)
    s.setSelection(s.selection.filter((id) => !gone.has(id)))
    if (s.inspectedId !== null && gone.has(s.inspectedId)) s.inspect(null)
  }
  try {
    for (let start = 0; start < ids.length; start += MOVE_BATCH) {
      const batch = ids.slice(start, start + MOVE_BATCH)
      const res = unwrap<{ moved?: number }>(
        await api.POST('/api/libraries/move-images', { body: { image_ids: batch, target_library_id: target } }),
      )
      moved += res.moved ?? 0
      leave(batch)
    }
    refresh()
    return moved
  } catch (error) {
    refresh()
    if (moved > 0) {
      useToasts.getState().push(tr('libraries.movePartial', { n: moved, reason: (error as Error).message }), 'error')
      return null
    }
    return fail(error)
  }
}

export const exportUrl = (id: string) => `/api/libraries/${encodeURIComponent(id)}/export`
