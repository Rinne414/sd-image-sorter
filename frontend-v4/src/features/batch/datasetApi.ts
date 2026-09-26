import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import type { Batch, BatchKind, BatchProjectView, DatasetProject, ScannedImage, UnlinkedDatasetProject } from '../../api/types'
import type { ProjectSettings } from './datasetSettings'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { addToBatch, batchKey, enqueue, markRemoving, refreshLists, removingKey, useRemoving } from './batchApi'
import {
  inOrder,
  pathKey,
  projectPutItems,
  refKey,
  restoreRefs,
  savedRef,
  UnsurfacedFolderImage,
  withAdded,
  withoutKeys,
  type EntryRef,
} from './datasetItems'

// A dataset batch's images live in its Dataset Maker project (the rows V3.5
// opens). Reads come from GET /api/batches/{id}/project; every change is a
// PUT of the whole project with the revision it was read at, run in the
// batch's queue. When V3.5 changed the project meanwhile the PUT is refused:
// the project is read again and the user is told, nothing is overwritten.

const libraryId = () => useApp.getState().libraryId
export const projectKey = (library: string, batchId: number) => ['batch-project', library, batchId] as const

export function useBatchProject(batch: Batch) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: projectKey(library, batch.id),
    enabled: batch.kind === 'dataset' && !batch.orphaned,
    queryFn: async ({ signal }) => {
      try {
        return unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batch.id } }, signal }))
      } catch (error) {
        // V3.5 deleted the project meanwhile: the batch view says so once it is read again.
        if (error instanceof ApiError && error.code === 'dataset_batch_orphaned') {
          void queryClient.invalidateQueries({ queryKey: batchKey(library, batch.id) })
          refreshLists()
        }
        throw error
      }
    },
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    staleTime: 15_000,
  })
}

/** V3.5 dataset projects no batch shows yet; opening one makes it a batch. */
export function useUnlinkedProjects(includeArchived: boolean) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: ['dataset-projects-unlinked', library, includeArchived],
    queryFn: async ({ signal }) =>
      unwrap<{ unlinked_dataset_projects: UnlinkedDatasetProject[] }>(
        await api.GET('/api/batches', { params: { query: { include_archived: includeArchived, kind: 'dataset' } }, signal }),
      ).unlinked_dataset_projects,
    staleTime: 15_000,
  })
}

function toast(text: string, tone: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
  useToasts.getState().push(text, tone, action)
}

/**
 * Folder images a scan or upload surfaced in this session (by pathKey): the
 * backend only accepts a new folder image it was shown by one of those.
 */
const surfaced = new Set<string>()

export function markSurfaced(paths: readonly string[]): void {
  for (const path of paths) surfaced.add(pathKey(path))
}

async function currentView(batchId: number): Promise<BatchProjectView> {
  const cached = queryClient.getQueryData<BatchProjectView>(projectKey(libraryId(), batchId))
  if (cached) return cached
  return queryClient.fetchQuery({
    queryKey: projectKey(libraryId(), batchId),
    queryFn: async () => unwrap<BatchProjectView>(await api.GET('/api/batches/{batch_id}/project', { params: { path: { batch_id: batchId } } })),
  })
}

/** The project's items in the order of `keys` (items the list does not name go last). */
function itemsInOrder(project: DatasetProject, keys: readonly string[]): DatasetProject['items'] {
  const rank = new Map(inOrder(project.items.map(savedRef), keys).map((ref, i) => [refKey(ref), i]))
  return [...project.items]
    .sort((a, b) => (rank.get(refKey(savedRef(a))) ?? 0) - (rank.get(refKey(savedRef(b))) ?? 0))
    .map((item, position) => ({ ...item, position }))
}

/**
 * Keep the new project in the cache. While more changes wait in the queue the
 * order on screen (a newer drag or Alt+arrow) stays; the next save sends it.
 * Names of Library images the view did not know yet come with a fresh read.
 */
function storeProject(batchId: number, view: BatchProjectView, saved: DatasetProject, more: boolean): BatchProjectView {
  const key = projectKey(libraryId(), batchId)
  const onScreen = queryClient.getQueryData<BatchProjectView>(key)?.project.items.map((item) => refKey(savedRef(item)))
  const project = more && onScreen ? { ...saved, items: itemsInOrder(saved, onScreen) } : saved
  const next = { ...view, project }
  const known = new Set(view.library_images.map((row) => row.id))
  const unknown = project.items.some((item) => item.item_type === 'library' && item.image_id !== null && !known.has(item.image_id))
  queryClient.setQueryData(key, next)
  if (unknown && !more) void queryClient.invalidateQueries({ queryKey: key })
  // The batch's count, covers and project revision follow the project.
  void queryClient.invalidateQueries({ queryKey: batchKey(libraryId(), batchId) })
  refreshLists()
  return next
}

