import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { cleanupImages, openLibrary, pageOverflow, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Settings › AI services (slice 5f): the VLM service form (the key shown
 * only as a mask and never sent back empty or masked, the service type from
 * the address, Fetch available models, presets, the rarer settings, Test
 * connection), local Ollama (download into Jobs, use, delete, start), the API
 * chat log, and the tag panel's "also write a description" that says how many
 * calls it makes before one Smart Tag run starts.
 *
 * SAFETY: every /api/vlm/* request is answered here (a real one could call a
 * paid API with a stored key, start Ollama or download gigabytes), and so are
 * /api/smart-tag/*, /api/tag/start and /api/models/*: nothing leaves this
 * machine, nothing costs money, no model runs on the GPU.
 *
 * Needs the V4 build: `cd frontend-v4 && npm ci && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4aitoken'
const PREFIX = 'v4ai-'
const COUNT = 3
const DIR = 'v4-ai'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

type Json = Record<string, unknown>

/** A made-up key: it must never be sent back, nor appear on the page. */
const SECRET = 'sk-e2e-secret-0123456789abcdef'
const CLOUD: Json = { provider: 'openai_compat', endpoint: 'https://api.example.test/v1', api_key: SECRET, model: 'vision-1', concurrent_requests: 2 }

const PRESETS = {
  lora_training: { name: 'LoRA Training (NL caption)', output_format: 'nl_caption', system_prompt: 'You caption images for training.', user_prompt: 'Describe this image.', user_prompt_with_tags: 'Tags: {tags}' },
  vlm_hybrid: { name: 'Hybrid (NL + Tags)', output_format: 'both', system_prompt: 'You output JSON only.', user_prompt: 'Return description and tags.', user_prompt_with_tags: 'Existing tags: {tags}' },
}

const REC = (id: string, name: string, installed: boolean, size = 4.7): Json => ({ id, name, size_gb: size, vram_min_gb: 6, description: `${name} (backend text)`, nsfw_ok: true, installed })

interface Vlm {
  /** What vlm-settings.json holds, the key included. */
  stored: Json
  posts: Json[]
  test: Json
  models: string[]
  probes: Json[]
  local: Json
  pulls: string[]
  /** What the pull progress says: nothing pulling, pulling (40%), or done. */
  pull: { model: string; state: 'none' | 'running' | 'done' }
  deletes: string[]
  chat: Json[]
}

const newVlm = (stored: Json = {}): Vlm => ({
  stored: { ...stored },
  posts: [],
  test: { status: 'ok', models: [] },
  models: [],
  probes: [],
  local: { ollama_installed: true, ollama_running: true, install_instructions: null, models: [], local_models: [] },
  pulls: [],
  pull: { model: '', state: 'none' },
  deletes: [],
  chat: [],
})

/** GET /api/vlm/settings as the backend answers it: secrets only as a masked stand-in. */
function masked(stored: Json): Json {
  const out = { ...stored }
  if (out.api_key) out.api_key_display = `${String(out.api_key).slice(0, 8)}***`
  if (out.service_account_json) out.service_account_json_display = '*** (configured)'
  delete out.api_key
  delete out.service_account_json
  return out
}

async function stubVlm(page: Page, vlm: Vlm) {
  // anything not answered below never reaches the server
  await page.route('**/api/vlm/**', (route) => route.fulfill({ status: 500, json: { detail: `not stubbed: ${new URL(route.request().url()).pathname}` } }))
  await page.route('**/api/vlm/settings', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: masked(vlm.stored) })
    const body = route.request().postDataJSON() as Json
    vlm.posts.push(body)
    // the backend's rule: only the fields sent change, and an empty string is stored as sent
    for (const [k, v] of Object.entries(body)) if (v !== null && v !== undefined) vlm.stored[k] = v
    return route.fulfill({ json: { status: 'ok' } })
  })
  await page.route('**/api/vlm/presets', (route) => route.fulfill({ json: { presets: PRESETS } }))
  await page.route('**/api/vlm/detect-provider', (route) => {
    const endpoint = String((route.request().postDataJSON() as Json).endpoint ?? '')
    const provider = endpoint.includes('anthropic.com') ? 'anthropic' : endpoint.includes('googleapis') ? 'gemini' : 'openai_compat'
    return route.fulfill({ json: { provider } })
  })
  await page.route('**/api/vlm/test', (route) => route.fulfill({ json: vlm.test }))
  await page.route('**/api/vlm/models', (route) => route.fulfill({ json: { models: vlm.models } }))
  await page.route('**/api/vlm/probe-concurrency', (route) => {
    vlm.probes.push(route.request().postDataJSON() as Json)
    vlm.stored.concurrent_requests = 5
    return route.fulfill({ json: { status: 'ok', recommended: 5, applied: true, levels: [], message: 'Highest stable concurrency: 5' } })
  })
  await page.route('**/api/vlm/local-models/recommended', (route) => route.fulfill({ json: vlm.local }))
  await page.route('**/api/vlm/local-models/pull', (route) => {
    const model = String((route.request().postDataJSON() as Json).model)
    vlm.pulls.push(model)
    vlm.pull = { model, state: 'running' }
    return route.fulfill({ json: { status: 'started', model } })
  })
  await page.route('**/api/vlm/local-models/pull/progress', (route) => {
    const { model, state } = vlm.pull
    if (state === 'running') return route.fulfill({ json: { pulling: true, model, percent: 40, status: 'pulling 6a0746a1ec1a' } })
    if (state === 'done') {
      const models = (vlm.local.models as Json[]).map((m) => (m.id === model ? { ...m, installed: true } : m))
      vlm.local = { ...vlm.local, models }
      return route.fulfill({ json: { pulling: false, model, percent: 100, status: 'success' } })
    }
    return route.fulfill({ json: { pulling: false, model: '', percent: 0, status: '' } })
  })
  await page.route('**/api/vlm/local-models/delete', (route) => {
    const model = String((route.request().postDataJSON() as Json).model)
    vlm.deletes.push(model)
    vlm.local = { ...vlm.local, local_models: (vlm.local.local_models as Json[]).filter((m) => m.id !== model) }
    return route.fulfill({ json: { status: 'ok' } })
  })
  await page.route('**/api/vlm/local-models/start-ollama', (route) => {
    vlm.local = { ...vlm.local, ollama_running: true }
    return route.fulfill({ json: { status: 'ok' } })
  })
  await page.route('**/api/vlm/caption-batch/debug-chat', (route) => route.fulfill({ json: { events: vlm.chat, limit: 80, running: false } }))
}

