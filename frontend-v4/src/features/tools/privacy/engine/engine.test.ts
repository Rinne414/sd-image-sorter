import { describe, expect, it } from 'vitest'
import golden from '../../../../../../backend/tests/assets/obfuscation_reference_golden.json'
import { extractSourceTextChunksFromBytes } from './harvest'
import { passwordKey, parsePassword, resolvePassword, type CompatMode, type Password } from './password'
import { addPadding, cropPadding, curveIndices, decryptPixels, encryptPixels, TooSmallError, type Pixels } from './pixels'
import { extractPngTextChunksFromBytes, writePngTextChunks, type TextChunk } from './png'
import { decryptText, encryptText } from './textCrypto'
import { repoBytes, repoText } from './testFiles'

// The TypeScript engine must stay byte-identical to what Big Tomato and Small
// Tomato produce, and to V3.5's engine (owner requirement). Three locks:
//  1. the golden vectors generated from the saved Big Tomato site JS (the same
//     file the backend parity test reads);
//  2. the harvest table of backend/tests/test_obfuscation_client_engine_parity.py
//     on the same fixture files;
//  3. V3.5's own engine (kept as a test reference in
//     tests/e2e/fixtures/obfuscation/v35-obfuscate-engine.js), run here on many
//     sizes, passwords and texts, compared output for output.

interface V35Engine {
  parsePassword: (raw: string) => Password
  __internals: {
    resolvePassword: (raw: string, compat: string) => Password
    gilbert2d: (w: number, h: number) => number[]
    encryptPixels: (d: Uint8ClampedArray, w: number, h: number, p: Password) => Uint8ClampedArray
    decryptPixels: (d: Uint8ClampedArray, w: number, h: number, p: Password) => Uint8ClampedArray
    addPadding: (d: Uint8ClampedArray, w: number, h: number, ew: number, eh: number) => { data: Uint8ClampedArray; width: number; height: number }
    cropPadding: (d: Uint8ClampedArray, w: number, h: number, ew: number, eh: number) => { data: Uint8ClampedArray; width: number; height: number }
    encryptText: (v: string, key: number[], legacy: boolean) => string
    decryptText: (v: string, key: number[], legacy: boolean) => string
    extractPngTextChunksFromBytes: (b: Uint8Array) => TextChunk[]
    extractSourceTextChunksFromBytes: (b: Uint8Array) => TextChunk[]
    writePngTextChunks: (png: Uint8Array, pairs: TextChunk[], p: Password, o: { decryptValues: boolean; legacyPngInfo: boolean }) => Blob
  }
}

const V35_ENGINE = 'tests/e2e/fixtures/obfuscation/v35-obfuscate-engine.js'

function loadV35(): V35Engine {
  const host: { ObfuscateEngine?: V35Engine } = {}
  new Function('window', repoText(V35_ENGINE))(host)
  if (!host.ObfuscateEngine) throw new Error('V3.5 engine did not load')
  return host.ObfuscateEngine
}

const v35 = loadV35()

const fromB64 = (b64: string): Pixels => Uint8ClampedArray.from(atob(b64), (c) => c.charCodeAt(0))

