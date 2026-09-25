import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import type { components } from '../../api/schema'
import type {
  Batch,
  BatchItem,
  BatchKind,
  BatchStep,
  BatchSummary,
  BatchTemplate,
  BatchTemplatesResponse,
  CollectionRow,
} from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { restoreOrder } from './batchLogic'

// Batches of the current library: reads are TanStack queries keyed by the
// library; writes are plain async functions (menus, dialogs and keys call
// them) that keep the cache in step and say what went wrong.

type PatchChanges = Omit<components['schemas']['BatchPatchRequest'], 'revision'>

const libraryId = () => useApp.getState().libraryId
export const batchKey = (library: string, id: number) => ['batch', library, id] as const

export function useBatches(includeArchived = false) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['batches', library, includeArchived],
    queryFn: async ({ signal }) =>
      unwrap<{ batches: BatchSummary[] }>(
        await api.GET('/api/batches', { params: { query: { include_archived: includeArchived } }, signal }),
      ).batches,
    staleTime: 15_000,
  })
}

export function useBatch(id: number | null) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: batchKey(library, id ?? 0),
    enabled: id !== null,
    queryFn: async ({ signal }) =>
      unwrap<Batch>(await api.GET('/api/batches/{batch_id}', { params: { path: { batch_id: id as number } }, signal })),
    staleTime: 15_000,
  })
}

export function useBatchTemplates() {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['batch-templates', library],
    queryFn: async ({ signal }) => unwrap<BatchTemplatesResponse>(await api.GET('/api/batches/templates', { signal })),
    staleTime: 60_000,
  })
}

/** V3.5 collections of this library (they open as custom batches). */
export function useCollections() {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['collections', library],
    queryFn: async ({ signal }) =>
      unwrap<{ collections: CollectionRow[] }>(await api.GET('/api/collections', { signal })).collections,
    staleTime: 30_000,
  })
}

function toast(text: string, tone: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
  useToasts.getState().push(text, tone, action)
}

function fail(error: unknown): null {
  toast(tr('error.generic', { reason: (error as Error).message }), 'error')
  return null
}

function refreshLists(): void {
  void queryClient.invalidateQueries({ queryKey: ['batches'] })
}

function store(batch: Batch): Batch {
  queryClient.setQueryData(batchKey(libraryId(), batch.id), batch)
  refreshLists()
  return batch
}

export interface CreateInput {
  kind: BatchKind
  name: string
  templateId?: number | null
  imageIds?: number[]
}

export async function createBatch({ kind, name, templateId = null, imageIds = [] }: CreateInput): Promise<Batch | null> {
  try {
    const res = unwrap<{ batch: Batch }>(
      await api.POST('/api/batches', { body: { kind, name: name.trim(), template_id: templateId, image_ids: imageIds } }),
    )
    return store(res.batch)
  } catch (error) {
    return fail(error)
  }
}

export interface AddResult {
  batch: Batch
  added: number
  skipped: number
}

export async function addToBatch(batchId: number, imageIds: number[]): Promise<AddResult | null> {
  try {
    const res = unwrap<{ batch: Batch; added_image_ids: number[]; skipped_image_ids: number[] }>(
      await api.POST('/api/batches/{batch_id}/items', { params: { path: { batch_id: batchId } }, body: { image_ids: imageIds } }),
    )
    return { batch: store(res.batch), added: res.added_image_ids.length, skipped: res.skipped_image_ids.length }
  } catch (error) {
    return fail(error)
  }
}

