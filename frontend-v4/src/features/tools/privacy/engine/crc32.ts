// CRC-32 (IEEE, the one PNG and ZIP use). V3.5 computed it bit by bit; a
// lookup table gives the same value eight times faster, which matters for a
// 60 MB PNG.

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** Continue a running CRC over more bytes (start from 0). */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export const crc32 = (bytes: Uint8Array): number => crc32Update(0, bytes)
