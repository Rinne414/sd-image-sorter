import type { Request } from '@playwright/test'

/**
 * A request the app cancels on purpose, which a "no failed requests" check must
 * not count: a thumbnail whose tile left the page during a scroll (the gallery
 * thumbnail gate cancels it, 17285c80) or whose <img> was replaced by a re-render.
 */
export function isIntentionalAbort(request: Request): boolean {
  if ((request.failure()?.errorText || '') !== 'net::ERR_ABORTED') return false
  try {
    return new URL(request.url()).pathname.startsWith('/api/image-thumbnail/')
  } catch {
    return false
  }
}
