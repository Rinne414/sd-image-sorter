import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionContent } from '../datasetTag'
import {
  composeCaption,
  contentsFromRows,
  initialContent,
  splitTags,
  initialTemplate,
  withoutTag,
  withTags,
} from './captionContent'
import { createCaptionSession, NO_HEAD, type HeadSnapshot, type SaveOutcome } from './captionSession'
import { afterRemoval, entryMarks, filterCounts, matches, stepKey, toggleSelection } from './marks'

const content = (booru: string, nl = '', type: CaptionContent['caption_type'] = 'booru'): CaptionContent => ({
  content_version: 1,
  booru_caption: booru,
  nl_caption: nl,
  caption_type: type,
})

const head = (generation: number, c: CaptionContent | null, revisionId = generation * 10): HeadSnapshot => ({
  generation,
  revisionId: c ? revisionId : null,
  subjectId: c ? 7 : null,
  author: c ? 'user' : null,
  content: c,
})

describe('the caption a never-edited image starts from', () => {
  it('takes the rendered tags; a description the template does not write stays in its box, unused', () => {
    const start = initialContent('1girl,  long_hair ,smile', 'A girl smiles.', '{trigger}, {tags:filtered}, {append}')
    expect(start).toEqual(content('1girl, long_hair, smile', 'A girl smiles.', 'booru'))
  })

  it('writes tags then words for a template that has both (Anima)', () => {
    const anima = '{quality}, {safety}, {count}, {trigger}, {characters}, {copyright}, {artists:@}, {general}. {nl_caption}'
    expect(initialContent('1girl, smile', 'A girl smiles.', anima).caption_type).toBe('both')
    expect(initialTemplate(anima, false)).toBe('{quality}, {safety}, {count}, {trigger}, {characters}, {copyright}, {artists:@}, {general}')
  })

  it('writes only words for a words-only template (FLUX), the words flattened to one line', () => {
    const flux = '{trigger}. {nl_caption}'
    expect(initialTemplate(flux, false)).toBe('{tags:filtered}')
    expect(initialContent('1girl', 'An old' + String.fromCharCode(10) + 'caption.', flux)).toEqual(content('1girl', 'An old caption.', 'nl'))
  })

  it('leaves the appended text out once common tags are set (the rule adds them)', () => {
    expect(initialTemplate('{trigger}, {tags:filtered}, {append}', false)).toBe('{trigger}, {tags:filtered}, {append}')
    expect(initialTemplate('{trigger}, {tags:filtered}, {append}', true)).toBe('{trigger}, {tags:filtered}')
  })

  it('is tags when there are no words (folder images, untagged descriptions)', () => {
    expect(initialContent('1girl', '', '{trigger}. {nl_caption}').caption_type).toBe('booru')
    expect(initialContent('', '', '{tags:filtered}')).toEqual(content(''))
  })

  it('builds many at once from the two renders (the tag step uses the same): the sentence goes to the words box, not the tags', () => {
    const entries = [
      { key: 'lib:4', imageId: 4, path: null },
      { key: 'dir:D:/set/a.png', imageId: null, path: 'D:\\set\\a.png' },
      { key: 'lib:5', imageId: 5, path: null },
    ]
    const row = (image_id: number, abs_path: string, caption: string, error: string | null = null) => ({ image_id, abs_path, caption, error, skipped_reason: null })
    const tags = [row(4, '', '1girl, smile'), row(0, 'D:/set/a.png', 'forest'), row(5, '', '', 'unreadable')]
    const words = [row(4, '', 'A girl smiles in the rain.'), row(0, 'D:/set/a.png', '')]
    const fresh = contentsFromRows(entries, tags, words, '{trigger}. {nl_caption}')
    expect(fresh.get('lib:4')).toEqual(content('1girl, smile', 'A girl smiles in the rain.', 'nl'))
    expect(fresh.get('lib:4')?.booru_caption).not.toContain('rain')
    expect(fresh.get('dir:D:/set/a.png')).toEqual(content('forest'))
    expect(fresh.has('lib:5')).toBe(false)
  })
})

describe('caption edits', () => {
  it('splits and composes like the backend', () => {
    expect(splitTags(' a_b ,\n c  d,, ')).toEqual(['a_b', 'c d'])
    expect(composeCaption(content('a, b', 'Two  lines\nhere.', 'both'))).toBe('a, b, Two lines here.')
    expect(composeCaption(content('a, b', '', 'nl'))).toBe('a, b')
  })

  it('adds tags once (any spelling) and removes by any spelling', () => {
    const { content: next, added } = withTags(content('long hair'), ['long_hair', 'smile, Smile', 'solo'])
    expect(added).toBe(2)
    expect(next.booru_caption).toBe('long hair, smile, solo')
    expect(withoutTag(next, 'LONG_HAIR').booru_caption).toBe('smile, solo')
  })
})

