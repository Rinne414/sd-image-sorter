import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
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
import { libraryKey } from './datasetItems'
import { applyOrder } from './orderLogic'

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

export function refreshLists(): void {
  void queryClient.invalidateQueries({ queryKey: ['batches'] })
  void queryClient.invalidateQueries({ queryKey: ['dataset-projects-unlinked'] })
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
    if (error instanceof ApiError && error.code === 'dataset_project_name_conflict') {
      toast(tr('dataset.nameTaken', { name: name.trim() }), 'error')
      return null
    }
    return fail(error)
  }
}

/**
 * A copy of a dataset batch under a new name ("Save as…"): the same images,
 * order, settings and captions, as a new batch the original never shares with.
 */
export async function copyBatch(batchId: number, name: string): Promise<Batch | null> {
  try {
    const res = unwrap<{ batch: Batch }>(
      await api.POST('/api/batches/{batch_id}/copy', { params: { path: { batch_id: batchId } }, body: { name: name.trim() } }),
    )
    return store(res.batch)
  } catch (error) {
    const code = error instanceof ApiError ? error.code : null
    if (code === 'dataset_project_name_conflict') toast(tr('dataset.nameTaken', { name: name.trim() }), 'error')
    else if (code === 'dataset_batch_copy_source_changed') toast(tr('batch.copy.changed'), 'error')
    else return fail(error)
    return null
  }
}

export interface AddResult {
  batch: Batch
  added: number
  skipped: number
}

/** Append images; runs in the batch's queue, after any change to it that is still on its way. */
export function addToBatch(batchId: number, imageIds: number[]): Promise<AddResult | null> {
  return enqueue(batchId, async () => {
    try {
      const res = unwrap<{ batch: Batch; added_image_ids: number[]; skipped_image_ids: number[] }>(
        await api.POST('/api/batches/{batch_id}/items', { params: { path: { batch_id: batchId } }, body: { image_ids: imageIds } }),
      )
      return { batch: store(res.batch), added: res.added_image_ids.length, skipped: res.skipped_image_ids.length }
    } catch (error) {
      return fail(error)
    }
  })
}

// Changes to one batch run one after another: batch patches (each with the
// revision the previous one produced, so fast step clicks and Alt+arrows never
// conflict), taking items out and putting them back. No two of them can race
// each other's answer into the cache.
const queues = new Map<number, { chain: Promise<unknown>; waiting: number }>()

export function enqueue<T>(id: number, task: () => Promise<T>): Promise<T> {
  const slot = queues.get(id) ?? { chain: Promise.resolve(), waiting: 0 }
  slot.waiting += 1
  queues.set(id, slot)
  const result = slot.chain.then(task)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  slot.chain = settled.finally(() => {
    slot.waiting -= 1
    if (slot.waiting === 0) queues.delete(id)
  })
  return result
}

/** Images on their way out of a batch ("batchId:entry key"): asking again for one of them does nothing. */
export const useRemoving = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set<string>() }))
export const removingKey = (batchId: number, entryKey: string) => `${batchId}:${entryKey}`

export function markRemoving(keys: string[], on: boolean): void {
  const next = new Set(useRemoving.getState().keys)
  for (const key of keys) {
    if (on) next.add(key)
    else next.delete(key)
  }
  useRemoving.setState({ keys: next })
}

/**
 * Take items out of a batch (never out of the library); the toast can undo it.
 * An image already on its way out is skipped, so a repeated key or a double
 * click removes it once and offers one undo.
 */
export async function removeFromBatch(batch: Batch, imageIds: number[]): Promise<boolean> {
  const busy = useRemoving.getState().keys
  const ids = [...new Set(imageIds)].filter((id) => !busy.has(removingKey(batch.id, libraryKey(id))))
  if (ids.length === 0) return false
  const keys = ids.map((id) => removingKey(batch.id, libraryKey(id)))
  markRemoving(keys, true)
  try {
    return await enqueue(batch.id, () => takeOut(batch, ids))
  } finally {
    markRemoving(keys, false)
  }
}

async function takeOut(fallback: Batch, imageIds: number[]): Promise<boolean> {
  // The order right before this removal (after earlier queued changes) is what undo restores.
  const batch = queryClient.getQueryData<Batch>(batchKey(libraryId(), fallback.id)) ?? fallback
  const before = batch.items.map((item) => item.image_id)
  let gone: Set<number>
  try {
    const res = unwrap<{ batch: Batch; removed_image_ids: number[] }>(
      await api.DELETE('/api/batches/{batch_id}/items', { params: { path: { batch_id: batch.id } }, body: { image_ids: imageIds } }),
    )
    store(res.batch)
    gone = new Set(res.removed_image_ids)
  } catch (error) {
    return fail(error) ?? false
  }
  const removed = batch.items.filter((item) => gone.has(item.image_id))
  const first = removed[0]
  if (!first) return false
  const lostCensor = removed.some((item) => item.has_censored)
  const text = removed.length === 1 ? tr('batch.removedOne', { name: first.filename }) : tr('batch.removedMany', { n: removed.length })
  toast(lostCensor ? `${text} ${tr('batch.removedCensorLost')}` : text, 'info', {
    label: tr('toast.undo'),
    run: () => void enqueue(batch.id, () => putBack(batch.id, before, removed)),
  })
  return true
}

