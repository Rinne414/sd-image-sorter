import { describe, expect, test } from 'vitest'
import { folderKey, libraryKey } from './datasetItems'
import {
  headKey,
  revisionsFromResults,
  smartTagBody,
  smartTagPurpose,
  tagScope,
  vlmCalls,
  type HeadInfo,
  type TagStepOptions,
} from './datasetTag'
import type { Entry } from './entries'

const lib = (id: number | null, source = id ?? 99): Entry => ({
  key: libraryKey(source),
  ref: { kind: 'library', imageId: source },
  imageId: id,
  path: null,
  filename: `${source}.png`,
  width: null,
  height: null,
  status: id === null ? 'missing' : 'ok',
  item: null,
})

const dir = (path: string, status: Entry['status'] = 'ok'): Entry => ({
  key: folderKey(path),
  ref: { kind: 'folder', path },
  imageId: null,
  path,
  filename: path.split('/').pop() ?? path,
  width: null,
  height: null,
  status,
  item: null,
})

const entries = [lib(1), lib(2), lib(null, 3), dir('D:/set/a.png'), dir('D:/set/b.png'), dir('D:/set/gone.png', 'missing')]
const tagged = new Set([2])
const heads = new Map<string, HeadInfo>([
  [folderKey('D:/set/b.png'), { generation: 2, author: 'ai' }],
  [libraryKey(1), { generation: 1, author: 'user' }],
])

const options: TagStepOptions = {
  model: 'wd-swinv2-tagger-v3',
  threshold: null,
  characterThreshold: 0.8,
  maxTags: 40,
  useGpu: true,
  secondModel: null,
  agreement: 'any',
  describer: 'off',
  toriiLength: 'detailed',
  grounding: true,
  retagExisting: false,
}

describe('which images a tag run takes', () => {
  test('untagged Library images and folder images without a caption; the rest only when re-tagging', () => {
    const scope = tagScope(entries, tagged, heads, false)
    expect(scope).toMatchObject({ untagged: 1, tagged: 1, folderNew: 1, folderDone: 1, missing: 2 })
    expect(scope.ids).toEqual([1])
    expect(scope.paths).toEqual(['D:/set/a.png'])
    expect(scope.userEdited).toEqual([libraryKey(1)])

    const again = tagScope(entries, tagged, heads, true)
    expect(again.ids).toEqual([1, 2])
    expect(again.paths).toEqual(['D:/set/a.png', 'D:/set/b.png'])
  })

  test('the VLM is called once per image sent, and only when it describes', () => {
    const scope = tagScope(entries, tagged, heads, true)
    expect(vlmCalls(scope, 'vlm')).toBe(4)
    expect(vlmCalls(scope, 'florence2')).toBe(0)
    expect(vlmCalls(scope, 'off')).toBe(0)
  })
})

describe('the Smart Tag request', () => {
  const scope = tagScope(entries, tagged, heads, false)

  test('skip_existing follows the choice; the trigger never goes to the Library', () => {
    expect(smartTagBody(options, scope, 'character', 'sdxl')).toMatchObject({
      image_ids: [1],
      image_paths: ['D:/set/a.png'],
      trigger_word: '',
      skip_existing: true,
      enable_vlm: false,
      training_purpose: 'character',
      character_threshold: 0.8,
      max_tags_per_image: 40,
      taggers: [],
    })
    expect(smartTagBody({ ...options, retagExisting: true }, scope, null, '').skip_existing).toBe(false)
    expect('general_threshold' in smartTagBody(options, scope, null, '')).toBe(false)
  })

  test('the caption profile comes from the base model, and only for VLM descriptions', () => {
    const krea = smartTagBody({ ...options, describer: 'vlm' }, scope, null, 'krea2')
    expect(krea).toMatchObject({ enable_vlm: true, natural_language_mode: 'vlm', caption_profile: 'krea2_long_nl' })
    expect('caption_profile' in smartTagBody({ ...options, describer: 'vlm' }, scope, null, 'sdxl')).toBe(false)
    const florence = smartTagBody({ ...options, describer: 'florence2' }, scope, null, 'krea2')
    expect(florence.natural_language_mode).toBe('florence2')
    expect('caption_profile' in florence).toBe(false)
  })

  test('purposes in Smart Tag words; two taggers vote', () => {
    expect(['character', 'style', 'outfit', 'pose', 'concept', 'general', null].map((p) => smartTagPurpose(p as never))).toEqual([
      'character',
      'style',
      'concept',
      'concept',
      'concept',
      'general',
      'general',
    ])
    const two = smartTagBody({ ...options, secondModel: 'camie-tagger-v2', agreement: 'both' }, scope, null, '')
    expect(two.taggers).toEqual([{ model: 'wd-swinv2-tagger-v3', character_threshold: 0.8 }, { model: 'camie-tagger-v2' }])
    expect(two.consensus_min).toBe(2)
  })
})

describe('folder results become AI caption revisions', () => {
  test('content, source and generation per image; user edits stay; empty results write nothing', () => {
    const headsWithEdit = new Map(heads).set(folderKey('D:/set/c.png'), { generation: 5, author: 'user' })
    const { write, kept, empty } = revisionsFromResults(
      [
        { path: 'D:/set/a.png', caption: 'x', booru_text: '1girl, smile', nl_text: 'A girl smiles.' },
        { path: 'D:\\set\\b.png', caption: 'x', booru_text: '', nl_text: 'Only words.' },
        { path: 'D:/set/c.png', caption: 'x', booru_text: 'kept', nl_text: '' },
        { path: 'D:/set/d.png', caption: '', booru_text: ' ', nl_text: '' },
      ],
      headsWithEdit,
    )
    expect(write).toEqual([
      {
        path: 'D:/set/a.png',
        content: { content_version: 1, booru_caption: '1girl, smile', nl_caption: 'A girl smiles.', caption_type: 'both' },
        source: 'wd14',
        generation: 0,
      },
      {
        path: 'D:\\set\\b.png',
        content: { content_version: 1, booru_caption: '', nl_caption: 'Only words.', caption_type: 'nl' },
        source: 'vlm',
        generation: 2,
      },
    ])
    expect(kept).toEqual(['D:/set/c.png'])
    expect(empty).toBe(1)
  })

  test('heads are keyed like the entries', () => {
    expect(headKey({ item_type: 'library', image_id: 4 })).toBe(libraryKey(4))
    expect(headKey({ item_type: 'local', path: 'D:\\x\\y.png' })).toBe(folderKey('D:/x/y.png'))
  })
})
