import { describe, expect, it } from 'vitest'
import { purposeTags, type GroupedTags } from './tagGroups'

const grouped: GroupedTags = {
  appearance: ['1girl', 'blue eyes'],
  clothing: ['school uniform'],
  pose: ['sitting', 'from side'],
  scenery: ['classroom', ' "window" '],
  style: ['watercolor'],
  qualityMeta: ['masterpiece', 'highres'],
  unclassified: ['holding  cup', 'Sitting'],
}

describe("the Reader's copy-for-a-purpose presets (V3.5's rules)", () => {
  it('pose + scene: the pose and scenery groups', () => {
    expect(purposeTags(grouped, 'poseScene')).toEqual(['sitting', 'from side', 'classroom', 'window'])
  })

  it('training caption: appearance, clothing, pose, scenery and style; no quality, meta or unclassified', () => {
    expect(purposeTags(grouped, 'trainingCaption')).toEqual(['1girl', 'blue eyes', 'school uniform', 'sitting', 'from side', 'classroom', 'window', 'watercolor'])
  })

  it('without quality/meta: the same plus the unclassified tags, each tag once', () => {
    expect(purposeTags(grouped, 'noQuality')).toEqual([
      '1girl',
      'blue eyes',
      'school uniform',
      'sitting',
      'from side',
      'classroom',
      'window',
      'watercolor',
      'holding cup',
    ])
  })
})
