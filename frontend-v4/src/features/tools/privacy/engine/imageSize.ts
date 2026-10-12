// An image's width and height from its first bytes, so a very large image is
// flagged before it is processed (D31: above 40 MP warn, never refuse).
// Covers what the queue is fed in practice: PNG, JPEG, WebP, GIF, BMP.

export interface Size {
  width: number
  height: number
}

/** Above this many pixels an image gets a warning (slow, memory hungry), never a refusal. */
export const HUGE_PIXELS = 40_000_000

/** How much of a file to read to find its size (JPEG's size sits after its EXIF/XMP/ICC). */
export const SIZE_PROBE_BYTES = 1 << 20

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))

function jpegSize(bytes: Uint8Array, view: DataView): Size | null {
  let at = 2
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(at + 7, false), height: view.getUint16(at + 5, false) }
    }
    if (marker === 0xda || marker === 0xd9) return null
    at += 2 + view.getUint16(at + 2, false)
  }
  return null
}

function webpSize(bytes: Uint8Array, view: DataView): Size | null {
  if (bytes.length < 30) return null
  if (ascii(bytes, 12, 'VP8 ')) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  if (ascii(bytes, 12, 'VP8L')) {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(bytes, 12, 'VP8X')) {
    const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
    return { width: u24(24) + 1, height: u24(27) + 1 }
  }
  return null
}

export function sniffImageSize(bytes: Uint8Array): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG') && ascii(bytes, 12, 'IHDR')) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view)
  if (bytes.length >= 16 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return webpSize(bytes, view)
  if (bytes.length >= 10 && ascii(bytes, 0, 'GIF8')) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes.length >= 26 && ascii(bytes, 0, 'BM')) return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
  return null
}

export const megapixels = (s: Size): number => (s.width * s.height) / 1_000_000
export const isHuge = (s: Size | null): boolean => !!s && s.width * s.height > HUGE_PIXELS