/** Open V4 on Settings › AI services, in English, dark (set once per page so reloads keep what the test changed). */
async function openAi(page: Page, theme: 'dark' | 'light' = 'dark') {
  await page.addInitScript((th) => {
    const flag = `v4ai-init-${th}`
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', th)
    localStorage.setItem('sd-v4-update-autocheck', '0')
  }, theme)
  // the theme in the address makes each theme a full load (a hash change alone would not run the init script)
  const res = await page.goto(`/v4/?theme=${theme}#/settings/ai`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('ai-services')).toBeVisible()
}

const note = (page: Page) => page.getByTestId('vlm-note')

test('the form reads what is stored; saving never sends an empty or masked key; it reads back', async ({ page }) => {
  const vlm = newVlm(CLOUD)
  await stubVlm(page, vlm)
  await openAi(page)

  await expect(page.getByTestId('vlm-now')).toHaveText('Now using vision-1 · api.example.test')
  const key = page.getByTestId('vlm-key')
  await expect(key).toHaveValue('')
  await expect(key).toHaveAttribute('type', 'password')
  await expect(key).toHaveAttribute('placeholder', '•••••••• (saved)')
  await expect(page.getByTestId('vlm-key-state')).toHaveText('A key is saved. Leave this empty to keep it; type a new one to replace it.')

  await page.getByTestId('vlm-model').fill('vision-2')
  await expect(page.getByTestId('vlm-actions')).toContainText('Unsaved changes')
  await page.getByTestId('vlm-save').click()
  await expect(note(page)).toHaveText('Saved.')
  await expect(page.getByTestId('vlm-actions')).not.toContainText('Unsaved changes')
  expect(vlm.posts).toHaveLength(1)
  expect(vlm.posts[0]).toMatchObject({ provider: 'openai_compat', endpoint: 'https://api.example.test/v1', model: 'vision-2', concurrent_requests: 2 })
  expect(vlm.posts[0]).not.toHaveProperty('api_key')
  expect(vlm.posts[0]).not.toHaveProperty('service_account_json')
  expect(vlm.stored.api_key).toBe(SECRET)
  await expect(page.getByTestId('vlm-now')).toHaveText('Now using vision-2 · api.example.test')

  // a number the backend would refuse is named, the fold opens on it, and nothing is sent
  await page.getByTestId('vlm-advanced').locator('summary').click()
  await page.getByTestId('vlm-concurrent').fill('40')
  await page.getByTestId('vlm-advanced').locator('summary').click()
  await page.getByTestId('vlm-save').click()
  await expect(note(page)).toHaveText('"Requests at once" must be between 1 and 16.')
  await expect(page.getByTestId('vlm-concurrent')).toBeVisible()
  await expect(page.getByTestId('vlm-concurrent')).toHaveAttribute('aria-invalid', 'true')
  expect(vlm.posts).toHaveLength(1)
  await page.getByTestId('vlm-concurrent').fill('4')

  // spaces are not a key; a typed key is sent once, then the field shows the mask again
  await key.fill('   ')
  await page.getByTestId('vlm-save').click()
  await expect(note(page)).toHaveText('Saved.')
  expect(vlm.posts[1]).not.toHaveProperty('api_key')
  await key.fill('sk-e2e-replacement-9876543210')
  await page.getByTestId('vlm-save').click()
  await expect.poll(() => vlm.posts.length).toBe(3)
  expect(vlm.posts[2]).toMatchObject({ api_key: 'sk-e2e-replacement-9876543210', concurrent_requests: 4 })
  await expect(key).toHaveValue('')
  expect(vlm.stored.api_key).toBe('sk-e2e-replacement-9876543210')

  // read back after a reload
  await page.reload()
  await expect(page.getByTestId('vlm-model')).toHaveValue('vision-2')
  await expect(page.getByTestId('vlm-concurrent')).toHaveValue('4')
  await expect(key).toHaveValue('')
  // no key, nor the start of one, is anywhere on the page
  expect(await page.content()).not.toContain('sk-e2e-')
})

