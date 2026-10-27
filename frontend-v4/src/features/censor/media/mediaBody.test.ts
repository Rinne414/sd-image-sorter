import { describe, expect, test } from 'vitest'
import { mediaCards, mediaDetection, mediaStartBody, type DetectInput, type MediaOptions } from './mediaBody'

const input = (over: Partial<DetectInput> = {}): DetectInput => ({
  detector: 'nudenet',
  recommended: null,
  targets: ['breasts', 'pussy'],
  confidence: 0.4,
  maskShape: 'precise',
  yolo: '',
  customPath: '',
  legacyKnowsTargets: true,
  ...over,
})

const options: MediaOptions = { style: 'blur', blockAuto: true, block: 20, every: 3, hold: 5, output: ' D:/out ', includeVideos: true }

describe('mediaDetection', () => {
  test('NudeNet takes the body-part targets and no file', () => {
    const d = mediaDetection(input({ yolo: 'D:/m/x.pt' }))
    expect(d).toMatchObject({ modelType: 'nudenet', modelPath: '', targets: ['breasts', 'pussy'], swappedFromSam3: false })
  })

  test('SAM 3 is replaced by NudeNet with the same targets, and says so', () => {
    expect(mediaDetection(input({ detector: 'sam3' }))).toMatchObject({ modelType: 'nudenet', swappedFromSam3: true, targets: ['breasts', 'pussy'] })
  })

  test('no detector chosen follows the backend recommendation, else NudeNet', () => {
    expect(mediaDetection(input({ detector: null, recommended: 'both' }))).toMatchObject({ modelType: 'both' })
    expect(mediaDetection(input({ detector: null, recommended: null }))).toMatchObject({ modelType: 'nudenet' })
  })

  test('a typed YOLO path wins over the listed one; a general YOLO file takes every class', () => {
    expect(mediaDetection(input({ detector: 'legacy', yolo: 'D:/a.pt', customPath: ' D:/b.pt ' }))).toMatchObject({ modelPath: 'D:/b.pt', targets: ['breasts', 'pussy'] })
    expect(mediaDetection(input({ detector: 'legacy', legacyKnowsTargets: false }))).toMatchObject({ targets: null })
  })

  test('no target ticked is refused when the model needs targets', () => {
    expect(mediaDetection(input({ targets: [] }))).toEqual({ error: 'noTargets' })
    expect(mediaDetection(input({ targets: [], detector: 'legacy', legacyKnowsTargets: false }))).toMatchObject({ targets: null })
  })
})

describe('mediaStartBody', () => {
  const detection = mediaDetection(input())
  if ('error' in detection) throw new Error('unexpected')

  test('picked files go as files, a folder as a folder', () => {
    expect(mediaStartBody({ files: ['a.gif'] }, detection, options)).toMatchObject({ files: ['a.gif'] })
    const body = mediaStartBody({ folder: 'D:/gifs' }, detection, options)
    expect(body).toMatchObject({ folder: 'D:/gifs' })
    expect('files' in body).toBe(false)
  })

  test('carries the detection, the style and the timing', () => {
    expect(mediaStartBody({ folder: 'D:/g' }, detection, options)).toMatchObject({
      output_folder: 'D:/out',
      include_videos: true,
      model_type: 'nudenet',
      confidence: 0.4,
      target_classes: ['breasts', 'pussy'],
      shape: 'precise',
      style: 'blur',
      block_size: 0,
      detect_every: 3,
      hold: 5,
    })
  })

  test('a chosen block size is sent, Auto sends 0', () => {
    expect(mediaStartBody({ folder: 'x' }, detection, { ...options, blockAuto: false })).toMatchObject({ block_size: 20 })
  })
})

describe('mediaCards', () => {
  test('NudeNet and both need the NudeNet card; legacy needs the YOLO card unless a file is named', () => {
    expect(mediaCards({ modelType: 'both', modelPath: '' })).toEqual(['censor-nudenet'])
    expect(mediaCards({ modelType: 'legacy', modelPath: '' })).toEqual(['censor-legacy'])
    expect(mediaCards({ modelType: 'legacy', modelPath: 'D:/a.pt' })).toEqual([])
  })
})
