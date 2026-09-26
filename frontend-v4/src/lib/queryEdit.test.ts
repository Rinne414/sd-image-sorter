import { describe, expect, test } from 'vitest'
import { isAnyOf, isKey, onlyWith, replaceTokens, toggleToken, valueOf } from './queryEdit'
import { parseSearch } from './searchQuery'

describe('query editing', () => {
  test('replace one filter, keep everything else in order', () => {
    expect(replaceTokens('silver ★3 tag:smile', isKey('stars'), ['★5'])).toBe('silver tag:smile ★5')
    expect(replaceTokens('silver 星级>=2', isKey('stars'), [])).toBe('silver')
  })

  test('only the matching value goes: no:caption survives clearing no:params', () => {
    const text = 'no:params no:caption'
    const next = replaceTokens(text, isAnyOf(isKey('has', 'params'), isKey('no', 'params')), ['has:params'])
    expect(next).toBe('no:caption has:params')
  })

  test('toggle adds when absent and removes when present, aliases included', () => {
    expect(toggleToken('a', isKey('rating', 'general'), 'rating:general')).toBe('a rating:general')
    expect(toggleToken('a 分级:普通', isKey('rating', 'general'), 'rating:general')).toBe('a')
  })

  test('valueOf reads what the panel should show', () => {
    expect(valueOf(parseSearch('aspect:竖图').parts, 'aspect')).toBe('portrait')
    expect(valueOf(parseSearch('x').parts, 'aspect')).toBeNull()
  })
})

describe('filter by one model or LoRA (clicked on the card)', () => {
  test('adds the filter and keeps the rest of the query', () => {
    expect(onlyWith('silver tag:smile', 'checkpoint', 'noobai_v1')).toBe('silver tag:smile checkpoint:noobai_v1')
  })

  test('names with spaces are quoted so they stay one token', () => {
    const next = onlyWith('', 'checkpoint', 'NovelAI Diffusion V4 37442FCA')
    expect(next).toBe('checkpoint:"NovelAI Diffusion V4 37442FCA"')
    expect(parseSearch(next).checkpoints).toEqual(['NovelAI Diffusion V4 37442FCA'])
  })

  test('replaces an earlier filter of the same kind, including an exclusion, and never repeats itself', () => {
    expect(onlyWith('a lora:old -lora:detail model:x', 'lora', 'detail')).toBe('a model:x lora:detail')
    expect(onlyWith('lora:detail', 'lora', 'detail')).toBe('lora:detail')
  })

  test('a stray quote in a name cannot break the query', () => {
    expect(parseSearch(onlyWith('', 'lora', 'my "best" lora')).loras).toEqual(['my best lora'])
  })
})
