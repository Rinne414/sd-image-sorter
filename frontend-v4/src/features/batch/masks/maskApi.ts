import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../../api/client'
import { fetchModelStatus } from '../../../api/queries'
import { queryClient } from '../../../api/queryClient'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { createRaster, type Raster } from '../../censor/raster'
import { installThen } from '../../jobs/installJob'
import { addJob, isQueueBusy, startingProgress, tr } from '../../jobs/jobs'
import { busyText } from '../../jobs/busyText'

// Training masks: one grey PNG per Library image on the backend (white =
// trained, black = left out; no mask = the whole picture). Folder images
// cannot have one (the API takes Library image ids only). The automatic masks
// come from Lucida or rembg, two Model Center cards downloaded on first use.

export type MaskEngine = 'lucida' | 'rembg'

/** What the engines are called, and their download size (Model Center cards). */
export const ENGINES: Record<MaskEngine, { label: string; size: string }> = {
  lucida: { label: 'Lucida', size: '885 MB' },
  rembg: { label: 'rembg (U2Net)', size: '170 MB' },
}

export const maskStatusKey = (library: string, ids: readonly number[]) => ['mask-status', library, ids.join(',')] as const

/** Which of these Library images have a saved mask. */
export function useMaskStatus(ids: readonly number[]) {
  const library = useApp((s) => s.libraryId)
  return useQuery({
    queryKey: maskStatusKey(library, ids),
    enabled: ids.length > 0,
    queryFn: async ({ signal }) => {
      const res = unwrap<{ masks: Record<string, boolean> }>(await api.POST('/api/masks/status', { body: { image_ids: [...ids] }, signal }))
      return new Set(ids.filter((id) => res.masks[String(id)]))
    },
    staleTime: 30_000,
  })
}

const refreshStatus = () => queryClient.invalidateQueries({ queryKey: ['mask-status'] })

/** A PNG (a URL or a data URL) as mask pixels at the picture's size (grey in every channel). */
async function decodeMask(src: Blob, width: number, height: number): Promise<Raster> {
  const bitmap = await createImageBitmap(src, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  try {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error(tr('censor.noCanvas'))
    ctx.drawImage(bitmap, 0, 0, width, height)
    const data = ctx.getImageData(0, 0, width, height).data
    // A grey (L) PNG decodes to equal channels; keep the red one everywhere and full alpha.
    for (let i = 0; i < data.length; i += 4) {
      data[i + 1] = data[i] as number
      data[i + 2] = data[i] as number
      data[i + 3] = 255
    }
    return createRaster(width, height, data)
  } finally {
    bitmap.close()
  }
}

/** The saved mask, or null when there is none (the whole picture is trained). */
export async function loadMask(imageId: number, width: number, height: number): Promise<Raster | null> {
  const res = await fetch(`/api/masks/${imageId}?t=${Date.now()}`, { headers: { 'X-SD-Library-Id': useApp.getState().libraryId } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(tr('dataset.masks.loadFailed', { status: res.status }))
  return decodeMask(await res.blob(), width, height)
}

async function toDataUrl(mask: Raster): Promise<string> {
  const canvas = new OffscreenCanvas(mask.width, mask.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(tr('censor.noCanvas'))
  ctx.putImageData(new ImageData(mask.data, mask.width, mask.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

export async function saveMask(imageId: number, mask: Raster): Promise<void> {
  unwrap(await api.PUT('/api/masks/{image_id}', { params: { path: { image_id: imageId } }, body: { data_url: await toDataUrl(mask) } }))
  void refreshStatus()
}

export async function deleteMask(imageId: number): Promise<void> {
  unwrap(await api.DELETE('/api/masks/{image_id}', { params: { path: { image_id: imageId } } }))
  void refreshStatus()
}

/** An automatic subject mask for one image, not saved (the editor shows it for review). */
export async function autoMask(imageId: number, engine: MaskEngine, width: number, height: number): Promise<Raster> {
  const res = unwrap<{ data_url: string }>(await api.POST('/api/masks/{image_id}/auto', { params: { path: { image_id: imageId } }, body: { method: engine } }))
  return decodeMask(await (await fetch(res.data_url)).blob(), width, height)
}

type EngineState = 'ready' | 'download' | 'restart'

/** Whether the engine can run now (a card the status does not know is tried: the run says what is missing). */
export async function engineState(engine: MaskEngine): Promise<EngineState> {
  try {
    const cards = (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
    const card = cards.find((c) => c.id === engine)
    if (!card) return 'ready'
    if (card.status === 'needs_restart') return 'restart'
    return card.status === 'ready' ? 'ready' : 'download'
  } catch {
    return 'ready'
  }
}

/**
 * Run `work` once the engine is on disk: at once when it is there, else after
 * its download (a job; the button said the size first). 'downloading' means
 * `work` runs later, when the download ends well.
 */
export async function withEngine(engine: MaskEngine, work: () => void): Promise<'ran' | 'downloading' | 'failed'> {
  const state = await engineState(engine)
  if (state === 'restart') {
    useToasts.getState().push(tr('tagging.needsRestart', { name: ENGINES[engine].label }), 'error')
    return 'failed'
  }
  if (state === 'ready') {
    work()
    return 'ran'
  }
  return (await installThen({ card: engine, variant: null, label: ENGINES[engine].label }, work)) ? 'downloading' : 'failed'
}

/** The endpoint takes this many images per job (a transport size): more run as further jobs, one after another. */
const AUTO_BATCH_IDS = 5000

/** Mask these Library images automatically as a job; images with a mask are skipped unless `overwrite`. */
export async function startAutoMaskAll(ids: readonly number[], engine: MaskEngine, overwrite: boolean): Promise<void> {
  if (isQueueBusy('masks')) return void useToasts.getState().push(tr('jobs.busy'), 'error')
  const chunk = ids.slice(0, AUTO_BATCH_IDS)
  const rest = ids.slice(AUTO_BATCH_IDS)
  try {
    const res = unwrap<{ job_id: string; total: number }>(await api.POST('/api/masks/auto-batch', { body: { image_ids: chunk, method: engine, overwrite } }))
    addJob({
      kind: 'masks',
      count: chunk.length,
      ids: chunk,
      label: ENGINES[engine].label,
      ctx: { maskJobId: res.job_id },
      progress: startingProgress(res.total, 'queued'),
      ...(rest.length ? { then: () => void startAutoMaskAll(rest, engine, overwrite) } : {}),
    })
  } catch (error) {
    const busy = error instanceof ApiError && error.status === 409
    useToasts.getState().push(busy ? busyText(error) : tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}
