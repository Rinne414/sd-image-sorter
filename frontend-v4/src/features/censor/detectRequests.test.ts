import { describe, expect, it } from 'vitest'
import { detectBody, frameMismatch, refineBody, segmentBody, type DetectPlan } from './detectRequests'

const PLAN: DetectPlan = {
  detector: 'nudenet',
  modelPath: '',
  targets: ['breasts', 'anus'],
  confidence: 0.45,
  maskShape: 'precise',
  words: ['face'],
  style: 'mosaic',
  block: 16,
}

describe('detection requests', () => {
  it('every request asks for the upright frame the editor draws', () => {
    expect(detectBody(7, PLAN)).toEqual({
      image_id: 7,
      model_path: '',
      model_type: 'nudenet',
      confidence_threshold: 0.45,
      exposed_only: true,
      target_classes: ['breasts', 'anus'],
      upright: true,
    })
    expect(detectBody(7, { ...PLAN, detector: 'sam3', targets: null })).toMatchObject({ text_prompts: ['face'], target_classes: null, upright: true })
    expect(refineBody(7, [[1.4, 2.6, 30, 40]], 0.5)).toEqual({ items: [{ image_id: 7, box: [1, 3, 30, 40], upright: true }], sam3_confidence: 0.5, upright: true })
    expect(segmentBody(7, 'tattoo')).toEqual({ image_id: 7, text_prompt: 'tattoo', upright: true })
  })

  it('an answer measured on a picture of another size is named; a matching one passes', () => {
    const picture = { width: 40, height: 80 }
    expect(frameMismatch({ image_width: 40, image_height: 80 }, picture)).toBeNull()
    // a backend that ignored `upright` answers in the file's raw frame of a rotated JPEG
    expect(frameMismatch({ image_width: 80, image_height: 40 }, picture)).toEqual({ got: '80×40', want: '40×80' })
    // no size at all is not trusted either
    expect(frameMismatch({}, picture)).toEqual({ got: '?×?', want: '40×80' })
  })
})
