import { describe, expect, it } from 'vitest'
import type { TagCategory } from '../../../api/types'
import { arrangeByGroup, cleanTags, isDirective, lookupKey, mergeInto, splitPrompt } from './buildCleanup'

const CATS: Record<string, TagCategory> = {
  '1girl': 'character',
  'silver hair': 'body',
  smile: 'expression',
  'school uniform': 'outfit',
  standing: 'pose',
  'night sky': 'background',
  masterpiece: 'quality',
  'best quality': 'quality',
  'watercolor (medium)': 'style',
}
const categoryOf = (key: string) => CATS[key]

describe('splitPrompt', () => {
  it('splits on commas outside brackets and LoRA directives, collapsing spaces', () => {
    expect(splitPrompt('1girl,  (silver hair, smile:1.2) ,<lora:my_style:0.8>, ,night   sky\nstanding')).toEqual([
      '1girl',
      '(silver hair, smile:1.2)',
      '<lora:my_style:0.8>',
      'night sky standing',
    ])
  })

  it('keeps the inside of a LoRA directive exactly', () => {
    expect(splitPrompt('<lora:a  b:0.5>')).toEqual(['<lora:a  b:0.5>'])
  })
})

describe('cleanTags', () => {
  it('drops repeats ignoring case, but keeps every LoRA directive', () => {
    const tags = ['1girl', '1GIRL', 'smile', '<lora:x:0.5>', '<lora:x:0.5>', 'Smile']
    expect(cleanTags(tags)).toEqual(['1girl', 'smile', '<lora:x:0.5>', '<lora:x:0.5>'])
  })

  it('turns underscores into spaces outside LoRA directives only', () => {
    expect(cleanTags(['silver_hair', '<lora:my_style_v2:0.8>', 'school_uniform'], { spaces: true })).toEqual([
      'silver hair',
      '<lora:my_style_v2:0.8>',
      'school uniform',
    ])
  })

  it('a tag written with and without underscores counts once when spaces are asked for', () => {
    expect(cleanTags(['silver_hair', 'silver hair'], { spaces: true })).toEqual(['silver hair'])
  })
})

describe('lookupKey', () => {
  it('looks a weighted or bracketed tag up by its bare words', () => {
    expect(lookupKey('(silver_hair:1.2)')).toBe('silver hair')
    expect(lookupKey('{{smile}}')).toBe('smile')
    expect(lookupKey('1.3::night sky::')).toBe('night sky')
  })

  it('has nothing to look up for a LoRA directive', () => {
    expect(isDirective('<lora:x:0.5>')).toBe(true)
    expect(lookupKey('<lora:x:0.5>')).toBe('')
  })
})

describe('arrangeByGroup', () => {
  const prompt = ['masterpiece', '<lora:x:0.5>', 'night sky', 'mystery tag', '(silver hair:1.2)', 'standing', '1girl', 'best quality', 'school uniform']

  it('orders by group (appearance, clothing, pose, scenery, style, quality, unclassified), by category inside a group, LoRA last', () => {
    expect(arrangeByGroup(prompt, categoryOf, { dropQuality: false })).toEqual([
      '1girl',
      '(silver hair:1.2)',
      'school uniform',
      'standing',
      'night sky',
      'masterpiece',
      'best quality',
      'mystery tag',
      '<lora:x:0.5>',
    ])
  })

  it('puts a tag the prompt marks as an artist (artist:name) with style, whatever the lookup says', () => {
    expect(arrangeByGroup(['mystery tag', '1.3::artist:hoshi::', 'masterpiece', '1girl'], categoryOf, { dropQuality: true })).toEqual(['1girl', '1.3::artist:hoshi::', 'mystery tag'])
  })

  it('can leave quality and meta words out, keeping LoRA and unclassified words', () => {
    expect(arrangeByGroup(prompt, categoryOf, { dropQuality: true })).toEqual([
      '1girl',
      '(silver hair:1.2)',
      'school uniform',
      'standing',
      'night sky',
      'mystery tag',
      '<lora:x:0.5>',
    ])
  })
})

describe('mergeInto', () => {
  it('adds only the words the text does not have yet (case and underscores ignored)', () => {
    expect(mergeInto('1girl, silver hair', ['silver_hair', 'Smile', '1GIRL'])).toEqual({ text: '1girl, silver hair, Smile', added: 1 })
  })

  it('starts an empty text', () => {
    expect(mergeInto('', ['a', 'b'])).toEqual({ text: 'a, b', added: 2 })
  })
})
