import { describe, expect, test } from 'vitest'
import type { ProjectSettings } from './datasetSettings'
import type { Entry } from './entries'
import {
  exportBody,
  exportProblems,
  formatOf,
  maskChoices,
  namingPattern,
  optionBlock,
  readV4Options,
  sampleName,
  splitEntries,
  stepsEstimate,
  withExportPart,
  withFormat,
  writeV4Options,
  type BodyInput,
} from './dsexport/plan'
import { groupIssues, issueLabel, refusedKey, type ReadinessIssue } from './dsexport/report'

const kohya: ProjectSettings = {
  settings_version: 1,
  target_model: 'sdxl',
  caption_render: {
    trigger: 'mychar',
    common_tags: ['masterpiece'],
    blacklist: ['watermark'],
    normalize_tag_underscores: true,
    content_mode: 'template',
    prefix: '',
    template: { template_override: '{trigger}, {tags:filtered}, {append}', replace_rules: {}, max_tags: 0 },
  },
  naming: { preset: 'renumber', custom_pattern: '{trigger}_{index:03d}' },
  output: { mode: 'folder', folder: 'D:\\out', image_op: 'copy', overwrite_policy: 'unique' },
  trainer: { config: 'kohya_toml', contract_version: '1.0.0', mask_export: 'kohya', repeats: 8, batch: 4, resolution: 768, keep_tokens: 1 },
  subject_crop: { enabled: false, alpha_threshold: 1, padding_percent: 0, background_mode: 'keep_background', solid_color: '#000000' },
  bucket_resize: { enabled: false, subject_aware: false, alpha_threshold: 128 },
  watermark_removal: { enabled: false, method: 'telea', radius: 3, padding_percent: 0, regions: [] },
  planning: { epochs: 10 },
}

const plain: ProjectSettings = { ...kohya, trainer: { ...kohya.trainer, config: 'none', contract_version: null, mask_export: 'none', resolution: 1024, keep_tokens: 0 } }

const contracts = { kohya_toml: '1.0.0', anima_lora_toml: '1.0.0' }

const lib = (id: number, over: Partial<Entry> = {}): Entry => ({
  key: `lib:${id}`,
  ref: { kind: 'library', imageId: id },
  imageId: id,
  path: null,
  filename: `img${id}.png`,
  width: 512,
  height: 512,
  status: 'ok',
  item: null,
  ...over,
})

const dir = (path: string, status: Entry['status'] = 'ok'): Entry => ({
  key: `dir:${path.replace(/\\/g, '/')}`,
  ref: { kind: 'folder', path },
  imageId: null,
  path,
  filename: path.split('\\').pop() ?? path,
  width: null,
  height: null,
  status,
  item: null,
})

