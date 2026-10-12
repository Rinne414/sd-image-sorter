import { describe, expect, it } from 'vitest'
import { HUGE_PIXELS, isHuge, megapixels, sniffImageSize } from './imageSize'
import { repoBytes } from './testFiles'

const bytesOf = (...parts: number[][]) => new Uint8Array(parts.flat())
const le16 = (n: number) => [n & 0xff, n >> 8]
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
const be16 = (n: number) => [n >> 8, n & 0xff]
const text = (s: string) => [...s].map((c) => c.charCodeAt(0))

describe('imageSize', () => {
  it.each(['sd-metadata-source.png', 'sd-metadata-source.jpg', 'sd-metadata-source.webp'])('reads %s (24 x 24)', (name) => {
    expect(sniffImageSize(repoBytes(`tests/e2e/fixtures/obfuscation/${name}`))).toEqual({ width: 24, height: 24 })
  })

  it('finds a JPEG frame after a large APP segment and skips the table markers', () => {
    const app = [0xff, 0xe1, ...be16(2 + 300), ...new Array<number>(300).fill(7)]
    const dht = [0xff, 0xc4, ...be16(5), 0, 0, 0]
    const sof = [0xff, 0xc2, ...be16(11), 8, ...be16(6000), ...be16(8000), 3, 0, 0]
    expect(sniffImageSize(bytesOf([0xff, 0xd8], app, dht, sof))).toEqual({ width: 8000, height: 6000 })
  })

  it('reads the three WebP flavours, GIF and BMP', () => {
    const riff = (chunk: number[]) => bytesOf(text('RIFF'), le32(4 + chunk.length), text('WEBP'), chunk)
    const vp8 = [...text('VP8 '), ...le32(20), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1920), ...le16(1080), ...new Array<number>(10).fill(0)]
    expect(sniffImageSize(riff(vp8))).toEqual({ width: 1920, height: 1080 })
    const bits = (1024 - 1) | ((768 - 1) << 14)
    const vp8l = [...text('VP8L'), ...le32(10), 0x2f, ...le32(bits), ...new Array<number>(5).fill(0)]
    expect(sniffImageSize(riff(vp8l))).toEqual({ width: 1024, height: 768 })
    const vp8x = [...text('VP8X'), ...le32(10), 0, 0, 0, 0, ...[(9000 - 1) & 0xff, ((9000 - 1) >> 8) & 0xff, 0], ...[(5000 - 1) & 0xff, ((5000 - 1) >> 8) & 0xff, 0]]
    expect(sniffImageSize(riff(vp8x))).toEqual({ width: 9000, height: 5000 })
    expect(sniffImageSize(bytesOf(text('GIF89a'), le16(320), le16(200)))).toEqual({ width: 320, height: 200 })
    expect(sniffImageSize(bytesOf(text('BM'), new Array<number>(16).fill(0), le32(640), le32(-480 >>> 0)))).toEqual({ width: 640, height: 480 })
  })

  it('says nothing about bytes it does not know', () => {
    expect(sniffImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull()
    expect(sniffImageSize(bytesOf([0xff, 0xd8, 0xff, 0xda, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('above 40 MP is huge (a warning, never a refusal)', () => {
    expect(HUGE_PIXELS).toBe(40_000_000)
    expect(isHuge({ width: 8000, height: 5000 })).toBe(false)
    expect(isHuge({ width: 8000, height: 5001 })).toBe(true)
    expect(isHuge(null)).toBe(false)
    expect(megapixels({ width: 9000, height: 5000 })).toBe(45)
  })
})
