import { describe, expect, test } from 'vitest'
import { fromPayload, shownRows, type LexRow } from './lexiconRows'

// Each of the four library endpoints answers its own field names; the list
// shows every row (no cap), found by part of a name and ordered by images or A-Z.

describe('lexicon rows', () => {
  test('each endpoint becomes name, filter value and count; a model filters by its short name', () => {
    expect(fromPayload('tags', { tags: [{ tag: 'long_hair', count: 3 }], total: 1 })).toEqual([{ name: 'long_hair', value: 'long_hair', count: 3 }])
    expect(fromPayload('prompts', { prompts: [{ prompt: 'best quality', count: 2 }] })).toEqual([{ name: 'best quality', value: 'best quality', count: 2 }])
    expect(fromPayload('loras', { loras: [{ lora: 'detailer', count: 5 }, { lora: '', count: 1 }] })).toEqual([{ name: 'detailer', value: 'detailer', count: 5 }])
    expect(fromPayload('checkpoints', { checkpoints: [{ checkpoint: 'models/noob.safetensors', checkpoint_normalized: 'noob', count: 4 }] })).toEqual([
      { name: 'models/noob.safetensors', value: 'noob', count: 4 },
    ])
    expect(fromPayload('tags', null)).toEqual([])
  })

  const rows: LexRow[] = [
    { name: 'long_hair', value: 'long_hair', count: 5 },
    { name: 'Blue eyes', value: 'Blue eyes', count: 9 },
    { name: 'hair_ornament', value: 'hair_ornament', count: 5 },
    { name: 'smile', value: 'smile', count: 1 },
  ]

  test('by images (ties by name), or A-Z ignoring case and underscores', () => {
    expect(shownRows(rows, { find: '', sort: 'count' }).map((r) => r.name)).toEqual(['Blue eyes', 'hair_ornament', 'long_hair', 'smile'])
    expect(shownRows(rows, { find: '', sort: 'name' }).map((r) => r.name)).toEqual(['Blue eyes', 'hair_ornament', 'long_hair', 'smile'])
  })

  test('finding matches part of a name, spaces and underscores alike', () => {
    expect(shownRows(rows, { find: 'HAIR', sort: 'count' }).map((r) => r.name)).toEqual(['hair_ornament', 'long_hair'])
    expect(shownRows(rows, { find: 'long hair', sort: 'count' }).map((r) => r.name)).toEqual(['long_hair'])
    expect(shownRows(rows, { find: 'blue_eyes', sort: 'count' }).map((r) => r.name)).toEqual(['Blue eyes'])
  })

  test('a category keeps only its tags; the whole list has no cap', () => {
    const categories = new Map([['long_hair', 'body'], ['smile', 'expression'], ['hair_ornament', 'body']])
    expect(shownRows(rows, { find: '', sort: 'count', category: 'body', categories }).map((r) => r.name)).toEqual(['hair_ornament', 'long_hair'])
    const many = Array.from({ length: 5000 }, (_, i) => ({ name: `t${i}`, value: `t${i}`, count: i }))
    expect(shownRows(many, { find: '', sort: 'count' })).toHaveLength(5000)
  })
})