describe('the caption session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (outcomes: ((c: CaptionContent, generation: number) => SaveOutcome)[]) => {
    const calls: { content: CaptionContent; generation: number }[] = []
    let n = 0
    const session = createCaptionSession({
      delayMs: 500,
      save: async (_key, c, generation) => {
        calls.push({ content: c, generation })
        const make = outcomes[Math.min(n, outcomes.length - 1)]
        n += 1
        return make ? make(c, generation) : { kind: 'failed', reason: 'no outcome' }
      },
      restore: async () => ({ kind: 'failed', reason: 'unused' }),
    })
    const item = () => session.store.getState().items.k
    return { session, calls, item }
  }

  const savedAs = (c: CaptionContent, generation: number): SaveOutcome => ({ kind: 'saved', head: head(generation + 1, c) })

  it('shows what the server holds, or the initial caption for a never-edited image', () => {
    const { session, item } = setup([savedAs])
    session.open('k', NO_HEAD, content('fresh'))
    expect(item()?.content.booru_caption).toBe('fresh')
    session.open('j', head(3, content('saved')), content('fresh'))
    expect(session.store.getState().items.j?.content.booru_caption).toBe('saved')
  })

  it('saves once after the pause, with the last change and the generation it was made on', async () => {
    const { session, calls, item } = setup([savedAs])
    session.open('k', head(2, content('a')), content(''))
    session.edit('k', (c) => ({ ...c, booru_caption: 'a, b' }))
    session.edit('k', (c) => ({ ...c, booru_caption: 'a, b, c' }))
    expect(item()?.status).toBe('waiting')
    await vi.advanceTimersByTimeAsync(499)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([{ content: content('a, b, c'), generation: 2 }])
    expect(item()?.status).toBe('saved')
    expect(item()?.head.generation).toBe(3)
  })

  it('does not save a change that changes nothing', async () => {
    const { session, calls } = setup([savedAs])
    session.open('k', head(1, content('a')), content(''))
    session.edit('k', (c) => ({ ...c }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(0)
  })

  it('saves a change made while saving right after, on the new generation', async () => {
    const { session, calls, item } = setup([savedAs])
    session.open('k', head(1, content('a')), content(''))
    session.edit('k', () => content('b'))
    await vi.advanceTimersByTimeAsync(500)
    session.edit('k', () => content('c'))
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.map((c) => [c.content.booru_caption, c.generation])).toEqual([
      ['b', 1],
      ['c', 2],
    ])
    expect(item()?.content.booru_caption).toBe('c')
  })

  it('on a generation conflict shows the newer version, says so, and keeps the user one click away', async () => {
    const theirs = content('theirs')
    const { session, calls, item } = setup([() => ({ kind: 'conflict', head: head(5, theirs) }), savedAs])
    session.open('k', head(2, content('a')), content(''))
    session.edit('k', () => content('mine'))
    await vi.advanceTimersByTimeAsync(500)
    expect(item()?.status).toBe('conflict')
    expect(item()?.content).toEqual(theirs)
    expect(item()?.lost).toEqual(content('mine'))
    expect(item()?.head.generation).toBe(5)

    session.reapplyLost('k')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.at(-1)).toEqual({ content: content('mine'), generation: 5 })
    expect(item()?.status).toBe('saved')
    expect(item()?.lost).toBeNull()
  })

  it('keeps a failed change on screen and saves it on retry', async () => {
    const { session, calls, item } = setup([() => ({ kind: 'failed', reason: 'offline' }), savedAs])
    session.open('k', head(1, content('a')), content(''))
    session.edit('k', () => content('b'))
    await vi.advanceTimersByTimeAsync(500)
    expect(item()).toMatchObject({ status: 'failed', error: 'offline', content: content('b') })
    session.retry('k')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    expect(item()?.status).toBe('saved')
  })

  it('undo goes back one saved change at a time, each saved as a new revision', async () => {
    const { session, calls, item } = setup([savedAs])
    session.open('k', head(1, content('a')), content(''))
    session.edit('k', () => content('a, b'))
    await vi.advanceTimersByTimeAsync(500)
    session.edit('k', () => content('a, b, c'))
    await vi.advanceTimersByTimeAsync(500)
    session.undo('k')
    await vi.advanceTimersByTimeAsync(0)
    expect(item()?.content.booru_caption).toBe('a, b')
    session.undo('k')
    await vi.advanceTimersByTimeAsync(0)
    expect(item()?.content.booru_caption).toBe('a')
    expect(item()?.undo).toHaveLength(0)
    session.undo('k')
    expect(calls.map((c) => c.content.booru_caption)).toEqual(['a, b', 'a, b, c', 'a, b', 'a'])
  })

  it('a newer server version replaces an image the user is not editing', () => {
    const { session, item } = setup([savedAs])
    session.open('k', head(1, content('a')), content(''))
    session.open('k', head(2, content('by the tagger')), content(''))
    expect(item()?.content.booru_caption).toBe('by the tagger')
  })

  it('restore makes an earlier revision current and can be undone', async () => {
    const restored = content('old one')
    const session = createCaptionSession({
      delayMs: 500,
      save: async (_k, c, g) => savedAs(c, g),
      restore: async (_k, revisionId, subjectId, generation) => {
        expect([revisionId, subjectId, generation]).toEqual([10, 7, 3])
        return { kind: 'saved', head: head(4, restored) }
      },
    })
    session.open('k', head(3, content('now')), content(''))
    expect(await session.restore('k', 10)).toBe(true)
    const item = session.store.getState().items.k
    expect(item?.content).toEqual(restored)
    expect(item?.undo).toEqual([content('now')])
  })
})