test('Test connection saves first, then says it worked or why not', async ({ page }) => {
  const vlm = newVlm(CLOUD)
  vlm.test = { status: 'ok', models: ['vision-1', 'vision-2', 'vision-3'] }
  await stubVlm(page, vlm)
  await openAi(page)

  await page.getByTestId('vlm-test').click()
  await expect(note(page)).toHaveText('Saved. Connected; the service lists 3 models.')
  expect(vlm.posts).toHaveLength(1)
  expect(vlm.posts[0]).not.toHaveProperty('api_key')

  vlm.test = { status: 'error', error: 'Invalid API key', error_type: 'auth' }
  await page.getByTestId('vlm-test').click()
  await expect(note(page)).toHaveText('Connection failed: the key is wrong or has no access (Invalid API key)')

  vlm.test = { status: 'error', error: 'Connection timed out', error_type: 'timeout' }
  await page.getByTestId('vlm-test').click()
  await expect(note(page)).toHaveText('Connection failed: no answer in time (Connection timed out)')

  // no address: said at once, nothing is sent
  await page.getByTestId('vlm-endpoint').fill('')
  await page.getByTestId('vlm-test').click()
  await expect(note(page)).toHaveText('Fill in the service address first.')
  expect(vlm.posts).toHaveLength(3)
  // an address without http(s) is refused before saving
  await page.getByTestId('vlm-endpoint').fill('api.example.test/v1')
  await page.getByTestId('vlm-save').click()
  await expect(note(page)).toHaveText('The service address must start with http:// or https://.')
  expect(vlm.posts).toHaveLength(3)
})

