import { describe, expect, test } from 'vitest'
import { DEFAULT_DISGUISE, detectorChoice, folderOf, formatBytes, frameMs, isMakeAnswer, makeFields, needsCover, problemWords, readDisguise, reasonWords } from './disguiseModel'

const detector = detectorChoice(null, '', '', 0.5, ['breasts'])
const ctx = { defaultText: 'Open to view', outputName: null, detector }
const field = (fields: ReturnType<typeof makeFields>, name: string) => fields.find(([n]) => n === name)?.[1]

describe('readDisguise', () => {
  test('empty or damaged storage gives the defaults', () => {
    expect(readDisguise(null)).toEqual(DEFAULT_DISGUISE)
    expect(readDisguise('{oops')).toEqual(DEFAULT_DISGUISE)
    expect(readDisguise('7')).toEqual(DEFAULT_DISGUISE)
  })

  test('each field is checked on its own', () => {
    const s = readDisguise(JSON.stringify({ coverKind: 'blur', coverBg: 'red', pack: true, packFormat: 'gif', frameSeconds: -2, maxSide: 0, scrub: false, outputFolder: 'D:\\out' }))
    expect(s.coverKind).toBe('blur')
    expect(s.coverBg).toBe(DEFAULT_DISGUISE.coverBg)
    expect(s.pack).toBe(true)
    expect(s.packFormat).toBe('gif')
    expect(s.frameSeconds).toBe(1)
    expect(s.maxSide).toBe(0)
    expect(s.scrub).toBe(false)
    expect(s.outputFolder).toBe('D:\\out')
    expect(readDisguise(JSON.stringify({ coverKind: 'weird' })).coverKind).toBe('default')
  })
})

describe('makeFields', () => {
  test('sends the settings the way the program reads them', () => {
    const fields = makeFields({ ...DEFAULT_DISGUISE, frameSeconds: 0.5, outputFolder: '  D:\\out ' }, ctx)
    expect(field(fields, 'cover_kind')).toBe('default')
    expect(field(fields, 'frame_ms')).toBe('500')
    expect(field(fields, 'max_side')).toBe('1600')
    expect(field(fields, 'scrub')).toBe('true')
    expect(field(fields, 'output_folder')).toBe('D:\\out')
    expect(field(fields, 'cover_text')).toBe('Open to view')
    expect(field(fields, 'output_format')).toBeUndefined()
    expect(field(fields, 'detect_model_type')).toBeUndefined()
  })

  test('a typed card text wins; a name and a GIF pack are added', () => {
    const fields = makeFields({ ...DEFAULT_DISGUISE, coverText: ' hi ', pack: true, packFormat: 'gif' }, { ...ctx, outputName: 'cat' })
    expect(field(fields, 'cover_text')).toBe('hi')
    expect(field(fields, 'output_name')).toBe('cat')
    expect(field(fields, 'output_format')).toBe('gif')
  })

  test('a mosaic cover carries the detector', () => {
    const fields = makeFields({ ...DEFAULT_DISGUISE, coverKind: 'mosaic' }, ctx)
    expect(field(fields, 'detect_model_type')).toBe('nudenet')
    expect(field(fields, 'detect_confidence')).toBe('0.5')
    expect(field(fields, 'detect_targets')).toBe('["breasts"]')
  })
})

describe('detectorChoice', () => {
  test('SAM3 and an unset choice use NudeNet; a legacy model takes its file', () => {
    expect(detectorChoice('sam3', 'a.pt', '', 0.4, []).modelType).toBe('nudenet')
    expect(detectorChoice('sam3', 'a.pt', '', 0.4, []).modelPath).toBe('')
    expect(detectorChoice('legacy', 'a.pt', ' b.pt ', 0.4, ['dick'])).toEqual({ modelType: 'legacy', modelPath: 'b.pt', confidence: 0.4, targets: ['dick'] })
    expect(detectorChoice('both', 'a.pt', '', 0.4, []).modelPath).toBe('a.pt')
  })
})

describe('small rules', () => {
  test('frameMs never goes below 1', () => {
    expect(frameMs(1)).toBe(1000)
    expect(frameMs(0.0001)).toBe(1)
    expect(frameMs(Number.NaN)).toBe(1000)
  })

  test('a GIF pack needs no cover', () => {
    expect(needsCover(DEFAULT_DISGUISE)).toBe(true)
    expect(needsCover({ ...DEFAULT_DISGUISE, pack: true, packFormat: 'gif' })).toBe(false)
    expect(needsCover({ ...DEFAULT_DISGUISE, pack: true })).toBe(true)
  })

  test('reasons and problems are put into words', () => {
    expect(reasonWords('nothing_detected').key).toBe('disguise.reason.nothing_detected')
    expect(reasonWords('x_y')).toEqual({ key: 'disguise.reason.unknown', params: { reason: 'x_y' } })
    expect(problemWords(400, 'This picture is not a disguise image.').key).toBe('disguise.err.notDisguise')
    expect(problemWords(400, 'The hidden picture is damaged and cannot be read.').key).toBe('disguise.err.damaged')
    expect(problemWords(413, 'Image file is too large.').key).toBe('disguise.err.tooLarge')
    expect(problemWords(404, 'Image 5 is gone').key).toBe('disguise.err.libraryGone')
    expect(problemWords(400, 'Upload is not a readable image.').key).toBe('disguise.err.unreadable')
    expect(problemWords(500, 'boom')).toEqual({ key: 'disguise.err.generic', params: { detail: 'boom' } })
  })

  test('folderOf and formatBytes', () => {
    expect(folderOf('D:\\out\\a.png')).toBe('D:\\out')
    expect(folderOf('/data/disguise/output/a.png')).toBe('/data/disguise/output')
    expect(formatBytes(10)).toBe('1 KB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  test('isMakeAnswer accepts the two shapes and nothing else', () => {
    expect(isMakeAnswer({ status: 'needs_cover', reason: 'no_upload' })).toBe(true)
    expect(isMakeAnswer({ status: 'ok', token: 't', file_url: '/u', output_path: 'p', file_name: 'n', cover_preview: 'c', width: 1, height: 1, real_frames: 1, bytes: 1 })).toBe(true)
    expect(isMakeAnswer({ status: 'ok' })).toBe(false)
    expect(isMakeAnswer(null)).toBe(false)
  })
})
