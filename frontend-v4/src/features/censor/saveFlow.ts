import type { Op } from './ops'
import { editOf, forgetEdit, isDirty, keyOf, patchEdit, type ImageEdit } from './session'

// What saving does to one image's edit, apart from the network so it can be
// tested. The image counts as saved only after `write` succeeded (the copy
// and its ops travel in one request); a failure keeps it unsaved with the
// reason, and the next leave tries again (unless the failure was final: too
// large or refused, which only an explicit retry tries again); a save asked for while one runs
// runs once more afterwards with the newest ops, and whoever asked for it
// gets the outcome of that later save.

/** The item or its batch no longer exists: there is nothing left to save to. */
export class ItemGoneError extends Error {}

/** A save failure with a message for the user; `final`: trying again the same way cannot help (too large, refused). */
export class SaveFailedError extends Error {
  readonly final: boolean
  constructor(message: string, final: boolean) {
    super(message)
    this.final = final
  }
}

/**
 * Make the server hold exactly these ops and review mark: the copy and the
 * state together, or (no ops) no copy and the state.
 */
export type WriteOps = (ops: Op[], reviewed: boolean | null) => Promise<void>

export interface SaveOptions {
  /** Write even when nothing changed (e.g. to drop a copy that has no ops). */
  force?: boolean
  /** The reason shown when a failure carries no message. */
  unknownReason: string
}

/** The save running per image (`batch:image`), including the retry it will run when asked again meanwhile. */
const inFlight = new Map<string, Promise<boolean>>()

/**
 * Returns true when the server now matches the edit. Asked while a save of
 * the image runs: marks it to run again and resolves when that retry settled.
 */
export function runSave(batchId: number, imageId: number, write: WriteOps, options: SaveOptions): Promise<boolean> {
  const edit = editOf(batchId, imageId)
  if (!edit || (!options.force && !isDirty(edit))) return Promise.resolve(true)
  const key = keyOf(batchId, imageId)
  if (edit.saving) {
    patchEdit(batchId, imageId, { again: true })
    return inFlight.get(key) ?? Promise.resolve(false)
  }
  const done = saveOnce(batchId, imageId, edit, write, options).finally(() => {
    if (inFlight.get(key) === done) inFlight.delete(key)
  })
  inFlight.set(key, done)
  return done
}

async function saveOnce(batchId: number, imageId: number, edit: ImageEdit, write: WriteOps, options: SaveOptions): Promise<boolean> {
  const { ops, reviewed } = edit
  patchEdit(batchId, imageId, { saving: true, again: false })
  let ok = false
  try {
    await write(ops, reviewed)
    patchEdit(batchId, imageId, { saved: ops, savedReviewed: reviewed, error: null, blocked: false })
    ok = true
  } catch (error) {
    if (error instanceof ItemGoneError) {
      forgetEdit(batchId, imageId)
      return false
    }
    const blocked = error instanceof SaveFailedError && error.final
    patchEdit(batchId, imageId, { error: (error as Error).message || options.unknownReason, blocked })
  } finally {
    patchEdit(batchId, imageId, { saving: false })
  }
  const after = editOf(batchId, imageId)
  if (after?.again && isDirty(after)) return runSave(batchId, imageId, write, { unknownReason: options.unknownReason })
  return ok && !(after && isDirty(after))
}

export type SaveOutcome = { ok: true } | { ok: false; reason: string | null }

/**
 * What a finished save means for work that saved on its own (detect all):
 * false with no error means newer edits came in and are saved later, which
 * is fine; an error or a forgotten item (gone from the batch) is a failure.
 */
export function saveOutcome(saved: boolean, edit: ImageEdit | undefined): SaveOutcome {
  if (!edit) return { ok: false, reason: null }
  if (saved || !edit.error) return { ok: true }
  return { ok: false, reason: edit.error }
}