test('the address sets the service type; Fetch lists models to pick; presets, Find the limit and Vertex', async ({ page }) => {
  const vlm = newVlm()
  vlm.models = ['claude-a', 'claude-b']
  await stubVlm(page, vlm)
  await openAi(page)
  await expect(page.getByTestId('vlm-now')).toHaveText('Not set up: fill in the address (and a key for a cloud service), then save.')
  await expect(page.getByTestId('vlm-key-state')).toHaveText('No key is saved. Local services usually need none.')

  await page.getByTestId('vlm-endpoint').fill('https://api.anthropic.com')
  await expect(page.getByTestId('vlm-provider')).toHaveValue('anthropic')
  await expect(page.getByTestId('vlm-detected')).toHaveText('Recognised as Anthropic Claude from the address.')
  await page.getByTestId('vlm-key').fill('sk-ant-e2e-key-000')

  // Fetch saves first (the backend lists from what is stored), then lists
  await page.getByTestId('vlm-fetch-models').click()
  const list = page.getByTestId('vlm-models')
  await expect(list).toContainText('Found 2 models; click one to fill it in.')
  expect(vlm.posts[0]).toMatchObject({ provider: 'anthropic', endpoint: 'https://api.anthropic.com', api_key: 'sk-ant-e2e-key-000' })
  await list.getByRole('button', { name: 'claude-b' }).click()
  await expect(page.getByTestId('vlm-model')).toHaveValue('claude-b')
  await expect(list).toContainText('claude-b filled in; it applies once saved.')

  // a preset replaces the prompts; one that asks for tags or JSON is not offered
  await expect(page.getByTestId('vlm-preset').locator('option[value="vlm_hybrid"]')).toHaveCount(0)
  await page.getByTestId('vlm-preset').selectOption('lora_training')
  await page.getByTestId('vlm-preset-apply').click()
  await expect(page.getByTestId('vlm-preset-note')).toHaveText('"LoRA training (description)" applied: the prompts were replaced; they apply once saved.')
  await expect(page.getByTestId('vlm-system')).toHaveValue(PRESETS.lora_training.system_prompt)
  await expect(page.getByTestId('vlm-user-tags')).toHaveValue(PRESETS.lora_training.user_prompt_with_tags)

  // Find the limit saves, probes from 8 up, and fills in what held
  await page.getByTestId('vlm-advanced').locator('summary').click()
  await page.getByTestId('vlm-probe').click()
  await expect(note(page)).toHaveText('Up to 5 requests at once run reliably; filled in and saved.')
  await expect(page.getByTestId('vlm-concurrent')).toHaveValue('5')
  expect(vlm.probes).toEqual([{ max_level: 8, apply: true }])
  const saved = vlm.posts.at(-1)!
  expect(saved).not.toHaveProperty('output_format')
  expect(saved).toMatchObject({ model: 'claude-b', system_prompt: PRESETS.lora_training.system_prompt, user_prompt_with_tags: PRESETS.lora_training.user_prompt_with_tags })
  expect(saved).not.toHaveProperty('api_key')
  await expect(page.getByTestId('vlm-actions')).not.toContainText('Unsaved changes')

  // Gemini shows the Vertex part; the service account is sent only when pasted
  await expect(page.getByTestId('vlm-vertex')).toHaveCount(0)
  await page.getByTestId('vlm-provider').selectOption('gemini')
  await page.getByTestId('vlm-vertex').locator('summary').click()
  await page.getByTestId('vlm-use-vertex').check()
  await page.getByTestId('vlm-vertex-project').fill('e2e-project')
  await page.getByTestId('vlm-save').click()
  await expect(note(page)).toHaveText('Saved.')
  expect(vlm.posts.at(-1)).toMatchObject({ provider: 'gemini', use_vertex: true, vertex_project: 'e2e-project', vertex_location: 'us-central1' })
  expect(vlm.posts.at(-1)).not.toHaveProperty('service_account_json')
  await page.getByTestId('vlm-vertex-json').fill('{"type": "service_account", "project_id": "e2e-project"}')
  await page.getByTestId('vlm-save').click()
  await expect.poll(() => vlm.posts.at(-1)?.service_account_json).toBe('{"type": "service_account", "project_id": "e2e-project"}')
  await expect(page.getByTestId('vlm-vertex-json')).toHaveValue('')
  await expect(page.getByTestId('vlm-vertex')).toContainText('A service account is saved.')
  await expect(page.getByTestId('vlm-now')).toHaveText('Now using Vertex AI · claude-b')
})

