import { describe, expect, it } from 'vitest'
import { groupTags } from '../../lib/tagGroups'
import { dragPayload, INTERNAL_DRAG, mimeOf } from './drag'
import { imageAtQuery, randomOffset } from './random'

describe('random image request', () => {
  it('draws an offset across the whole result, not just the loaded page', () => {
    expect(randomOffset(10_000, () => 0)).toBe(0)
    expect(randomOffset(10_000, () => 0.99999)).toBe(9_999)
    // far past the 240 a first page holds
    expect(randomOffset(10_000, () => 0.5)).toBe(5_000)
    expect(randomOffset(0, () => 0.5)).toBe(-1)
  })

  it('asks for one image at that offset with the same filter and sort', () => {
    const params = { search: 'silver', generators: 'nai', sort_by: 'aesthetic', tags: 'smile' }
    expect(imageAtQuery(params, 4321)).toEqual({ ...params, limit: 1, offset: 4321 })
  })
})

describe('dragging a card out', () => {
  it('carries the full-size file as DownloadURL (mime:name:url) and as a URL', () => {
    const data = dragPayload({ id: 42, filename: 'ComfyUI_00012_.png' }, 'http://127.0.0.1:8487')
    expect(data.DownloadURL).toBe('image/png:ComfyUI_00012_.png:http://127.0.0.1:8487/api/image-file/42')
    expect(data['text/uri-list']).toBe('http://127.0.0.1:8487/api/image-file/42')
    expect(data['text/plain']).toBe('http://127.0.0.1:8487/api/image-file/42')
    expect(data[INTERNAL_DRAG]).toBe('42')
  })

  it('names the type from the extension and keeps the name usable', () => {
    expect(mimeOf('a.WEBP')).toBe('image/webp')
    expect(mimeOf('b.jpeg')).toBe('image/jpeg')
    expect(mimeOf('noext')).toBe('image/png')
    expect(dragPayload({ id: 1, filename: 'odd:name.jpg' }, 'http://x').DownloadURL).toBe('image/jpeg:odd_name.jpg:http://x/api/image-file/1')
  })
})

describe('tags by category', () => {
  it('folds the 14 categories into 7 groups, each tag once, unknown ones unclassified', () => {
    const cat: Record<string, 'character' | 'outfit' | 'pose' | 'artist' | 'rating'> = {
      '1girl': 'character',
      dress: 'outfit',
      sitting: 'pose',
      'artist name': 'artist',
      general: 'rating',
    }
    const g = groupTags(['1girl', 'dress', 'sitting', 'artist name', 'general', 'mystery', '1girl'], (t) => cat[t])
    expect(g.appearance).toEqual(['1girl'])
    expect(g.clothing).toEqual(['dress'])
    expect(g.pose).toEqual(['sitting'])
    expect(g.style).toEqual(['artist name'])
    expect(g.qualityMeta).toEqual(['general'])
    expect(g.unclassified).toEqual(['mystery'])
    expect(g.scenery).toEqual([])
  })
})