describe('formats and the trainer rules', () => {
  test('each format is read back from the settings it writes', () => {
    for (const format of ['kohya', 'anima', 'folder', 'beside'] as const) {
      expect(formatOf(withFormat(kohya, format, contracts).settings)).toBe(format)
    }
  })

  test('kohya takes no pixel changes: switching to it turns them off and says so', () => {
    const busy: ProjectSettings = {
      ...plain,
      output: { ...plain.output, image_op: 'copy' },
      subject_crop: { ...plain.subject_crop!, enabled: true },
      bucket_resize: { enabled: true, subject_aware: false, alpha_threshold: 128 },
    }
    const { settings, notes } = withFormat(busy, 'kohya', contracts)
    expect(settings.trainer).toMatchObject({ config: 'kohya_toml', contract_version: '1.0.0' })
    expect(settings.subject_crop?.enabled).toBe(false)
    expect(settings.bucket_resize?.enabled).toBe(false)
    expect(notes).toEqual(expect.arrayContaining(['bucketOff', 'cropOff']))
    expect(exportProblems(settings, 3, 0, false)).toEqual([])
  })

  test('captions beside the originals write no copies: no pixel options, no Anima masks', () => {
    const { settings } = withFormat({ ...plain, trainer: { ...plain.trainer, mask_export: 'onetrainer' } }, 'beside', contracts)
    expect(settings.output.mode).toBe('beside_image')
    expect(optionBlock('crop', settings, 0)).toBe('beside')
    expect(optionBlock('watermark', settings, 0)).toBe('beside')
    expect(optionBlock('move', settings, 0)).toBe('beside')
    expect(maskChoices(settings)).toEqual(['none', 'onetrainer', 'kohya'])
    expect(exportProblems(settings, 3, 0, false)).toEqual([])
  })

  test('saving the form keeps a caption rule saved meanwhile', () => {
    const current = { ...kohya, caption_render: { ...kohya.caption_render, trigger: 'newer' } }
    const form = { ...kohya, output: { ...kohya.output, folder: 'E:\\set' } }
    const merged = withExportPart(current, form)
    expect(merged.caption_render.trigger).toBe('newer')
    expect(merged.output.folder).toBe('E:\\set')
  })

  test('each option says why it is off', () => {
    expect(optionBlock('crop', kohya, 0)).toBe('package')
    expect(optionBlock('nl', kohya, 0)).toBe('package')
    expect(optionBlock('nl', plain, 0)).toBeNull()
    expect(optionBlock('crop', plain, 2)).toBe('folderImages')
    expect(optionBlock('bucket', { ...plain, output: { ...plain.output, image_op: 'move' } }, 0)).toBe('move')
    expect(optionBlock('move', { ...plain, trainer: { ...plain.trainer, mask_export: 'kohya' } }, 0)).toBe('copyNeeded')
    expect(optionBlock('move', plain, 0)).toBeNull()
  })

  test('what stops an export before it is checked', () => {
    expect(exportProblems(kohya, 0, 0, false)).toEqual(['noImages'])
    expect(exportProblems({ ...kohya, output: { ...kohya.output, folder: ' ' } }, 2, 0, false)).toEqual(['noFolder'])
    expect(exportProblems(kohya, 2, 0, true)).toEqual(['nlPackage'])
    const crop = { ...plain, subject_crop: { ...plain.subject_crop!, enabled: true } }
    expect(exportProblems(crop, 2, 1, false)).toEqual(['cropFolderImages'])
    const wm = { ...plain, watermark_removal: { ...plain.watermark_removal!, enabled: true, regions: [] } }
    expect(exportProblems(wm, 2, 0, false)).toEqual(['watermarkRegion'])
  })
})

describe('names and steps', () => {
  test('keep, number after the trigger (plain numbers without one), or the own pattern', () => {
    expect(namingPattern({ preset: 'keep', custom_pattern: 'x' }, 'hero')).toBe('{filename}')
    expect(namingPattern({ preset: 'renumber', custom_pattern: 'x' }, 'hero')).toBe('{trigger}_{index:03d}')
    expect(namingPattern({ preset: 'renumber', custom_pattern: 'x' }, ' ')).toBe('{index:03d}')
    expect(namingPattern({ preset: 'custom', custom_pattern: 'set_{index}' }, 'hero')).toBe('set_{index}')
    expect(sampleName('{trigger}_{index:03d}', { filename: 'a b.webp', index: 7, trigger: 'hero' })).toBe('hero_007.webp')
    expect(sampleName('{filename}', { filename: 'a b.webp', index: 7, trigger: 'hero' })).toBe('a b.webp')
  })

  test("kohya's steps: ceil(images x repeats / batch) x epochs", () => {
    expect(stepsEstimate(40, 10, 2, 10)).toBe(2000)
    expect(stepsEstimate(41, 10, 4, 3)).toBe(309)
    expect(stepsEstimate(0, 10, 2, 10)).toBe(0)
  })
})

describe('which images go', () => {
  test('changed or missing folder files, gone Library rows and refused images are left out and named', () => {
    const entries = [lib(1), dir('C:\\a\\x.png', 'changed'), dir('C:\\a\\y.png', 'missing'), lib(4, { imageId: null }), lib(5), dir('C:\\a\\z.png')]
    const { send, leftOut } = splitEntries(entries, new Set(['lib:5']))
    expect(send.map((e) => e.key)).toEqual(['lib:1', 'dir:C:/a/z.png'])
    expect(leftOut.map((l) => [l.key, l.reason])).toEqual([
      ['dir:C:/a/x.png', 'changed'],
      ['dir:C:/a/y.png', 'missing'],
      ['lib:4', 'gone'],
      ['lib:5', 'refused'],
    ])
  })
})