test('local Ollama: a download goes into Jobs, then Use and Delete (after a confirm)', async ({ page }) => {
  const vlm = newVlm(CLOUD)
  vlm.local = {
    ollama_installed: true,
    ollama_running: true,
    install_instructions: null,
    models: [REC('qwen2.5-vl:7b', 'Qwen 2.5 VL 7B', false), REC('gemma3:4b', 'Gemma 3 4B', true, 3)],
    local_models: [{ id: 'gemma3:4b', size_gb: 3 }, { id: 'my-own:latest', size_gb: 2.1 }],
  }
  await stubVlm(page, vlm)
  await openAi(page)

  const qwen = page.locator('[data-testid="ollama-model"][data-model="qwen2.5-vl:7b"]')
  await expect(qwen).toContainText('Steady on anime and Chinese, Japanese and Korean content · 4.7 GB · at least 6 GB graphics memory · Describes adult content')
  await expect(page.getByTestId('ollama-others')).toContainText('my-own:latest')
  await expect(page.getByTestId('ollama-others')).not.toContainText('gemma3:4b')

  await qwen.getByTestId('ollama-pull').click()
  await expect(page.getByTestId('ollama-note')).toHaveText('Downloading qwen2.5-vl:7b; see its progress in Jobs.')
  expect(vlm.pulls).toEqual(['qwen2.5-vl:7b'])
  await expect(qwen).toContainText('Downloading 40%')
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('job').first()
  await expect(job).toContainText('Downloading Ollama model qwen2.5-vl:7b')
  await expect(job).toContainText('40%')
  await expect(job).toContainText('Downloading files')
  await expect(job.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  // a second download waits for this one
  vlm.pull = { model: 'qwen2.5-vl:7b', state: 'done' }
  await expect(job).toContainText('Ollama model qwen2.5-vl:7b is ready')
  await page.keyboard.press('Escape')
  await expect(qwen.getByTestId('ollama-use')).toBeVisible()
  await expect(qwen).toContainText('Downloaded')

  // Use sends only the service type, address and model: the stored key stays
  await qwen.getByTestId('ollama-use').click()
  await expect(page.getByTestId('ollama-note')).toHaveText('Now using qwen2.5-vl:7b (local Ollama); saved.')
  expect(vlm.posts.at(-1)).toEqual({ provider: 'openai_compat', endpoint: 'http://localhost:11434/v1', model: 'qwen2.5-vl:7b' })
  expect(vlm.stored.api_key).toBe(SECRET)
  await expect(page.getByTestId('vlm-endpoint')).toHaveValue('http://localhost:11434/v1')
  await expect(page.getByTestId('vlm-model')).toHaveValue('qwen2.5-vl:7b')
  await expect(page.getByTestId('vlm-now')).toHaveText('Now using qwen2.5-vl:7b · localhost:11434')
  await expect(qwen).toContainText('In use')
  await expect(qwen.getByTestId('ollama-use')).toBeDisabled()
  await expect(page.getByTestId('vlm-actions')).not.toContainText('Unsaved changes')

  // Delete asks first, with Cancel focused; the model in use says so
  await qwen.getByTestId('ollama-delete').click()
  let dialog = page.getByTestId('ollama-delete-dialog')
  await expect(dialog).toContainText('This is the model in use')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(vlm.deletes).toEqual([])
  const own = page.locator('[data-testid="ollama-model"][data-model="my-own:latest"]')
  await own.getByTestId('ollama-delete').click()
  dialog = page.getByTestId('ollama-delete-dialog')
  await expect(dialog).toContainText('Removes this model from Ollama and frees about 2.1 GB. You can download it again later.')
  await expect(dialog).not.toContainText('in use')
  await dialog.getByTestId('ollama-delete-confirm').click()
  await expect(page.getByTestId('ollama-note')).toHaveText('my-own:latest deleted.')
  expect(vlm.deletes).toEqual(['my-own:latest'])
  await expect(page.getByTestId('ollama-others')).toHaveCount(0)
})

test('Ollama not installed points to its download, not running offers Start; a pull already running is in Jobs', async ({ page }) => {
  const vlm = newVlm()
  vlm.local = { ollama_installed: false, ollama_running: false, install_instructions: 'Download from https://ollama.com/download/windows', models: [REC('qwen2.5-vl:7b', 'Qwen 2.5 VL 7B', false)], local_models: [] }
  vlm.pull = { model: 'gemma3:4b', state: 'running' }
  await stubVlm(page, vlm)
  await openAi(page)

  const state = page.getByTestId('ollama-state')
  await expect(state).toContainText('Ollama is not installed on this computer.')
  await expect(state.getByRole('link', { name: 'Download from ollama.com ↗' })).toHaveAttribute('href', 'https://ollama.com/download')
  await expect(page.locator('[data-model="qwen2.5-vl:7b"]').getByTestId('ollama-pull')).toBeDisabled()

  vlm.local = { ...vlm.local, ollama_installed: true, ollama_running: false }
  await page.getByTestId('ollama-refresh').click()
  await expect(state).toContainText('Ollama is installed but not running')
  await page.getByTestId('ollama-start').click()
  await expect(page.getByTestId('ollama-note')).toHaveText('Ollama started.')
  await expect(state).toContainText('Ollama is running.')
  await expect(page.getByTestId('ollama-start')).toHaveCount(0)

  // the pull that was running when the page opened (V3.5 or a reload) is followed in Jobs
  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('job').first()
  await expect(job).toContainText('Downloading Ollama model gemma3:4b')
  await expect(job).toContainText('Started elsewhere')
  await page.keyboard.press('Escape')
  // and a new download waits for it
  await page.locator('[data-model="qwen2.5-vl:7b"]').getByTestId('ollama-pull').click()
  await expect(page.getByTestId('ollama-note')).toHaveText('gemma3:4b is downloading; start the next one when it ends.')
  expect(vlm.pulls).toEqual([])
})

test('the API chat log is read when it is unfolded', async ({ page }) => {
  const vlm = newVlm(CLOUD)
  vlm.chat = [
    { id: 1, phase: 'request', provider: 'openai_compat', model: 'vision-1', image_name: 'a.png', system_prompt: 'SYS', user_prompt: 'Describe this image.', tags: ['1girl', 'solo'] },
    { id: 2, phase: 'response', model: 'vision-1', image_name: 'a.png', latency_ms: 812, tokens_used: 96, caption: 'A girl stands in a red room.' },
    { id: 3, phase: 'error', model: 'vision-1', image_name: 'b.png', error: 'Rate limited', error_type: 'rate_limit' },
  ]
  await stubVlm(page, vlm)
  await openAi(page)
  const chatCalls: string[] = []
  page.on('request', (r) => r.url().includes('/debug-chat') && chatCalls.push(r.url()))
  await page.waitForTimeout(300)
  expect(chatCalls).toEqual([])

  await page.getByTestId('ai-log-fold').locator('summary').click()
  const events = page.getByTestId('ai-log-event')
  await expect(events).toHaveCount(3)
  await expect(events.nth(0)).toContainText('Request')
  await expect(events.nth(0)).toContainText('1girl, solo')
  await expect(events.nth(1)).toContainText('Reply')
  await expect(events.nth(1)).toContainText('812 ms · 96 tokens')
  await expect(events.nth(1)).toContainText('A girl stands in a red room.')
  await expect(events.nth(2)).toContainText('Error (rate_limit)')
  vlm.chat = []
  await page.getByTestId('ai-log-refresh').click()
  await expect(page.getByTestId('ai-log')).toContainText('Nothing logged yet.')
})

// ---- the tag panel ----

interface Runs {
  tagStarts: Json[]
  smartStarts: Json[]
}

/** Every tagger ready (nothing is downloaded), and the tagging runs answered here. */
async function stubTagRuns(page: Page): Promise<Runs> {
  const runs: Runs = { tagStarts: [], smartStarts: [] }
  await page.route(/\/api\/models\/(prepare|download|bulk)/, (route) => route.fulfill({ status: 500, json: { detail: 'not in this test' } }))
  await page.route('**/api/models/status', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { models?: Json[] }
    for (const card of body.models ?? []) {
      card.status = 'ready'
      card.available = true
      card.installed_variants = Array.isArray(card.variants) ? card.variants : []
    }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/tag/start', (route) => {
    runs.tagStarts.push(route.request().postDataJSON() as Json)
    return route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/smart-tag/start', (route) => {
    runs.smartStarts.push(route.request().postDataJSON() as Json)
    return route.fulfill({ json: { job_id: `e2e-ai-${runs.smartStarts.length}`, status: 'running' } })
  })
  await page.route('**/api/smart-tag/progress**', (route: Route) => {
    const n = ((runs.smartStarts.at(-1)?.image_ids as number[]) ?? []).length
    return route.fulfill({
      json: { job_id: `e2e-ai-${runs.smartStarts.length}`, status: 'completed', active: false, total: n, processed: n, succeeded: n, failed: 0, errors: [], pipeline_queue: { total_queued: 0, queued: [] } },
    })
  })
  await page.route('**/api/smart-tag/cancel**', (route) => route.fulfill({ json: { status: 'cancelled' } }))
  return runs
}

