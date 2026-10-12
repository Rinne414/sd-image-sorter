// "全部下载 (.zip)": a stored (uncompressed) ZIP, since PNG and JPEG are already
// compressed. The files stay Blobs, so a big batch is never copied into one
// buffer. Unlike V3.5's writer it marks names as UTF-8 (Chinese names open
// correctly in Windows Explorer) and switches to ZIP64 past 4 GB instead of
// writing a broken archive.

export interface ZipEntry {
  name: string
  data: Blob
  /** CRC-32 of `data`, worked out where the bytes were made. */
  crc: number
}

const LIMIT_32 = 0xffffffff
const LIMIT_16 = 0xffff
const UTF8_NAMES = 0x0800
const encoder = new TextEncoder()

type Bytes = Uint8Array<ArrayBuffer>

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function setUint64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 2 ** 32, true)
  view.setUint32(at + 4, Math.floor(value / 2 ** 32), true)
}

/** A ZIP64 extra field holding these 8-byte values (empty when none are needed). */
function zip64Extra(values: number[]): Bytes {
  if (values.length === 0) return new Uint8Array(0)
  const extra = new Uint8Array(4 + values.length * 8)
  const view = new DataView(extra.buffer)
  view.setUint16(0, 0x0001, true)
  view.setUint16(2, values.length * 8, true)
  values.forEach((v, i) => setUint64(view, 4 + i * 8, v))
  return extra
}

interface Fields {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  stamp: { time: number; date: number }
  limit: number
}

function localHeader(f: Fields): Bytes {
  const big = f.size >= f.limit
  const extra = zip64Extra(big ? [f.size, f.size] : [])
  const out = new Uint8Array(30 + f.name.length + extra.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x04034b50, true)
  v.setUint16(4, big ? 45 : 20, true)
  v.setUint16(6, UTF8_NAMES, true)
  v.setUint16(8, 0, true) // stored
  v.setUint16(10, f.stamp.time, true)
  v.setUint16(12, f.stamp.date, true)
  v.setUint32(14, f.crc, true)
  v.setUint32(18, big ? LIMIT_32 : f.size, true)
  v.setUint32(22, big ? LIMIT_32 : f.size, true)
  v.setUint16(26, f.name.length, true)
  v.setUint16(28, extra.length, true)
  out.set(f.name, 30)
  out.set(extra, 30 + f.name.length)
  return out
}

function centralHeader(f: Fields): Bytes {
  const bigSize = f.size >= f.limit
  const bigOffset = f.offset >= f.limit
  const extra = zip64Extra([...(bigSize ? [f.size, f.size] : []), ...(bigOffset ? [f.offset] : [])])
  const version = bigSize || bigOffset ? 45 : 20
  const out = new Uint8Array(46 + f.name.length + extra.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x02014b50, true)
  v.setUint16(4, version, true)
  v.setUint16(6, version, true)
  v.setUint16(8, UTF8_NAMES, true)
  v.setUint16(10, 0, true)
  v.setUint16(12, f.stamp.time, true)
  v.setUint16(14, f.stamp.date, true)
  v.setUint32(16, f.crc, true)
  v.setUint32(20, bigSize ? LIMIT_32 : f.size, true)
  v.setUint32(24, bigSize ? LIMIT_32 : f.size, true)
  v.setUint16(28, f.name.length, true)
  v.setUint16(30, extra.length, true)
  // comment length, disk, internal and external attributes stay 0
  v.setUint32(42, bigOffset ? LIMIT_32 : f.offset, true)
  out.set(f.name, 46)
  out.set(extra, 46 + f.name.length)
  return out
}

function endRecords(count: number, size: number, offset: number, limit: number): Bytes[] {
  const needs64 = count >= LIMIT_16 || size >= limit || offset >= limit
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, needs64 ? LIMIT_16 : count, true)
  e.setUint16(10, needs64 ? LIMIT_16 : count, true)
  e.setUint32(12, needs64 ? LIMIT_32 : size, true)
  e.setUint32(16, needs64 ? LIMIT_32 : offset, true)
  if (!needs64) return [end]

  const record = new Uint8Array(56)
  const r = new DataView(record.buffer)
  r.setUint32(0, 0x06064b50, true)
  setUint64(r, 4, 44)
  r.setUint16(12, 45, true)
  r.setUint16(14, 45, true)
  setUint64(r, 24, count)
  setUint64(r, 32, count)
  setUint64(r, 40, size)
  setUint64(r, 48, offset)
  const locator = new Uint8Array(20)
  const l = new DataView(locator.buffer)
  l.setUint32(0, 0x07064b50, true)
  setUint64(l, 8, offset + size)
  l.setUint32(16, 1, true)
  return [record, locator, end]
}

/**
 * The archive of these files, in order. `limit` is where 32-bit fields run out
 * (tests lower it to exercise ZIP64 without writing 4 GB).
 */
export function buildZip(entries: readonly ZipEntry[], when: Date = new Date(), limit: number = LIMIT_32): Blob {
  const stamp = dosTime(when)
  const parts: BlobPart[] = []
  const central: Bytes[] = []
  let offset = 0
  for (const entry of entries) {
    const f: Fields = { name: encoder.encode(entry.name), crc: entry.crc, size: entry.data.size, offset, stamp, limit }
    const local = localHeader(f)
    parts.push(local, entry.data)
    central.push(centralHeader(f))
    offset += local.length + f.size
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0)
  parts.push(...central, ...endRecords(entries.length, centralSize, offset, limit))
  return new Blob(parts, { type: 'application/zip' })
}
