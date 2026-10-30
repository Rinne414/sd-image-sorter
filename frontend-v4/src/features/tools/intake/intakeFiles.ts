import { ApiError } from '../../../api/client'
import { inspect, isPictureFile, type Inspected } from '../../../lib/localPicture'
import { useApp } from '../../../state/store'
import type { ParseResult } from '../reader/readerAdapter'

// Images into a tool: dropped anywhere on its page, chosen with the file
// picker, or pasted (the Reader and Reverse prompt take one, Privacy many). The
// Reader's file is read by POST /api/parse-image, which also keeps a copy for
// 24 hours (`source_temp_path`) that saving and tagging use.

/** How an image came in; a pasted one has usually lost its generation details. */
export type IntakeOrigin = 'drop' | 'pick' | 'paste'

/** An image by its MIME type, or by its name when the type is blank. */
export const isImageFile = isPictureFile

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

/** A pasted image, named so a tool can say where it came from. */
export const withName = (file: File): File => (file.name ? file : new File([file], 'clipboard.png', { type: file.type || 'image/png' }))

/**
 * What the clipboard holds, read by the Paste button (the browser may ask
 * first): its image, and its HTML and text, where a chat app such as QQ puts a
 * copied picture's file location instead of the picture.
 */
/** `baseName` names a pasted picture: the Reader says "clipboard", collecting saves it as "pasted". */
export async function readClipboard(baseName = 'clipboard'): Promise<Inspected> {
  const files: File[] = []
  const text = { uriList: '', html: '', plain: '' }
  for (const item of await navigator.clipboard.read()) {
    for (const type of item.types) {
      if (type.startsWith('image/') && !files.length) {
        files.push(new File([await item.getType(type)], `${baseName}.${type.split('/')[1] || 'png'}`, { type }))
      } else if (type === 'text/html' && !text.html) {
        text.html = await (await item.getType(type)).text()
      } else if (type === 'text/plain' && !text.plain) {
        text.plain = await (await item.getType(type)).text()
      }
    }
  }
  return inspect(files, text)
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