/** Put removed items back where they were, then their names and step state; the batch is read once at the end. */
async function putBack(batchId: number, before: number[], removed: BatchItem[]): Promise<void> {
  const path = { batch_id: batchId }
  let batch: Batch
  try {
    const ids = removed.map((item) => item.image_id)
    const added = unwrap<{ batch: Batch }>(await api.POST('/api/batches/{batch_id}/items', { params: { path }, body: { image_ids: ids } }))
    const order = restoreOrder(before, added.batch.items.map((item) => item.image_id))
    batch = unwrap<Batch>(await api.PUT('/api/batches/{batch_id}/items/order', { params: { path }, body: { image_ids: order } }))
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: batchKey(libraryId(), batchId) })
    fail(error)
    return
  }
  const withState = removed.filter((item) => item.output_name !== null || item.item_state !== null)
  const lost = await restoreItemState(batchId, withState)
  if (withState.length > 0) {
    try {
      batch = unwrap<Batch>(await api.GET('/api/batches/{batch_id}', { params: { path } }))
    } catch {
      void queryClient.invalidateQueries({ queryKey: batchKey(libraryId(), batchId) })
    }
  }
  store(batch)
  if (lost.length > 0) {
    const names = lost.map((name) => tr('batch.undoLostName', { name })).join(tr('batch.listSep'))
    toast(tr('batch.undoLost', { names }), 'error')
  }
}

/** Give put-back items their export name and step state again; returns the file names that did not get them. */
async function restoreItemState(batchId: number, items: BatchItem[]): Promise<string[]> {
  const lost: string[] = []
  for (const item of items) {
    try {
      unwrap(
        await api.PATCH('/api/batches/{batch_id}/items/{image_id}', {
          params: { path: { batch_id: batchId, image_id: item.image_id } },
          body: { output_name: item.output_name, item_state: item.item_state },
        }),
      )
    } catch {
      lost.push(item.filename)
    }
  }
  return lost
}

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
  return enqueue(id, () => sendPatch(id, changes, fallbackRevision))
}

/**
 * Delete a batch. A dataset batch takes its project with it: `projectRevision`
 * (what the user confirmed against) stops the delete when V3.5 changed the
 * project meanwhile.
 */
export async function deleteBatch(batch: { id: number; name: string }, projectRevision: number | null = null): Promise<boolean> {
  try {
    const query = projectRevision === null ? {} : { expected_project_revision: projectRevision }
    unwrap(await api.DELETE('/api/batches/{batch_id}', { params: { path: { batch_id: batch.id }, query } }))
  } catch (error) {
    if (error instanceof ApiError && error.code === 'dataset_project_revision_conflict') {
      refreshLists()
      void queryClient.invalidateQueries({ queryKey: ['batch-project'] })
      toast(tr('dataset.deleteConflict', { name: batch.name }), 'error')
      return false
    }
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

/** More changes to this batch are waiting behind the one running now. */
const moreQueued = (id: number) => (queues.get(id)?.waiting ?? 1) > 1

/**
 * Put the batch's items in this order: the screen follows at once, the save
 * runs in the batch's queue and sends the newest order on screen (so fast
 * Alt+arrow presses end as one consistent order).
 */
export function reorderBatch(batchId: number, imageIds: readonly number[]): Promise<boolean> {
  const key = batchKey(libraryId(), batchId)
  queryClient.setQueryData<Batch>(key, (b) => (b ? { ...b, items: applyOrder(b.items, imageIds) } : b))
  return enqueue(batchId, async () => {
    const order = queryClient.getQueryData<Batch>(key)?.items.map((item) => item.image_id) ?? [...imageIds]
    try {
      const next = unwrap<Batch>(await api.PUT('/api/batches/{batch_id}/items/order', { params: { path: { batch_id: batchId } }, body: { image_ids: order } }))
      if (!moreQueued(batchId)) store(next)
      return true
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: key })
      return fail(error) ?? false
    }
  })
}

/** Give one image its own export name (null: back to the naming template). */
export function setOutputName(batchId: number, imageId: number, name: string | null): Promise<boolean> {
  const key = batchKey(libraryId(), batchId)
  // Only this field is written into the cache: a censored copy saved meanwhile keeps its own answer.
  const put = (value: string | null) =>
    queryClient.setQueryData<Batch>(key, (b) =>
      b ? { ...b, items: b.items.map((item) => (item.image_id === imageId ? { ...item, output_name: value } : item)) } : b,
    )
  put(name)
  return enqueue(batchId, async () => {
    try {
      const item = unwrap<BatchItem>(
        await api.PATCH('/api/batches/{batch_id}/items/{image_id}', {
          params: { path: { batch_id: batchId, image_id: imageId } },
          body: { output_name: name },
        }),
      )
      put(item.output_name)
      return true
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: key })
      return fail(error) ?? false
    }
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