export interface WriteResult {
  before: EntryRef[]
  after: EntryRef[]
  view: BatchProjectView
}

type SettingsChange = (settings: ProjectSettings) => ProjectSettings

/**
 * One PUT that turns the project's entries into `change(entries)` (and its
 * settings into `settingsChange(settings)`); errors are thrown to the caller.
 * Folder images named in `rebind` are taken as their files are now.
 */
async function writeOnce(
  batchId: number,
  change: (refs: EntryRef[]) => EntryRef[],
  settingsChange: SettingsChange = (s) => s,
  rebind: ReadonlySet<string> = new Set(),
): Promise<WriteResult> {
  const view = await currentView(batchId)
  const { project } = view
  const before = project.items.map(savedRef)
  const after = change(before)
  const saved = unwrap<DatasetProject>(
    await api.PUT('/api/dataset/projects/{project_id}', {
      params: { path: { project_id: project.id } },
      body: {
        expected_revision: project.revision,
        name: project.name,
        items: projectPutItems(project.items, after, surfaced, rebind),
        settings: settingsChange(project.settings),
      },
    }),
  )
  const more = (queuedWrites.get(batchId) ?? 1) > 1
  return { before, after, view: storeProject(batchId, view, saved, more) }
}

/** Project writes waiting in (or running from) each batch's queue. */
const queuedWrites = new Map<number, number>()

/** Run `task` in the batch's queue; says what went wrong and returns null on failure. */
function inQueue(batchId: number, task: () => Promise<WriteResult>): Promise<WriteResult | null> {
  queuedWrites.set(batchId, (queuedWrites.get(batchId) ?? 0) + 1)
  return enqueue(batchId, async () => {
    try {
      return await task()
    } catch (error) {
      explain(batchId, error)
      return null
    } finally {
      const left = (queuedWrites.get(batchId) ?? 1) - 1
      if (left > 0) queuedWrites.set(batchId, left)
      else queuedWrites.delete(batchId)
    }
  })
}

export function writeEntries(batchId: number, change: (refs: EntryRef[]) => EntryRef[]): Promise<WriteResult | null> {
  return inQueue(batchId, () => writeOnce(batchId, change))
}

/** Save the project's settings (the V1 settings V3.5 reads), built from the ones saved now. */
export async function saveProjectSettings(batchId: number, change: SettingsChange): Promise<boolean> {
  return (await inQueue(batchId, () => writeOnce(batchId, (refs) => refs, change))) !== null
}

function explain(batchId: number, error: unknown): void {
  void queryClient.invalidateQueries({ queryKey: projectKey(libraryId(), batchId) })
  void queryClient.invalidateQueries({ queryKey: batchKey(libraryId(), batchId) })
  if (error instanceof UnsurfacedFolderImage) return toast(tr('dataset.folderRefused', { path: error.path }), 'error')
  const code = error instanceof ApiError ? error.code : null
  if (code === 'dataset_project_revision_conflict') return toast(tr('dataset.conflict'), 'error')
  if (code === 'dataset_project_state_conflict') return toast(tr('dataset.archivedNoEdit'), 'error')
  if (code === 'dataset_project_images_not_found') return toast(tr('dataset.imagesGone'), 'error')
  const path = (error instanceof ApiError ? (error.body as { path?: unknown } | null)?.path : null) ?? ''
  if (code === 'dataset_project_local_source_invalid' || code === 'dataset_project_local_source_identity_conflict') {
    return toast(tr('dataset.folderRefused', { path: String(path) }), 'error')
  }
  toast(tr('error.generic', { reason: (error as Error).message }), 'error')
}

export interface AddCount {
  added: number
  skipped: number
}

async function addRefs(batchId: number, refs: EntryRef[]): Promise<AddCount | null> {
  let count: AddCount = { added: 0, skipped: 0 }
  const res = await writeEntries(batchId, (current) => {
    const next = withAdded(current, refs)
    count = { added: next.added, skipped: next.skipped }
    return next.refs
  })
  return res && count
}

export function addLibraryImages(batchId: number, imageIds: readonly number[]): Promise<AddCount | null> {
  return addRefs(batchId, imageIds.map((imageId) => ({ kind: 'library', imageId })))
}

export function addFolderImages(batchId: number, images: readonly ScannedImage[]): Promise<AddCount | null> {
  markSurfaced(images.map((image) => image.abs_path))
  return addRefs(batchId, images.map((image) => ({ kind: 'folder', path: image.abs_path })))
}

