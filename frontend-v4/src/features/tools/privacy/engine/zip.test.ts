import { describe, expect, it } from 'vitest'
import { crc32 } from './crc32'
import { buildZip, type ZipEntry } from './zip'

// A reader just strict enough to prove the archive is well formed: the end
// record (ZIP64 when present) leads to the central directory, which leads to
// each local header and its data, whose CRC must match.

interface Read {
  name: string
  utf8: boolean
  data: Uint8Array
  crcOk: boolean
}

const u64 = (v: DataView, at: number) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32

/** The four 8-byte fields a ZIP64 extra may hold, in order, for the 32-bit fields that are full. */
function zip64Values(v: DataView, at: number, length: number): number[] {
  const out: number[] = []
  for (let p = at; p < at + length; p += 4 + v.getUint16(p + 2, true)) {
    if (v.getUint16(p, true) !== 0x0001) continue
    for (let q = p + 4; q < p + 4 + v.getUint16(p + 2, true); q += 8) out.push(u64(v, q))
  }
  return out
}

function readZip(bytes: Uint8Array): Read[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  expect(v.getUint32(end, true)).toBe(0x06054b50)
  let count = v.getUint16(end + 10, true)
  let cdOffset = v.getUint32(end + 16, true)
  if (cdOffset === 0xffffffff) {
    const locator = end - 20
    expect(v.getUint32(locator, true)).toBe(0x07064b50)
    const record = u64(v, locator + 8)
    expect(v.getUint32(record, true)).toBe(0x06064b50)
    count = u64(v, record + 32)
    cdOffset = u64(v, record + 48)
  }
  const out: Read[] = []
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50)
    const flags = v.getUint16(at + 8, true)
    const crc = v.getUint32(at + 16, true)
    const nameLength = v.getUint16(at + 28, true)
    const extraLength = v.getUint16(at + 30, true)
    const extra = zip64Values(v, at + 46 + nameLength, extraLength)
    let size = v.getUint32(at + 24, true)
    let local = v.getUint32(at + 42, true)
    if (size === 0xffffffff) {
      extra.shift() // uncompressed, then compressed: the same for stored files
      size = extra.shift()!
    }
    if (local === 0xffffffff) local = extra.shift()!
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    expect(v.getUint32(local, true)).toBe(0x04034b50)
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const data = bytes.subarray(dataAt, dataAt + size)
    out.push({ name, utf8: (flags & 0x0800) !== 0, data, crcOk: crc32(data) === crc })
    at += 46 + nameLength + extraLength + v.getUint16(at + 32, true)
  }
  return out
}

const entry = (name: string, text: string): ZipEntry => {
  const bytes = new TextEncoder().encode(text)
  return { name, data: new Blob([bytes]), crc: crc32(bytes) }
}

describe('zip', () => {
  it('crc32 is the standard one', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('stores each file under its UTF-8 name with a correct CRC', async () => {
    const zip = buildZip([entry('一.png', 'first'), entry('b.jpg', 'second file'), entry('空.png', '')], new Date(2026, 8, 26, 13, 45, 30))
    const files = readZip(new Uint8Array(await zip.arrayBuffer()))
    expect(files.map((f) => f.name)).toEqual(['一.png', 'b.jpg', '空.png'])
    expect(files.every((f) => f.utf8 && f.crcOk)).toBe(true)
    expect(new TextDecoder().decode(files[1]!.data)).toBe('second file')
    expect(zip.type).toBe('application/zip')
  })

  it('switches to ZIP64 where 32-bit fields would overflow', async () => {
    const zip = buildZip([entry('a.png', 'aaaaaaaaaaaaaaaaaaaa'), entry('b.png', 'bbbbbbbbbbbbbbbbbbbbbbbbb')], new Date(), 16)
    const files = readZip(new Uint8Array(await zip.arrayBuffer()))
    expect(files.map((f) => [f.name, new TextDecoder().decode(f.data), f.crcOk])).toEqual([
      ['a.png', 'aaaaaaaaaaaaaaaaaaaa', true],
      ['b.png', 'bbbbbbbbbbbbbbbbbbbbbbbbb', true],
    ])
  })

  it('an empty list is a valid empty archive', async () => {
    expect(readZip(new Uint8Array(await buildZip([]).arrayBuffer()))).toEqual([])
  })
})
