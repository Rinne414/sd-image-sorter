import { extractPngTextChunksFromBytes, isPngBytes, type TextChunk } from './png'

// The generation details a source image carries, whatever its container,
// ported from V3.5's obfuscate-engine.js (which mirrors
// extract_source_text_chunks_from_bytes in backend/obfuscation.py; both are
// pinned to the same table by test_obfuscation_client_engine_parity.py). The
// result is always a PNG, so a JPEG's or WebP's EXIF/XMP prompt is re-keyed to
// the PNG text key the parsers read.

// Mirrors _MAX_CARRIED_TEXT_BYTES in backend/obfuscation.py: real A1111 blocks
// are a few kB, an XMP packet this big is broken or hostile.
const MAX_CARRIED_TEXT_BYTES = 1024 * 1024
const XMP_APP1_HEADER = 'http://ns.adobe.com/xap/1.0/\u0000'
const EXIF_APP1_HEADER = 'Exif\u0000\u0000'
const TAG_IMAGE_DESCRIPTION = 0x010e
const TAG_SUB_IFD_POINTER = 0x8769
const TAG_USER_COMMENT = 0x9286
const TYPE_ASCII = 2
const TYPE_LONG = 4
const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function startsWith(bytes: Uint8Array, ascii: string, offset = 0): boolean {
  if (bytes.length < offset + ascii.length) return false
  for (let i = 0; i < ascii.length; i++) if (bytes[offset + i] !== (ascii.charCodeAt(i) & 0xff)) return false
  return true
}

function decodeLatin1(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!)
  return text
}

// Pillow's TIFF reader drops one trailing NUL and decodes ASCII tags as
// latin-1; matching it keeps the harvested value identical on both sides.
function decodeTiffAscii(bytes: Uint8Array): string {
  const end = bytes.length && bytes[bytes.length - 1] === 0 ? bytes.length - 1 : bytes.length
  return decodeLatin1(bytes.subarray(0, end))
}

function stripNullsAndSpaces(text: string): string {
  let start = 0
  let end = text.length
  const trimmable = (char: string | undefined) => char === '\u0000' || char === ' '
  while (start < end && trimmable(text[start])) start += 1
  while (end > start && trimmable(text[end - 1])) end -= 1
  return text.slice(start, end)
}

function decodeUtf16(payload: Uint8Array): string {
  if (payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xfe) return new TextDecoder('utf-16le').decode(payload)
  if (payload.length >= 2 && payload[0] === 0xfe && payload[1] === 0xff) return new TextDecoder('utf-16be').decode(payload)
  if (payload.length >= 2 && payload[1] === 0x00) return new TextDecoder('utf-16le').decode(payload)
  return new TextDecoder('utf-16be').decode(payload)
}

/** An EXIF UserComment the way SD tools write it (mirrors _decode_exif_user_comment). */
export function decodeExifUserComment(value: string | Uint8Array): string {
  if (typeof value === 'string') {
    const text = value.startsWith('ASCII') || value.startsWith('UNICODE') ? value.slice(7) : value
    return stripNullsAndSpaces(text)
  }
  let text: string
  if (startsWith(value, 'UNICODE\u0000')) text = decodeUtf16(value.subarray(8))
  else if (startsWith(value, 'ASCII\u0000\u0000\u0000') || startsWith(value, '\u0000'.repeat(8))) text = decoder.decode(value.subarray(8))
  else text = decoder.decode(value)
  return stripNullsAndSpaces(text)
}

const isNode = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && 'class_type' in value

/** The PNG text key that carries `text` back to the parser (mirrors _text_chunk_key_for); unknown text still travels, as UserComment. */
export function textChunkKeyFor(text: string): string {
  const stripped = String(text || '').trim()
  if (stripped.includes('Steps:') && stripped.includes('Sampler:')) return 'parameters'
  if (stripped.startsWith('{')) {
    let payload: unknown
    try {
      payload = JSON.parse(stripped)
    } catch {
      return 'UserComment'
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (Object.values(payload).some(isNode)) return 'prompt'
      if ('prompt' in payload && 'uc' in payload) return 'Comment'
    }
  }
  return 'UserComment'
}

interface Containers {
  tiff: Uint8Array | null
  xmp: string
}

function jpegContainers(bytes: Uint8Array): Containers {
  const found: Containers = { tiff: null, xmp: '' }
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // Entropy-coded data starts at SOS; nothing past it is a segment.
    if (marker === 0xd9 || marker === 0xda) break
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    if (length < 2 || offset + 2 + length > bytes.length) break
    if (marker === 0xe1) {
      const payload = bytes.subarray(offset + 4, offset + 2 + length)
      if (!found.tiff && startsWith(payload, EXIF_APP1_HEADER)) found.tiff = payload.subarray(EXIF_APP1_HEADER.length)
      else if (!found.xmp && startsWith(payload, XMP_APP1_HEADER)) found.xmp = decoder.decode(payload.subarray(XMP_APP1_HEADER.length))
    }
    offset += 2 + length
  }
  return found
}

