import { create } from 'zustand'
import type { Batch, BatchItem } from '../../api/types'
import { EMPTY_HISTORY, record, redo, undo, type History } from './history'
import { parseOps, type Op } from './ops'

// Censor edits of every image touched since the page loaded, per batch. Kept
// outside React so undo history survives switching images and steps, and a
// save that finishes after the editor closed still lands in the right place.

export interface ImageEdit {
  ops: Op[]
  /** The list the server's copy was made from; null when the server has no copy of these ops. */
  saved: Op[] | null
  history: History
  error: string | null
  saving: boolean
  /** A save was asked for while one was running: run another when it ends. */
  again: boolean
}

export type ItemStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'error'

export const keyOf = (batchId: number, imageId: number) => `${batchId}:${imageId}`

/** The edit an item starts with: the ops stored with it, "saved" when its copy exists (or it has none). */
export function initialEdit(item: BatchItem): ImageEdit {
  const ops = parseOps(item.item_state)
  return { ops, saved: ops.length === 0 || item.has_censored ? ops : null, history: EMPTY_HISTORY, error: null, saving: false, again: false }
}

export function isDirty(edit: ImageEdit): boolean {
  return edit.ops !== edit.saved
}

export function itemStatus(item: BatchItem, edit: ImageEdit | undefined): ItemStatus {
  const e = edit ?? initialEdit(item)
  if (e.saving) return 'saving'
  if (e.error) return 'error'
  if (isDirty(e)) return 'dirty'
  return item.has_censored ? 'saved' : 'clean'
}

/**
 * A tracked edit after the server sent the item again: a copy that went away
 * (the item was taken out and put back, or deleted elsewhere) makes saved ops
 * unsaved, so leaving the image renders the copy again.
 */
export function reconcile(edit: ImageEdit, item: BatchItem): ImageEdit {
  if (edit.saving || isDirty(edit) || edit.ops.length === 0 || item.has_censored) return edit
  return { ...edit, saved: null }
}

interface SessionState {
  edits: Record<string, ImageEdit>
  /** Which library each open batch belongs to: its saves go there even after a library switch. */
  libraries: Record<number, string>
  /** The image last open in each batch's editor. */
  lastImage: Record<number, number>
}

export const useCensorSession = create<SessionState>(() => ({ edits: {}, libraries: {}, lastImage: {} }))

export function editOf(batchId: number, imageId: number): ImageEdit | undefined {
  return useCensorSession.getState().edits[keyOf(batchId, imageId)]
}

export function useEdit(batchId: number, imageId: number | null): ImageEdit | undefined {
  return useCensorSession((s) => (imageId === null ? undefined : s.edits[keyOf(batchId, imageId)]))
}

export function libraryOf(batchId: number): string | undefined {
  return useCensorSession.getState().libraries[batchId]
}

/** Track the batch's items: start the new ones, reconcile the known ones with what the server says. */
export function syncItems(batch: Batch): void {
  const s = useCensorSession.getState()
  let changed = s.libraries[batch.id] !== batch.library_id
  const edits = { ...s.edits }
  for (const item of batch.items) {
    const key = keyOf(batch.id, item.image_id)
    const known = edits[key]
    const next = known ? reconcile(known, item) : initialEdit(item)
    if (next !== known) {
      edits[key] = next
      changed = true
    }
  }
  if (changed) useCensorSession.setState({ edits, libraries: { ...s.libraries, [batch.id]: batch.library_id } })
}

export function rememberImage(batchId: number, imageId: number): void {
  useCensorSession.setState((s) => ({ lastImage: { ...s.lastImage, [batchId]: imageId } }))
}

/** Where the editor opens: the image left last time, else the first one without a censored copy. */
export function startImage(batch: Batch): number | null {
  const last = useCensorSession.getState().lastImage[batch.id]
  if (last !== undefined && batch.items.some((item) => item.image_id === last)) return last
  const first = batch.items.find((item) => !item.has_censored) ?? batch.items[0]
  return first?.image_id ?? null
}

export function patchEdit(batchId: number, imageId: number, changes: Partial<ImageEdit>): void {
  const key = keyOf(batchId, imageId)
  useCensorSession.setState((s) => {
    const edit = s.edits[key]
    return edit ? { edits: { ...s.edits, [key]: { ...edit, ...changes } } } : s
  })
}

export function forgetEdit(batchId: number, imageId: number): void {
  useCensorSession.setState((s) => {
    const edits = { ...s.edits }
    delete edits[keyOf(batchId, imageId)]
    return { edits }
  })
}

/** A new op list for the image (a stroke, a reset): one undo step. */
export function changeOps(batchId: number, item: BatchItem, ops: Op[]): void {
  const key = keyOf(batchId, item.image_id)
  useCensorSession.setState((s) => {
    const edit = s.edits[key] ?? initialEdit(item)
    return { edits: { ...s.edits, [key]: { ...edit, ops, history: record(edit.history, edit.ops) } } }
  })
}

function step(batchId: number, imageId: number, move: typeof undo): boolean {
  const key = keyOf(batchId, imageId)
  const edit = useCensorSession.getState().edits[key]
  const moved = edit && move(edit.history, edit.ops)
  if (!edit || !moved) return false
  useCensorSession.setState((s) => ({ edits: { ...s.edits, [key]: { ...edit, ops: moved.ops, history: moved.history } } }))
  return true
}

export const undoEdit = (batchId: number, imageId: number) => step(batchId, imageId, undo)
export const redoEdit = (batchId: number, imageId: number) => step(batchId, imageId, redo)

/** Image ids of the batch whose edits are not on the server yet. */
export function unsavedIds(batchId: number): number[] {
  const prefix = `${batchId}:`
  return Object.entries(useCensorSession.getState().edits)
    .filter(([key, edit]) => key.startsWith(prefix) && isDirty(edit))
    .map(([key]) => Number(key.slice(prefix.length)))
}

export function anyUnsaved(): boolean {
  return Object.values(useCensorSession.getState().edits).some((edit) => edit.saving || isDirty(edit))
}

// Closing or reloading the tab while an edit is not saved asks first.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!anyUnsaved()) return
    e.preventDefault()
    e.returnValue = ''
  })
}
