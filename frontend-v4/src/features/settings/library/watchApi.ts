import { create } from 'zustand'
import { queryClient } from '../../../api/queryClient'
import { useToasts } from '../../../ui/toasts'
import { lt } from '../libraryText'
import { rootName } from './roots'
import type { LibraryRoot } from './types'
import { picturesArrived, pollDelay, readWatchStatus, type WatchStatus } from './watch'

// Folder watching, live side: the per-folder switch (PATCH
// /api/library-roots/{id}/watch) and the status poll (GET /api/watch/status)
// that refreshes the gallery when watched folders bring new pictures. These
// routes are not in the generated schema yet, so they are called directly.

export const useFolderWatch = create<{ status: WatchStatus | null }>(() => ({ status: null }))

/** What a gallery shows after pictures arrive (the same set an import refreshes). */
const ARRIVAL_KEYS = ['images', 'image-count', 'libraries', 'generators', 'folders', 'library-health', 'library-roots']

async function requestJson(method: 'GET' | 'PATCH', url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = data && typeof data === 'object' ? (data as { detail?: unknown; message?: unknown }) : {}
    const inner = detail.detail && typeof detail.detail === 'object' ? (detail.detail as { message?: unknown }).message : detail.detail
    const reason = typeof inner === 'string' ? inner : typeof detail.message === 'string' ? detail.message : res.statusText
    throw new Error(reason || `HTTP ${res.status}`)
  }
  return data
}

let timer: number | null = null
let lastGeneration: number | null = null

async function poll(): Promise<void> {
  if (!document.hidden) {
    try {
      const status = readWatchStatus(await requestJson('GET', '/api/watch/status'))
      if (status) apply(status)
    } catch {
      // Unreadable for a moment (the program restarting): the next poll tries again.
    }
  }
  schedule()
}

function apply(status: WatchStatus): void {
  const arrived = picturesArrived(lastGeneration, status.generation)
  lastGeneration = status.generation
  useFolderWatch.setState({ status })
  if (arrived) for (const key of ARRIVAL_KEYS) void queryClient.invalidateQueries({ queryKey: [key] })
}

function schedule(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => void poll(), pollDelay(useFolderWatch.getState().status))
}

/** Check now (after a switch was flipped, or the page came back) and reschedule. */
export function pokeFolderWatch(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  void poll()
}

/** Follow the watched folders while the app is open. Returns the cleanup (the app mounts it once). */
export function startFolderWatch(): () => void {
  const onVisible = () => {
    if (!document.hidden) pokeFolderWatch()
  }
  document.addEventListener('visibilitychange', onVisible)
  lastGeneration = null
  pokeFolderWatch()
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    lastGeneration = null
  }
}

/** Turn watching on or off for one folder; says what changed. */
export async function setRootWatch(root: LibraryRoot, on: boolean): Promise<boolean> {
  try {
    await requestJson('PATCH', `/api/library-roots/${root.id}/watch`, { watch: on })
  } catch (error) {
    useToasts.getState().push(lt('libset.watch.failed', { reason: (error as Error).message }), 'error')
    return false
  }
  await queryClient.invalidateQueries({ queryKey: ['library-roots'] })
  useToasts.getState().push(lt(on ? 'libset.watch.on' : 'libset.watch.off', { name: rootName(root.path) }), 'info')
  pokeFolderWatch()
  return true
}
