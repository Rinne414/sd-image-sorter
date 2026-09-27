import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  formFromSettings,
  isDirty,
  isLocalEndpoint,
  settingsBody,
  testOutcome,
  usesOllamaModel,
  vlmReadiness,
  withDetectedProvider,
  type VlmForm,
} from './vlmForm'

const stored = {
  provider: 'openai_compat',
  endpoint: 'https://api.example.test/v1',
  api_key_display: 'sk-abcde***',
  model: 'vision-1',
  max_retries: 3,
  timeout_seconds: 60,
  concurrent_requests: 2,
  caption_temperature: 0,
  use_vertex: false,
  service_account_json_display: '*** (configured)',
}

const form = (patch: Partial<VlmForm> = {}): VlmForm => ({ ...formFromSettings(stored), ...patch })

describe('settingsBody never wipes a stored secret', () => {
  it('leaves api_key and service_account_json out when nothing new was typed', () => {
    const r = settingsBody(form())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect('api_key' in r.body).toBe(false)
    expect('service_account_json' in r.body).toBe(false)
  })

  it('leaves them out when only spaces were typed', () => {
    const r = settingsBody(form({ apiKey: '   ', serviceAccountJson: ' \n ' }))
    expect(r.ok && 'api_key' in r.body).toBe(false)
    expect(r.ok && 'service_account_json' in r.body).toBe(false)
  })

  it('never sends a masked stand-in back as the key', () => {
    for (const apiKey of ['sk-abcde***', '••••••••', '*** (configured)']) {
      const r = settingsBody(form({ apiKey, serviceAccountJson: '*** (configured)' }))
      expect(r.ok && 'api_key' in r.body).toBe(false)
      expect(r.ok && 'service_account_json' in r.body).toBe(false)
    }
  })

  it('sends a newly typed key and service account, trimmed', () => {
    const r = settingsBody(form({ apiKey: '  sk-new-key  ', serviceAccountJson: ' {"type":"service_account"} ' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body.api_key).toBe('sk-new-key')
    expect(r.body.service_account_json).toBe('{"type":"service_account"}')
  })

  it('sends every other field, numbers as numbers, and a temperature of 0', () => {
    const r = settingsBody(form())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toMatchObject({
      provider: 'openai_compat',
      endpoint: 'https://api.example.test/v1',
      model: 'vision-1',
      max_retries: 3,
      timeout_seconds: 60,
      concurrent_requests: 2,
      caption_temperature: 0,
      caption_max_tokens: 1024,
      max_image_size: 1024,
      retry_delay_seconds: 2,
      include_tags_as_context: true,
      vertex_location: 'us-central1',
    })
  })

  it('leaves the stored output format alone (only V3.5 batch captioning reads it)', () => {
    const r = settingsBody(form())
    expect(r.ok && 'output_format' in r.body).toBe(false)
  })
})

describe('settingsBody checks what the backend would refuse', () => {
  it('names a number out of range', () => {
    const r = settingsBody(form({ concurrent: '17' }))
    expect(r).toEqual({ ok: false, error: { key: 'ai.range', field: 'ai.adv.concurrent', min: 1, max: 16 } })
  })

  it('refuses a number that is not one, or a fraction where a whole number is needed', () => {
    expect(settingsBody(form({ timeoutSeconds: 'soon' })).ok).toBe(false)
    expect(settingsBody(form({ maxRetries: '2.5' })).ok).toBe(false)
    expect(settingsBody(form({ retryDelay: '0.5' })).ok).toBe(true)
  })

  it('asks for http(s) in an address that has one', () => {
    expect(settingsBody(form({ endpoint: 'api.example.test/v1' }))).toEqual({ ok: false, error: { key: 'ai.needHttp' } })
    expect(settingsBody(form({ endpoint: '' })).ok).toBe(true)
  })
})

describe('formFromSettings', () => {
  it('fills the defaults the backend uses and never holds a secret', () => {
    const f = formFromSettings({})
    expect(f).toMatchObject({ provider: 'openai_compat', endpoint: '', apiKey: '', maxRetries: '3', timeoutSeconds: '60', concurrent: '2', maxTokens: '1024', temperature: '0.3', retryDelay: '2', maxImageSize: '1024', includeTags: true, vertexLocation: 'us-central1', serviceAccountJson: '' })
    expect(formFromSettings(stored).apiKey).toBe('')
  })

  it('treats an unknown provider as the default', () => {
    expect(formFromSettings({ provider: 'mystery' })).toMatchObject({ provider: 'openai_compat' })
  })
})

describe('the provider follows the address', () => {
  it('applies what the backend recognised while the address is unchanged', () => {
    const f = form({ endpoint: 'https://api.anthropic.com' })
    expect(withDetectedProvider(f, 'https://api.anthropic.com', 'anthropic').provider).toBe('anthropic')
  })

  it('ignores an answer for an address the user has since changed', () => {
    const f = form({ endpoint: 'https://generativelanguage.googleapis.com' })
    expect(withDetectedProvider(f, 'https://api.anthropic.com', 'anthropic')).toBe(f)
  })

  it('ignores an answer that is not a known provider', () => {
    const f = form()
    expect(withDetectedProvider(f, f.endpoint, 'mystery')).toBe(f)
  })
})

describe('applyPreset', () => {
  it('replaces the prompts with the preset', () => {
    const f = applyPreset(form({ systemPrompt: 'mine', userPrompt: 'mine' }), {
      name: 'Hybrid',
      output_format: 'both',
      system_prompt: 'sys',
      user_prompt: 'user',
      user_prompt_with_tags: 'user {tags}',
    })
    expect(f).toMatchObject({ systemPrompt: 'sys', userPrompt: 'user', userPromptWithTags: 'user {tags}' })
  })

  it('clears a prompt the preset does not have', () => {
    const f = applyPreset(form({ userPromptWithTags: 'mine {tags}' }), { name: 'x', output_format: 'poem', system_prompt: 's', user_prompt: 'u' })
    expect(f.userPromptWithTags).toBe('')
  })
})

describe('vlmReadiness (what the tag panel offers)', () => {
  it('is ready with an address and a key', () => {
    expect(vlmReadiness(stored)).toEqual({ ready: true, local: false, label: 'vision-1', missing: null })
  })

  it('needs no key on this computer, and says it is local', () => {
    expect(vlmReadiness({ endpoint: 'http://localhost:11434/v1', model: 'qwen2.5-vl:7b' })).toEqual({ ready: true, local: true, label: 'qwen2.5-vl:7b', missing: null })
  })

  it('names what is missing', () => {
    expect(vlmReadiness({}).missing).toBe('endpoint')
    expect(vlmReadiness({ endpoint: 'https://api.example.test/v1' }).missing).toBe('key')
    expect(vlmReadiness({ provider: 'anthropic', endpoint: 'http://localhost:8080' }).missing).toBe('key')
  })

  it('is ready through Vertex with a project', () => {
    expect(vlmReadiness({ provider: 'gemini', use_vertex: true, vertex_project: 'p1', model: 'gemini-2.0-flash' }).ready).toBe(true)
    expect(vlmReadiness({ provider: 'gemini', use_vertex: true }).ready).toBe(false)
  })
})

describe('isLocalEndpoint', () => {
  it('knows this computer and the local network names', () => {
    for (const e of ['http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://[::1]:8000', 'http://box.local/v1', 'http://nas.lan:8080']) expect(isLocalEndpoint(e)).toBe(true)
    for (const e of ['https://api.openai.com/v1', '', 'not a url']) expect(isLocalEndpoint(e)).toBe(false)
  })
})

describe('isDirty', () => {
  it('sees an edit, a typed key and nothing else', () => {
    const base = form()
    expect(isDirty(base, base)).toBe(false)
    expect(isDirty(form({ model: 'vision-2' }), base)).toBe(true)
    expect(isDirty(form({ apiKey: 'sk-new' }), base)).toBe(true)
  })
})

describe('testOutcome', () => {
  it('counts the models of a good connection', () => {
    expect(testOutcome({ status: 'ok', models: ['a', 'b'] })).toEqual({ ok: true, key: 'ai.test.ok', params: { n: 2 } })
    expect(testOutcome({ status: 'ok', models: [], note: 'Models endpoint returned 404' })).toEqual({ ok: true, key: 'ai.test.okNoList', params: {} })
  })

  it('says why a connection failed, with the service reason', () => {
    expect(testOutcome({ status: 'error', error: 'Invalid API key', error_type: 'auth' })).toEqual({ ok: false, key: 'ai.test.failDetail', params: { why: 'ai.why.auth', reason: 'Invalid API key' } })
    expect(testOutcome({ status: 'error', error_type: 'weird' })).toEqual({ ok: false, key: 'ai.test.fail', params: { why: 'ai.why.unknown' } })
  })
})

describe('usesOllamaModel', () => {
  it('is the model on the Ollama of this computer', () => {
    expect(usesOllamaModel({ endpoint: 'http://localhost:11434/v1', model: 'gemma3:4b' }, 'gemma3:4b')).toBe(true)
    expect(usesOllamaModel({ endpoint: 'http://127.0.0.1:11434', model: 'gemma3:4b' }, 'gemma3:4b')).toBe(true)
    expect(usesOllamaModel({ endpoint: 'http://localhost:11434/v1', model: 'gemma3:4b' }, 'qwen2.5-vl:7b')).toBe(false)
    expect(usesOllamaModel({ endpoint: 'http://localhost:1234/v1', model: 'gemma3:4b' }, 'gemma3:4b')).toBe(false)
    expect(usesOllamaModel({ endpoint: 'https://api.openai.com/v1', model: 'gemma3:4b' }, 'gemma3:4b')).toBe(false)
  })
})
