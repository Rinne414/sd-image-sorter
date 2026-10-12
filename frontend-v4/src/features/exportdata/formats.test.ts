import { describe, expect, test } from 'vitest'
import { buildExportText, EXPORT_FORMATS, fileExtension, type ExportImage } from './formats'

const a: ExportImage = {
  id: 1,
  filename: 'a.png',
  generator: 'nai',
  prompt: '1girl, smile',
  negative_prompt: 'lowres',
  ai_caption: 'A girl smiling.',
  tags: ['smile', '1girl'],
  checkpoint: 'NAI v4.5',
  width: 832,
  height: 1216,
  aesthetic_score: 6.1,
  generation_params: { steps: 28, sampler: 'k_euler', seed: 7, cfg_scale: 5, zeta: 'x' },
}
const b: ExportImage = { ...a, id: 2, filename: 'b.png', prompt: 'solo, "quoted", comma', negative_prompt: '', ai_caption: '', tags: ['solo'], generation_params: {} }

describe('buildExportText', () => {
  test('prompts: blank line between images; numbered adds filenames', () => {
    expect(buildExportText([a, b], 'prompt')).toBe('1girl, smile\n\nsolo, "quoted", comma')
    expect(buildExportText([a, b], 'prompt_numbered')).toBe('1. a.png\n1girl, smile\n\n2. b.png\nsolo, "quoted", comma')
  })

  test('negative and prompt+negative skip what is empty', () => {
    expect(buildExportText([a, b], 'negative')).toBe('lowres')
    expect(buildExportText([a, b], 'prompt_negative')).toBe('1girl, smile\nNegative prompt: lowres\n\nsolo, "quoted", comma')
  })

  test('A1111 block: known parameters in WebUI order, the rest by name, then size and model', () => {
    expect(buildExportText([a], 'a1111')).toBe(
      '1girl, smile\nNegative prompt: lowres\nSteps: 28, Sampler: k_euler, CFG scale: 5, Seed: 7, Size: 832x1216, Model: NAI v4.5, Zeta: x',
    )
  })

  test('tags: every distinct tag once, sorted', () => {
    expect(buildExportText([a, b], 'tags')).toBe('1girl, smile, solo')
  })

  test('caption lines drop repeats case-insensitively', () => {
    expect(buildExportText([a], 'caption_tags')).toBe('A girl smiling., smile, 1girl')
    expect(buildExportText([{ ...a, tags: ['Smile', '1girl, smile'] }], 'caption_merged')).toBe('A girl smiling., 1girl, smile')
  })

  test('JSONL: one object per line with size and model folded into the parameters', () => {
    const line = JSON.parse(buildExportText([b], 'jsonl'))
    expect(line).toMatchObject({ id: 2, filename: 'b.png', tags: ['solo'], generation_params: { model: 'NAI v4.5', size: '832x1216' } })
  })

  test('CSV quotes fields with commas, quotes or line breaks', () => {
    const csv = buildExportText([b], 'csv').split('\n')
    expect(csv[0]).toBe('id,filename,generator,prompt,negative_prompt,ai_caption,tags,checkpoint,width,height')
    expect(csv[1]).toBe('2,b.png,nai,"solo, ""quoted"", comma",,,solo,NAI v4.5,832,1216')
  })

  test('every format has a file extension', () => {
    for (const f of EXPORT_FORMATS) expect(['txt', 'jsonl', 'csv']).toContain(fileExtension(f))
    expect(fileExtension('csv')).toBe('csv')
  })
})
