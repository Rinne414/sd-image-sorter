import { describe, expect, test } from 'vitest'
import { artistName, percent, summarize, tierOf } from './artistSummary'

// What a finished run says: one image names its artist (or says why not);
// several are counted by tier, and a run with no confident match says why.

const say = (key: string, params?: Record<string, string | number>) => `${key}${params ? ' ' + JSON.stringify(params) : ''}`

describe('style run summary', () => {
  test('the tier: the backend word, else only a real name counts as confident', () => {
    expect(tierOf({ image_id: 1, artist: 'wlop', confidence: 0.5, confidence_level: 'high' })).toBe('high')
    expect(tierOf({ image_id: 1, artist: 'undefined', confidence: 0.1, confidence_level: 'LOW' })).toBe('low')
    expect(tierOf({ image_id: 1, artist: 'wlop', confidence: 0.5 })).toBe('high')
    expect(tierOf({ image_id: 1, artist: 'undefined', confidence: 0.1 })).toBe('none')
  })

  test('one image, confident: its artist and how sure', () => {
    const s = summarize([{ image_id: 1, artist: 'greg_rutkowski', confidence: 0.784, confidence_level: 'high' }], 0, say)
    expect(s).toEqual({ text: 'artist.job.one.high {"name":"greg rutkowski","pct":"78%"}', tone: 'info' })
  })

  test('one image, unconfirmed: the candidate, said to be a guess', () => {
    const s = summarize([{ image_id: 1, artist: 'undefined', confidence: 0.12, confidence_level: 'low', candidate_artist: 'wlop' }], 0, say)
    expect(s.text).toBe('artist.job.one.low {"name":"wlop","pct":"12%"}')
  })

  test('one image, no match', () => {
    expect(summarize([{ image_id: 1, artist: 'undefined', confidence: 0.01, confidence_level: 'none' }], 0, say).text).toBe('artist.job.one.none')
  })

  test('several: counted by tier, failures added', () => {
    const results = [
      { image_id: 1, artist: 'a', confidence: 0.5, confidence_level: 'high' },
      { image_id: 2, artist: 'undefined', confidence: 0.1, confidence_level: 'low', candidate_artist: 'b' },
      { image_id: 3, artist: 'undefined', confidence: 0.01, confidence_level: 'none' },
    ]
    const s = summarize(results, 2, say)
    expect(s.text).toBe('artist.job.many {"n":3,"high":1,"low":1,"none":1}artist.job.failedSuffix {"n":2}')
    expect(s.tone).toBe('error')
  })

  test('several, none confident: says the artists are probably not in the vocabulary', () => {
    const results = [
      { image_id: 1, artist: 'undefined', confidence: 0.1, confidence_level: 'low', candidate_artist: 'b' },
      { image_id: 2, artist: 'undefined', confidence: 0.01, confidence_level: 'none' },
    ]
    expect(summarize(results, 0, say).text).toBe('artist.job.noneConfident {"n":2}')
  })

  test('nothing identified at all: every image failed', () => {
    expect(summarize([], 3, say)).toEqual({ text: 'artist.job.allFailed {"n":3}', tone: 'error' })
    expect(summarize([], 0, say)).toEqual({ text: 'artist.job.empty', tone: 'info' })
  })

  test('names read with spaces; the no-name word is never shown as a name', () => {
    expect(artistName('ask_(askzy)')).toBe('ask (askzy)')
    expect(artistName('undefined')).toBe('')
    expect(percent(0.2)).toBe('20%')
    expect(percent(0.0049)).toBe('0.5%')
  })
})
