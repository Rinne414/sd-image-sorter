import { describe, expect, test } from 'vitest'
import { insertTag, mergeOptions, nextActive, placeList, tokenAt, wantsSuggestions, withSeries } from './tagSuggest'

describe('the tag being typed', () => {
  test('in a comma list: from the comma before the caret to the next one, spaces around it left out', () => {
    expect(tokenAt('smile, long ha', 14, 'list')).toEqual({ text: 'long ha', start: 7, end: 14 })
    expect(tokenAt('smile,lo', 8, 'list')).toEqual({ text: 'lo', start: 6, end: 8 })
    expect(tokenAt('a\nbl', 4, 'list')).toEqual({ text: 'bl', start: 2, end: 4 })
    expect(tokenAt('微笑，长', 4, 'list')).toEqual({ text: '长', start: 3, end: 4 })
  })

  test('with the caret inside a tag, what is typed so far is asked for and the whole tag is replaced', () => {
    expect(tokenAt('smile, long hair, red', 9, 'list')).toEqual({ text: 'lo', start: 7, end: 16 })
    expect(tokenAt('smile, long hair  , red', 16, 'list')).toEqual({ text: 'long hair', start: 7, end: 16 })
  })

  test('one tag per field: the whole field is the tag', () => {
    expect(tokenAt('  long ha', 9, 'single')).toEqual({ text: 'long ha', start: 2, end: 9 })
  })

  test('writing a prompt: the word under the caret, between spaces, brackets, weights and commas', () => {
    expect(tokenAt('masterpiece, (blue sk', 21, 'insert')).toEqual({ text: 'sk', start: 19, end: 21 })
    expect(tokenAt('(smil:1.2)', 5, 'insert')).toEqual({ text: 'smil', start: 1, end: 5 })
    expect(tokenAt('{{lon}}', 5, 'insert')).toEqual({ text: 'lon', start: 2, end: 5 })
  })
})

describe('when the list is asked for', () => {
  test('two letters, or one Chinese / Japanese character for the vocabulary with aliases', () => {
    expect(wantsSuggestions('l', 'global')).toBe(false)
    expect(wantsSuggestions('lo', 'global')).toBe(true)
    expect(wantsSuggestions('长', 'global')).toBe(true)
    expect(wantsSuggestions('长', 'library')).toBe(false)
    expect(wantsSuggestions('长发', 'library')).toBe(true)
  })

  test('a weight or a number is not a tag', () => {
    expect(wantsSuggestions('1.2', 'global')).toBe(false)
    expect(wantsSuggestions('12', 'global')).toBe(false)
    expect(wantsSuggestions('1girl', 'global')).toBe(true)
  })
})

describe('taking a suggestion', () => {
  test('in a comma list: the typed part becomes the tag, and ", " waits for the next one', () => {
    expect(insertTag('smile, long ha', tokenAt('smile, long ha', 14, 'list'), ['long hair'], 'list')).toEqual({ value: 'smile, long hair, ', caret: 18 })
    expect(insertTag('lo', tokenAt('lo', 2, 'list'), ['long hair'], 'list')).toEqual({ value: 'long hair, ', caret: 11 })
  })

  test('after a comma with no space, a space is put in', () => {
    expect(insertTag('smile,lo', tokenAt('smile,lo', 8, 'list'), ['long hair'], 'list').value).toBe('smile, long hair, ')
  })

  test('in the middle of the list: the tag replaces the one under the caret, and no second comma is added', () => {
    const value = 'smile, lo, red'
    expect(insertTag(value, tokenAt(value, 9, 'list'), ['long hair'], 'list')).toEqual({ value: 'smile, long hair, red', caret: 16 })
    const lines = 'smile\nlo\nred'
    expect(insertTag(lines, tokenAt(lines, 8, 'list'), ['long hair'], 'list').value).toBe('smile\nlong hair\nred')
  })

  test('spaces after the last tag do not pile up', () => {
    expect(insertTag('lo   ', tokenAt('lo   ', 2, 'list'), ['long hair'], 'list').value).toBe('long hair, ')
  })

  test('a character and its series go in together', () => {
    expect(insertTag('hat', tokenAt('hat', 3, 'list'), ['hatsune miku', 'vocaloid'], 'list').value).toBe('hatsune miku, vocaloid, ')
  })

  test('one tag per field: the field becomes the tag, nothing added', () => {
    expect(insertTag('long ha', tokenAt('long ha', 7, 'single'), ['long hair'], 'single')).toEqual({ value: 'long hair', caret: 9 })
  })

  test('writing a prompt: only the word is completed, the rest of the text stays as it was', () => {
    const value = 'masterpiece, (blue sk:1.2), smile'
    expect(insertTag(value, tokenAt(value, 21, 'insert'), ['sky'], 'insert')).toEqual({ value: 'masterpiece, (blue sky:1.2), smile', caret: 22 })
  })
})