async function tagTwo(page: Page) {
  await openLibrary(page, TOKEN, COUNT)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await tiles.nth(1).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('selection-bar')).toContainText('2 picked')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Tag…' }).click()
  const dialog = page.getByTestId('tag-dialog')
  await expect(dialog.getByRole('radiogroup', { name: 'Tagger' })).toBeVisible()
  return dialog
}

test('tag panel: a description only once a service is set up, the call count said first, one Smart Tag run', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const vlm = newVlm()
  await stubVlm(page, vlm)
  const runs = await stubTagRuns(page)

  // nothing set up: no option, only the way to set one up
  let dialog = await tagTwo(page)
  await expect(dialog.getByTestId('tag-describe-setup')).toBeVisible()
  await expect(dialog.locator('input[name="describer"][value="vlm"]')).toBeDisabled()
  await dialog.getByTestId('tag-describe-setup').click()
  await expect(page).toHaveURL(/#\/settings\/ai$/)
  await expect(page.getByTestId('tag-dialog')).toHaveCount(0)
  await expect(page.getByTestId('ai-services')).toBeVisible()

  // a cloud service: off by default; ticked, it says the count and that it may charge
  vlm.stored = { ...CLOUD }
  dialog = await tagTwo(page)
  const check = dialog.locator('input[name="describer"][value="vlm"]')
  await expect(check).not.toBeChecked()
  await expect(dialog.getByTestId('tag-describe-calls')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Tag 2' })).toBeVisible()
  await check.check()
  await expect(dialog.getByTestId('tag-describe-calls')).toHaveText('Calls vision-1 2 times (once per image). A service billed per call will charge for them.')
  const start = dialog.getByRole('button', { name: 'Tag and describe 2' })
  await expect(dialog).toBeInViewport()
  await expect(start).toBeInViewport({ ratio: 1 })
  // tags to drop cannot go through the describing run: said before starting
  await dialog.getByText('Advanced').click()
  await dialog.getByPlaceholder('watermark, signature').fill('watermark')
  await expect(dialog.getByTestId('tag-describe')).toContainText('"Drop these tags while tagging" does not apply this time.')
  await dialog.getByPlaceholder('watermark, signature').fill('')
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
  await start.click()
  await expect(page.getByTestId('tag-dialog')).toHaveCount(0)
  expect(runs.tagStarts).toEqual([])
  expect(runs.smartStarts).toHaveLength(1)
  expect(runs.smartStarts[0]).toMatchObject({ enable_wd14: true, enable_vlm: true, natural_language_mode: 'vlm', skip_existing: false, merge_strategy: 'replace', image_paths: [] })
  expect(runs.smartStarts[0].image_ids as number[]).toHaveLength(2)
  expect(typeof runs.smartStarts[0].tagger_model).toBe('string')
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('job').first()).toContainText('Tagged 2')
  await page.keyboard.press('Escape')

  // opened again: off again; left off, it is the plain tag run
  dialog = await tagTwo(page)
  await expect(dialog.locator('input[name="describer"][value="vlm"]')).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Tag 2' }).click()
  await expect.poll(() => runs.tagStarts.length).toBe(1)
  expect(runs.smartStarts).toHaveLength(1)

  // Ollama on this computer: it says the calls cost nothing
  vlm.stored = { endpoint: 'http://localhost:11434/v1', model: 'qwen2.5-vl:7b' }
  dialog = await tagTwo(page)
  await dialog.locator('input[name="describer"][value="vlm"]').check()
  await expect(dialog.getByTestId('tag-describe-calls')).toHaveText('Calls qwen2.5-vl:7b 2 times; it runs on this computer, so it costs nothing.')
})