function webpContainers(bytes: Uint8Array): Containers {
  const found: Containers = { tiff: null, xmp: '' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = decodeLatin1(bytes.subarray(offset, offset + 4))
    const length = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + length > bytes.length) break
    const payload = bytes.subarray(start, start + length)
    if (type === 'EXIF' && !found.tiff) found.tiff = startsWith(payload, EXIF_APP1_HEADER) ? payload.subarray(EXIF_APP1_HEADER.length) : payload
    else if (type === 'XMP ' && !found.xmp) found.xmp = decoder.decode(payload)
    // RIFF pads odd-sized chunks to an even boundary.
    offset = start + length + (length & 1)
  }
  return found
}

/** The raw TIFF block and XMP packet of a JPEG (APP1) or WebP (RIFF chunks). */
function findExifTiffAndXmp(bytes: Uint8Array): Containers {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegContainers(bytes)
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) return webpContainers(bytes)
  return { tiff: null, xmp: '' }
}

interface ExifText {
  userComment: string | Uint8Array | null
  imageDescription: string | null
}

type Visit = (tag: number, type: number, value: Uint8Array) => void

function readExifTextTags(tiff: Uint8Array | null): ExifText {
  const tags: ExifText = { userComment: null, imageDescription: null }
  if (!tiff || tiff.length < 8) return tags
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const order = view.getUint16(0, false)
  if (order !== 0x4949 && order !== 0x4d4d) return tags
  const little = order === 0x4949
  if (view.getUint16(2, little) !== 42) return tags

  const visitIfd = (ifdOffset: number, visit: Visit) => {
    if (!ifdOffset || ifdOffset < 8 || ifdOffset + 2 > tiff.length) return
    const count = view.getUint16(ifdOffset, little)
    for (let index = 0; index < count; index++) {
      const entry = ifdOffset + 2 + index * 12
      if (entry + 12 > tiff.length) return
      const type = view.getUint16(entry + 2, little)
      const size = (TYPE_SIZES[type] || 0) * view.getUint32(entry + 4, little)
      if (!size) continue
      // Values of four bytes or fewer sit inline in the entry itself.
      const at = size > 4 ? view.getUint32(entry + 8, little) : entry + 8
      if (at + size > tiff.length) continue
      visit(view.getUint16(entry, little), type, tiff.subarray(at, at + size))
    }
  }

  let subIfd = 0
  visitIfd(view.getUint32(4, little), (tag, type, value) => {
    if (tag === TAG_IMAGE_DESCRIPTION && type === TYPE_ASCII) tags.imageDescription = decodeTiffAscii(value)
    else if (tag === TAG_SUB_IFD_POINTER && type === TYPE_LONG && value.length >= 4) subIfd = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, little)
  })
  visitIfd(subIfd, (tag, type, value) => {
    if (tag === TAG_USER_COMMENT) tags.userComment = type === TYPE_ASCII ? decodeTiffAscii(value) : value.slice()
  })
  return tags
}

const isA1111 = (text: string) => text.includes('Steps:') && text.includes('Sampler:')

/** SD metadata a JPEG or WebP carries in EXIF or XMP. */
function harvestNonPngTextChunks(bytes: Uint8Array): TextChunk[] {
  const chunks: TextChunk[] = []
  const seen = new Set<string>()
  const add = (key: string, text: string) => {
    const cleaned = String(text || '').trim()
    if (!cleaned || encoder.encode(cleaned).length > MAX_CARRIED_TEXT_BYTES || seen.has(key)) return
    seen.add(key)
    chunks.push([key, cleaned])
  }

  let containers: Containers
  let tags: ExifText
  try {
    containers = findExifTiffAndXmp(bytes)
    tags = readExifTextTags(containers.tiff)
  } catch {
    // An unreadable source or a malformed Exif IFD simply carries nothing.
    return chunks
  }

  if (tags.userComment && tags.userComment.length) {
    const decoded = decodeExifUserComment(tags.userComment)
    if (decoded) add(textChunkKeyFor(decoded), decoded)
  }
  if (typeof tags.imageDescription === 'string' && isA1111(tags.imageDescription)) add('parameters', tags.imageDescription)
  if (containers.xmp && isA1111(containers.xmp)) add('parameters', containers.xmp)
  return chunks
}

/** PNG sources keep their tEXt/iTXt verbatim; JPEG and WebP carry theirs in EXIF or XMP. */
export function extractSourceTextChunksFromBytes(bytes: Uint8Array): TextChunk[] {
  return isPngBytes(bytes) ? extractPngTextChunksFromBytes(bytes) : harvestNonPngTextChunks(bytes)
}