describe('the request body', () => {
  const input = (over: Partial<BodyInput> = {}): BodyInput => ({
    settings: kohya,
    batchSettings: { dataset: { training_purpose: 'character', remove_categories: ['character'] } },
    project: { id: 7, revision: 3 },
    send: [lib(1), lib(2), dir('C:\\a\\z.png')],
    heads: new Map([['lib:2', { revisionId: 55 }]]),
    options: { nl_sidecar: false, dedupe_implications: false, json_sidecar: false },
    choices: { skipBlocked: false, allowEmpty: false },
    ...over,
  })

  test('kohya: every image with its caption source, the trainer numbers, the batch rules', () => {
    const body = exportBody(input())
    expect(body).toMatchObject({
      image_ids: [1, 2],
      image_paths: ['C:\\a\\z.png'],
      output_folder: 'D:\\out',
      output_mode: 'folder',
      naming_pattern: '{trigger}_{index:03d}',
      image_op: 'copy',
      trigger: 'mychar',
      content_mode: 'template',
      trainer_config: 'kohya_toml',
      trainer_repeats: 8,
      trainer_batch: 4,
      trainer_resolution: 768,
      trainer_keep_tokens: 1,
      mask_export: 'kohya',
      dataset_project_id: 7,
      dataset_project_revision: 3,
      annotation_selections: {
        '1': { kind: 'dynamic_source' },
        '2': { kind: 'revision_ref', revision_id: 55 },
        'C:\\a\\z.png': { kind: 'dynamic_source' },
      },
    })
    if (body.content_mode !== 'template') throw new Error('a caption body')
    expect(body.caption_transforms).toEqual({ prepend: ['mychar', 'masterpiece'], remove: ['watermark'], remove_categories: ['character'] })
    expect(body.template_options.trigger).toBe(body.trigger)
    // Nothing V4-only unless chosen: the body is the one V3.5 sends.
    for (const key of ['nl_sidecar', 'dedupe_implications', 'skip_blocked_items', 'allow_empty_captions']) expect(body).not.toHaveProperty(key)
  })

  test('the chosen options ride along; beside the originals writes copies of nothing', () => {
    const beside = withFormat(plain, 'beside', contracts).settings
    const body = exportBody(
      input({ settings: beside, options: { nl_sidecar: true, dedupe_implications: true, json_sidecar: false }, choices: { skipBlocked: true, allowEmpty: true } }),
    )
    expect(body).toMatchObject({ output_mode: 'beside_image', output_folder: '', image_op: 'copy', nl_sidecar: true, dedupe_implications: true, skip_blocked_items: true, allow_empty_captions: true })
  })

  test('the V4 options live in the batch row and keep what else is there', () => {
    const settings = { dataset: { training_purpose: 'style', export: { other: 1 } }, x: 2 }
    const next = writeV4Options(settings, { nl_sidecar: true, dedupe_implications: false, json_sidecar: false })
    expect(readV4Options(next)).toEqual({ nl_sidecar: true, dedupe_implications: false, json_sidecar: false })
    expect(next).toEqual({ dataset: { training_purpose: 'style', export: { other: 1, nl_sidecar: true, dedupe_implications: false, json_sidecar: false } }, x: 2 })
    expect(readV4Options({})).toEqual({ nl_sidecar: false, dedupe_implications: false, json_sidecar: false })
  })
})

