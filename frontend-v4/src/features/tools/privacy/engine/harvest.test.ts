import { describe, expect, it } from 'vitest'
import { extractSourceTextChunksFromBytes, textChunkKeyFor } from './harvest'
import { resolvePassword } from './password'
import { extractPngTextChunksFromBytes, writePngTextChunks, type TextChunk } from './png'
import { repoBytes, repoText } from './testFiles'

// Harvest on the SAME committed fixture files the backend reads in
// backend/tests/test_obfuscation_client_engine_parity.py, with the SAME
// expected table (EXPECTED_HARVEST there), so the V4 engine, V3.5's engine and
// backend/obfuscation.py cannot drift apart.

const A1111_PARAMETERS = [
  'a girl standing in the rain, masterpiece, best quality',
  'Negative prompt: lowres, bad anatomy',
  'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 123456789, Size: 512x768, Model: someModel',
].join('\n')

const EXPECTED_HARVEST: Record<string, TextChunk[]> = {
  'sd-metadata-source.png': [['parameters', A1111_PARAMETERS]],
  'sd-metadata-source.jpg': [['parameters', A1111_PARAMETERS]],
  'sd-metadata-source.webp': [['parameters', A1111_PARAMETERS]],
  'no-metadata-source.png': [],
}

const fixture = (name: string) => repoBytes(`tests/e2e/fixtures/obfuscation/${name}`)

type V35 = { __internals: { extractSourceTextChunksFromBytes: (b: Uint8Array) => TextChunk[] } }
const host: { ObfuscateEngine?: V35 } = {}
new Function('window', repoText('frontend/js/obfuscate-engine.js'))(host)
const v35Harvest = (b: Uint8Array) => host.ObfuscateEngine!.__internals.extractSourceTextChunksFromBytes(b)

// ---- synthetic JPEG / WebP containers, for the EXIF shapes the fixtures do not cover ----

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A little-endian TIFF with ImageDescription in IFD0 and UserComment (type UNDEFINED) in the Exif IFD. */
function tiff(userComment: Uint8Array, description: string | null): Uint8Array {
  const ifd0Count = description === null ? 1 : 2
  const ifd0 = 8
  const sub = ifd0 + 2 + ifd0Count * 12 + 4
  const commentAt = sub + 2 + 12 + 4
  const descBytes = description === null ? new Uint8Array(0) : concat(ascii(description), new Uint8Array([0]))
  const descAt = commentAt + userComment.length
  const out = new Uint8Array(descAt + descBytes.length)
  const v = new DataView(out.buffer)
  out.set(ascii('II'), 0)
  v.setUint16(2, 42, true)
  v.setUint32(4, ifd0, true)
  v.setUint16(ifd0, ifd0Count, true)
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    v.setUint16(at, tag, true)
    v.setUint16(at + 2, type, true)
    v.setUint32(at + 4, count, true)
    v.setUint32(at + 8, value, true)
  }
  entry(ifd0 + 2, 0x8769, 4, 1, sub)
  if (description !== null) entry(ifd0 + 14, 0x010e, 2, descBytes.length, descAt)
  v.setUint16(sub, 1, true)
  entry(sub + 2, 0x9286, 7, userComment.length, commentAt)
  out.set(userComment, commentAt)
  out.set(descBytes, descAt)
  return out
}

function jpegWith(segments: Uint8Array[]): Uint8Array {
  const app1 = segments.map((payload) => {
    const head = new Uint8Array([0xff, 0xe1, 0, 0])
    new DataView(head.buffer).setUint16(2, payload.length + 2, false)
    return concat(head, payload)
  })
  return concat(new Uint8Array([0xff, 0xd8]), ...app1, new Uint8Array([0xff, 0xd9]))
}

function webpWith(chunks: [string, Uint8Array][]): Uint8Array {
  const body = chunks.map(([type, data]) => {
    const head = concat(ascii(type), new Uint8Array(4))
    new DataView(head.buffer).setUint32(4, data.length, true)
    return concat(head, data, new Uint8Array(data.length & 1))
  })
  const riff = concat(ascii('RIFF'), new Uint8Array(4), ascii('WEBP'), ...body)
  new DataView(riff.buffer).setUint32(4, riff.length - 8, true)
  return riff
}

