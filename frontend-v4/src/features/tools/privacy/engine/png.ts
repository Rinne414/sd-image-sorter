import { crc32 } from './crc32'
import { passwordKey, type Password } from './password'
import { decryptText, encryptText } from './textCrypto'

// PNG text chunks, ported from V3.5's obfuscate-engine.js: read tEXt/iTXt
// pairs, and write them back (encrypted or decrypted) as tEXt chunks in front
// of the first IDAT, the way the Big Tomato site does.

export type TextChunk = [key: string, value: string]

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false
  return SIGNATURE.every((b, i) => bytes[i] === b)
}

const readUint32BE = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false)

interface Chunk {
  type: Uint8Array
  data: Uint8Array
}

/** Every chunk after the signature, as long as the file holds together. */
function readChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = []
  let offset = SIGNATURE.length
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) break
    chunks.push({ type: bytes.subarray(offset + 4, offset + 8), data: bytes.subarray(dataStart, dataEnd) })
    offset = dataEnd + 4
  }
  return chunks
}

const typeName = (type: Uint8Array) => String.fromCharCode(...type)

/** The (key, value) of each tEXt/iTXt chunk that has both. */
export function extractPngTextChunksFromBytes(bytes: Uint8Array): TextChunk[] {
  if (!isPngBytes(bytes)) return []
  const pairs: TextChunk[] = []
  for (const chunk of readChunks(bytes)) {
    const type = typeName(chunk.type)
    if (type !== 'tEXt' && type !== 'iTXt') continue
    const parts = decoder.decode(chunk.data).split('\u0000')
    if (parts.length < 2) continue
    const key = parts[0]
    const value = parts[parts.length - 1]
    if (key && value) pairs.push([key, value])
  }
  return pairs
}

/** Signature, then each chunk as length, type, data and CRC, written straight into one buffer. */
function assemble(chunks: readonly Chunk[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + 12 + c.data.length, SIGNATURE.length))
  const view = new DataView(out.buffer)
  out.set(SIGNATURE, 0)
  let at = SIGNATURE.length
  for (const { type, data } of chunks) {
    view.setUint32(at, data.length, false)
    out.set(type, at + 4)
    out.set(data, at + 8)
    view.setUint32(at + 8 + data.length, crc32(out.subarray(at + 4, at + 8 + data.length)), false)
    at += 12 + data.length
  }
  return out
}

export interface WriteTextOptions {
  /** true when restoring: the carried values are decrypted. */
  decryptValues?: boolean
  legacyPngInfo?: boolean
}

/** The PNG with these text pairs (encrypted, or decrypted when restoring) put in front of its first IDAT. */
export function writePngTextChunks(png: Uint8Array, pairs: readonly TextChunk[], password: Password, options: WriteTextOptions = {}): Uint8Array<ArrayBuffer> {
  const { decryptValues = false, legacyPngInfo = false } = options
  if (!isPngBytes(png)) throw new Error('Not a PNG file')
  const chunks = readChunks(png)
  const key = passwordKey(password)
  const tEXt = encoder.encode('tEXt')
  const textChunks = pairs.map(([name, value]) => {
    const text = decryptValues ? decryptText(value, key, legacyPngInfo) : encryptText(value, key, legacyPngInfo)
    const nameBytes = encoder.encode(name)
    const valueBytes = encoder.encode(text)
    const data = new Uint8Array(nameBytes.length + 1 + valueBytes.length)
    data.set(nameBytes, 0)
    data.set(valueBytes, nameBytes.length + 1)
    return { type: tEXt, data }
  })
  const idat = chunks.findIndex((c) => typeName(c.type) === 'IDAT')
  const at = idat >= 0 ? idat : chunks.length
  return assemble([...chunks.slice(0, at), ...textChunks, ...chunks.slice(at)])
}
