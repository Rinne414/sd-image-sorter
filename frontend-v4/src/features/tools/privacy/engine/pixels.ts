import type { Password } from './password'

// The pixel scramble, ported from V3.5's obfuscate-engine.js and locked to the
// Big Tomato site by backend/tests/assets/obfuscation_reference_golden.json:
// pixels are walked along a generalised Hilbert (Gilbert) curve and each one
// moves a golden-ratio share of the curve further along, `step` times.
//
// Same output as V3.5, lighter: the curve is kept as one Int32Array of pixel
// indices (V3.5 kept a JS array of x/y pairs plus two position arrays) and a
// pixel's four bytes move as one 32-bit word.

export type Pixels = Uint8ClampedArray<ArrayBuffer>

export interface PixelImage {
  data: Pixels
  width: number
  height: number
}

/** Walk one rectangle of the curve, writing pixel indices from `out.at`. */
function generate2d(out: { lin: Int32Array; at: number; width: number }, x: number, y: number, ax: number, ay: number, bx: number, by: number): void {
  const w = Math.abs(ax + ay)
  const h = Math.abs(bx + by)
  const dax = Math.sign(ax)
  const day = Math.sign(ay)
  const dbx = Math.sign(bx)
  const dby = Math.sign(by)

  if (h === 1) {
    for (let i = 0; i < w; i++) {
      out.lin[out.at++] = x + y * out.width
      x += dax
      y += day
    }
    return
  }
  if (w === 1) {
    for (let i = 0; i < h; i++) {
      out.lin[out.at++] = x + y * out.width
      x += dbx
      y += dby
    }
    return
  }

  let ax2 = Math.floor(ax / 2)
  let ay2 = Math.floor(ay / 2)
  let bx2 = Math.floor(bx / 2)
  let by2 = Math.floor(by / 2)
  const w2 = Math.abs(ax2 + ay2)
  const h2 = Math.abs(bx2 + by2)

  if (2 * w > 3 * h) {
    if (w2 & 1 && w > 2) {
      ax2 += dax
      ay2 += day
    }
    generate2d(out, x, y, ax2, ay2, bx, by)
    generate2d(out, x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by)
    return
  }

  if (h2 & 1 && h > 2) {
    bx2 += dbx
    by2 += dby
  }
  generate2d(out, x, y, bx2, by2, ax2, ay2)
  generate2d(out, x + bx2, y + by2, ax, ay, bx - bx2, by - by2)
  generate2d(out, x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby), -bx2, -by2, -(ax - ax2), -(ay - ay2))
}

/** The curve over a width x height image: the i-th pixel it visits, as x + y * width. */
export function curveIndices(width: number, height: number): Int32Array {
  if (width <= 0 || height <= 0) return new Int32Array(0)
  const out = { lin: new Int32Array(width * height), at: 0, width }
  if (width >= height) generate2d(out, 0, 0, width, 0, 0, height)
  else generate2d(out, 0, 0, 0, height, width, 0)
  return out.lin
}

interface Positions {
  lin: Int32Array
  offset: number
}

// A batch is usually one size, and a 40 MP curve is 160 MB: keep the last one only.
let cached: { key: string; positions: Positions } | null = null

function positionsFor(width: number, height: number): Positions {
  const key = `${width}x${height}`
  if (cached?.key === key) return cached.positions
  const total = width * height
  const positions = { lin: curveIndices(width, height), offset: Math.round(((Math.sqrt(5) - 1) / 2) * total) }
  cached = { key, positions }
  return positions
}

const words = (bytes: Uint8ClampedArray<ArrayBuffer>) => new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2)

/**
 * `step` passes; each pass sends the pixel at curve point i to curve point
 * i + offset (encrypt) or back (decrypt). Always returns a new array.
 */
function movePixels(source: Uint8ClampedArray, width: number, height: number, password: Password, forward: boolean): Pixels {
  const { lin, offset } = positionsFor(width, height)
  const total = width * height
  let current: Pixels = new Uint8ClampedArray(source)
  let buffer: Pixels = new Uint8ClampedArray(current.length)
  for (let pass = 0; pass < password.step; pass++) {
    const from = words(current)
    const to = words(buffer)
    // i + offset wraps once, so split the walk there instead of taking a modulo per pixel.
    const split = total - offset
    if (forward) {
      for (let i = 0; i < split; i++) to[lin[i + offset]!] = from[lin[i]!]!
      for (let i = split; i < total; i++) to[lin[i - split]!] = from[lin[i]!]!
    } else {
      for (let i = 0; i < split; i++) to[lin[i]!] = from[lin[i + offset]!]!
      for (let i = split; i < total; i++) to[lin[i]!] = from[lin[i - split]!]!
    }
    const swap = current
    current = buffer
    buffer = swap
  }
  return current
}

export const encryptPixels = (source: Uint8ClampedArray, width: number, height: number, password: Password): Pixels =>
  movePixels(source, width, height, password, true)

export const decryptPixels = (source: Uint8ClampedArray, width: number, height: number, password: Password): Pixels =>
  movePixels(source, width, height, password, false)

/** Grow the image right and down, repeating the last column and row (the password's extra width and height). */
export function addPadding(source: Pixels, width: number, height: number, extraWidth: number, extraHeight: number): PixelImage {
  if (extraWidth === 0 && extraHeight === 0) return { data: source, width, height }
  const nextWidth = width + extraWidth
  const nextHeight = height + extraHeight
  const data: Pixels = new Uint8ClampedArray(nextWidth * nextHeight * 4)
  const from = words(source)
  const to = words(data)
  for (let y = 0; y < nextHeight; y++) {
    for (let x = 0; x < nextWidth; x++) {
      let index: number
      if (y < height && x < width) index = x + y * width
      else if (y < height) index = width - 1 + y * width
      else index = Math.min(x, width - 1) + (height - 1) * width
      to[x + y * nextWidth] = from[index]!
    }
  }
  return { data, width: nextWidth, height: nextHeight }
}

/** Thrown when restoring an image smaller than the border the password says to cut off. */
export class TooSmallError extends Error {
  constructor() {
    super('image smaller than the password border')
    this.name = 'TooSmallError'
  }
}

/** Cut the extra columns and rows off again. */
export function cropPadding(source: Pixels, width: number, height: number, extraWidth: number, extraHeight: number): PixelImage {
  if (extraWidth === 0 && extraHeight === 0) return { data: source, width, height }
  const nextWidth = width - extraWidth
  const nextHeight = height - extraHeight
  if (nextWidth < 1 || nextHeight < 1) throw new TooSmallError()
  const data: Pixels = new Uint8ClampedArray(nextWidth * nextHeight * 4)
  for (let y = 0; y < nextHeight; y++) {
    const at = y * width * 4
    data.set(source.subarray(at, at + nextWidth * 4), y * nextWidth * 4)
  }
  return { data, width: nextWidth, height: nextHeight }
}
