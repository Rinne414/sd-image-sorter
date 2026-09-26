import { ApiError } from '../../../api/client'
import { useApp } from '../../../state/store'
import type { ParseResult } from '../reader/readerAdapter'

// One image into a tool: dropped anywhere on its page, chosen with the file
// picker, or pasted. The file is read by POST /api/parse-image, which also
// keeps a copy for 24 hours (`source_temp_path`) that saving and tagging use.

/** How an image came in; a pasted one has usually lost its generation details. */
export type IntakeOrigin = 'drop' | 'pick' | 'paste'

const IMAGE_NAME = /\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i

export const isImageFile = (f: File): boolean => f.type.startsWith('image/') || IMAGE_NAME.test(f.name)

/** The first image among these files (a drop or the picker can hand over several). */
export function firstImage(files: Iterable<File> | ArrayLike<File> | null | undefined): File | null {
  if (!files) return null
  for (const f of Array.from(files)) if (isImageFile(f)) return f
  return null
}

/** The image a paste carries, named so the Reader can say where it came from. */
export function pastedImage(data: DataTransfer | null): File | null {
  if (!data) return null
  const file = firstImage(data.files) ?? firstImage([...data.items].flatMap((i) => (i.kind === 'file' ? [i.getAsFile()] : [])).filter((f): f is File => !!f))
  if (!file) return null
  return file.name ? file : new File([file], 'clipboard.png', { type: file.type || 'image/png' })
}

/** The clipboard's image, read by the Paste button (the browser may ask first); null when it holds none. */
export async function readClipboardImage(): Promise<File | null> {
  const items = await navigator.clipboard.read()
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    return new File([blob], `clipboard.${type.split('/')[1] || 'png'}`, { type })
  }
  return null
}

/** Read an image's generation details without adding it to the library. */
export async function parseUpload(file: File, signal?: AbortSignal): Promise<ParseResult> {
  const form = new FormData()
  form.append('file', file, file.name || 'image.png')
  const res = await fetch('/api/parse-image', {
    method: 'POST',
    headers: { 'X-SD-Library-Id': useApp.getState().libraryId },
    body: form,
    signal,
  })
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null
  if (!res.ok) {
    const reason = typeof body?.detail === 'string' ? body.detail : res.statusText
    throw new ApiError(res.status, reason, null, body)
  }
  return body as unknown as ParseResult
}
