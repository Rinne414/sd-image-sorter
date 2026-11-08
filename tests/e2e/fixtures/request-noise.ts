import type { Request } from '@playwright/test'

/**
 * A request the app cancels on purpose, which a "no failed requests" check must
 * not count: a thumbnail whose tile left the page during a scroll (the gallery
 * thumbnail gate cancels it, 17285c80) or whose <img> was replaced by a
 * re-render, and a gallery listing or count superseded by a newer one (the
 * request manager aborts the older; a slow machine makes that order vary).
 * A lost final listing still fails the test through what the gallery shows.
 */
export function isIntentionalAbort(request: Request): boolean {
  if ((request.failure()?.errorText || '') !== 'net::ERR_ABORTED') return false
  try {
    const { pathname } = new URL(request.url())
    return pathname.startsWith('/api/image-thumbnail/') || pathname === '/api/images' || pathname === '/api/images/count'
  } catch {
    return false
  }
}
