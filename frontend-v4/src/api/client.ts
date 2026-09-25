import createClient from 'openapi-fetch'
import type { paths } from './schema'
import { useApp } from '../state/store'

// Typed requests: path + query params are checked against the backend's
// OpenAPI schema (regenerate with `npm run gen:api`).
export const api = createClient<paths>({ baseUrl: '' })

// Every request names the library it works on (same header V3.5 sends).
api.use({
  onRequest({ request }) {
    request.headers.set('X-SD-Library-Id', useApp.getState().libraryId)
    return request
  },
})

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function detailOf(body: unknown): string | null {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d) => (d as { msg?: string }).msg ?? '').join('; ')
  }
  return null
}

/** Unwrap an openapi-fetch result: return data or throw an ApiError with the server's reason. */
export function unwrap<T>(result: { data?: unknown; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const reason = detailOf(result.error) ?? result.response.statusText ?? 'request failed'
    throw new ApiError(result.response.status, reason)
  }
  return result.data as T
}

export const thumbnailUrl = (id: number, size: number) => `/api/image-thumbnail/${id}?size=${size}`
export const imageFileUrl = (id: number) => `/api/image-file/${id}`