/** Put removed items back where they were, with their names and step state. */
async function undoRemove(batchId: number, before: number[], removed: BatchItem[]): Promise<void> {
  const path = { batch_id: batchId }
  try {
    const ids = removed.map((item) => item.image_id)
    const added = unwrap<{ batch: Batch }>(await api.POST('/api/batches/{batch_id}/items', { params: { path }, body: { image_ids: ids } }))
    const order = restoreOrder(before, added.batch.items.map((item) => item.image_id))
    let batch = unwrap<Batch>(await api.PUT('/api/batches/{batch_id}/items/order', { params: { path }, body: { image_ids: order } }))
    for (const item of removed.filter((i) => i.output_name !== null || i.item_state !== null)) {
      unwrap(
        await api.PATCH('/api/batches/{batch_id}/items/{image_id}', {
          params: { path: { batch_id: batchId, image_id: item.image_id } },
          body: { output_name: item.output_name, item_state: item.item_state },
        }),
      )
      batch = unwrap<Batch>(await api.GET('/api/batches/{batch_id}', { params: { path } }))
    }
    store(batch)
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: batchKey(libraryId(), batchId) })
    fail(error)
  }
}

/** Take items out of a batch (never out of the library); the toast can undo it. */
export async function removeFromBatch(batch: Batch, imageIds: number[]): Promise<boolean> {
  const gone = new Set(imageIds)
  const removed = batch.items.filter((item) => gone.has(item.image_id))
  if (removed.length === 0) return false
  const before = batch.items.map((item) => item.image_id)
  try {
    const res = unwrap<{ batch: Batch }>(
      await api.DELETE('/api/batches/{batch_id}/items', { params: { path: { batch_id: batch.id } }, body: { image_ids: imageIds } }),
    )
    store(res.batch)
  } catch (error) {
    return fail(error) ?? false
  }
  const first = removed[0] as BatchItem
  const lostCensor = removed.some((item) => item.has_censored)
  const text =
    removed.length === 1 ? tr('batch.removedOne', { name: first.filename }) : tr('batch.removedMany', { n: removed.length })
  toast(lostCensor ? `${text} ${tr('batch.removedCensorLost')}` : text, 'info', {
    label: tr('toast.undo'),
    run: () => void undoRemove(batch.id, before, removed),
  })
  return true
}

// Changes to one batch run one after another, each with the revision the
// previous one produced, so fast edits (step clicks, Alt+arrows) never
// conflict with each other. The cache shows every change at once.
const queues = new Map<number, { chain: Promise<unknown>; waiting: number }>()

function applyLocally(batch: Batch, changes: PatchChanges): Batch {
  const next = { ...batch }
  if (changes.name) next.name = changes.name
  if (changes.steps) next.steps = changes.steps as BatchStep[]
  if (changes.settings) next.settings = changes.settings
  if (changes.current_step !== undefined) next.current_step = changes.current_step
  return next
}

async function sendPatch(id: number, changes: PatchChanges, fallbackRevision: number | null): Promise<Batch | null> {
  const key = batchKey(libraryId(), id)
  const slot = queues.get(id)
  // Revisions only grow: the higher of the cached batch and the list row is the freshest known.
  const known = [queryClient.getQueryData<Batch>(key)?.revision, fallbackRevision].filter((r): r is number => typeof r === 'number')
  const revision = known.length ? Math.max(...known) : null
  try {
    if (revision === null) throw new Error(tr('batch.notLoaded'))
    const next = unwrap<Batch>(await api.PATCH('/api/batches/{batch_id}', { params: { path: { batch_id: id } }, body: { ...changes, revision } }))
    // More edits are queued: keep their local state, take only the new revision.
    const later = (slot?.waiting ?? 1) > 1
    queryClient.setQueryData<Batch>(key, (b) => (later && b ? { ...b, revision: next.revision, updated_at: next.updated_at } : next))
    refreshLists()
    return next
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: key })
    refreshLists()
    if (error instanceof ApiError && error.code === 'batch_revision_conflict') toast(tr('batch.conflict'), 'error')
    else fail(error)
    return null
  }
}