for (const viewport of VIEWPORTS) {
  test(`AI services fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const vlm = newVlm(CLOUD)
    vlm.local = { ollama_installed: true, ollama_running: true, install_instructions: null, models: [REC('qwen3-vl:32b-instruct', 'Qwen3 VL 32B Instruct', false, 21), REC('gemma3:4b', 'Gemma 3 4B', true, 3)], local_models: [{ id: 'gemma3:4b', size_gb: 3 }] }
    await stubVlm(page, vlm)
    await page.setViewportSize(viewport)
    for (const theme of ['dark', 'light'] as const) {
      await openAi(page, theme)
      await expect(page.getByTestId('vlm-save')).toBeInViewport({ ratio: 1 })
      await page.getByTestId('vlm-advanced').locator('summary').click()
      await page.getByTestId('vlm-proxy').locator('summary').click()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      // the save bar stays in reach while the long form scrolls
      await page.getByTestId('vlm-nsfw').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('vlm-save')).toBeInViewport({ ratio: 1 })
      await page.getByTestId('ai-log').scrollIntoViewIfNeeded()
      await expect(page.locator('[data-model="gemma3:4b"]').getByTestId('ollama-use')).toBeVisible()
      const content = await page.evaluate(() => {
        const main = document.querySelector('[data-testid="settings-ai"]') as HTMLElement
        return main.scrollWidth - main.clientWidth
      })
      expect(content).toBeLessThanOrEqual(0)
      // nothing of the form (not even its hidden radios) makes the app itself scroll away under the top bar
      expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(0)
    }
  })
}