describe('the series that comes with a character', () => {
  test('its series is added unless the field has it already (case, spaces and underscores ignored)', () => {
    expect(withSeries('hatsune miku', 'vocaloid', 'smile, hat')).toEqual(['hatsune miku', 'vocaloid'])
    expect(withSeries('hatsune miku', 'vocaloid', 'Vocaloid, hat')).toEqual(['hatsune miku'])
    expect(withSeries('kiana kaslana', 'honkai (series), honkai impact 3rd', 'honkai_(series), ki')).toEqual(['kiana kaslana', 'honkai impact 3rd'])
  })

  test('a tag with no series is just the tag', () => {
    expect(withSeries('smile', null, '')).toEqual(['smile'])
    expect(withSeries('smile', '', '')).toEqual(['smile'])
  })
})

describe('what the list offers', () => {
  test('preferred tags that start with what is typed come first; each tag once; the typed tag itself is not offered', () => {
    const found = [{ value: 'long_hair', count: 9 }, { value: 'long sleeves', count: 5 }, { value: 'lo', count: 1 }]
    expect(mergeOptions('lo', ['long hair', 'blue sky'], found).map((o) => o.value)).toEqual(['long hair', 'long sleeves'])
  })
})

describe('moving in the list', () => {
  test('↓ and ↑ go round from the last to the first and back', () => {
    expect(nextActive(0, 3, 'ArrowDown')).toBe(1)
    expect(nextActive(2, 3, 'ArrowDown')).toBe(0)
    expect(nextActive(0, 3, 'ArrowUp')).toBe(2)
    expect(nextActive(0, 0, 'ArrowDown')).toBe(0)
  })
})

describe('where the list goes', () => {
  const view = { width: 1366, height: 768 }

  test('under the field, as wide as it (at least 240 px), inside the window', () => {
    expect(placeList({ left: 100, top: 200, bottom: 228, width: 300 }, view)).toEqual({ left: 100, top: 230, bottom: null, width: 300, maxHeight: 280 })
    expect(placeList({ left: 100, top: 200, bottom: 228, width: 120 }, view).width).toBe(240)
    expect(placeList({ left: 1300, top: 200, bottom: 228, width: 60 }, view).left).toBe(1366 - 8 - 240)
  })

  test('above the field when there is more room there than below', () => {
    expect(placeList({ left: 100, top: 600, bottom: 700, width: 300 }, view)).toEqual({ left: 100, top: null, bottom: 170, width: 300, maxHeight: 280 })
  })

  test('below, cut to the room left, when it fits neither way in full', () => {
    const small = { width: 1366, height: 400 }
    expect(placeList({ left: 0, top: 150, bottom: 178, width: 300 }, small)).toMatchObject({ top: 180, maxHeight: 212 })
  })
})

describe('a caption written as text: the word at the caret', () => {
  test('the word under the caret is asked for, never the words around it', () => {
    expect(tokenAt('1girl, a girl with lon', 22, 'caption')).toEqual({ text: 'lon', start: 19, end: 22 })
    expect(tokenAt('smile, lo', 9, 'caption')).toEqual({ text: 'lo', start: 7, end: 9 })
    expect(tokenAt('smile, long_ha', 14, 'caption')).toEqual({ text: 'long_ha', start: 7, end: 14 })
  })

  test('a word that is a whole tag of the list: the tag goes in and ", " waits for the next one', () => {
    const value = 'smile, lo'
    expect(insertTag(value, tokenAt(value, 9, 'caption'), ['long hair'], 'caption')).toEqual({ value: 'smile, long hair, ', caret: 18 })
    const middle = 'smile, lo, red'
    expect(insertTag(middle, tokenAt(middle, 9, 'caption'), ['long hair'], 'caption')).toEqual({ value: 'smile, long hair, red', caret: 16 })
    expect(insertTag('smile,lo', tokenAt('smile,lo', 8, 'caption'), ['long hair'], 'caption').value).toBe('smile, long hair, ')
    const lines = 'smile\nlo'
    expect(insertTag(lines, tokenAt(lines, 8, 'caption'), ['long hair'], 'caption').value).toBe('smile\nlong hair, ')
  })

  test('a word inside a sentence: only the word changes; the words and commas around it stay as they were', () => {
    const value = '1girl, a girl with lon standing, smile'
    expect(insertTag(value, tokenAt(value, 22, 'caption'), ['long hair'], 'caption')).toEqual({ value: '1girl, a girl with long hair standing, smile', caret: 28 })
    const end = 'a girl with lon'
    expect(insertTag(end, tokenAt(end, 15, 'caption'), ['long hair'], 'caption')).toEqual({ value: 'a girl with long hair', caret: 21 })
    const first = 'lon standing'
    expect(insertTag(first, tokenAt(first, 3, 'caption'), ['long hair'], 'caption').value).toBe('long hair standing')
  })
})
