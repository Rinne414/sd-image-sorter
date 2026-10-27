import { describe, expect, test } from 'vitest'
import { readRepairCounts } from './repairCounts'

describe('what the repair can work on', () => {
  test('reads the images without text and the ComfyUI images', () => {
    const health = { totals: { missing_text: 12, missing_prompt: 400 }, generators: [{ generator: 'webui', total: 5 }, { generator: 'comfyui', total: 33 }] }
    expect(readRepairCounts(health)).toEqual({ missingText: 12, comfy: 33 })
  })

  test('an answer without those parts counts as none', () => {
    expect(readRepairCounts({})).toEqual({ missingText: 0, comfy: 0 })
    expect(readRepairCounts(null)).toEqual({ missingText: 0, comfy: 0 })
    expect(readRepairCounts({ totals: { missing_text: 'x' }, generators: [null, { generator: 'comfyui' }] })).toEqual({ missingText: 0, comfy: 0 })
  })
})
