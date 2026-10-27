import { rawJson } from '../../api/raw'
import type { CollectedSource, PairingLike } from './collectLogic'

// Routes of /api/collect and /api/browser-extension (not in the generated schema).

export interface Collected {
  filename: string
  folder: string
  converted_from?: string | null
}

export interface ExtensionState {
  pending: PairingLike[]
  collect: {
    generation?: number
    last_error?: string | null
    last_error_code?: string | null
    last_error_params?: Record<string, string | number>
  }
}

export interface InstallFolders {
  chrome: string
  firefox: string
}

export function collectPicture(file: File): Promise<Collected> {
  const form = new FormData()
  form.append('file', file, file.name || 'pasted.png')
  return rawJson<Collected>('POST', '/api/collect/paste', { form })
}

export function collectUrl(url: string): Promise<Collected> {
  return rawJson<Collected>('POST', '/api/collect/url', { body: { url } })
}

export async function fetchCollectedSource(imageId: number): Promise<CollectedSource | null> {
  const answer = await rawJson<{ source: CollectedSource | null }>('GET', `/api/collect/source/${imageId}`)
  return answer?.source ?? null
}

export function fetchExtensionState(): Promise<ExtensionState> {
  return rawJson<ExtensionState>('GET', '/api/browser-extension/state')
}

export async function fetchPaired(): Promise<PairingLike[]> {
  const answer = await rawJson<{ paired: PairingLike[] }>('GET', '/api/browser-extension/paired')
  return answer?.paired ?? []
}

export function decidePairing(id: string, allow: boolean): Promise<unknown> {
  return rawJson('POST', `/api/browser-extension/pairings/${encodeURIComponent(id)}/decide`, { body: { allow } })
}

export function revokePairing(id: string): Promise<unknown> {
  return rawJson('DELETE', `/api/browser-extension/pairings/${encodeURIComponent(id)}`)
}

export function prepareInstallFolders(): Promise<InstallFolders> {
  return rawJson<InstallFolders>('POST', '/api/browser-extension/install-folders', { body: {} })
}

export function openInstallFolder(browser: keyof InstallFolders): Promise<unknown> {
  return rawJson('POST', '/api/browser-extension/open-folder', { body: { browser } })
}
