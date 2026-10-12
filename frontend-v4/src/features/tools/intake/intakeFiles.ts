import { ApiError } from '../../../api/client'
import { useApp } from '../../../state/store'
import type { ParseResult } from '../reader/readerAdapter'

// Images into a tool: dropped anywhere on its page, chosen with the file
// picker, or pasted (the Reader and Reverse prompt take one, Privacy many). The
// Reader's file is read by POST /api/parse-image, which also keeps a copy for
// 24 hours (`source_temp_path`) that saving and tagging use.

/** How an image came in; a pasted one has usually lost its generation details. */
export type IntakeOrigin = 'drop' | 'pick' | 'paste'

const IMAGE_NAME = /\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i

export const isImageFile = (f: File): boolean => f.type.startsWith('image/') || IMAGE_NAME.test(f.name)

/** A drag that carries a tool's own result (Privacy's scrambled image): never taken back in as a new file. */
export const TOOL_RESULT_DRAG = 'application/x-sd-tool-result'

/** The images among these files, in order (a drop, the picker or a paste can hand over several). */
export function imagesOf(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return files ? Array.from(files).filter(isImageFile) : []
}

/** The first image among these files. */
export function firstImage(files: Iterable<File> | ArrayLike<File> | null | undefined): File | null {
  return imagesOf(files)[0] ?? null
}

/** The images a paste carries, each named so a tool can say where it came from. */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return []
  let files = imagesOf(data.files)
  if (!files.length) files = imagesOf([...data.items].flatMap((i) => (i.kind === 'file' ? [i.getAsFile()] : [])).filter((f): f is File => !!f))
  return files.map((file) => (file.name ? file : new File([file], 'clipboard.png', { type: file.type || 'image/png' })))
}

/** The image a paste carries (the first, when it carries several). */
export function pastedImage(data: DataTransfer | null): File | null {
  return pastedImages(data)[0] ?? null
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
