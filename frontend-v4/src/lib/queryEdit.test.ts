import { describe, expect, test } from 'vitest'
import { addPrompt, addTags, isAnyOf, isKey, onlyWith, replaceTokens, setPromptMode, setTagMode, toggleToken, valueOf } from './queryEdit'
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

describe('match modes written by the filter panel', () => {
  test('tags: "any" folds every required tag into one list, "all" splits it back', () => {
    const any = setTagMode('silver tag:a -tag:x tag:b', 'or')
    expect(any).toBe('silver tag:a|b -tag:x')
    expect(setTagMode(any, 'and')).toBe('silver tag:a tag:b -tag:x')
    // a mixed line that warned becomes one list
    expect(setTagMode('tag:1girl tag:cat|fox', 'or')).toBe('tag:1girl|cat|fox')
    expect(setTagMode('tag:"long hair" tag:cat', 'or')).toBe('tag:"long hair|cat"')
  })

  test('tags: adding keeps the mode the line is in, and skips ones already there', () => {
    expect(addTags('x', ['a', 'b'], 'and')).toBe('x tag:a tag:b')
    expect(addTags('x tag:a', ['a', 'c'], 'and')).toBe('x tag:a tag:c')
    expect(addTags('tag:a|b', ['c'], 'or')).toBe('tag:a|b|c')
    expect(addTags('', ['long hair', 'cat'], 'or')).toBe('tag:"long hair|cat"')
  })

  test('prompt: "contains" stars every term, "exact" removes the stars', () => {
    const on = setPromptMode('prompt:smile -prompt:"long hair" silver', 'contains')
    expect(on).toBe('prompt:*smile* -prompt:"*long hair*" silver')
    expect(setPromptMode(on, 'exact')).toBe('prompt:smile -prompt:"long hair" silver')
    expect(addPrompt('x', 'blue eyes', 'contains')).toBe('x prompt:"*blue eyes*"')
    expect(addPrompt('x', 'smile', 'exact')).toBe('x prompt:smile')
  })
})
