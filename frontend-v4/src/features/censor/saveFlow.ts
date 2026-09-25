import type { Op } from './ops'
import { editOf, forgetEdit, isDirty, patchEdit } from './session'

// What saving does to one image's edit, apart from the network so it can be
// tested. The image counts as saved only after `write` succeeded (the copy
// and its ops travel in one request); a failure keeps it unsaved with the
// reason, and the next leave tries again; a save asked for while one runs
// runs once more afterwards with the newest ops.

/** The item or its batch no longer exists: there is nothing left to save to. */
export class ItemGoneError extends Error {}

/** Make the server hold exactly these ops: their copy and the ops together, or (no ops) neither. */
export type WriteOps = (ops: Op[]) => Promise<void>

export interface SaveOptions {
  /** Write even when nothing changed (e.g. to drop a copy that has no ops). */
  force?: boolean
  /** The reason shown when a failure carries no message. */
  unknownReason: string
}

/** Returns true when the server now matches the edit. */
export async function runSave(batchId: number, imageId: number, write: WriteOps, options: SaveOptions): Promise<boolean> {
  const edit = editOf(batchId, imageId)
  if (!edit || (!options.force && !isDirty(edit))) return true
  if (edit.saving) {
    patchEdit(batchId, imageId, { again: true })
    return false
  }
  const ops = edit.ops
  patchEdit(batchId, imageId, { saving: true, again: false })
  let ok = false
  try {
    await write(ops)
    patchEdit(batchId, imageId, { saved: ops, error: null })
    ok = true
  } catch (error) {
    if (error instanceof ItemGoneError) {
      forgetEdit(batchId, imageId)
      return false
    }
    patchEdit(batchId, imageId, { error: (error as Error).message || options.unknownReason })
  } finally {
    patchEdit(batchId, imageId, { saving: false })
  }
  const after = editOf(batchId, imageId)
  if (after?.again && isDirty(after)) return runSave(batchId, imageId, write, { unknownReason: options.unknownReason })
  return ok && !(after && isDirty(after))
}
