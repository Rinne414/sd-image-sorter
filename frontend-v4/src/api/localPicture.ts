import { locationName } from '../lib/localPicture'
import { ApiError, codeOf, detailOf } from './client'

// POST /api/local-picture: the picture at a location on this computer (a path
// or file:// URL a chat app handed over instead of the picture), as a File the
// caller sends on its usual way. Errors carry the backend's code
// (local_picture_missing, ...), which the caller words in the UI language.

export async function fetchLocalPicture(path: string, signal?: AbortSignal): Promise<File> {
  const res = await fetch('/api/local-picture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    signal,
  })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new ApiError(res.status, detailOf(body) ?? `HTTP ${res.status}`, codeOf(body), body)
  }
  const blob = await res.blob()
  let name = ''
  try {
    name = decodeURIComponent(res.headers.get('X-Picture-Name') ?? '')
  } catch {
    name = ''
  }
  return new File([blob], name || locationName(path) || 'picture.png', { type: blob.type || 'image/png', lastModified: Date.now() })
}