describe('the check report', () => {
  const issue = (over: Partial<ReadinessIssue>): ReadinessIssue => ({
    severity: 'blocker',
    code: 'source_unreadable',
    message: 'Source image is missing',
    image_id: null,
    source_path: null,
    destination: null,
    ...over,
  })

  test('issues are grouped by what they are, blockers first, each naming its batch images', () => {
    const entries = [lib(1), lib(2), dir('C:\\a\\z.png')]
    const groups = groupIssues(
      [
        issue({ severity: 'warning', code: 'missing_trigger', image_id: 2 }),
        issue({ code: 'source_unreadable', image_id: 1 }),
        issue({ code: 'source_unreadable', source_path: 'c:/a/z.png' }),
        issue({ code: 'caption_destination_collision', image_id: 1 }),
      ],
      entries,
    )
    expect(groups.map((g) => [g.severity, g.label, g.keys])).toEqual([
      ['blocker', 'unreadable', ['lib:1', 'dir:C:/a/z.png']],
      ['blocker', 'nameClash', ['lib:1']],
      ['warning', 'missingTrigger', ['lib:2']],
    ])
    expect(groups[0]?.names).toEqual(['img1.png', 'z.png'])
    expect(issueLabel('some_new_mask_code')).toBe('noMask')
    expect(issueLabel('never_seen')).toBe('other')
  })

  test('a refused check names its image, a Library id or a folder path (Python repr)', () => {
    expect(refusedKey("Dynamic source selection does not match: key='12', project_id=7")).toBe('lib:12')
    expect(refusedKey("does not match: key='C:\\\\Users\\\\me\\\\a b.png', project_id=7")).toBe('dir:C:/Users/me/a b.png')
    expect(refusedKey('key="C:\\\\it\'s.png", x')).toBe("dir:C:/it's.png")
    expect(refusedKey('Job failed due to an internal error')).toBeNull()
  })
})

describe('a .json per image instead of the caption .txt (V3.5 content mode "json")', () => {
  const input = (settings: ProjectSettings, json: boolean, nl = false): BodyInput => ({
    settings,
    batchSettings: { dataset: { training_purpose: 'character', remove_categories: ['character'] } },
    project: { id: 7, revision: 3 },
    send: [lib(1), lib(2), dir('C:\a\z.png')],
    heads: new Map([['lib:2', { revisionId: 55 }]]),
    options: { nl_sidecar: nl, dedupe_implications: false, json_sidecar: json },
    choices: { skipBlocked: false, allowEmpty: false },
  })

  test('a plain folder or beside the originals: the json content mode, with the batch blacklist and the naming trigger', () => {
    for (const settings of [plain, withFormat(plain, 'beside', contracts).settings]) {
      const body = exportBody(input(settings, true, true))
      expect(body).toMatchObject({ content_mode: 'json', image_ids: [1, 2], image_paths: ['C:\a\z.png'], blacklist: ['watermark'], trigger: 'mychar', naming_pattern: '{trigger}_{index:03d}' })
      // the .json is the image's own data: no caption revisions, rules or common tags ride along (they would replace or break it),
      // and there is no caption to split into _nl.txt
      for (const key of ['annotation_selections', 'dataset_project_id', 'dataset_project_revision', 'caption_transforms', 'template_options', 'nl_sidecar']) expect(body).not.toHaveProperty(key)
      expect(body.common_tags).toEqual([])
    }
  })

  test('kohya and Anima exports never change: the choice is ignored for a verified package', () => {
    const anima = withFormat(plain, 'anima', contracts).settings
    for (const settings of [kohya, anima]) expect(exportBody(input(settings, true))).toEqual(exportBody(input(settings, false)))
  })

  test('the option says why it is off for a package, and a package with it on is named before the check', () => {
    expect(optionBlock('json', kohya, 0)).toBe('package')
    expect(optionBlock('json', plain, 0)).toBeNull()
    expect(exportProblems(kohya, 2, 0, false, true)).toEqual(['jsonPackage'])
    expect(exportProblems(plain, 2, 0, false, true)).toEqual([])
  })

  test('the choice is kept in the batch row with the other V4 options', () => {
    const next = writeV4Options({ dataset: { export: { nl_sidecar: true } } }, { nl_sidecar: false, dedupe_implications: false, json_sidecar: true })
    expect(readV4Options(next).json_sidecar).toBe(true)
    expect(readV4Options({ dataset: { export: { json_sidecar: 'yes' } } }).json_sidecar).toBe(false)
  })
})
