import { describe, expect, test } from 'vitest'
import {
  categoriesChanged,
  formFromSettings,
  parseReplaceRules,
  readBatchDataset,
  settingsFromForm,
  splitList,
  toggleCategory,
  triggerProblem,
  withPurpose,
  withTriggerChange,
  writeBatchDataset,
  type ProjectSettings,
} from './datasetSettings'
import { trainerProblems, withTrainer } from './trainerRules'

/** Every field V3.5's strict V1 settings have, set to something other than the default. */
const v1: ProjectSettings = {
  settings_version: 1,
  target_model: 'sdxl',
  caption_render: {
    trigger: 'mychar',
    common_tags: ['masterpiece', 'best quality'],
    blacklist: ['watermark', 'signature'],
    normalize_tag_underscores: true,
    content_mode: 'template',
    prefix: 'photo of',
    template: { template_override: '{trigger}, {tags:filtered}, {append}', replace_rules: { long_hair: 'long hair' }, max_tags: 30 },
  },
  naming: { preset: 'renumber', custom_pattern: '{trigger}_{index:03d}' },
  output: { mode: 'folder', folder: 'D:\\out', image_op: 'copy', overwrite_policy: 'unique' },
  trainer: { config: 'kohya_toml', contract_version: '1.0.0', mask_export: 'kohya', repeats: 8, batch: 4, resolution: 768, keep_tokens: 1 },
  subject_crop: { enabled: false, alpha_threshold: 1, padding_percent: 0, background_mode: 'keep_background', solid_color: '#000000' },
  bucket_resize: { enabled: false, subject_aware: false, alpha_threshold: 128 },
  watermark_removal: { enabled: false, method: 'telea', radius: 3, padding_percent: 0, regions: [] },
  planning: { epochs: 12 },
}

describe('the settings form and V3.5 settings', () => {
  test('a round trip gives back exactly the same V1 settings', () => {
    const form = formFromSettings(v1, { training_purpose: 'character', remove_categories: ['character'] })
    expect(settingsFromForm(form, v1)).toEqual(v1)
  })

  test('the form changes only what it edits, and never the input', () => {
    const before = JSON.stringify(v1)
    const form = { ...formFromSettings(v1, readBatchDataset({})), trigger: '  newchar ', maxTags: 12.7, commonTags: 'a,\nb' }
    const out = settingsFromForm(form, v1)
    expect(out.caption_render.trigger).toBe('newchar')
    expect(out.caption_render.template.max_tags).toBe(12)
    expect(out.caption_render.common_tags).toEqual(['a', 'b'])
    expect(out.trainer).toEqual(v1.trainer)
    expect(out.naming).toEqual(v1.naming)
    expect(JSON.stringify(v1)).toBe(before)
  })

  test('one list parser for common tags and the blacklist: commas or line breaks, trimmed, once each', () => {
    expect(splitList(' watermark ,signature\nlong_hair\r\n\n, long hair ,WATERMARK,')).toEqual(['watermark', 'signature', 'long_hair'])
    const form = { ...formFromSettings(v1, readBatchDataset({})), blacklist: 'a\nb, c', commonTags: 'a\nb, c' }
    const out = settingsFromForm(form, v1)
    expect(out.caption_render.blacklist).toEqual(out.caption_render.common_tags)
  })

  test('replace rules read V3.5 lines, both arrows', () => {
    expect(parseReplaceRules('long_hair -> long hair\nbad line\n a => b \n -> nothing')).toEqual({ long_hair: 'long hair', a: 'b' })
  })

  test('the batch keeps purpose and categories beside its other settings', () => {
    const settings = { source_collection_id: 4, dataset: { other: 1 } }
    const next = writeBatchDataset(settings, { training_purpose: 'style', remove_categories: ['style', 'artist'] })
    expect(next).toEqual({ source_collection_id: 4, dataset: { other: 1, training_purpose: 'style', remove_categories: ['style', 'artist'] } })
    expect(readBatchDataset(next)).toEqual({ training_purpose: 'style', remove_categories: ['style', 'artist'] })
    expect(readBatchDataset({ dataset: { training_purpose: 'nope', remove_categories: ['style', 'x', 'style'] } })).toEqual({
      training_purpose: null,
      remove_categories: ['style'],
    })
  })
})

