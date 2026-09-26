import { describe, expect, test } from 'vitest'
import { parseSearch } from '../../../lib/searchQuery'
import { activeValues, hasEntry, quoteValue, toggleEntry } from './lexiconQuery'

// A click in 词库 only edits the library's search text: it adds the entry as
// a filter, or takes it out again when it is already there. Values with a
// space or a colon are quoted so they stay one token.

describe('lexicon: the search text', () => {
  test('values with a space or a colon are quoted; quotes inside are dropped', () => {
    expect(quoteValue('long_hair')).toBe('long_hair')
    expect(quoteValue('best quality')).toBe('"best quality"')
    expect(quoteValue('style:v2')).toBe('"style:v2"')
    expect(quoteValue(' say "hi"  there ')).toBe('"say hi there"')
  })

  test('a tag is added as tag:, then taken out by a second click', () => {
    const once = toggleEntry('silver', 'tags', 'long_hair')
    expect(once).toBe('silver tag:long_hair')
    expect(hasEntry(once, 'tags', 'long_hair')).toBe(true)
    expect(hasEntry(once, 'tags', 'LONG HAIR')).toBe(true)
    expect(toggleEntry(once, 'tags', 'long_hair')).toBe('silver')
  })

  test('in any-of mode the tag joins the one tag:a|b token, and leaves it', () => {
    const added = toggleEntry('tag:cat_ears|fox_ears', 'tags', 'wolf_ears')
    expect(added).toBe('tag:cat_ears|fox_ears|wolf_ears')
    expect(parseSearch(added).tags).toEqual(['cat_ears', 'fox_ears', 'wolf_ears'])
    expect(toggleEntry(added, 'tags', 'fox_ears')).toBe('tag:cat_ears|wolf_ears')
  })

  test('a prompt word follows the prompt mode the search already uses', () => {
    expect(toggleEntry('', 'prompts', 'best quality')).toBe('prompt:"best quality"')
    const contains = toggleEntry('prompt:*hair*', 'prompts', 'best quality')
    expect(contains).toBe('prompt:*hair* prompt:"*best quality*"')
    expect(hasEntry(contains, 'prompts', 'best quality')).toBe(true)
    expect(toggleEntry(contains, 'prompts', 'best quality')).toBe('prompt:*hair*')
  })

  test('a LoRA or a model is added as its own filter, quoted when it has a space or colon', () => {
    const lora = toggleEntry('tag:1girl', 'loras', 'style:v2')
    expect(lora).toBe('tag:1girl lora:"style:v2"')
    expect(parseSearch(lora).loras).toEqual(['style:v2'])
    const model = toggleEntry('', 'checkpoints', 'NovelAI Diffusion V4.5')
    expect(model).toBe('checkpoint:"NovelAI Diffusion V4.5"')
    expect(parseSearch(model).checkpoints).toEqual(['NovelAI Diffusion V4.5'])
    expect(toggleEntry(model, 'checkpoints', 'novelai diffusion v4.5')).toBe('')
  })

  test('an excluded entry does not count as there; adding keeps the exclusion', () => {
    expect(hasEntry('-tag:blurry', 'tags', 'blurry')).toBe(false)
    expect(toggleEntry('-lora:x', 'loras', 'y')).toBe('-lora:x lora:y')
  })

  test('the entries the search holds, to mark in the list', () => {
    const text = 'tag:cat_ears|Fox_Ears lora:detailer -lora:bad prompt:"*best quality*"'
    expect([...activeValues(text, 'tags')]).toEqual(['cat ears', 'fox ears'])
    expect([...activeValues(text, 'loras')]).toEqual(['detailer'])
    expect([...activeValues(text, 'prompts')]).toEqual(['best quality'])
    expect(activeValues(text, 'checkpoints').size).toBe(0)
  })
})
