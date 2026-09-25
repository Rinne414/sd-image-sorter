import { api, ApiError, imageFileUrl, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import type { Batch, BatchItem } from '../../api/types'
import { useApp } from '../../state/store'
import { tr } from '../jobs/jobs'
import { batchKey } from '../batch/batchApi'
import { withCensorState, type Op, type SavedCensorState } from './ops'
import { renderOps } from './paint'
import { createRaster, type Raster } from './raster'
import { ItemGoneError, runSave } from './saveFlow'
import { libraryOf, needsCopy, unsavedIds } from './session'

// Loading originals and saving censored copies. A copy is saved from a fresh
// replay of the ops on the original (the same bytes the editor shows), sent
// together with the ops (the item's state) so reopening the batch can edit
// them again. An image counts as censored only after that request succeeded.

const ORIGINALS_KEPT = 3
const originals = new Map<number, Promise<Raster>>()

async function decode(imageId: number): Promise<Raster> {
  const res = await fetch(imageFileUrl(imageId))
  if (!res.ok) throw new Error(tr('censor.loadHttp', { status: res.status }))
  // No colour conversion: the copy keeps the file's own pixel values.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error(tr('censor.noCanvas'))
    ctx.drawImage(bitmap, 0, 0)
    return createRaster(bitmap.width, bitmap.height, ctx.getImageData(0, 0, bitmap.width, bitmap.height).data)
  } finally {
    bitmap.close()
  }
}

/** The original pixels of an image; the last few stay in memory for going back and forth. */
export function loadOriginal(imageId: number): Promise<Raster> {
  const hit = originals.get(imageId)
  originals.delete(imageId)
  const pending = hit ?? decode(imageId)
  originals.set(imageId, pending)
  pending.catch(() => originals.delete(imageId))
  while (originals.size > ORIGINALS_KEPT) originals.delete(originals.keys().next().value as number)
  return pending
}

export async function encodePng(raster: Raster): Promise<string> {
  const canvas = new OffscreenCanvas(raster.width, raster.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(tr('censor.noCanvas'))
  ctx.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error(tr('censor.noCanvas')))
    reader.readAsDataURL(blob)
  })
}

// A batch belongs to one library: its saves name that library explicitly, so
// a save still in flight after the user switched libraries lands in the right one.
export const libraryFor = (batchId: number) => libraryOf(batchId) ?? useApp.getState().libraryId
const key = (batchId: number) => batchKey(libraryFor(batchId), batchId)

function cachedItem(batchId: number, imageId: number): BatchItem | undefined {
  return queryClient.getQueryData<Batch>(key(batchId))?.items.find((item) => item.image_id === imageId)
}

/** Put the server's answer for one item into the open batch. */
function storeItem(batchId: number, item: BatchItem): void {
  queryClient.setQueryData<Batch>(key(batchId), (batch) => {
    if (!batch) return batch
    const items = batch.items.map((i) => (i.image_id === item.image_id ? item : i))
    return { ...batch, items, censored_count: items.filter((i) => i.has_censored).length }
  })
}

const itemRequest = (batchId: number, imageId: number) => ({
  params: { path: { batch_id: batchId, image_id: imageId } },
  headers: { 'X-SD-Library-Id': libraryFor(batchId) },
})

/** The item state to send: `null` rather than an empty object when nothing is left. */
function stateBody(state: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(state).length > 0 ? state : null
}

/** What item_state.censor should hold: null when there is nothing to keep. */
function censorState(item: BatchItem | undefined, ops: Op[], reviewed: boolean | null, size?: { width: number; height: number }): SavedCensorState | null {
  if (ops.length === 0 && reviewed === null) return null
  const width = size?.width ?? item?.width ?? 0
  const height = size?.height ?? item?.height ?? 0
  return { v: 1, width, height, ops, ...(reviewed === null ? {} : { reviewed }) }
}

/**
 * Make the server hold exactly `ops` and the review mark, in ONE request each
 * way: the rendered copy together with the state (PUT), or, when no copy is
 * needed (no ops and not approved), no copy and the state (DELETE with the
 * state). The server writes both or neither, so a copy never sits next to ops
 * it was not made from.
 */
async function writeCopy(batchId: number, imageId: number, ops: Op[], reviewed: boolean | null): Promise<void> {
  const item = cachedItem(batchId, imageId)
  const state = item?.item_state ?? null
  try {
    if (!needsCopy(ops, reviewed)) {
      const body = { item_state: stateBody(withCensorState(state, censorState(item, ops, reviewed))) }
      storeItem(batchId, unwrap<BatchItem>(await api.DELETE('/api/batches/{batch_id}/items/{image_id}/censored', { ...itemRequest(batchId, imageId), body })))
      return
    }
    const rendered = renderOps(await loadOriginal(imageId), ops)
    const censor = censorState(item, ops, reviewed, rendered)
    const body = { image_data: await encodePng(rendered), item_state: stateBody(withCensorState(state, censor)) }
    storeItem(batchId, unwrap<BatchItem>(await api.PUT('/api/batches/{batch_id}/items/{image_id}/censored', { ...itemRequest(batchId, imageId), body })))
  } catch (error) {
    throw gone(error) ? new ItemGoneError((error as Error).message) : error
  } finally {
    void queryClient.invalidateQueries({ queryKey: ['batches'] })
  }
}

const gone = (error: unknown) =>
  error instanceof ApiError && error.status === 404 && (error.code === 'batch_item_not_found' || error.code === 'batch_not_found')

/**
 * Save one image's edit if it changed (`force`: even when it did not, e.g. to
 * delete a copy that has no ops). Returns true when the server now matches it.
 */
export function saveImage(batchId: number, imageId: number, force = false): Promise<boolean> {
  return runSave(batchId, imageId, (ops, reviewed) => writeCopy(batchId, imageId, ops, reviewed), { force, unknownReason: tr('censor.saveUnknown') })
}

/**
 * Save every changed image of the batch: the one being left and earlier ones
 * that failed. `except` is the image being opened, which is saved when it is left.
 */
export function saveAll(batchId: number, except: number | null = null): Promise<boolean[]> {
  const ids = unsavedIds(batchId).filter((imageId) => imageId !== except)
  return Promise.all(ids.map((imageId) => saveImage(batchId, imageId)))
}
