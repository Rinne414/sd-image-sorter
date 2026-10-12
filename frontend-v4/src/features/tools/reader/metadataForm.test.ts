import { describe, expect, it } from 'vitest'
import samples from './readerSamples.json'
import { fromParse, readRecord, type ParseResult } from './readerAdapter'
import {
  changedFields,
  editedName,
  fieldProblem,
  fieldsOf,
  formatOf,
  payloadOf,
  samePath,
  splitPath,
  warningMessage,
  withFormat,
  type MetaFields,
} from './metadataForm'

const view = (name: string) => readRecord(fromParse((samples as Record<string, { parse: unknown }>)[name]!.parse as ParseResult))

const blank: MetaFields = { prompt: '', negative: '', seed: '', model: '', sampler: '', steps: '', cfg: '', size: '', loras: '' }

describe('the nine fields', () => {
  it('start from what the image records', () => {
    expect(fieldsOf(view('a1111'))).toEqual({
      prompt: expect.stringContaining('v4reader webui prompt'),
      negative: 'lowres, bad hands',
      seed: '123456789',
      model: 'v4reader_webui_model',
      sampler: 'DPM++ 2M',
      steps: '28',
      cfg: '7',
      size: '96x64',
      loras: 'v4reader_detail',
    })
  })

  it('send what is filled in, steps and CFG as numbers', () => {
    expect(payloadOf({ ...blank, prompt: ' 1girl ', steps: '30', cfg: '6.5', loras: 'a, b' })).toEqual({ prompt: '1girl', steps: 30, cfg_scale: 6.5, loras: 'a, b' })
    expect(payloadOf(blank)).toEqual({})
  })

  it('name a step count or CFG that is not a number', () => {
    expect(fieldProblem({ ...blank, steps: '2.5' })).toBe('steps')
    expect(fieldProblem({ ...blank, steps: '0' })).toBe('steps')
    expect(fieldProblem({ ...blank, cfg: 'high' })).toBe('cfg')
    expect(fieldProblem({ ...blank, steps: '20', cfg: '7' })).toBeNull()
    expect(fieldProblem(blank)).toBeNull()
  })

  it('list the fields that changed', () => {
    expect(changedFields(blank, { ...blank, seed: '5', prompt: 'x' })).toEqual(['prompt', 'seed'])
    expect(changedFields(blank, { ...blank, prompt: '  ' })).toEqual([])
  })
})

describe('where the copy goes', () => {
  it('reads the format from a file name', () => {
    expect(formatOf('a.PNG')).toBe('png')
    expect(formatOf('a.jpeg')).toBe('jpg')
    expect(formatOf('a.webp')).toBe('webp')
    expect(formatOf('a.gif')).toBeNull()
  })

  it('names the copy after the source and swaps the extension', () => {
    expect(editedName('C:\\pics\\cat.png', 'webp')).toBe('cat.edited.webp')
    expect(editedName('upload', 'jpg')).toBe('upload.edited.jpg')
    expect(withFormat('cat.edited.png', 'jpg')).toBe('cat.edited.jpg')
    expect(withFormat('noext', 'png')).toBe('noext.png')
  })

  it('splits a path and compares paths the way Windows does', () => {
    expect(splitPath('D:\\a\\b.png')).toEqual({ folder: 'D:\\a', name: 'b.png' })
    expect(splitPath('/x/y.png')).toEqual({ folder: '/x', name: 'y.png' })
    expect(samePath('D:\\A\\b.PNG', 'd:/a/b.png')).toBe(true)
    expect(samePath('/x/A.png', '/x/a.png')).toBe(false)
  })
})

describe('save warnings', () => {
  it("are shown in the user's words, with their values", () => {
    expect(warningMessage({ code: 'jpeg_limited', params: {} }, 'x')).toEqual({ key: 'reader.warn.jpegLimited', params: { keys: '', format: '', frames: '' } })
    expect(warningMessage({ code: 'chunks_not_carried', params: { format: 'JPEG', keys: ['prompt', 'workflow'] } }, 'x')).toEqual({
      key: 'reader.warn.chunksNotCarried',
      params: { keys: 'prompt, workflow', format: 'JPEG', frames: '' },
    })
    expect(warningMessage({ code: 'animation_flattened', params: { format: 'JPEG', frames: 12 } }, 'x')).toMatchObject({ params: { frames: 12 } })
  })

  it("an unknown code keeps the backend's sentence", () => {
    expect(warningMessage({ code: 'nai_fields_unsaved', params: { keys: ['LoRAs'] } }, 'x')).toMatchObject({ key: 'reader.warn.naiFieldsUnsaved', params: { keys: 'LoRAs' } })
    expect(warningMessage({ code: 'other', params: { text: 'New thing.' } }, 'New thing.')).toEqual({ text: 'New thing.' })
    expect(warningMessage({ code: 'brand_new' }, 'Said in English.')).toEqual({ text: 'Said in English.' })
  })
})