/** Change a batch's name, steps, settings, current step or archive state. */
export function patchBatch(id: number, changes: PatchChanges, fallbackRevision: number | null = null): Promise<Batch | null> {
  queryClient.setQueryData<Batch>(batchKey(libraryId(), id), (b) => (b ? applyLocally(b, changes) : b))
  const slot = queues.get(id) ?? { chain: Promise.resolve(), waiting: 0 }
  slot.waiting += 1
  queues.set(id, slot)
  const result = slot.chain.then(() => sendPatch(id, changes, fallbackRevision))
  slot.chain = result.finally(() => {
    slot.waiting -= 1
    if (slot.waiting === 0) queues.delete(id)
  })
  return result
}

export async function deleteBatch(batch: { id: number; name: string }): Promise<boolean> {
  try {
    unwrap(await api.DELETE('/api/batches/{batch_id}', { params: { path: { batch_id: batch.id } } }))
  } catch (error) {
    return fail(error) ?? false
  }
  queryClient.removeQueries({ queryKey: batchKey(libraryId(), batch.id) })
  refreshLists()
  const s = useApp.getState()
  if (s.batchId === batch.id) s.setPage('batch')
  if (s.adding && 'batchId' in s.adding && s.adding.batchId === batch.id) s.setAdding(null)
  toast(tr('batch.deleted', { name: batch.name }))
  return true
}

export async function saveTemplate(kind: BatchKind, name: string, steps: BatchStep[], settings: Record<string, unknown>): Promise<BatchTemplate | null> {
  try {
    const template = unwrap<BatchTemplate>(await api.POST('/api/batches/templates', { body: { kind, name: name.trim(), steps, settings } }))
    void queryClient.invalidateQueries({ queryKey: ['batch-templates'] })
    toast(tr('batch.templateSaved', { name: template.name }))
    return template
  } catch (error) {
    return fail(error)
  }
}

/** Delete one of my templates; the toast can bring it back (as a new template). */
export async function deleteTemplate(template: BatchTemplate): Promise<void> {
  try {
    unwrap(await api.DELETE('/api/batches/templates/{template_id}', { params: { path: { template_id: template.id } } }))
  } catch (error) {
    fail(error)
    return
  }
  void queryClient.invalidateQueries({ queryKey: ['batch-templates'] })
  toast(tr('batch.templateDeleted', { name: template.name }), 'info', {
    label: tr('toast.undo'),
    run: () => void saveTemplate(template.kind, template.name, template.steps, template.settings),
  })
}

function missingIds(error: unknown): number[] {
  if (!(error instanceof ApiError) || error.code !== 'batch_images_not_found') return []
  const ids = (error.body as { image_ids?: unknown } | null)?.image_ids
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []
}

async function createFromIds(name: string, ids: number[]): Promise<{ batch: Batch; left: number } | null> {
  try {
    const res = unwrap<{ batch: Batch }>(await api.POST('/api/batches', { body: { kind: 'custom', name, image_ids: ids } }))
    return { batch: res.batch, left: 0 }
  } catch (error) {
    // Images of the collection that live in another library stay out.
    const missing = new Set(missingIds(error))
    if (missing.size === 0) return fail(error)
    const rest = ids.filter((id) => !missing.has(id))
    const again = await createFromIds(name, rest)
    return again && { batch: again.batch, left: missing.size }
  }
}

/** A V3.5 collection becomes a custom batch in the collection's order; the collection stays as it is. */
export async function batchFromCollection(collection: CollectionRow, name: string): Promise<Batch | null> {
  try {
    const ids = unwrap<{ image_ids: number[] }>(
      await api.GET('/api/collections/{collection_id}/images', { params: { path: { collection_id: collection.id } } }),
    ).image_ids
    const made = await createFromIds(name, ids)
    if (!made) return null
    const batch = store(made.batch)
    const withSource = await patchBatch(batch.id, { settings: { ...batch.settings, source_collection_id: collection.id } })
    if (made.left > 0) toast(tr('batch.collectionPartial', { n: made.left }))
    return withSource ?? batch
  } catch (error) {
    return fail(error)
  }
}