/** A small seeded generator, so a failure names a case that can be run again. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function noise(width: number, height: number, seed: number): Pixels {
  const next = random(seed)
  return Uint8ClampedArray.from({ length: width * height * 4 }, () => Math.floor(next() * 256))
}

function protect(data: Pixels, w: number, h: number, p: Password) {
  return addPadding(encryptPixels(data, w, h, p), w, h, p.extraWidth, p.extraHeight)
}

function restore(data: Pixels, w: number, h: number, p: Password) {
  const cropped = cropPadding(data, w, h, p.extraWidth, p.extraHeight)
  return decryptPixels(cropped.data, cropped.width, cropped.height, p)
}

describe('engine: Big Tomato golden vectors', () => {
  it.each(golden.pixel_cases.map((c) => [`${c.width}x${c.height} "${c.password}"`, c] as const))('pixels %s are byte-exact both ways', (_, c) => {
    const password = resolvePassword(c.password, 'big_tomato')
    const original = fromB64(c.original_b64)
    const expected = fromB64(c.encrypted_b64)

    const out = protect(original, c.width, c.height, password)
    expect([out.width, out.height]).toEqual([c.encrypted_width, c.encrypted_height])
    expect(Array.from(out.data)).toEqual(Array.from(expected))
    // the site's scrambled bytes come back to the original
    expect(Array.from(restore(expected, c.encrypted_width, c.encrypted_height, password))).toEqual(Array.from(original))
  })

  it.each(golden.text_cases.map((c) => [`key ${c.key.join(',')}: ${c.value.slice(0, 12)}`, c] as const))('text %s, modern and legacy', (_, c) => {
    expect(encryptText(c.value, c.key, false)).toBe(c.modern)
    expect(decryptText(c.modern, c.key, false)).toBe(c.value)
    expect(encryptText(c.value, c.key, true)).toBe(c.legacy)
    expect(decryptText(c.legacy, c.key, true)).toBe(c.value)
  })
})

describe('engine: passwords', () => {
  it('reads digits the way the site does, short and non-numeric ones included', () => {
    expect(parsePassword('')).toEqual({ step: 1, extraWidth: 0, extraHeight: 0 })
    expect(parsePassword('0512')).toEqual({ step: 5, extraWidth: 1, extraHeight: 2 })
    expect(parsePassword('9987')).toEqual({ step: 99, extraWidth: 8, extraHeight: 7 })
    expect(parsePassword('5')).toEqual({ step: 5, extraWidth: 0, extraHeight: 0 })
    expect(parsePassword('00')).toEqual({ step: 1, extraWidth: 0, extraHeight: 0 })
    expect(parsePassword('ab12')).toEqual({ step: 1, extraWidth: 1, extraHeight: 2 })
    expect(parsePassword('12x')).toEqual({ step: 12, extraWidth: 0, extraHeight: 0 })
    expect(passwordKey(parsePassword('1200'))).toEqual([12, 0, 0])
    // Small Tomato has no password: whatever was typed makes no difference
    expect(resolvePassword('0512', 'small_tomato')).toEqual({ step: 1, extraWidth: 0, extraHeight: 0 })
  })

  const RAW = ['', '0', '1', '7', '12', '99', '0512', '9987', '1200', '0099', 'abcd', 'a1b2', '5x', ' 1 2', '-1-2', '1.5e', '٣٤', '12345678', '0x12']
  it.each(RAW)('"%s" parses as in V3.5 in both modes', (raw) => {
    expect(parsePassword(raw)).toEqual(v35.parsePassword(raw))
    for (const mode of ['big_tomato', 'small_tomato'] as CompatMode[]) expect(resolvePassword(raw, mode)).toEqual(v35.__internals.resolvePassword(raw, mode))
  })
})

describe('engine: same output as V3.5', () => {
  it('walks the same curve', () => {
    for (const [w, h] of [[1, 1], [1, 9], [9, 1], [2, 2], [3, 5], [5, 3], [16, 9], [31, 17], [64, 64], [100, 3], [257, 129]] as const) {
      const pairs = v35.__internals.gilbert2d(w, h)
      const expected = Array.from({ length: w * h }, (_, i) => pairs[i * 2]! + pairs[i * 2 + 1]! * w)
      expect(Array.from(curveIndices(w, h)), `${w}x${h}`).toEqual(expected)
    }
  })

  const SIZES = [[1, 1], [1, 7], [7, 1], [2, 3], [5, 7], [16, 9], [9, 16], [31, 17], [64, 64], [123, 77]] as const
  const PASSWORDS = ['', '0', '12', '0512', '9987', '1200', 'ab12', '0199', '3000']
  it.each(SIZES.map(([w, h]) => [`${w}x${h}`, w, h] as const))('pixels %s: protect and restore match for every password', (_, w, h) => {
    const data = noise(w, h, w * 1000 + h)
    for (const raw of PASSWORDS) {
      const p = resolvePassword(raw, 'big_tomato')
      const mine = protect(data, w, h, p)
      const theirs = v35.__internals.addPadding(v35.__internals.encryptPixels(data, w, h, p), w, h, p.extraWidth, p.extraHeight)
      expect([mine.width, mine.height], raw).toEqual([theirs.width, theirs.height])
      expect(Array.from(mine.data), `protect "${raw}"`).toEqual(Array.from(theirs.data))

      const cropped = v35.__internals.cropPadding(theirs.data, theirs.width, theirs.height, p.extraWidth, p.extraHeight)
      const back = v35.__internals.decryptPixels(cropped.data, cropped.width, cropped.height, p)
      expect(Array.from(restore(mine.data, mine.width, mine.height, p)), `restore "${raw}"`).toEqual(Array.from(back))
      expect(Array.from(back)).toEqual(Array.from(data))
    }
  })

  it('refuses to restore an image smaller than the border the password cuts off', () => {
    expect(() => cropPadding(noise(3, 3, 1), 3, 3, 5, 0)).toThrow(TooSmallError)
  })

  const TEXTS = [
    'masterpiece, 1girl, (silver hair:1.2)\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a',
    '杰作，银发少女 中文提示词 {"a": [1, 2]}',
    'emoji 🌸 and astral 𠀋 plus combining é',
    '\u0000\u0001 control\tchars\r\n',
    '',
    'x'.repeat(5000),
  ]
  it.each(TEXTS.map((t) => [t.slice(0, 16), t] as const))('text "%s" matches in both algorithms for many keys', (_, text) => {
    for (const raw of ['', '0512', '9987', '1200', '0199', 'ab12']) {
      const key = passwordKey(resolvePassword(raw, 'big_tomato'))
      for (const legacy of [false, true]) {
        const mine = encryptText(text, key, legacy)
        expect(mine).toBe(v35.__internals.encryptText(text, key, legacy))
        expect(decryptText(mine, key, legacy)).toBe(v35.__internals.decryptText(mine, key, legacy))
      }
    }
  })

  it('writes the same PNG bytes when carrying generation details, both ways and both algorithms', async () => {
    const png = repoBytes('tests/e2e/fixtures/obfuscation/sd-metadata-source.png')
    const pairs = extractSourceTextChunksFromBytes(png)
    expect(pairs.length).toBe(1)
    for (const raw of ['', '0512', '9987']) {
      const p = resolvePassword(raw, 'big_tomato')
      for (const decryptValues of [false, true]) {
        for (const legacyPngInfo of [false, true]) {
          const mine = writePngTextChunks(png, pairs, p, { decryptValues, legacyPngInfo })
          const theirs = new Uint8Array(await v35.__internals.writePngTextChunks(png, pairs, p, { decryptValues, legacyPngInfo }).arrayBuffer())
          expect(Array.from(mine), `${raw} ${decryptValues} ${legacyPngInfo}`).toEqual(Array.from(theirs))
          expect(extractPngTextChunksFromBytes(mine)).toEqual(v35.__internals.extractPngTextChunksFromBytes(theirs))
        }
      }
    }
  })
})
