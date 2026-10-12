import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import type { ScannedImage } from '../../api/types'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { addFolderImages, type AddCount } from './datasetApi'

// Folder images come into a dataset batch two ways. A folder on disk is
// scanned and its images join by path: nothing is copied and nothing enters
// the Library. Files dropped or picked in the browser have no path the app
// can see, so they are copied into the batch's own uploads folder first.

/** Images per folder-scan page (the backend's page cap). */
const SCAN_PAGE = 5000
/** Files per upload request, so a big drop is never one huge request. */
const UPLOAD_CHUNK = 250
export const IMAGE_FILE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i
export const ARCHIVE_FILE = /\.(zip|rar)$/i

/** What a running import is doing, shown in the pick bar. */
export const useDatasetImport = create<{ batchId: number | null; label: string }>(() => ({ batchId: null, label: '' }))

/** The "add from a folder" dialog: which batch it adds to and where it opens. */
export const useFolderDialog = create<{ batchId: number | null; start: string | null }>(() => ({ batchId: null, start: null }))

export function openFolderDialog(batchId: number, start: string | null = null): void {
  useFolderDialog.setState({ batchId, start })
}

function toast(text: string, tone: 'info' | 'error' = 'info'): void {
  useToasts.getState().push(text, tone)
}

function busy(batchId: number | null, label = ''): void {
  useDatasetImport.setState({ batchId, label })
}

interface ScanPage {
  items: ScannedImage[]
  scan_token: string
  has_more: boolean
  next_offset: number | null
  total_files_seen: number
}

/** Every image in the folder (and its subfolders when asked), page by page, without thumbnails. */
export async function scanFolder(folder: string, recursive: boolean, onPage: (seen: number, total: number) => void): Promise<ScannedImage[]> {
  const images: ScannedImage[] = []
  let page = unwrap<ScanPage>(
    await api.POST('/api/dataset/folder-scan', { body: { folder_path: folder, recursive, include_thumbnails: false, limit: SCAN_PAGE, offset: 0 } }),
  )
  images.push(...page.items)
  onPage(images.length, page.total_files_seen)
  while (page.has_more && page.next_offset !== null) {
    page = unwrap<ScanPage>(
      await api.POST('/api/dataset/folder-scan', {
        body: { scan_token: page.scan_token, offset: page.next_offset, recursive, include_thumbnails: false, limit: SCAN_PAGE },
      }),
    )
    images.push(...page.items)
    onPage(images.length, page.total_files_seen)
  }
  return images
}

function reportAdded(count: AddCount, key: 'dataset.addedFolder' | 'dataset.addedUpload'): void {
  toast(count.skipped > 0 ? tr(`${key}Skipped`, { n: count.added, skipped: count.skipped }) : tr(key, { n: count.added }))
}

/** Scan a folder and add its images to the dataset by path. False when nothing could be added. */
export async function addFromFolder(batchId: number, folder: string, recursive: boolean): Promise<boolean> {
  busy(batchId, tr('dataset.scanning', { n: 0 }))
  try {
    const images = await scanFolder(folder, recursive, (seen) => busy(batchId, tr('dataset.scanning', { n: seen })))
    if (images.length === 0) {
      toast(tr('dataset.folderEmpty', { folder }), 'error')
      return false
    }
    busy(batchId, tr('dataset.adding', { n: images.length }))
    const count = await addFolderImages(batchId, images)
    if (count) reportAdded(count, 'dataset.addedFolder')
    return count !== null
  } catch (error) {
    toast(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  } finally {
    busy(null)
  }
}

interface UploadAnswer {
  items: ScannedImage[]
  skipped_unreadable: number
}

async function uploadChunk(batchId: number, files: File[]): Promise<UploadAnswer> {
  const form = new FormData()
  for (const file of files) form.append('files', file, file.name)
  form.append('recursive', 'true')
  form.append('batch_id', String(batchId))
  const response = await fetch('/api/dataset/upload-files', {
    method: 'POST',
    body: form,
    headers: { 'X-SD-Library-Id': useApp.getState().libraryId },
  })
  const body: unknown = await response.json().catch(() => null)
  return unwrap<UploadAnswer>({ data: body, error: response.ok ? undefined : body, response })
}

/** Copy dropped or picked files (images, ZIP, RAR) into the batch's uploads folder and add them. */
export async function uploadInto(batchId: number, files: readonly File[]): Promise<boolean> {
  const wanted = files.filter((file) => IMAGE_FILE.test(file.name) || ARCHIVE_FILE.test(file.name))
  if (wanted.length === 0) {
    toast(tr('dataset.dropNothing'), 'error')
    return false
  }
  const images: ScannedImage[] = []
  let skipped = 0
  try {
    for (let start = 0; start < wanted.length; start += UPLOAD_CHUNK) {
      busy(batchId, tr('dataset.copying', { done: start, n: wanted.length }))
      const answer = await uploadChunk(batchId, wanted.slice(start, start + UPLOAD_CHUNK))
      images.push(...answer.items)
      skipped += answer.skipped_unreadable
    }
    busy(batchId, tr('dataset.adding', { n: images.length }))
    const count = await addFolderImages(batchId, images)
    if (count) reportAdded({ added: count.added, skipped: count.skipped + skipped }, 'dataset.addedUpload')
    return count !== null
  } catch (error) {
    toast(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  } finally {
    busy(null)
  }
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)))
}

/** Every file under the dropped entries (folders read to the bottom). */
async function filesUnder(entries: readonly FileSystemEntry[]): Promise<File[]> {
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await entryFile(entry as FileSystemFileEntry)
      if (file) out.push(file)
      return
    }
    if (!entry.isDirectory) return
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (let batch = await readEntries(reader); batch.length > 0; batch = await readEntries(reader)) {
      for (const child of batch) await walk(child)
    }
  }
  for (const entry of entries) await walk(entry)
  return out
}

/** Where a dropped folder is on disk (the browser does not say), or null. */
async function findFolder(dir: FileSystemDirectoryEntry): Promise<string | null> {
  const files = (await readEntries(dir.createReader())).filter((e): e is FileSystemFileEntry => e.isFile && IMAGE_FILE.test(e.name)).slice(0, 5)
  const sample = (await Promise.all(files.map(entryFile))).filter((f): f is File => f !== null).map((f) => ({ name: f.name, size: f.size }))
  try {
    return unwrap<{ folder_path?: string | null }>(await api.POST('/api/resolve-drop', { body: { folder_name: dir.name, files: sample } })).folder_path ?? null
  } catch {
    return null
  }
}

/**
 * A drop on a dataset batch. A folder the app can find on disk opens the
 * add-from-folder dialog there (nothing copied); anything else is copied in.
 */
export async function takeDrop(batchId: number, data: DataTransfer): Promise<void> {
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  const dirs = entries.filter((e): e is FileSystemDirectoryEntry => e.isDirectory)
  const loose = [...data.files]
  if (dirs.length === 1 && entries.length === 1) {
    const folder = await findFolder(dirs[0] as FileSystemDirectoryEntry)
    if (folder) {
      openFolderDialog(batchId, folder)
      return
    }
    toast(tr('dataset.dropCopyFolder', { name: dirs[0]?.name ?? '' }))
  }
  const files = dirs.length > 0 ? await filesUnder(entries) : loose
  await uploadInto(batchId, files)
}
