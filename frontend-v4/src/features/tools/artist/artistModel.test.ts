import { describe, expect, test } from 'vitest'
import { artistModelState, artistRows, parseNames, withArtist } from './artistModel'

describe('style tool: the model and the vocabulary check', () => {
  test('Kaloscope ready, missing, or waiting for a restart', () => {
    expect(artistModelState([{ id: 'artist', status: 'ready', available: true }])).toBe('ready')
    expect(artistModelState([{ id: 'artist', status: 'missing', available: false }])).toBe('download')
    expect(artistModelState([{ id: 'artist', status: 'needs_restart', available: false }])).toBe('restart')
    // no card (an old backend): the run tries and the backend says what is missing
    expect(artistModelState([{ id: 'wd14', status: 'ready' }])).toBe('ready')
    expect(artistModelState(undefined)).toBe('ready')
  })

  test('names split on commas of either width, 、 and new lines, each once, with no cap', () => {
    expect(parseNames(' wlop, ask_(askzy)，米山舞、wlop\nsakimichan ,, ')).toEqual(['wlop', 'ask_(askzy)', '米山舞', 'sakimichan'])
    expect(parseNames('  ')).toEqual([])
    expect(parseNames(Array.from({ length: 30 }, (_, i) => `a${i}`).join(','))).toHaveLength(30)
  })

  test('an artist becomes the only artist filter; the rest of the search stays, a name with a space is quoted', () => {
    expect(withArtist('', 'wlop')).toBe('artist:wlop')
    expect(withArtist('tag:1girl artist:old score>=6', 'ask_(askzy)')).toBe('tag:1girl score>=6 artist:ask_(askzy)')
    expect(withArtist('tag:1girl', 'some one')).toBe('tag:1girl artist:"some one"')
  })

  test('artists by images, then by name; candidates without the no-name word', () => {
    const stats = {
      total_images: 10, identified_images: 6, undefined_count: 1, confident_count: 4, low_confidence_count: 1, confident_threshold: 0.2,
      artist_counts: { b: 2, a: 2, c: 0 },
      artist_stats: { a: { count: 2, avg_confidence: 0.5, max_confidence: 0.7 } },
      low_confidence_artist_counts: { undefined: 3, d: 1 },
    }
    const rows = artistRows(stats)
    expect(rows.confident.map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(rows.confident[0]).toEqual({ name: 'a', count: 2, avg: 0.5, peak: 0.7 })
    expect(rows.confident[1]).toMatchObject({ avg: null, peak: null })
    expect(rows.candidates).toEqual([{ name: 'd', count: 1, avg: null, peak: null }])
    expect(artistRows(undefined)).toEqual({ confident: [], candidates: [] })
  })
})
