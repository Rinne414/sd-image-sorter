import { describe, expect, test } from 'vitest'
import { countMoving, movingKind, splitPicks } from './mediaKind'

const row = (id: number, filename: string, media_type?: string) => ({ id, filename, path: `D:/pics/${filename}`, media_type })

describe('movingKind', () => {
  test('a GIF is found by its name, a video by its type or its name', () => {
    expect(movingKind({ filename: 'a.GIF' })).toBe('gif')
    expect(movingKind(row(1, 'clip.bin', 'video'))).toBe('video')
    expect(movingKind({ filename: 'clip.mp4' })).toBe('video')
    expect(movingKind({ filename: 'still.png' })).toBeNull()
    expect(movingKind(null)).toBeNull()
  })

  test('a GIF with a picture type is still a GIF; a video type wins over a .gif name', () => {
    expect(movingKind(row(1, 'a.gif', 'image'))).toBe('gif')
    expect(movingKind(row(1, 'a.gif', 'video'))).toBe('video')
  })
})

describe('splitPicks', () => {
  const library = new Map([row(1, 'a.png'), row(2, 'b.gif'), row(3, 'c.mp4', 'video'), row(4, 'd.webp', 'image')].map((r) => [r.id, r]))

  test('stills keep their order and the moving ones carry their file', () => {
    const split = splitPicks([4, 2, 1, 3], (id) => library.get(id) ?? null)
    expect(split.pictures).toEqual([4, 1])
    expect(split.moving).toEqual([
      { id: 2, name: 'b.gif', path: 'D:/pics/b.gif', kind: 'gif' },
      { id: 3, name: 'c.mp4', path: 'D:/pics/c.mp4', kind: 'video' },
    ])
  })

  test('an id nobody has loaded counts as a picture', () => {
    expect(splitPicks([9], () => null)).toEqual({ pictures: [9], moving: [] })
  })

  test('counts GIFs and videos', () => {
    expect(countMoving(splitPicks([2, 3, 3], (id) => library.get(id) ?? null).moving)).toEqual({ gifs: 1, videos: 2 })
  })
})
