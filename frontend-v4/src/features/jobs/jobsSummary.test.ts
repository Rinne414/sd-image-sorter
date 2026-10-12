import { describe, expect, it } from 'vitest'
import { buttonSummary } from './jobsSummary'
import type { JobStatus } from './progress'

const p = (unit: 'images' | 'bytes' | 'percent', current: number, total: number, status: JobStatus = 'running') => ({ progress: { unit, current, total, status }, count: total })

describe('the Jobs button count', () => {
  it('images only: done of all', () => {
    expect(buttonSummary([p('images', 3, 10), p('images', 1, 5)])).toEqual({ text: '4/15', fraction: 4 / 15 })
  })

  it('never adds bytes or percent to images: several kinds of work say how many are running', () => {
    const s = buttonSummary([p('images', 30, 100), p('bytes', 500_000_000, 1_000_000_000)])
    expect(s.text).toBe('2')
    expect(s.fraction).toBeCloseTo((0.3 + 0.5) / 2)
  })

  it('one download or pull alone: its percent', () => {
    expect(buttonSummary([p('bytes', 250, 1000)]).text).toBe('25%')
    expect(buttonSummary([p('percent', 42, 100)]).text).toBe('42%')
  })

  it('nothing running: how many jobs are listed, no meter', () => {
    expect(buttonSummary([p('images', 5, 5, 'done'), p('bytes', 1, 1, 'error')])).toEqual({ text: '2', fraction: null })
  })
})
