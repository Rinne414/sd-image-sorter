import { crc32 } from './engine/crc32'
import { extractSourceTextChunksFromBytes } from './engine/harvest'
import { normalizeCompatMode, resolvePassword } from './engine/password'
import { addPadding, cropPadding, decryptPixels, encryptPixels, TooSmallError, type PixelImage } from './engine/pixels'
import { writePngTextChunks } from './engine/png'
import type { Encoded, JpegJob, ProcessJob, Processed, WorkerProblem } from './protocol'

// What the worker does with a job: V3.5's processImage (obfuscate-engine.js),
// with an OffscreenCanvas in place of the page's <img> and <canvas>. Decoding
// and encoding stay the browser's own, exactly as on the Tomato sites.

export class JobProblem extends Error {
  readonly problem: WorkerProblem
  constructor(problem: WorkerProblem, detail: string) {
    super(detail)
    this.problem = problem
  }
}

async function decodePixels(blob: Blob): Promise<ImageData> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (error) {
    throw new JobProblem('decode', String((error as Error)?.message ?? error))
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new JobProblem('decode', 'no 2d canvas')
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

async function encodeImage(image: PixelImage | ImageBitmap, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  try {
    const canvas = new OffscreenCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no 2d canvas')
    if ('data' in image) context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
    else context.drawImage(image, 0, 0)
    return await canvas.convertToBlob({ type, quality: 1 })
  } catch (error) {
    throw new JobProblem('encode', String((error as Error)?.message ?? error))
  }
}

function movePixels(job: ProcessJob, image: ImageData): PixelImage {
  const password = resolvePassword(job.password, job.compat)
  const { width, height } = image
  if (job.direction === 'encode') return addPadding(encryptPixels(image.data, width, height, password), width, height, password.extraWidth, password.extraHeight)
  try {
    const cropped = cropPadding(image.data, width, height, password.extraWidth, password.extraHeight)
    return { data: decryptPixels(cropped.data, cropped.width, cropped.height, password), width: cropped.width, height: cropped.height }
  } catch (error) {
    if (error instanceof TooSmallError) throw new JobProblem('too-small', `${width}x${height}`)
    throw error
  }
}

/** Protect or restore one image; always a PNG, carrying the generation details unless turned off. */
export async function processImage(job: ProcessJob): Promise<Processed> {
  const compat = normalizeCompatMode(job.compat)
  const password = resolvePassword(job.password, compat)
  const pairs = job.keepInfo ? extractSourceTextChunksFromBytes(new Uint8Array(await job.source.arrayBuffer())) : []
  const image = await decodePixels(job.source)
  const out = movePixels({ ...job, compat }, image)
  let blob = await encodeImage(out, 'image/png')
  let bytes = new Uint8Array(await blob.arrayBuffer())
  if (pairs.length) {
    bytes = writePngTextChunks(bytes, pairs, password, { decryptValues: job.direction === 'decode', legacyPngInfo: job.legacyInfo })
    blob = new Blob([bytes], { type: 'image/png' })
  }
  return { blob, width: out.width, height: out.height, sourceWidth: image.width, sourceHeight: image.height, carried: pairs.length, crc: crc32(bytes) }
}

/** A result as a JPEG at full quality (what Small Tomato takes). */
export async function toJpeg(job: JpegJob): Promise<Encoded> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(job.source)
  } catch (error) {
    throw new JobProblem('decode', String((error as Error)?.message ?? error))
  }
  try {
    const blob = await encodeImage(bitmap, 'image/jpeg')
    return { blob, crc: crc32(new Uint8Array(await blob.arrayBuffer())) }
  } finally {
    bitmap.close()
  }
}
