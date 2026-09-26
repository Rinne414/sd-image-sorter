import { describe, expect, it } from 'vitest'
import samples from './readerSamples.json'
import { fromDetail, fromParse, promptLoraWeight, readHashes, readRecord, type ParseResult, type ReaderView } from './readerAdapter'
import type { ImageDetail } from '../../../api/types'

// readerSamples.json: four real files (tests/e2e/fixtures/v4_reader_samples.py
// --json), each read the two ways the Reader gets an image: POST
// /api/parse-image for a dropped file, and the row a library scan stores.

type Sample = { parse: unknown; detail: unknown }
const all = samples as Record<string, Sample>

/** Everything but the LoRA weight lookup, which is a function. */
function comparable(v: ReaderView) {
  const { loraWeight: _drop, ...info } = v.info
  return { ...v, info }
}

const bothWays = (name: string) => {
  const s = all[name] as Sample
  return [readRecord(fromParse(s.parse as ParseResult)), readRecord(fromDetail(s.detail as ImageDetail))] as const
}

describe('readerAdapter', () => {
  it.each(['comfyui', 'a1111', 'nai', 'webp'])('an upload and the library row of %s read the same', (name) => {
    const [upload, library] = bothWays(name)
    expect(comparable(upload)).toEqual(comparable(library))
  })

  it('reads ComfyUI parameters, model and LoRA strengths', () => {
    const [view] = bothWays('comfyui')
    expect(view.generator).toBe('comfyui')
    expect(view.gen).toMatchObject({ seed: '20260926', steps: '24', cfg: '6.5', sampler: 'euler', scheduler: 'karras', size: '96×64' })
    expect(view.gen.model).toBe('v4reader_comfy_model.safetensors')
    expect(view.gen.loras).toEqual(['v4reader_style_lora.safetensors'])
    expect(view.info.loraWeight('v4reader_style_lora')).toBe('0.8 / 0.6')
    expect(view.negative).toBe('lowres, v4reader comfy negative')
  })

  it('reads A1111 hashes, the LoRA weight in the prompt and the extra settings', () => {
    const [view] = bothWays('a1111')
    expect(view.generator).toBe('webui')
    expect(view.hashes.model).toBe('0a1b2c3d4e')
    expect(view.hashes.loras).toEqual([{ name: 'v4reader_detail', hash: '9f8e7d6c5b4a' }])
    expect(view.info.modelHash).toBe('0a1b2c3d4e')
    expect(promptLoraWeight(view.prompt, 'v4reader_detail')).toBe('0.7')
    expect(view.gen.extra.map(([k]) => k)).toEqual(expect.arrayContaining(['clip_skip', 'version']))
  })

  it('reads NovelAI characters with their place and negative', () => {
    const [view] = bothWays('nai')
    expect(view.generator).toBe('nai')
    expect(view.gen.characters).toEqual([
      { index: 0, prompt: 'girl, red hair, smile', negative: 'bad hands', center: { x: 0.3, y: 0.5 } },
      { index: 1, prompt: 'girl, blue hair, wave', negative: 'extra fingers', center: { x: 0.7, y: 0.5 } },
    ])
    expect(view.sourceFormat).toBe('nai')
  })

  it('reads a WebP whose parameters sit in EXIF', () => {
    const [view] = bothWays('webp')
    expect(view.prompt).toContain('v4reader webp prompt')
    expect(view.gen).toMatchObject({ seed: '777', steps: '20', model: 'v4reader_webp_model' })
  })

  it('an unknown generator is no generator', () => {
    const view = readRecord(fromParse({ generator: 'unknown', prompt: null, negative_prompt: null, checkpoint: null, loras: [], width: 10, height: 10, file_size: 5, metadata: {} }))
    expect(view.generator).toBeNull()
    expect(view.prompt).toBe('')
    expect(view.gen.size).toBe('10×10')
  })
})

describe('readHashes', () => {
  it('splits quoted A1111 hash lists and keeps embeddings apart', () => {
    expect(readHashes({ model_hash: 'aa', lora_hashes: '"one: 11, two: 22"', ti_hashes: 'emb: 33' })).toEqual({
      model: 'aa',
      loras: [
        { name: 'one', hash: '11' },
        { name: 'two', hash: '22' },
      ],
      embeddings: [{ name: 'emb', hash: '33' }],
    })
    expect(readHashes({})).toEqual({ model: null, loras: [], embeddings: [] })
  })
})
