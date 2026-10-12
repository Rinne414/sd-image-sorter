import type { DragEvent } from 'react'
import { useToasts } from '../../../ui/toasts'
import { TOOL_RESULT_DRAG } from '../intake/intakeFiles'
import { buildZip, type ZipEntry } from './engine/zip'
import { resultName, uniqueNames, zipName } from './names'
import { pt } from './privacyText'
import { usePrivacy, type QueueItem } from './privacyStore'
import { runJpeg } from './workerClient'

// Handing results out: copy, download, drag, and all of them as one ZIP.
// Results are PNG. Only a Simple-mode (Small Tomato) download is re-encoded as
// JPEG, as V3.5 and the site do; the page says up front that it loses the
// generation details, and copy and drag stay PNG.

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)
const reasonOf = (error: unknown) => String((error as Error)?.message ?? error)

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // the download has its own copy by now; give the browser a moment anyway
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const isSimple = (item: QueueItem) => item.result?.compat === 'small_tomato'

/** The file a download hands out: the PNG, or for Simple mode the JPEG made from it. */
async function downloadable(item: QueueItem): Promise<{ name: string; blob: Blob; crc: number }> {
  const result = item.result!
  if (!isSimple(item)) return { name: resultName(item.fileName, item.rename, '.png'), blob: result.blob, crc: result.crc }
  const jpeg = await runJpeg(result.blob)
  return { name: resultName(item.fileName, item.rename, '.jpg'), blob: jpeg.blob, crc: jpeg.crc }
}

export async function downloadItem(item: QueueItem): Promise<void> {
  if (!item.result) return
  try {
    const file = await downloadable(item)
    save(file.blob, file.name)
  } catch (error) {
    toast(pt('privacy.downloadFailed', { reason: reasonOf(error) }), 'error')
  }
}

export async function copyItem(item: QueueItem): Promise<void> {
  if (!item.result) return
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    toast(pt('privacy.copyUnsupported'), 'error')
    return
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': item.result.blob })])
    toast(pt('privacy.copied'))
  } catch (error) {
    toast(pt('privacy.copyFailed', { reason: reasonOf(error) }), 'error')
  }
}

/** Dragging a result out: the PNG as a file (chat apps, web pages) and as a download (Explorer). */
export function dragResult(event: DragEvent, item: QueueItem): void {
  if (!item.result) return
  const name = resultName(item.fileName, item.rename, '.png')
  const data = event.dataTransfer
  data.effectAllowed = 'copy'
  data.items.add(new File([item.result.blob], name, { type: 'image/png' }))
  data.setData('DownloadURL', `image/png:${name.replace(/:/g, '_')}:${new URL(item.result.url, location.href).href}`)
  data.setData(TOOL_RESULT_DRAG, '1')
}

/** Every processed image in one ZIP, in queue order. */
export async function downloadAll(): Promise<void> {
  const state = usePrivacy.getState()
  if (state.zipping) return
  const done = state.items.filter((it) => it.result)
  if (!done.length) {
    toast(pt('privacy.noResults'), 'error')
    return
  }
  usePrivacy.setState({ zipping: true })
  try {
    const files = []
    for (const item of done) files.push(await downloadable(item))
    const names = uniqueNames(files.map((f) => f.name))
    const entries: ZipEntry[] = files.map((f, i) => ({ name: names[i]!, data: f.blob, crc: f.crc }))
    const now = new Date()
    save(buildZip(entries, now), zipName(now))
    toast(pt('privacy.zipDone', { n: entries.length }))
  } catch (error) {
    toast(pt('privacy.zipFailed', { reason: reasonOf(error) }), 'error')
  } finally {
    usePrivacy.setState({ zipping: false })
  }
}
