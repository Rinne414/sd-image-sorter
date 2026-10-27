import { describe, expect, test } from 'vitest'
import { cleanName, isEdited, isOwn, ownNamed, promptFields, readRefusal, restoreBody, splitPresets } from './presets'
import type { Preset } from './types'
import { formFromSettings } from './vlmForm'

/** What api/client.ts#ApiError carries (that module needs a browser to load). */
const ApiError = class extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(message)
  }
}

const form = (over: Partial<ReturnType<typeof formFromSettings>> = {}) => ({ ...formFromSettings({}), ...over })

const BUILTIN: Preset = { id: 'lora_training', name: 'LoRA', builtin: true, output_format: 'nl_caption', system_prompt: 's', user_prompt: 'u' }
const MINE: Preset = { id: 'custom-0123abcd', name: 'Cat  captions', builtin: false, output_format: 'nl_caption', system_prompt: 'ms', user_prompt: 'mu', user_prompt_with_tags: 'mt' }
const TAGS: Preset = { id: 'custom-ffff0000', name: 'Tag list', builtin: false, output_format: 'danbooru_tags' }

describe('splitPresets', () => {
  test('the shipped ones apart from the user’s own; a preset with no flag is a shipped one', () => {
    const noFlag: Preset = { name: 'Plain', output_format: 'nl_caption' }
    const split = splitPresets({ a: BUILTIN, b: MINE, c: noFlag })
    expect(split.builtin.map(([id]) => id)).toEqual(['a', 'c'])
    expect(split.mine.map(([id]) => id)).toEqual(['b'])
  })

  test('a preset that makes the model answer with tags is not offered, even among the user’s own', () => {
    const split = splitPresets({ a: BUILTIN, t: TAGS })
    expect(split.mine).toEqual([])
  })

  test('isOwn is true only for builtin:false', () => {
    expect(isOwn(MINE)).toBe(true)
    expect(isOwn(BUILTIN)).toBe(false)
    expect(isOwn({ name: 'x' })).toBe(false)
    expect(isOwn(undefined)).toBe(false)
  })
})

describe('what the boxes say against a preset', () => {
  const same = form({ systemPrompt: 'ms', userPrompt: 'mu', userPromptWithTags: 'mt' })

  test('the same prompts are not an edit', () => {
    expect(isEdited(same, MINE)).toBe(false)
  })

  test.each([{ systemPrompt: 'x' }, { userPrompt: 'x' }, { userPromptWithTags: 'x' }])('a change in %o is an edit', (change) => {
    expect(isEdited({ ...same, ...change }, MINE)).toBe(true)
  })

  test('a preset with no tags prompt equals an empty box; no preset is never an edit', () => {
    expect(isEdited(form({ systemPrompt: 's', userPrompt: 'u' }), BUILTIN)).toBe(false)
    expect(isEdited(same, undefined)).toBe(false)
  })

  test('a save sends the three prompts of the form', () => {
    expect(promptFields(same)).toEqual({ system_prompt: 'ms', user_prompt: 'mu', user_prompt_with_tags: 'mt' })
  })
})

describe('names', () => {
  test('blanks are folded the way the backend keeps them', () => {
    expect(cleanName('  Cat   preset ')).toBe('Cat preset')
    expect(cleanName('   ')).toBe('')
  })

  test('an own preset is found by name without case or extra blanks; a shipped one is not', () => {
    const all = { a: BUILTIN, b: MINE }
    expect(ownNamed(all, 'cat captions')?.[0]).toBe('b')
    expect(ownNamed(all, 'lora')).toBeUndefined()
  })
})

describe('Undo of a delete', () => {
  test('brings back the same id with every prompt', () => {
    expect(restoreBody(MINE)).toEqual({
      id: 'custom-0123abcd',
      name: 'Cat  captions',
      output_format: 'nl_caption',
      system_prompt: 'ms',
      user_prompt: 'mu',
      user_prompt_with_tags: 'mt',
    })
  })

  test('a field the backend left out comes back empty', () => {
    expect(restoreBody({ id: 'custom-1', name: 'n' })).toMatchObject({ output_format: 'nl_caption', system_prompt: '', user_prompt: '', user_prompt_with_tags: '' })
  })
})

describe('readRefusal', () => {
  test('a name already used names the preset to replace', () => {
    const body = { code: 'vlm_preset_name_taken', message: 'x', params: { existing_id: 'custom-1', name: 'Cat' } }
    expect(readRefusal(new ApiError(409, 'x', 'vlm_preset_name_taken', body))).toEqual({ kind: 'taken', existingId: 'custom-1', name: 'Cat' })
  })

  test.each([
    ['vlm_preset_not_found', 'aipresets.err.gone'],
    ['vlm_preset_builtin', 'aipresets.err.builtin'],
    ['vlm_preset_name_required', 'aipresets.name.required'],
    ['vlm_preset_file_unreadable', 'aipresets.err.unreadable'],
    ['vlm_preset_file_busy', 'aipresets.err.busy'],
  ])('%s is said in words', (code, key) => {
    expect(readRefusal(new ApiError(400, 'x', code, {}))).toEqual({ kind: 'text', key })
  })

  test('anything else keeps the reason it came with', () => {
    expect(readRefusal(new ApiError(500, 'boom', null, {}))).toEqual({ kind: 'raw', message: 'boom' })
    expect(readRefusal(new Error('offline'))).toEqual({ kind: 'raw', message: 'offline' })
    expect(readRefusal('plain')).toEqual({ kind: 'raw', message: 'plain' })
  })

  test('a name-taken answer without the id falls back to the plain reason', () => {
    expect(readRefusal(new ApiError(409, 'taken', 'vlm_preset_name_taken', {}))).toEqual({ kind: 'raw', message: 'taken' })
  })
})
