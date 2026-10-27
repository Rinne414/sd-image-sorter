import { describe, expect, it } from 'vitest'
import { translate } from '../../i18n'
import type { GeneratorRecipe } from './generatorApi'
import { comfyKind, hasNothing, naiText, readSeedMode, saidError, savedWhere, SEED_MODE_KEY, webuiText, writeSeedMode } from './recipeText'

/** What api/client's ApiError looks like (that module needs the app's stores, which tests in node do not have). */
const ApiError = class extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const recipe = (over: Partial<GeneratorRecipe> = {}): GeneratorRecipe => ({
  image_id: 1,
  generator: 'comfyui',
  source_format: 'sd',
  has_prompt: true,
  webui_text: 'a cat\nNegative prompt: bad\nSteps: 20',
  webui_is_original: false,
  webui_settings_line: 'Steps: 20',
  nai_text: '',
  metadata_source: 'file',
  comfyui: { has_api_prompt: true, has_workflow: true, seed_inputs: 1, workflow: {} },
  comfyui_url: 'http://127.0.0.1:8188',
  ...over,
})

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params)

describe('webuiText', () => {
  it('uses the text the server built for a picture that is already in WebUI syntax', () => {
    expect(webuiText(recipe(), '(cat:1.2)', 'bad')).toBe('a cat\nNegative prompt: bad\nSteps: 20')
  })

  it('writes a NovelAI prompt in WebUI weights, with the settings line', () => {
    const nai = recipe({ source_format: 'nai', generator: 'nai' })
    expect(webuiText(nai, '1.2::cat::, dog', '1.5::bad::')).toBe('(cat:1.2), dog\nNegative prompt: (bad:1.5)\nSteps: 20')
  })

  it('keeps the original WebUI text of a WebUI picture', () => {
    const own = recipe({ source_format: 'sd', webui_is_original: true, webui_text: 'original' })
    expect(webuiText(own, 'x', 'y')).toBe('original')
  })
})

describe('naiText', () => {
  it('prefers the server text (it holds the character slots)', () => {
    expect(naiText(recipe({ nai_text: 'server text' }), 'a', 'b')).toBe('server text')
  })

  it('writes an SD prompt in NovelAI weights with the undesired content labelled', () => {
    expect(naiText(recipe(), '(cat:1.2), dog', 'bad')).toBe('1.2::cat::, dog\n\nUndesired Content: bad')
  })

  it('is empty when there is no prompt', () => {
    expect(naiText(recipe(), '', '')).toBe('')
    expect(naiText(recipe(), null, null)).toBe('')
  })
})

describe('what the picture holds for ComfyUI', () => {
  it('tells the four cases apart', () => {
    const part = (run: boolean, workflow: boolean) => recipe({ comfyui: { has_api_prompt: run, has_workflow: workflow, seed_inputs: 0, workflow: null } })
    expect(comfyKind(part(true, true))).toBe('full')
    expect(comfyKind(part(true, false))).toBe('runOnly')
    expect(comfyKind(part(false, true))).toBe('workflowOnly')
    expect(comfyKind(part(false, false))).toBe('none')
  })

  it('knows a picture with nothing to send', () => {
    const empty = recipe({ has_prompt: false, webui_text: '', comfyui: { has_api_prompt: false, has_workflow: false, seed_inputs: 0, workflow: null } })
    expect(hasNothing(empty, '', '')).toBe(true)
    expect(hasNothing(recipe(), 'x', '')).toBe(false)
  })
})

describe('savedWhere', () => {
  it('splits the path into the folder and the name', () => {
    expect(savedWhere({ path: 'C:\\out\\workflows\\a_2.json', filename: 'a_2.json' })).toEqual({ name: 'a_2.json', folder: 'C:\\out\\workflows\\' })
  })
})

describe('saidError', () => {
  const refused = (code: string, params: Record<string, unknown>, status = 502) => new ApiError(status, 'server words', code, { code, params, details: ['KSampler #3: bad seed'] })

  it('says ComfyUI is not reachable, with the address', () => {
    const said = saidError(en, refused('comfyui_unreachable', { address: 'http://127.0.0.1:8188' }), 'queue')
    expect(said.message).toBe('ComfyUI is not reachable at http://127.0.0.1:8188. Start ComfyUI, or check the address above.')
  })

  it('keeps ComfyUI\'s node error lines', () => {
    const said = saidError(en, refused('comfyui_rejected', { address: 'http://x', reason: 'Prompt outputs failed validation' }, 422), 'queue')
    expect(said.message).toContain('Prompt outputs failed validation')
    expect(said.details).toEqual(['KSampler #3: bad seed'])
  })

  it('words a missing recipe by what was tried', () => {
    const error = new ApiError(422, 'x', 'no_comfyui_recipe', { code: 'no_comfyui_recipe' })
    expect(saidError(en, error, 'queue').message).toBe('This picture has no ComfyUI recipe to run. Its prompt can still be copied.')
    expect(saidError(en, error, 'save').message).toBe('This picture has no ComfyUI workflow to save.')
  })

  it('speaks Chinese when asked to', () => {
    const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('zh-CN', key, params)
    expect(saidError(zh, refused('comfyui_unreachable', { address: 'http://a:1' }), 'queue').message).toContain('连不上 http://a:1')
  })

  it('shows the server words for a code it does not know, and for a plain error', () => {
    expect(saidError(en, new ApiError(500, 'boom', 'weird', { code: 'weird' }), 'save').message).toBe('That did not work: boom')
    expect(saidError(en, new Error('offline'), 'queue').message).toBe('That did not work: offline')
  })

  it('passes the server reason of a bad saved address', () => {
    const said = saidError(en, new ApiError(400, 'The host is wrong', 'bad_address', { code: 'bad_address' }), 'queue')
    expect(said.message).toBe('The ComfyUI address in the settings cannot be used: The host is wrong')
  })
})

describe('the seed choice', () => {
  const store = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
  }

  it('is a new seed until the user picks the same one', () => {
    const s = store()
    expect(readSeedMode(s)).toBe('new')
    writeSeedMode(s, 'same')
    expect(s.getItem(SEED_MODE_KEY)).toBe('same')
    expect(readSeedMode(s)).toBe('same')
  })

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readSeedMode(broken)).toBe('new')
    expect(() => writeSeedMode(broken, 'same')).not.toThrow()
  })
})
