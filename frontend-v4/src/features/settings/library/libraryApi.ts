import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { LibrariesResponse, LibraryHealth } from '../../../api/types'
import { tailOfPath } from '../../../lib/paths'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { afterImport } from '../../import/afterImport'
import { addJob, isQueueBusy, startingProgress, tr, useJobs } from '../../jobs/jobs'
import { asScanSource } from '../../jobs/progress'
import { lt } from '../libraryText'
import { readBusy, type BusyWork } from './clearIndex'
import { rootName } from './roots'
import type { LibraryRoot, LibraryRootsResponse, TagExport, TagImportResult } from './types'

// What Settings › Library reads and writes: the source folders, the tag
// backup, and clearing the library's index.

export function useLibraryRoots() {
  const libraryId = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['library-roots', libraryId],
    queryFn: async ({ signal }) => unwrap<LibraryRootsResponse>(await api.GET('/api/library-roots', { signal })).roots,
    staleTime: 10_000,
  })
}

const refreshRoots = () => void queryClient.invalidateQueries({ queryKey: ['library-roots'] })

type ScanState = { status?: string; run_id?: number; source?: string | null }

const TERMINAL = new Set(['done', 'cancelled', 'error'])

/** Rescan one source folder as a job (a finished import nobody confirmed would block it, so it is confirmed first). */
export async function rescanRoot(root: LibraryRoot): Promise<boolean> {
  if (isQueueBusy('scan')) {
    useToasts.getState().push(lt('libset.rescan.busy'), 'error')
    return false
  }
  try {
    const before = unwrap<ScanState>(await api.GET('/api/scan/progress'))
    if (before.source === 'manual' && TERMINAL.has(before.status ?? '') && (before.run_id ?? 0) > 0) {
      unwrap(await api.POST('/api/scan/acknowledge', { body: { run_id: before.run_id ?? 0, source: 'manual' } }))
    }
    const res = unwrap<{ run_id: number; source: string }>(
      await api.POST('/api/library-roots/{root_id}/rescan', { params: { path: { root_id: root.id } } }),
    )
    addJob({
      kind: 'scan',
      destination: root.path,
      label: tailOfPath(root.path, 36),
      ctx: { runId: res.run_id, scanSource: asScanSource(res.source) },
      progress: { ...startingProgress(0), phase: 'files' },
      then: (job) => {
        refreshRoots()
        return afterImport(job, false, 0)
      },
    })
    useToasts.getState().push(lt('libset.rescan.started', { name: rootName(root.path) }), 'info', {
      label: tr('jobs.show'),
      run: () => useJobs.getState().setDrawerOpen(true),
    })
    return true
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    useToasts.getState().push(busy ? lt('libset.rescan.busy') : tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Stop treating a folder as a source; its images and files stay. */
export async function removeRoot(root: LibraryRoot): Promise<boolean> {
  try {
    unwrap(await api.DELETE('/api/library-roots/{root_id}', { params: { path: { root_id: root.id } } }))
    refreshRoots()
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
    useToasts.getState().push(lt('libset.remove.done', { name: rootName(root.path) }), 'info')
    return true
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Download every tagged image's tags as JSON (the same file V3.5 writes). */
export async function exportTags(): Promise<void> {
  try {
    const data = unwrap<TagExport>(await api.GET('/api/tags/export'))
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sd-image-sorter-tags-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    useToasts.getState().push(lt('libset.tags.exported', { n: data.count ?? data.images?.length ?? 0 }), 'info')
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}

export async function importTags(images: Record<string, unknown>[], overwrite: boolean): Promise<boolean> {
  try {
    const res = unwrap<TagImportResult>(await api.POST('/api/tags/import', { body: { images, overwrite } }))
    for (const key of ['images', 'image', 'suggest', 'image-count', 'library-health']) void queryClient.invalidateQueries({ queryKey: [key] })
    useToasts.getState().push(lt('libset.import.done', { imported: res.imported, skipped: res.skipped }), 'info')
    return true
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** What of import, tagging and scoring runs now (throws when the app cannot say). */
export async function probeBusy(): Promise<BusyWork[]> {
  const [scan, tag, aesthetic] = await Promise.all([
    api.GET('/api/scan/progress').then((r) => unwrap<unknown>(r)),
    api.GET('/api/tag/progress').then((r) => unwrap<unknown>(r)),
    api.GET('/api/aesthetic/progress').then((r) => unwrap<unknown>(r)),
  ])
  return readBusy(scan, tag, aesthetic)
}

export async function stopWork(busy: BusyWork): Promise<void> {
  if (busy.work === 'scan') {
    const source = asScanSource(busy.source)
    unwrap(await api.POST('/api/scan/cancel', { body: { run_id: busy.runId ?? 0, source } }))
  } else if (busy.work === 'tag') {
    unwrap(await api.POST('/api/tag/cancel'))
  } else {
    unwrap(await api.POST('/api/aesthetic/cancel'))
  }
}

export interface ClearFacts {
  name: string
  records: number
  tagged: number
  rated: number
  favorites: number
}

/** What clearing this library would take away, counted fresh. */
export async function clearFacts(): Promise<ClearFacts> {
  const libraryId = useApp.getState().libraryId
  const [libs, health, rated, favs] = await Promise.all([
    api.GET('/api/libraries').then((r) => unwrap<LibrariesResponse>(r)),
    api.GET('/api/library-health').then((r) => unwrap<LibraryHealth>(r)),
    api.GET('/api/images/count', { params: { query: { min_user_rating: 1 } } }).then((r) => unwrap<{ total: number }>(r)),
    api.GET('/api/collections/favorites/ids').then((r) => unwrap<{ image_ids: number[] }>(r)),
  ])
  const library = libs.libraries.find((l) => l.id === libraryId)
  const records = library?.image_count ?? health.summary.total_images
  const untagged = health.issue_counts.untagged ?? 0
  return {
    name: library?.name ?? libraryId,
    records,
    tagged: Math.max(0, health.summary.total_images - untagged),
    rated: rated.total,
    favorites: favs.image_ids.length,
  }
}

/** Every view of the library that clearing it empties. */
const CLEARED = ['libraries', 'images', 'image', 'generators', 'folders', 'favorites', 'library-health', 'missing-summary', 'missing-groups', 'colors-missing', 'image-count', 'suggest', 'duplicates', 'similar', 'similarity-stats', 'library-roots']

/** DELETE /api/clear-gallery for the library in use. Throws the refusal (409 names the work in the way). */
export async function clearIndex(facts: ClearFacts): Promise<void> {
  const res = unwrap<{ removed?: string | number }>(await api.DELETE('/api/clear-gallery'))
  const s = useApp.getState()
  s.setSelection([])
  s.inspect(null)
  for (const key of CLEARED) void queryClient.invalidateQueries({ queryKey: [key] })
  const n = Number(res.removed ?? facts.records)
  useToasts.getState().push(lt('libset.clear.done', { name: facts.name, n: Number.isFinite(n) ? n : facts.records }), 'info', {
    label: lt('libset.clear.toLibrary'),
    run: () => useApp.getState().setPage('library'),
  })
}