/** Add Library picks to any batch: a dataset batch's go into its project. */
export async function addLibraryPicks(batch: { id: number; kind: BatchKind }, imageIds: number[]): Promise<AddCount | null> {
  if (batch.kind === 'dataset') return addLibraryImages(batch.id, imageIds)
  const res = await addToBatch(batch.id, imageIds)
  return res && { added: res.added, skipped: res.skipped }
}

/**
 * Put the entries in this order: the screen follows at once, the save runs in
 * the batch's queue and sends the newest order on screen.
 */
export async function reorderEntries(batchId: number, keys: readonly string[]): Promise<boolean> {
  queryClient.setQueryData<BatchProjectView>(projectKey(libraryId(), batchId), (view) =>
    view ? { ...view, project: { ...view.project, items: itemsInOrder(view.project, keys) } } : view,
  )
  return (await writeEntries(batchId, (current) => current)) !== null
}

/** Show a V3.5 dataset project as a batch (the same batch every time). */
export async function openProjectAsBatch(project: UnlinkedDatasetProject): Promise<Batch | null> {
  try {
    const res = unwrap<{ batch: Batch }>(await api.POST('/api/batches', { body: { kind: 'dataset', dataset_project_id: project.id } }))
    queryClient.setQueryData(batchKey(libraryId(), res.batch.id), res.batch)
    refreshLists()
    return res.batch
  } catch (error) {
    toast(tr('error.generic', { reason: (error as Error).message }), 'error')
    return null
  }
}

/** Rescan the folders these images are in, so the backend accepts them again (its permission lasts hours, not forever). */
async function resurface(paths: readonly string[]): Promise<void> {
  const folders = [...new Set(paths.map((path) => path.replace(/[\\/][^\\/]*$/, '')))]
  for (const folder of folders) {
    try {
      unwrap(await api.POST('/api/dataset/folder-scan', { body: { folder_path: folder, recursive: false, include_thumbnails: false, limit: 1, offset: 0 } }))
    } catch {
      // A folder that is gone stays refused; the retry below says so.
    }
  }
}

const refusedFolderImage = (error: unknown) =>
  error instanceof ApiError && error.code === 'dataset_project_local_source_invalid'

/** Undo a removal: each entry back in its old place; folder images the backend forgot are shown to it again first. */
function putBack(batchId: number, before: EntryRef[], removed: EntryRef[]): Promise<unknown> {
  const folders = removed.flatMap((ref) => (ref.kind === 'folder' ? [ref.path] : []))
  markSurfaced(folders)
  const change = (current: EntryRef[]) => restoreRefs(before, current, removed)
  return inQueue(batchId, async () => {
    try {
      return await writeOnce(batchId, change)
    } catch (error) {
      if (!refusedFolderImage(error) || folders.length === 0) throw error
      await resurface(folders)
      return writeOnce(batchId, change)
    }
  })
}

/**
 * Take entries out of the dataset (never out of the Library, never off the
 * disk); the toast can undo it. An entry already on its way out is skipped.
 */
export async function removeEntries(batchId: number, keys: readonly string[], names: ReadonlyMap<string, string>): Promise<boolean> {
  const busy = useRemoving.getState().keys
  const wanted = [...new Set(keys)].filter((key) => !busy.has(removingKey(batchId, key)))
  if (wanted.length === 0) return false
  const marks = wanted.map((key) => removingKey(batchId, key))
  markRemoving(marks, true)
  const gone = new Set(wanted)
  let removed: EntryRef[] = []
  try {
    const res = await writeEntries(batchId, (current) => {
      removed = current.filter((ref) => gone.has(refKey(ref)))
      return withoutKeys(current, gone)
    })
    if (!res || removed.length === 0) return false
    const first = names.get(refKey(removed[0] as EntryRef)) ?? ''
    const text = removed.length === 1 ? tr('dataset.removedOne', { name: first }) : tr('dataset.removedMany', { n: removed.length })
    const { before } = res
    const out = removed
    toast(text, 'info', { label: tr('toast.undo'), run: () => void putBack(batchId, before, out) })
    return true
  } finally {
    markRemoving(marks, false)
  }
}

/**
 * Folder images whose file changed since they were added: take each file as
 * it is now (the export refuses the old one). A caption edited for the old
 * file does not follow it. The backend is shown the files again first.
 */
export async function readdEntries(batchId: number, keys: readonly string[]): Promise<boolean> {
  const view = await currentView(batchId)
  const wanted = new Set(keys)
  const paths = view.project.items.flatMap((item) => (item.item_type === 'local' && wanted.has(refKey(savedRef(item))) ? [item.path] : []))
  if (paths.length === 0) return false
  markSurfaced(paths)
  const res = await inQueue(batchId, async () => {
    await resurface(paths)
    return writeOnce(batchId, (refs) => refs, (s) => s, wanted)
  })
  if (res) toast(tr('dataset.check.readded', { n: paths.length }))
  return res !== null
}