const utf16le = (text: string) => {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) new DataView(out.buffer).setUint16(i * 2, text.charCodeAt(i), true)
  return out
}
const exifHeader = ascii('Exif\u0000\u0000')
const xmpHeader = ascii('http://ns.adobe.com/xap/1.0/\u0000')
const COMFY = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: 1 } } })
const NAI = JSON.stringify({ prompt: '1girl, 银发', uc: 'lowres' })

const SYNTHETIC: Record<string, Uint8Array> = {
  'jpeg unicode LE comment': jpegWith([concat(exifHeader, tiff(concat(ascii('UNICODE\u0000'), utf16le(A1111_PARAMETERS)), null))]),
  'jpeg unicode BOM comment': jpegWith([concat(exifHeader, tiff(concat(ascii('UNICODE\u0000'), new Uint8Array([0xff, 0xfe]), utf16le('中文 prompt')), null))]),
  'jpeg ascii comfy comment': jpegWith([concat(exifHeader, tiff(concat(ascii('ASCII\u0000\u0000\u0000'), new TextEncoder().encode(COMFY)), null))]),
  'jpeg raw nai comment + description': jpegWith([concat(exifHeader, tiff(new TextEncoder().encode(NAI), A1111_PARAMETERS))]),
  'jpeg xmp only': jpegWith([concat(xmpHeader, new TextEncoder().encode(`<x:xmpmeta>${A1111_PARAMETERS}</x:xmpmeta>`))]),
  'webp raw tiff + xmp': webpWith([['VP8L', new Uint8Array(5)], ['EXIF', tiff(ascii('   plain words  '), null)], ['XMP ', new TextEncoder().encode(A1111_PARAMETERS)]]),
  'truncated jpeg': jpegWith([concat(exifHeader, tiff(ascii('x'), null))]).subarray(0, 20),
  garbage: Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff),
}

describe('harvest', () => {
  it.each(Object.keys(EXPECTED_HARVEST))('%s gives the backend table', (name) => {
    expect(extractSourceTextChunksFromBytes(fixture(name))).toEqual(EXPECTED_HARVEST[name])
  })

  it.each(Object.keys(EXPECTED_HARVEST))('%s gives what V3.5 gives', (name) => {
    expect(extractSourceTextChunksFromBytes(fixture(name))).toEqual(v35Harvest(fixture(name)))
  })

  it.each(Object.keys(SYNTHETIC))('synthetic %s gives what V3.5 gives', (name) => {
    const bytes = SYNTHETIC[name]!
    expect(extractSourceTextChunksFromBytes(bytes)).toEqual(v35Harvest(bytes))
  })

  it('reads the EXIF shapes SD tools write', () => {
    expect(extractSourceTextChunksFromBytes(SYNTHETIC['jpeg unicode LE comment']!)).toEqual([['parameters', A1111_PARAMETERS]])
    expect(extractSourceTextChunksFromBytes(SYNTHETIC['jpeg ascii comfy comment']!)).toEqual([['prompt', COMFY]])
    expect(extractSourceTextChunksFromBytes(SYNTHETIC['jpeg raw nai comment + description']!)).toEqual([
      ['Comment', NAI],
      ['parameters', A1111_PARAMETERS],
    ])
    expect(textChunkKeyFor('just words')).toBe('UserComment')
  })

  it('the prompt survives protect then restore at the text level, in every container and both algorithms', () => {
    for (const name of ['sd-metadata-source.png', 'sd-metadata-source.jpg', 'sd-metadata-source.webp']) {
      const pairs = extractSourceTextChunksFromBytes(fixture(name))
      for (const legacyPngInfo of [false, true]) {
        const p = resolvePassword('0512', 'big_tomato')
        const carrier = fixture('no-metadata-source.png')
        const hidden = writePngTextChunks(carrier, pairs, p, { legacyPngInfo })
        const carried = extractPngTextChunksFromBytes(hidden)
        expect(carried[0]![1]).not.toContain('a girl standing in the rain')
        const back = writePngTextChunks(carrier, carried, p, { decryptValues: true, legacyPngInfo })
        expect(extractPngTextChunksFromBytes(back)).toEqual([['parameters', A1111_PARAMETERS]])
      }
    }
  })
})
