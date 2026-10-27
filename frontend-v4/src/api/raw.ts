import { useApp } from '../state/store'
import { ApiError, codeOf, detailOf } from './client'

// Routes the generated schema does not have yet (regenerating it changes many
// typed calls at once): called directly, with the same library header and the
// same errors as the typed client.

export type RawMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RawOptions {
  /** A JSON body. */
  body?: unknown
  /** A multipart body (file uploads); wins over `body`. */
  form?: FormData
  signal?: AbortSignal
  /** Work that must stay with the library it started in names it. */
  libraryId?: string
}

/** One request; resolves to the parsed answer (null for an empty one), throws ApiError otherwise. */
export async function rawJson<T>(method: RawMethod, url: string, options: RawOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-SD-Library-Id': options.libraryId ?? useApp.getState().libraryId }
  let body: BodyInit | undefined
  if (options.form) {
    body = options.form
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const res = await fetch(url, { method, headers, body, signal: options.signal })
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) throw new ApiError(res.status, detailOf(data) ?? `HTTP ${res.status}`, codeOf(data), data)
  return data as T
}
