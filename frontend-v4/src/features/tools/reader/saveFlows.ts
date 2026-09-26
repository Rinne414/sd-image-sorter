import { ApiError } from '../../../api/client'
import type { Params } from '../../../i18n'
import { useToasts } from '../../../ui/toasts'
import { tr } from '../../jobs/jobs'
import { tt, type ToolKey } from '../toolText'
import { splitPath, warningMessage, type SaveFormat } from './metadataForm'
import { refreshLibrary, refreshLibraryImage, reparseImage, saveEdited, type SaveEditedResult, type SaveRequest } from './saveEdited'

// The two saves the Reader offers, with what the user is told afterwards:
// a new image, or (a library image) its own file, undoable once by writing
// the old values back in the same format.

export type SaveMessage = { key: ToolKey; params: Params } | { text: string }

export interface Saved {
  path: string
  messages: SaveMessage[]
  overwrote: boolean
}

export interface LibraryFile {
  id: number
  path: string
  format: SaveFormat
}

/** The warnings in the user's words; a backend without codes keeps its English sentences. */
function messagesOf(res: SaveEditedResult): SaveMessage[] {
  const codes = res.warning_codes ?? []
  if (codes.length !== res.warnings.length) return res.warnings.map((text) => ({ text }))
  return codes.map((code, i) => warningMessage(code, res.warnings[i]))
}

export function saveFailed(error: unknown): null {
  const reason = error instanceof Error ? error.message : String(error)
  useToasts.getState().push(tt('reader.edit.failed', { reason }), 'error')
  return null
}

const noteCount = (messages: SaveMessage[]) => (messages.length ? tt('reader.edit.seeNotes', { n: messages.length }) : '')

/** Save a new image; 'exists' when a file of that name is already there and the user has not said to replace it. */
export async function saveCopy(r: SaveRequest): Promise<Saved | 'exists' | null> {
  try {
    const res = await saveEdited(r)
    refreshLibrary()
    const messages = messagesOf(res)
    useToasts.getState().push(tt('reader.edit.savedAs', { name: splitPath(res.output_path).name }) + noteCount(messages), 'info')
    return { path: res.output_path, messages, overwrote: false }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && !r.overwrite) return 'exists'
    return saveFailed(error)
  }
}

/** The backend re-reads a library file it wrote; when that failed, ask once more, then refresh what shows it. */
async function afterLibraryWrite(id: number, res: SaveEditedResult): Promise<void> {
  if (res.warning_codes?.some((w) => w.code === 'library_refresh_failed')) {
    try {
      await reparseImage(id)
    } catch {
      // the saved warning already says the library entry may be stale
    }
  }
  refreshLibraryImage(id)
}

async function writeBack(file: LibraryFile, metadata: Record<string, string | number>): Promise<SaveEditedResult> {
  return saveEdited({ sourcePath: file.path, outputPath: file.path, format: file.format, metadata, overwrite: true })
}

async function undoOverwrite(file: LibraryFile, before: Record<string, string | number>): Promise<void> {
  try {
    await afterLibraryWrite(file.id, await writeBack(file, before))
    useToasts.getState().push(tt('reader.edit.undone'), 'info')
  } catch (error) {
    saveFailed(error)
  }
}

/** Write the edited details into the library image's own file (the user confirmed); one undo writes the old ones back. */
export async function overwriteOriginal(file: LibraryFile, edited: Record<string, string | number>, before: Record<string, string | number>): Promise<Saved | null> {
  try {
    const res = await writeBack(file, edited)
    await afterLibraryWrite(file.id, res)
    const messages = messagesOf(res)
    useToasts.getState().push(tt('reader.edit.overwritten') + noteCount(messages), 'info', { label: tr('toast.undo'), run: () => void undoOverwrite(file, before) })
    return { path: res.output_path, messages, overwrote: true }
  } catch (error) {
    return saveFailed(error)
  }
}
