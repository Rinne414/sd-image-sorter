import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import { autoScale, pageOffset, parseScaleSetting, roomAt, scaleFor, SCALE_OPTIONS, UI_SCALE_KEY } from './uiScale'

describe('uiScale', () => {
  it('auto follows the V3.5 thresholds by window width', () => {
    expect(autoScale(1366)).toBe(1)
    expect(autoScale(1920)).toBe(1)
    expect(autoScale(1999)).toBe(1)
    expect(autoScale(2000)).toBe(1.15)
    expect(autoScale(2349)).toBe(1.15)
    expect(autoScale(2350)).toBe(1.3)
    expect(autoScale(2560)).toBe(1.3)
    expect(autoScale(3100)).toBe(1.4)
    expect(autoScale(3440)).toBe(1.4)
    expect(autoScale(3600)).toBe(1.5)
    expect(autoScale(3840)).toBe(1.5)
  })

  it('a stored choice is one of the offered scales; anything else is auto', () => {
    expect(parseScaleSetting(null)).toBe('auto')
    expect(parseScaleSetting('auto')).toBe('auto')
    expect(parseScaleSetting('1.3')).toBe(1.3)
    expect(parseScaleSetting('1')).toBe(1)
    expect(parseScaleSetting('1.25')).toBe('auto')
    expect(parseScaleSetting('9')).toBe('auto')
    expect(parseScaleSetting('abc')).toBe('auto')
    expect(SCALE_OPTIONS).toEqual([1, 1.15, 1.3, 1.4, 1.5])
  })

  it('a fixed choice wins over the window width', () => {
    expect(scaleFor('auto', 2560)).toBe(1.3)
    expect(scaleFor(1, 2560)).toBe(1)
    expect(scaleFor(1.5, 1366)).toBe(1.5)
  })

  it('says how wide the page is at a zoom and whether the layout still fits', () => {
    expect(roomAt(1920, 1.3)).toEqual({ width: 1477, fits: true })
    expect(roomAt(1920, 1.5)).toEqual({ width: 1280, fits: true })
    expect(roomAt(1366, 1.15)).toEqual({ width: 1188, fits: false })
    // auto never squeezes the page below the layout's width
    for (const w of [1280, 1366, 1920, 2000, 2350, 2560, 3100, 3440, 3600, 3840]) expect(roomAt(w, autoScale(w)).fits).toBe(true)
  })

  it('index.html applies the same rule before first paint', () => {
    const script = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '').find((s) => s.includes(UI_SCALE_KEY))
    expect(script, 'index.html has no ui scale script').toBeTruthy()
    const run = (width: number, stored: string | null) => {
      const style: Record<string, string> = {}
      const props: Record<string, string> = {}
      const root = { style: Object.assign(style, { setProperty: (k: string, v: string) => (props[k] = v) }) }
      const storage = { getItem: (k: string) => (k === UI_SCALE_KEY ? stored : null) }
      new Function('window', 'localStorage', 'document', script ?? '')({ innerWidth: width }, storage, { documentElement: root })
      return { zoom: Number(style.zoom || 1), prop: Number(props['--ui-zoom']) }
    }
    for (const w of [1366, 1920, 2000, 2350, 2560, 3100, 3600, 3840]) {
      for (const stored of [null, 'auto', '1', '1.15', '1.5', 'junk']) {
        const expected = scaleFor(parseScaleSetting(stored), w)
        expect(run(w, stored), `${w} ${stored}`).toEqual({ zoom: expected, prop: expected })
      }
    }
  })
})

describe('a screen point as page px', () => {
  it('measures from the origin and divides by the zoom', () => {
    expect(pageOffset(364 + 130, 248 + 65, { left: 364, top: 248 }, 1.3)).toEqual([100, 50])
    expect(pageOffset(464, 298, { left: 364, top: 248 }, 1)).toEqual([100, 50])
  })
})
