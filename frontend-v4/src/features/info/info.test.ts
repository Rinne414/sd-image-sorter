import { describe, expect, test } from 'vitest'
import { createRaster } from '../censor/raster'
import { aestheticModelState, unscoredParams } from './scoring'
import { binsPeak, channelBins, histogramLine, readColorFacts } from './colors'

describe('colour histogram of the thumbnail', () => {
  const raster = () => {
    // two red pixels, one grey, one transparent (ignored)
    const r = createRaster(2, 2)
    r.data.set([255, 0, 0, 255, 255, 0, 0, 255, 128, 128, 128, 255, 9, 9, 9, 0])
    return r
  }

  test('counts each channel and luma, skipping transparent pixels', () => {
    const bins = channelBins(raster())
    expect(bins.r[255]).toBe(2)
    expect(bins.g[0]).toBe(2)
    expect(bins.r[128]).toBe(1)
    expect(bins.l[76]).toBe(2) // 0.299 * 255
    expect(bins.l[128]).toBe(1)
    expect(bins.r[9]).toBe(0)
  })

  test('the scale leaves out pure black and white, so a flat backdrop does not flatten the rest', () => {
    const bins = channelBins(raster())
    expect(binsPeak(bins, 'rgb')).toBe(1) // 255 and 0 are left out; 128 is the tallest left
    expect(binsPeak(bins, 'luma')).toBe(2) // luma 76 twice
  })

  test('a channel line spans the view and stays inside its band', () => {
    const bins = channelBins(raster())
    const d = histogramLine(bins.l, 2, 256, 20, 10)
    expect(d.startsWith('M0.5 30.0')).toBe(true)
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
    expect(ys).toHaveLength(256)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(20)
    expect(Math.max(...ys)).toBeLessThanOrEqual(30)
  })
})

describe('stored colour analysis', () => {
  test('main colours, brightness and saturation in percent, tone and shape', () => {
    const facts = readColorFacts({
      dominant_colors: '[{"hex":"#2A1F1b","pct":41.5},{"hex":"bad","pct":3},{"hex":"#E8D2C0","pct":20}]',
      avg_brightness: 127.5,
      color_saturation: 51,
      color_temperature: 'warm',
      brightness_distribution: 'left_heavy',
    })
    expect(facts).toEqual({
      colors: [
        { hex: '#2A1F1B', pct: 41.5 },
        { hex: '#E8D2C0', pct: 20 },
      ],
      brightness: 50,
      saturation: 20,
      temperature: 'warm',
      distribution: 'left_heavy',
    })
  })

  test('not analysed yet is null; unknown words are dropped', () => {
    expect(readColorFacts({ avg_brightness: null })).toBeNull()
    expect(readColorFacts({ avg_brightness: 10, color_temperature: 'hot', dominant_colors: 'x' })).toMatchObject({ temperature: null, colors: [] })
  })
})

describe('aesthetic scoring', () => {
  test('the model card decides: ready, download first, or restart first', () => {
    expect(aestheticModelState([{ id: 'aesthetic', status: 'ready' }])).toBe('ready')
    expect(aestheticModelState([{ id: 'aesthetic', status: 'missing', available: false }])).toBe('download')
    expect(aestheticModelState([{ id: 'aesthetic', status: 'needs_restart' }])).toBe('restart')
    expect(aestheticModelState(undefined)).toBe('ready')
  })

  test('"score these" asks for the filter\'s unscored images; score ranges would exclude them', () => {
    expect(unscoredParams({ tags: 'smile', min_aesthetic: 7, sort_by: 'aesthetic' })).toEqual({ tags: 'smile', aesthetic_unscored: true })
  })
})
