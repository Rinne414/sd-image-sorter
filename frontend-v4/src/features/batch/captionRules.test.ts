import { describe, expect, test } from 'vitest'
import {
  captionTransforms,
  DEFAULT_TEMPLATE,
  defaultTemplate,
  previewBody,
  ruleTokens,
  templateIsOwn,
  withTargetModel,
  type TemplatePreset,
} from './captionRules'
import type { DatasetForm } from './datasetSettings'
import type { Entry } from './entries'

const presets: TemplatePreset[] = [
  { id: 'illustrious_pony', template: '{trigger}, {tags:filtered}, {append}' },
  { id: 'anima', template: '{quality}, {safety}, {count}, {trigger}, {characters}, {copyright}, {artists:@}, {general}. {nl_caption}' },
  { id: 'flux', template: '{trigger}. {nl_caption}' },
]

const form: DatasetForm = {
  trigger: ' mychar ',
  targetModel: 'sdxl',
  purpose: 'character',
  removeCategories: ['character', 'body'],
  commonTags: 'masterpiece, best quality\nmasterpiece',
  blacklist: 'watermark\nold_trigger',
  maxTags: 30,
  template: DEFAULT_TEMPLATE,
  replaceRules: 'a -> b',
  prefix: '',
  normalizeUnderscores: true,
}

const entry = (over: Partial<Entry>): Entry => ({
  key: 'k',
  ref: { kind: 'library', imageId: 1 },
  imageId: null,
  path: null,
  filename: 'x.png',
  width: null,
  height: null,
  status: 'ok',
  item: null,
  ...over,
})

describe('caption rules', () => {
  test('the trigger leads, common tags follow, the blacklist and the chosen categories are taken out', () => {
    expect(captionTransforms(form)).toEqual({
      prepend: ['mychar', 'masterpiece', 'best quality'],
      remove: ['watermark', 'old_trigger'],
      remove_categories: ['character', 'body'],
    })
    expect(captionTransforms({ ...form, trigger: '', removeCategories: [] })).toEqual({
      prepend: ['masterpiece', 'best quality'],
      remove: ['watermark', 'old_trigger'],
      remove_categories: [],
    })
  })

  test('the preview sends the export body: Library ids, folder paths still on disk, the same rules both ways', () => {
    const entries = [
      entry({ imageId: 7 }),
      entry({ imageId: null, status: 'missing' }),
      entry({ ref: { kind: 'folder', path: 'D:/a.png' }, path: 'D:/a.png' }),
      entry({ ref: { kind: 'folder', path: 'D:/gone.png' }, path: 'D:/gone.png', status: 'missing' }),
    ]
    const body = previewBody(form, entries, 900)
    expect(body.image_ids).toEqual([7])
    expect(body.image_paths).toEqual(['D:/a.png'])
    expect(body.limit).toBe(500)
    expect(body.trigger).toBe('mychar')
    expect(body.template_options).toMatchObject({
      preset_id: 'illustrious_pony',
      trigger: 'mychar',
      blacklist: ['watermark', 'old_trigger'],
      append: ['masterpiece', 'best quality'],
      replace_rules: { a: 'b' },
      max_tags: 30,
    })
    expect(body.blacklist).toEqual(body.template_options.blacklist)
    expect(body.common_tags).toEqual(body.template_options.append)
    expect(body.caption_transforms).toEqual(captionTransforms(form))
  })

  test('the base model brings its template unless the user wrote one', () => {
    const anima = withTargetModel(form, 'anima', presets)
    expect(anima.template).toBe(defaultTemplate('anima', presets))
    expect(templateIsOwn(anima, presets)).toBe(false)
    expect(withTargetModel(anima, 'krea2', presets).template).toBe('{trigger}. {nl_caption}')
    expect(withTargetModel(anima, '', presets).template).toBe(DEFAULT_TEMPLATE)
    const own = { ...form, template: '{trigger}, {tags:20}' }
    expect(withTargetModel(own, 'anima', presets).template).toBe('{trigger}, {tags:20}')
    expect(templateIsOwn(own, presets)).toBe(true)
  })

  test('tokens the rules put in front are marked', () => {
    expect(ruleTokens('mychar, masterpiece, best_quality, 1girl, smile', form)).toEqual([
      { token: 'mychar', fromRule: true },
      { token: 'masterpiece', fromRule: true },
      { token: 'best_quality', fromRule: true },
      { token: '1girl', fromRule: false },
      { token: 'smile', fromRule: false },
    ])
  })
})