describe('the image list marks and moves', () => {
  const form = {
    trigger: 'mychar',
    targetModel: '' as const,
    purpose: null,
    removeCategories: [],
    commonTags: 'best quality',
    blacklist: '',
    maxTags: 0,
    template: '',
    replaceRules: '',
    prefix: '',
    normalizeUnderscores: true,
  }
  const entry = (key: string, imageId: number | null, status: 'ok' | 'missing' | 'changed' = 'ok') => ({
    key,
    ref: imageId !== null ? { kind: 'library' as const, imageId } : { kind: 'folder' as const, path: key },
    imageId,
    path: imageId === null ? key : null,
    filename: key,
    width: null,
    height: null,
    status,
    item: null,
  })

  it('marks who wrote a caption and whether it says anything of its own', () => {
    const user = { generation: 2, author: 'user' as const, content: content('smile') }
    const ai = { generation: 1, author: 'ai' as const, content: content('', '', 'booru') }
    expect(entryMarks(entry('lib:1', 1), user, undefined, form)).toEqual({ edited: true, ai: false, empty: false, locked: false })
    expect(entryMarks(entry('lib:2', 2), ai, undefined, form)).toEqual({ edited: false, ai: true, empty: true, locked: false })
    // never edited: the template's caption minus what the rules put in front
    expect(entryMarks(entry('lib:3', 3), undefined, 'mychar, best quality', form).empty).toBe(true)
    expect(entryMarks(entry('lib:4', 4), undefined, 'mychar, best quality, 1girl', form).empty).toBe(false)
    expect(entryMarks(entry('lib:5', 5), undefined, undefined, form).empty).toBeNull()
    expect(entryMarks(entry('D:/a.png', null, 'changed'), undefined, undefined, form).locked).toBe(true)
    const gone = { ...entry('lib:6', 6), imageId: null, status: 'missing' as const }
    expect(entryMarks(gone, undefined, undefined, form).locked).toBe(true)
  })

  it('counts each filter and steps within the list', () => {
    const marks = [
      { edited: true, ai: false, empty: false, locked: false },
      { edited: false, ai: true, empty: true, locked: false },
      { edited: false, ai: false, empty: null, locked: false },
    ]
    expect(filterCounts(marks)).toEqual({ all: 3, edited: 1, ai: 1, empty: 1 })
    expect(marks.filter((m) => matches(m, 'empty'))).toHaveLength(1)
    expect(stepKey(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(stepKey(['a', 'b', 'c'], 'c', 1)).toBe('c')
    expect(stepKey(['a', 'b', 'c'], 'zz', -1)).toBe('a')
    expect(afterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(afterRemoval(['a', 'b', 'c'], 'a')).toBe('b')
  })
})

describe('picking images for a bulk change', () => {
  const shown = ['a', 'b', 'c', 'd', 'e']
  it('a click flips one; Shift+click sets the range from the last click to the new state', () => {
    let sel = toggleSelection(shown, new Set(), null, 'b', false)
    expect([...sel]).toEqual(['b'])
    sel = toggleSelection(shown, sel, 'b', 'd', true)
    expect([...sel].sort()).toEqual(['b', 'c', 'd'])
    sel = toggleSelection(shown, sel, 'd', 'c', true)
    expect([...sel].sort()).toEqual(['b'])
    sel = toggleSelection(shown, new Set(['a', 'b', 'c']), 'a', 'b', false)
    expect([...sel].sort()).toEqual(['a', 'c'])
    expect([...toggleSelection(shown, new Set(['a', 'b', 'c', 'd']), 'a', 'c', true)].sort()).toEqual(['d'])
  })
})
