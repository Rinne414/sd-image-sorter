import { rawJson } from '../../../../api/raw'
import { ApiError, detailOf } from '../../../../api/client'
import { useApp } from '../../../../state/store'
import { isMakeAnswer, type MakeAnswer } from './disguiseModel'

// The program's /api/disguise routes (not in the generated schema yet, so
// called through the raw helper). Every call throws ApiError with the
// program's own words as the message.

const BASE = '/api/disguise'

/** One make request: the pictures (files in `uploads` are sent in order) and the settings fields. */
export interface MakeRequest {
  /** Per picture, a library image by id or the next uploaded file. */
  sources: ({ image_id: number } | { file_index: number })[]
  uploads: { file: Blob; name: string }[]
  coverFile: Blob | null
  fields: readonly (readonly [string, string])[]
}

function formOf(req: MakeRequest): FormData {
  const form = new FormData()
  form.append('sources', JSON.stringify(req.sources))
  for (const upload of req.uploads) form.append('files', upload.file, upload.name)
  if (req.coverFile) form.append('cover_file', req.coverFile)
  for (const [name, value] of req.fields) form.append(name, value)
  return form
}

export async function makeDisguise(req: MakeRequest): Promise<MakeAnswer> {
  const answer = await rawJson<unknown>('POST', `${BASE}/make`, { form: formOf(req) })
  if (!isMakeAnswer(answer)) throw new ApiError(502, 'The program answered in a form this page does not know.', null, answer)
  return answer
}

/** The made file itself (the browser keeps a copy to download, preview and drag). */
export async function fetchMade(fileUrl: string): Promise<Blob> {
  const res = await fetch(fileUrl, { headers: { 'X-SD-Library-Id': useApp.getState().libraryId } })
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, null, null)
  return res.blob()
}

/** The real picture inside a disguise, as a PNG. */
export async function restoreDisguise(file: Blob, name: string): Promise<Blob> {
  const form = new FormData()
  form.append('file', file, name)
  const res = await fetch(`${BASE}/restore`, { method: 'POST', body: form, headers: { 'X-SD-Library-Id': useApp.getState().libraryId } })
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null)
    throw new ApiError(res.status, detailOf(data) ?? `HTTP ${res.status}`, null, data)
  }
  return res.blob()
}

export async function defaultCoverInfo(): Promise<{ exists: boolean; version: number }> {
  const info = await rawJson<{ exists?: boolean; version?: number } | null>('GET', `${BASE}/default-cover/info`)
  return { exists: info?.exists === true, version: Number(info?.version ?? 0) }
}

export async function saveDefaultCover(file: Blob): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  await rawJson('PUT', `${BASE}/default-cover`, { form })
}

export async function clearDefaultCover(): Promise<void> {
  await rawJson('DELETE', `${BASE}/default-cover`)
}

export const defaultCoverUrl = (version: number): string => `${BASE}/default-cover?v=${version}`

export async function copyMadeFiles(tokens: string[]): Promise<void> {
  await rawJson('POST', `${BASE}/copy`, { body: { tokens } })
}

export async function revealMade(token: string): Promise<void> {
  await rawJson('POST', `${BASE}/reveal`, { body: { token } })
}
