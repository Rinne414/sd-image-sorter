import { describe, expect, it } from 'vitest'
import { parseSearch } from '../../../lib/searchQuery'
import { withCheckpoint, withRecipe, withTag } from './libraryLinks'

describe('"筛到图库" edits only the search text', () => {
  it('adds a tag and keeps what the search already had', () => {
    expect(withTag('generator:nai score:>6', 'silver_hair')).toBe('generator:nai score:>6 tag:silver_hair')
  })

  it('quotes a tag with spaces so it stays one tag', () => {
    const text = withTag('', 'silver hair')
    expect(text).toBe('tag:"silver hair"')
    expect(parseSearch(text).tags).toEqual(['silver hair'])
  })

  it('does not add a tag the search already requires', () => {
    expect(withTag('tag:smile', 'smile')).toBe('tag:smile')
  })

  it('follows an "any of" tag search', () => {
    expect(withTag('tag:a|b', 'c')).toBe('tag:a|b|c')
  })

  it('a model replaces any model filter already there, by its file name', () => {
    expect(withCheckpoint('checkpoint:old -checkpoint:bad tag:x', 'models/Stable/animagine-xl-4.0.safetensors')).toBe('tag:x checkpoint:animagine-xl-4.0')
  })

  it('a recipe sets the model and adds its tags', () => {
    const text = withRecipe('', 'noob v1', ['1girl', 'smile'])
    const q = parseSearch(text)
    expect(q.checkpoints).toEqual(['noob v1'])
    expect(q.tags).toEqual(['1girl', 'smile'])
  })
})
