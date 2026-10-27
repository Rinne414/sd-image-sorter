import { describe, expect, test } from 'vitest'
import { badgeOf, canPreviewInBrowser, companionRecipe, formatDuration, isVideo, mediaFilterOf, stepTime, videoFacts, videoKey, withMediaFilter } from './videoMedia'

describe('isVideo', () => {
  test('media_type decides; a missing one falls back to the file name', () => {
    expect(isVideo({ media_type: 'video' })).toBe(true)
    expect(isVideo({ media_type: 'image', filename: 'clip.mp4' })).toBe(false)
    expect(isVideo({ filename: 'clip.MP4' })).toBe(true)
    expect(isVideo({ filename: 'a.png' })).toBe(false)
    expect(isVideo(null)).toBe(false)
  })
})

describe('formatDuration', () => {
  test('minutes and seconds, hours when needed', () => {
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(65.4)).toBe('1:05')
    expect(formatDuration(3729)).toBe('1:02:09')
    expect(formatDuration(null)).toBe('0:00')
  })
})

describe('badgeOf', () => {
  test('length when read, unreadable when ffmpeg could not, plain otherwise', () => {
    expect(badgeOf({ duration_seconds: 7, video_probe_state: 'ok' })).toEqual({ kind: 'duration', time: '0:07' })
    expect(badgeOf({ duration_seconds: null, video_probe_state: 'unreadable' }).kind).toBe('unreadable')
    expect(badgeOf({ duration_seconds: null, video_probe_state: 'pending' }).kind).toBe('plain')
  })
})

describe('canPreviewInBrowser', () => {
  test('ProRes and friends go to the converted preview', () => {
    expect(canPreviewInBrowser('h264')).toBe(true)
    expect(canPreviewInBrowser(null)).toBe(true)
    expect(canPreviewInBrowser('ProRes')).toBe(false)
  })
})

describe('stepTime', () => {
  test('one frame either way, kept inside the clip', () => {
    expect(stepTime(1, 1, 25, 10)).toBeCloseTo(1.04)
    expect(stepTime(1, -1, 25, 10)).toBeCloseTo(0.96)
    expect(stepTime(0, -1, 25, 10)).toBe(0)
    expect(stepTime(9.99, 1, 25, 10)).toBe(10)
    expect(stepTime(1, 1, null, 10)).toBeCloseTo(1 + 1 / 24)
  })
})

describe('media filter in the query line', () => {
  test('read and set, the rest of the line stays', () => {
    expect(mediaFilterOf('silver hair media:video')).toBe('video')
    expect(mediaFilterOf('silver hair')).toBe('')
    expect(mediaFilterOf('media:gif')).toBe('')
    expect(withMediaFilter('silver hair', 'video')).toBe('silver hair media:video')
    expect(withMediaFilter('media:video silver', 'image')).toBe('silver media:image')
    expect(withMediaFilter('media:video silver', '')).toBe('silver')
  })
})

describe('companionRecipe', () => {
  test('only a recipe read from the picture beside the video counts', () => {
    expect(companionRecipe('{"_parsed":{"video_recipe":{"source":"companion","file":"a.png"}}}')).toEqual({ file: 'a.png' })
    expect(companionRecipe('{"_parsed":{"video_recipe":{"source":"embedded"}}}')).toBeNull()
    expect(companionRecipe('not json')).toBeNull()
    expect(companionRecipe(null)).toBeNull()
  })
})

describe('videoKey', () => {
  const key = (k: string, mods: object = {}) => videoKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods })
  test('comma and period step, space and k toggle, modifiers pass', () => {
    expect(key(',')).toEqual({ type: 'step', dir: -1 })
    expect(key('.')).toEqual({ type: 'step', dir: 1 })
    expect(key(' ')).toEqual({ type: 'toggle' })
    expect(key('K')).toEqual({ type: 'toggle' })
    expect(key('k', { ctrlKey: true })).toBeNull()
    expect(key('f')).toBeNull()
  })
})

describe('videoFacts', () => {
  test('size, length, codec, frame rate and file size in one line', () => {
    const line = videoFacts(
      { width: 1280, height: 720, duration_seconds: 5, video_codec: 'h264', file_size: 2048, video_fps: 24 },
      (n) => `${n} fps`,
      (b) => `${b} B`,
    )
    expect(line).toBe('1280×720 • 0:05 • H264 • 24 fps • 2048 B')
  })
})
