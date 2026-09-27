import { describe, expect, it } from 'vitest'
import { HOVER_DELAY_MS, hoverPlace, idChunks, pagePlace, previewBox, scoreMap } from './hoverPlace'

// The Order step's hover preview (V3.5's queue: a larger picture after a
// 400 ms hover, beside the pointer) and the aesthetic score on its tiles.

describe('the hover preview', () => {
  it('waits as long as V3.5 did before it shows', () => {
    expect(HOVER_DELAY_MS).toBe(400)
  })

  it('keeps the picture shape and fits it into the largest box the window allows', () => {
    expect(previewBox(1000, 500, { w: 1920, h: 1080 })).toEqual({ w: 640, h: 320 })
    expect(previewBox(600, 1200, { w: 1366, h: 768 })).toEqual({ w: 231, h: 461 })
    expect(previewBox(null, null, { w: 1920, h: 1080 })).toEqual({ w: 640, h: 640 })
  })

  it('never grows a small picture past its own size', () => {
    expect(previewBox(300, 200, { w: 2560, h: 1440 })).toEqual({ w: 300, h: 200 })
  })

  it('sits right of the pointer, a little above it, as V3.5 placed it', () => {
    expect(hoverPlace({ x: 100, y: 400 }, { w: 300, h: 200 }, { w: 1920, h: 1080 })).toEqual({ left: 116, top: 340 })
  })

  it('flips to the left of the pointer near the right edge', () => {
    expect(hoverPlace({ x: 1800, y: 400 }, { w: 300, h: 200 }, { w: 1920, h: 1080 })).toEqual({ left: 1484, top: 340 })
  })

  it('stays inside the window at the top and bottom', () => {
    expect(hoverPlace({ x: 100, y: 20 }, { w: 300, h: 200 }, { w: 1920, h: 1080 }).top).toBe(8)
    expect(hoverPlace({ x: 100, y: 1070 }, { w: 300, h: 200 }, { w: 1920, h: 1080 }).top).toBe(872)
  })
})

describe('aesthetic scores for the tiles', () => {
  it('keeps the scores that exist, by image id', () => {
    const rows = [
      { id: 1, aesthetic_score: 6.4178 },
      { id: 2, aesthetic_score: null },
      { id: 3, aesthetic_score: 5 },
    ]
    expect([...scoreMap(rows)]).toEqual([
      [1, 6.4178],
      [3, 5],
    ])
  })

  it('asks for the ids in pieces the endpoint takes', () => {
    expect(idChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(idChunks([], 2)).toEqual([])
  })
})

describe('the hover preview under the interface zoom', () => {
  it('sits beside the pointer at 130 %: the pointer and the window are read in page px', () => {
    // pointer at (1300, 650) screen px in a 2560 x 1440 window at 130 %: (1000, 500) page px in 1969 x 1108
    const at = pagePlace({ x: 1300, y: 650 }, { w: 2560, h: 1440 }, 1.3)
    expect(at.pointer).toEqual({ x: 1000, y: 500 })
    expect(at.viewport).toEqual({ w: 1969, h: 1108 })
    expect(hoverPlace(at.pointer, { w: 400, h: 600 }, at.viewport)).toEqual({ left: 1016, top: 440 })
  })

  it('changes nothing at 100 %', () => {
    expect(pagePlace({ x: 1300, y: 650 }, { w: 1920, h: 1080 }, 1)).toEqual({ pointer: { x: 1300, y: 650 }, viewport: { w: 1920, h: 1080 } })
  })
})
