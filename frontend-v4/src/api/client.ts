import createClient from 'openapi-fetch'
import type { paths } from './schema'
import { translate, useLang } from '../i18n'
import { debugMiddleware } from '../lib/debug'
import { useApp } from '../state/store'
import { checkAnswer } from './answer'

// Typed requests: path + query params are checked against the backend's
// OpenAPI schema (regenerate with `npm run gen:api`).
export const api = createClient<paths>({ baseUrl: '' })

// Every request names the library it works on (same header V3.5 sends). A
// request that already names one keeps it: work that finishes after the user
// switched libraries (a censor save) must still go to its own library.
api.use({
  onRequest({ request }) {
    if (!request.headers.has('X-SD-Library-Id')) request.headers.set('X-SD-Library-Id', useApp.getState().libraryId)
    return request
  },
})

// Settings › About › Support › Detailed log: every request in the browser console.
api.use(debugMiddleware())

export class ApiError extends Error {
  readonly status: number
  /** The backend's error code when it sends one (e.g. "batch_revision_conflict"). */
  readonly code: string | null
  /** The whole error body, for callers that need its details (ids, lists). */
  readonly body: unknown

  constructor(status: number, message: string, code: string | null = null, body: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

function detailOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const { detail, message, error } = body as { detail?: unknown; message?: unknown; error?: unknown }
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((d) => (d as { msg?: string }).msg ?? '').join('; ')
  // The global error envelope: { error, message?, code?, ... }
  if (typeof message === 'string') return message
  if (typeof error === 'string') return error
  return null
}

function codeOf(body: unknown): string | null {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null
  return typeof code === 'string' ? code : null
}

/** Success statuses that carry no body by design (No Content, Reset Content). */
const EMPTY_BY_DESIGN: ReadonlySet<number> = new Set([204, 205])

const incomplete = () => translate(useLang.getState().lang, 'error.badAnswer')

/**
 * Unwrap an openapi-fetch result: return data or throw an ApiError with the
 * server's reason. A success without a body (empty, or the JSON `null`) whose
 * status does not say "no content" is an answer lost on the way (every backend
 * route answers a body; only a 204 is empty on purpose): it fails with the plain
 * "the server's answer was incomplete" instead of reaching a caller that reads
 * its fields ("Cannot read properties of undefined").
 */
export function unwrap<T>(result: { data?: unknown; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const reason = detailOf(result.error) ?? result.response.statusText ?? 'request failed'
    throw new ApiError(result.response.status, reason, codeOf(result.error), result.error ?? null)
  }
  if ((result.data === undefined || result.data === null) && !EMPTY_BY_DESIGN.has(result.response.status)) throw new Error(incomplete())
  return result.data as T
}

/**
 * `unwrap` for an answer whose fields are read: one without them (a 204, `{}`,
 * cut off) fails with the plain "the server's answer was incomplete".
 */
export function unwrapAnswer<T>(result: { data?: unknown; error?: unknown; response: Response }, has: (answer: Record<string, unknown>) => boolean): T {
  return checkAnswer<T>(unwrap<unknown>(result), has, incomplete())
}

export { imageFileUrl, thumbnailUrl } from './urls'
