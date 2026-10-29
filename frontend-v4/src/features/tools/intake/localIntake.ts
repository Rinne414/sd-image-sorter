import { ApiError } from '../../../api/client'
import { fetchLocalPicture } from '../../../api/localPicture'
import type { Inspected, MissingReason } from '../../../lib/localPicture'
import { useToasts } from '../../../ui/toasts'
import { tt, type ToolKey } from '../toolText'

// Taking the pictures a drop or paste carries, when some arrive as their file
// location (QQ and other chat apps): picture files go on at once; locations are
// read from disk first. For a paste the location wins over a pasted bitmap,
// which has lost its generation details; the file on disk has not.

/** 'files' = the files handed over; 'location' = originals read from disk. */
export type TakenHow = 'files' | 'location'

type OnPictures = (files: File[], how: TakenHow) => void

export interface TakeOptions {
  /** All of them, not just the first. */
  many?: boolean
  /** A paste: read the location even when a bitmap came along. */
  preferLocation?: boolean
}

export interface Taken {
  taken: boolean
  reason: MissingReason | null
}

const ERROR_KEYS = new Set(['local_picture_bad_path', 'local_picture_network', 'local_picture_not_picture', 'local_picture_missing', 'local_picture_unreadable'])

/** Why a location could not be read, in the UI language. */
export function localPictureError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { params?: Record<string, string> } | null
    if (error.code && ERROR_KEYS.has(error.code)) return tt(`intake.local.err.${error.code}` as ToolKey, body?.params ?? {})
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** The pictures at these locations, read from disk; the reasons for the ones that could not be read. */
export async function readLocations(paths: readonly string[]): Promise<{ files: File[]; problems: string[] }> {
  const files: File[] = []
  const problems: string[] = []
  for (const path of paths) {
    try {
      files.push(await fetchLocalPicture(path))
    } catch (error) {
      problems.push(localPictureError(error))
    }
  }
  return { files, problems: [...new Set(problems)] }
}

async function openLocations(paths: string[], fallback: File[], onPictures: OnPictures): Promise<void> {
  const toast = useToasts.getState().push
  toast(tt('intake.local.reading'))
  const { files, problems } = await readLocations(paths)
  if (files.length) {
    onPictures(files, 'location')
  } else if (fallback.length) {
    toast(tt('intake.local.fellBack', { reason: problems[0] ?? '' }))
    onPictures(fallback, 'files')
    return
  }
  for (const reason of problems) toast(tt('intake.local.readFailed', { reason }), 'error')
}

/** Take what an inspected drop or paste carries; `reason` says why nothing was taken. */
export function takePictures(found: Inspected, onPictures: OnPictures, options: TakeOptions = {}): Taken {
  const files = options.many ? found.files : found.files.slice(0, 1)
  const paths = options.many ? found.paths : found.paths.slice(0, 1)
  if (paths.length && (options.preferLocation || !files.length)) {
    void openLocations(paths, files, onPictures)
    return { taken: true, reason: null }
  }
  if (files.length) {
    onPictures(files, 'files')
    return { taken: true, reason: null }
  }
  return { taken: false, reason: found.reason }
}

/** What was missing and what to do, in plain words. */
export function missingText(reason: MissingReason, clipboard: boolean): string {
  if (reason === 'web-only') return tt('intake.local.webOnly')
  if (reason === 'not-picture') return tt('intake.local.notPicture')
  return tt(clipboard ? 'intake.noImageInClipboard' : 'intake.local.nothingDropped')
}

export function tellMissing(reason: MissingReason, clipboard: boolean): void {
  useToasts.getState().push(missingText(reason, clipboard), 'error')
}