describe('trigger, purpose and categories', () => {
  const form = formFromSettings(v1, readBatchDataset({}))

  test('a trigger the backend would refuse is named', () => {
    expect(triggerProblem('my char')).toBeNull()
    expect(triggerProblem('a,b')).toBe('comma')
    expect(triggerProblem('a\nb')).toBe('breaks')
    expect(triggerProblem('x'.repeat(101))).toBe('long')
    expect(triggerProblem('___')).toBe('blank')
  })

  test('a new trigger puts the old one on the blacklist, once', () => {
    const changed = withTriggerChange({ ...form, trigger: 'newchar' }, 'mychar')
    expect(splitList(changed.blacklist)).toEqual(['watermark', 'signature', 'mychar'])
    expect(withTriggerChange(changed, 'mychar')).toBe(changed)
    expect(withTriggerChange({ ...form, trigger: 'MyChar' }, 'mychar').blacklist).toBe(form.blacklist)
  })

  test('going back to a blacklisted trigger takes it off the blacklist', () => {
    const changed = withTriggerChange({ ...form, trigger: 'newchar' }, 'mychar')
    const back = withTriggerChange({ ...changed, trigger: 'MyChar' }, 'newchar')
    expect(splitList(back.blacklist)).toEqual(['watermark', 'signature', 'newchar'])
  })

  test('a purpose suggests categories the user can then change', () => {
    const style = withPurpose(form, 'style')
    expect(style.removeCategories).toEqual(['style', 'artist', 'meta', 'quality', 'rating'])
    expect(categoriesChanged(style)).toBe(false)
    expect(categoriesChanged(toggleCategory(style, 'background'))).toBe(true)
    expect(toggleCategory(toggleCategory(style, 'meta'), 'meta').removeCategories).toContain('meta')
  })
})

describe('trainer rules match the backend validator', () => {
  const generic: ProjectSettings = {
    ...v1,
    trainer: { ...v1.trainer, config: 'none', contract_version: null, mask_export: 'onetrainer', resolution: 768, keep_tokens: 0 },
    bucket_resize: { enabled: true, subject_aware: false, alpha_threshold: 128 },
    watermark_removal: { enabled: true, method: 'telea', radius: 3, padding_percent: 0, regions: [{ x: 0, y: 0, width: 100, height: 100 }] },
  }

  test('valid settings have no problems', () => {
    expect(trainerProblems(v1)).toEqual([])
    expect(trainerProblems(generic)).toEqual([])
  })

  test('choosing Kohya switches bucket resizing and watermark removal off and says so', () => {
    const { settings, notes } = withTrainer(generic, 'kohya_toml', '1.0.0')
    expect(settings.bucket_resize?.enabled).toBe(false)
    expect(settings.watermark_removal?.enabled).toBe(false)
    expect(settings.trainer.mask_export).toBe('none')
    expect(notes).toEqual(['bucketOff', 'watermarkOff', 'maskReset'])
    expect(trainerProblems(settings)).toEqual([])
    expect(generic.bucket_resize?.enabled).toBe(true)
  })

  test('Anima and "no trainer" without resizing fix resolution 1024 and keep tokens 0', () => {
    const anima = withTrainer(v1, 'anima_lora_toml', '1.0.0')
    expect(anima.settings.trainer).toMatchObject({ resolution: 1024, keep_tokens: 0, mask_export: 'none' })
    expect(anima.notes).toEqual(['maskReset', 'resolution1024', 'keepTokens0'])
    const none = withTrainer(v1, 'none', null)
    expect(none.settings.trainer.contract_version).toBeNull()
    expect(trainerProblems(none.settings)).toEqual([])
  })

  test('each rule of the validator is reported', () => {
    const broken: ProjectSettings = {
      ...generic,
      trainer: { ...generic.trainer, config: 'kohya_toml', contract_version: null, mask_export: 'onetrainer', resolution: 1000 },
      output: { ...generic.output, image_op: 'move' },
    }
    expect(trainerProblems(broken)).toEqual([
      'mask',
      'bucketTrainer',
      'bucketResolution',
      'bucketOutput',
      'watermarkTrainer',
      'watermarkOutput',
      'contractMissing',
      'trainerOutput',
    ])
    expect(trainerProblems({ ...v1, trainer: { ...v1.trainer, config: 'none', mask_export: 'none' } })).toEqual(['fixedNumbers', 'contractNone'])
  })
})
