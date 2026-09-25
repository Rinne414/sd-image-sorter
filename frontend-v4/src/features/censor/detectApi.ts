import { api, unwrap } from '../../api/client'
import { tr } from '../jobs/jobs'
import { bitmapFromRgba, maskShapeOf, regionsFromDetections, textDetector, type MaskBitmap, type RawDetection } from './detection'
import { detectBody, frameMismatch, refineBody, segmentBody, type DetectPlan, type Size } from './detectRequests'
import { newOpId, type Box, type CensorStyle, type RegionOp, type RegionShape } from './ops'

// The detection endpoints: /api/censor/models, /detect, /batch-refine-mask,
// /segment-text, and the mask cache. Masks arrive as a PNG cropped to their
// bounds, inline (a data URL) or by reference; either way they are decoded
// here into one bit per pixel. Every answer must be measured on the picture
// the editor shows (same size); otherwise nothing of it is used.

export type { DetectPlan, Size } from './detectRequests'

/** The answer was measured on a picture of another size than the one on screen. */
export class FrameMismatchError extends Error {}

function checkFrame(answer: { image_width?: unknown; image_height?: unknown }, picture: Size): void {
  const mismatch = frameMismatch(answer, picture)
  if (mismatch) throw new FrameMismatchError(tr('censor.detect.sizeMismatch', mismatch))
}

export interface LegacyFile {
  path: string
  name?: string
  profile?: string
  profile_label?: string
  recommended_for_censor?: boolean
}

export interface CensorModel {
  id: string
  name: string
  available: boolean
  message?: string
  files?: LegacyFile[]
  default_model_path?: string | null
}

export interface CensorModels {
  models: CensorModel[]
  recommended_backend: string | null
}

export const censorModelsQuery = {
  queryKey: ['censor-models'],
  queryFn: async ({ signal }: { signal?: AbortSignal }) => unwrap<CensorModels>(await api.GET('/api/censor/models', { signal })),
  staleTime: 60_000,
}

interface MaskPayload {
  mask?: string | null
  mask_ref?: string | null
  mask_bounds?: unknown
  image_width?: unknown
  image_height?: unknown
}

async function decodeMask(p: MaskPayload): Promise<MaskBitmap | null> {
  const src = p.mask || (p.mask_ref ? `/api/censor/mask-cache/${encodeURIComponent(p.mask_ref)}` : null)
  const bounds = Array.isArray(p.mask_bounds) ? (p.mask_bounds as unknown[]) : null
  if (!src || !bounds || bounds.length !== 4) return null
  const res = await fetch(src)
  if (!res.ok) throw new Error(tr('censor.detect.maskFailed', { status: res.status }))
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error(tr('censor.noCanvas'))
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    return bitmapFromRgba(data, bitmap.width, bitmap.height, Math.round(Number(bounds[0])), Math.round(Number(bounds[1])))
  } finally {
    bitmap.close()
  }
}

interface DetectAnswer {
  detections?: RawDetection[]
  combined_mask?: string | null
  combined_mask_ref?: string | null
  combined_mask_bounds?: unknown
  image_width?: number
  image_height?: number
  warnings?: unknown
}

export interface DetectResult {
  regions: RegionOp[]
  warnings: string[]
}

/** Requests name the batch's library, so a run still going after a library switch reads the right images. */
const inLibrary = (library: string) => ({ headers: { 'X-SD-Library-Id': library } })

export async function detectImage(imageId: number, plan: DetectPlan, library: string, picture: Size): Promise<DetectResult> {
  const body = detectBody(imageId, plan)
  const res = unwrap<DetectAnswer>(await api.POST('/api/censor/detect', { body, ...inLibrary(library) }))
  checkFrame(res, picture)
  const detections = Array.isArray(res.detections) ? res.detections : []
  const precise = plan.maskShape === 'precise' && detections.length > 0
  const mask = precise
    ? await decodeMask({ mask: res.combined_mask, mask_ref: res.combined_mask_ref, mask_bounds: res.combined_mask_bounds })
    : null
  const options = {
    detector: plan.detector,
    style: plan.style,
    block: plan.block,
    maskShape: plan.maskShape,
    confidence: plan.confidence,
    width: picture.width,
    height: picture.height,
  }
  const warnings = Array.isArray(res.warnings) ? res.warnings.filter((w): w is string => typeof w === 'string' && w.trim() !== '') : []
  return { regions: regionsFromDetections(detections, options, mask), warnings }
}

interface RefineAnswer {
  results?: (MaskPayload & { index?: number; status?: string })[]
  errors?: { index?: number; error?: string }[]
}

export interface RefineResult {
  shapes: Map<string, RegionShape>
  /** SAM3 could not refine these boxes: they stay as they were. */
  kept: number
  /** Why boxes failed (none when all went through). */
  errors: string[]
}

/** SAM3 masks for the regions' boxes, by region id. */
export async function refineRegions(
  imageId: number,
  regions: readonly (RegionOp & { box: Box })[],
  confidence: number,
  library: string,
  picture: Size,
): Promise<RefineResult> {
  const body = refineBody(
    imageId,
    regions.map((r) => r.box),
    confidence,
  )
  const res = unwrap<RefineAnswer>(await api.POST('/api/censor/batch-refine-mask', { body, ...inLibrary(library) }))
  for (const result of res.results ?? []) if (result.status === 'ok') checkFrame(result, picture)
  const shapes = new Map<string, RegionShape>()
  let kept = 0
  for (const result of res.results ?? []) {
    const region = regions[result.index ?? -1]
    if (!region) continue
    const bitmap = result.status === 'ok' ? await decodeMask(result) : null
    const shape = bitmap ? maskShapeOf(bitmap) : null
    if (shape) shapes.set(region.id, shape)
    else kept++
  }
  const errors = (res.errors ?? []).map((e) => e.error ?? '').filter(Boolean)
  return { shapes, kept, errors }
}

interface SegmentAnswer extends MaskPayload {
  status?: string
}

/** SAM3 finds what `word` describes; null when nothing matched. */
export async function segmentWord(
  imageId: number,
  word: string,
  style: CensorStyle,
  block: number,
  library: string,
  picture: Size,
): Promise<RegionOp | null> {
  const body = segmentBody(imageId, word)
  const res = unwrap<SegmentAnswer>(await api.POST('/api/censor/segment-text', { body, ...inLibrary(library) }))
  if (res.status !== 'ok') return null
  checkFrame(res, picture)
  const bitmap = await decodeMask(res)
  const shape = bitmap ? maskShapeOf(bitmap) : null
  if (!shape) return null
  return { type: 'region', id: newOpId(), source: 'detection', detector: textDetector(word), label: word, style, block, shape }
}
