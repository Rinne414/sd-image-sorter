import { describe, expect, it } from 'vitest'
import type { ImageSummary } from '../../../api/types'
import { lookupRows, ROWS_PER_REQUEST } from './lookupRows'

const row = (id: number, filename = `${id}.png`): ImageSummary => ({ id, filename, path: `/pics/${filename}` }) as ImageSummary

describe('looking up what a pick is', () => {
  it('asks once per chunk of ids, never once per image', async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => i + 1)
    const calls: number[][] = []
    const known = await lookupRows(ids, () => null, async (chunk) => {
      calls.push(chunk)
      return chunk.map((id) => row(id))
    })
    expect(calls.map((c) => c.length)).toEqual([ROWS_PER_REQUEST, ROWS_PER_REQUEST, 1000])
    expect(known.size).toBe(5000)
  })

  it('uses the rows the library already loaded and asks only for the rest, each id once', async () => {
    const loaded = new Map([[2, row(2, 'loop.gif')]])
    const calls: number[][] = []
    const known = await lookupRows([1, 2, 3, 3, 1], (id) => loaded.get(id) ?? null, async (chunk) => {
      calls.push(chunk)
      return chunk.map((id) => row(id))
    })
    expect(calls).toEqual([[1, 3]])
    expect(known.get(2)?.filename).toBe('loop.gif')
    expect([...known.keys()].sort()).toEqual([1, 2, 3])
  })

  it('a chunk that fails stays unknown; the other chunks still count', async () => {
    const known = await lookupRows([1, 2, 3, 4], () => null, async (chunk) => {
      if (chunk.includes(1)) throw new Error('offline')
      return chunk.map((id) => row(id))
    }, 2)
    expect([...known.keys()]).toEqual([3, 4])
  })

  it('ids the backend no longer has are simply missing', async () => {
    const known = await lookupRows([7, 8], () => null, async () => [row(8)])
    expect([...known.keys()]).toEqual([8])
  })
})
