import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { cleanupImages, openLibrary, pageOverflow, seedImages } from '../fixtures/v4-seed'

/**
 * V4 Model Center (slice 5d): the summary and the note on what works now,
 * the download source, one card per model (purpose, size, state, version, the
 * other taggers with PixAI v1.0's weight, the source choice only where it
 * exists, manual install), getting one model ready through the Jobs drawer,
 * "Download models…" (recommended ticked, the gated one not, one after
 * another), a model that needs a restart (banner, restart, the rest continues
 * after the reload) and "Which one should I pick?" from the tag panel.
 *
 * SAFETY: every /api/models/* request is answered here (nothing downloads or
 * loads a model), and so are /api/updates/restart and /api/updates/boot-id
 * (a real restart would stop the test server) and /api/open-path (it opens a
 * file manager window).
 */

test.describe.configure({ mode: 'serial' })

type Json = Record<string, unknown>

const TOKEN = 'v4modelstoken'
const PREFIX = 'v4models-'
const DIR = 'v4-models'

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: 3, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const MB = 1024 * 1024
const GB = 1024 * MB
const ROOT = 'D:\\SD Image Sorter\\data\\models'
const WD_VARIANTS = [
  'wd-eva02-large-tagger-v3',
  'wd-swinv2-tagger-v3',
  'wd-convnext-tagger-v3',
  'wd-vit-tagger-v3',
  'wd-vit-large-tagger-v3',
  'camie-tagger-v2',
  'pixai-tagger-v0.9',
  'pixai-tagger-v1.0',
]

const card = (id: string, group: string, recommended: boolean, fields: Json = {}): Json => ({
  id,
  name: id,
  group_key: `models.group.${group}`,
  status: 'missing',
  available: false,
  message_key: `models.${id}.missing`,
  path: `${ROOT}\\${id}`,
  download_supported: true,
  recommended,
  ...fields,
})

/** The fourteen cards of GET /api/models/status, in its order (services/model_service_inventory.py). */
function cards(): Json[] {
  return [
    card('wd14', 'tagging', true, {
      status: 'ready',
      available: true,
      message_key: 'models.wd14.readyCount',
      message_params: { count: 2 },
      path: `${ROOT}\\wd14\\wd-swinv2-tagger-v3\\model.onnx`,
      variants: WD_VARIANTS,
      installed_variants: ['wd-swinv2-tagger-v3', 'pixai-tagger-v0.9'],
      default_variant: 'wd-swinv2-tagger-v3',
    }),
    card('toriigate', 'captioning', false),
    card('florence2', 'captioning', true, { message_key: 'models.florence2.missing', external_links: [{ label: 'HuggingFace', url: 'https://huggingface.co/florence-community/Florence-2-base' }] }),
    card('oppai-oracle', 'tagging', false, { message_key: 'models.oppaiOracle.missing' }),
    card('cl-tagger-v2', 'tagging', false, {
      message_key: 'models.clTaggerV2.missing',
      gated_download: true,
      requires_auth: true,
      external_links: [{ label: 'HuggingFace', url: 'https://huggingface.co/cella110n/cl_tagger_v2' }],
    }),
    card('tipo', 'tagging', false),
    card('clip', 'search', true, { message_key: 'models.clip.missingModel', text_path: `${ROOT}\\clip\\Qdrant-clip-ViT-B-32-text` }),
    card('aesthetic', 'scoring', true, { status: 'ready', available: true, message_key: 'models.aesthetic.ready' }),
    card('artist', 'artistId', true, {
      status: 'ready',
      available: true,
      message_key: 'models.artist.ready',
      sources: ['auto', 'huggingface', 'modelscope'],
      runtime_path: `${ROOT}\\artist\\comfyui-lsnet-runtime`,
    }),
    card('lucida', 'trainingMasks', true, { status: 'ready', available: true, message_key: 'models.lucida.ready' }),
    card('rembg', 'trainingMasks', false),
    card('censor-legacy', 'censor', false, { message_key: 'models.censorLegacy.missing', external_links: [{ label: 'Civitai', url: 'https://civitai.com/models/1' }] }),
    card('censor-nudenet', 'censor', true, { message_key: 'models.censorNudenet.missing' }),
    card('sam3', 'censor', false, { external_links: [{ label: 'ModelScope', url: 'https://modelscope.cn/models/facebook/sam3/files' }] }),
  ]
}

const BUNDLE = (status: (id: string) => string) => ({
  items: [
    { id: 'wd14', label: 'WD14 Tagger', size_bytes: 446 * MB, status: status('wd14'), variant: 'wd-swinv2-tagger-v3', feature_key: 'tagging', recommended: true, default_selected: true },
    { id: 'censor-nudenet', label: 'NudeNet 320n', size_bytes: 12 * MB, status: status('censor-nudenet'), feature_key: 'censor', recommended: true, default_selected: true, restart_after_install: true },
    { id: 'clip', label: 'CLIP', size_bytes: 600 * MB, status: status('clip'), feature_key: 'similarity', recommended: true, default_selected: true, restart_after_install: true },
    { id: 'aesthetic', label: 'Aesthetic', size_bytes: 1.7 * GB, status: status('aesthetic'), feature_key: 'scoring', recommended: true, default_selected: true },
    { id: 'sam3', label: 'SAM 3', size_bytes: 3.3 * GB, status: status('sam3'), feature_key: 'segmentation', recommended: false, default_selected: false },
    { id: 'florence2', label: 'Florence-2', size_bytes: 465 * MB, status: status('florence2'), variant: 'base', feature_key: 'natural_language_caption', recommended: true, default_selected: true },
    {
      id: 'cl-tagger-v2',
      label: 'CL Tagger v2 (gated optional tagger)',
      size_bytes: 2.7 * GB,
      status: status('cl-tagger-v2'),
      variant: 'v2_00',
      feature_key: 'tagging',
      recommended: false,
      default_selected: false,
      requires_auth: true,
      gated_download: true,
      auth_url: 'https://huggingface.co/cella110n/cl_tagger_v2',
    },
  ],
  excluded: [{ id: 'censor-legacy' }, { id: 'toriigate' }, { id: 'oppai-oracle' }],
})

type Outcome = 'done' | 'needs_restart' | 'error'

interface Stub {
  cards: Json[]
  mirror: string
  mirrorPosts: Json[]
  prepares: Json[]
  /** Prepares that arrived while another download was still running (must stay empty). */
  overlapping: string[]
  outcome: Record<string, Outcome>
  /** Progress polls of a download before it settles. */
  pollsPerDownload: number
  active: string | null
  polls: number
  /** The backend numbers prepares (run_id) and keeps each finished one's result by that number. */
  run: number
  finished: Record<string, Json>
  last: { run_id: number; model_id: string; status: string; restart_recommended: boolean }
  restartPosts: Json[]
  bootIds: string[]
  bootHits: number
  openPaths: Json[]
}

function newStub(fields: Partial<Stub> = {}): Stub {
  return {
    cards: cards(),
    mirror: 'auto',
    mirrorPosts: [],
    prepares: [],
    overlapping: [],
    outcome: {},
    pollsPerDownload: 2,
    active: null,
    polls: 0,
    run: 0,
    finished: {},
    last: { run_id: 0, model_id: '', status: '', restart_recommended: false },
    restartPosts: [],
    bootIds: ['boot-A'],
    bootHits: 0,
    openPaths: [],
    ...fields,
  }
}

const statusOf = (stub: Stub) => (id: string) => String(stub.cards.find((c) => c.id === id)?.status === 'ready' ? 'ready' : 'missing')

function settle(stub: Stub): Json {
  const id = stub.active ?? ''
  const outcome = stub.outcome[id] ?? 'done'
  const target = stub.cards.find((c) => c.id === id)
  if (target && outcome !== 'error') target.status = outcome === 'done' ? 'ready' : 'needs_restart'
  const status = outcome === 'needs_restart' ? 'needs_restart' : outcome
  stub.last = { run_id: stub.run, model_id: id, status, restart_recommended: outcome === 'needs_restart' }
  stub.active = null
  const result = { active: false, ...stub.last, message: outcome === 'error' ? 'Download failed.' : 'Ready.' }
  stub.finished[String(stub.run)] = result
  return { active: false, prepare_result: result, finished_prepares: stub.finished }
}

async function stubAll(page: Page, stub: Stub) {
  // the catch-all first: the more specific routes below win (Playwright tries the last added first)
  await page.route('**/api/models/**', (route: Route) => route.fulfill({ status: 500, json: { detail: 'unexpected model call in a test' } }))
  await page.route('**/api/models/status', (route: Route) => route.fulfill({ json: { status: 'ok', models: stub.cards } }))
  await page.route('**/api/models/mirror', (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Json
      stub.mirrorPosts.push(body)
      stub.mirror = String(body.mirror)
    }
    return route.fulfill({ json: { mirror: stub.mirror, options: ['auto', 'hf-mirror', 'modelscope'] } })
  })
  await page.route('**/api/models/plan?**', (route: Route) => {
    const id = new URL(route.request().url()).searchParams.get('model_id') ?? ''
    const plans: Record<string, Json> = {
      clip: { model_id: 'clip', packages: ['fastembed'], restart_likely: false },
      'censor-nudenet': { model_id: 'censor-nudenet', packages: ['nudenet', 'onnx'], restart_likely: true },
      florence2: { model_id: 'florence2', packages: [], restart_likely: false },
    }
    return route.fulfill({ json: plans[id] ?? { model_id: id, packages: [], restart_likely: null } })
  })
  await page.route('**/api/models/bulk-bundle', (route: Route) => route.fulfill({ json: BUNDLE(statusOf(stub)) }))
  await page.route('**/api/models/prepare', (route: Route) => {
    const body = route.request().postDataJSON() as Json
    stub.prepares.push(body)
    if (stub.active) {
      stub.overlapping.push(String(body.model_id))
      return route.fulfill({ json: { status: 'downloading', model_id: stub.active, run_id: stub.run, message: 'A download is already in progress.' } })
    }
    stub.active = String(body.model_id)
    stub.run += 1
    stub.polls = 0
    return route.fulfill({ json: { status: 'downloading', model_id: body.model_id, run_id: stub.run, message: 'Download started in background.' } })
  })
  await page.route('**/api/models/download-progress', (route: Route) => {
    if (!stub.active) return route.fulfill({ json: { active: false, prepare_result: { active: false, ...stub.last }, finished_prepares: stub.finished } })
    stub.polls += 1
    if (stub.polls > stub.pollsPerDownload) return route.fulfill({ json: settle(stub) })
    const downloaded = stub.polls * 100 * MB
    const live = { active: true, run_id: stub.run, model_id: stub.active, status: 'downloading' }
    return route.fulfill({ json: { active: true, downloaded, total: 400 * MB, filename: 'model.onnx', prepare_result: live, finished_prepares: stub.finished } })
  })
  await page.route('**/api/updates/**', (route: Route) => route.fulfill({ status: 500, json: { detail: 'unexpected update call in a test' } }))
  await page.route('**/api/updates/restart', (route: Route) => {
    stub.restartPosts.push(route.request().postDataJSON() as Json)
    return route.fulfill({ json: { status: 'scheduled', boot_id: 'boot-A' } })
  })
  await page.route('**/api/updates/boot-id', (route: Route) => {
    const id = stub.bootIds[Math.min(stub.bootHits, stub.bootIds.length - 1)]
    stub.bootHits += 1
    return route.fulfill({ json: { boot_id: id } })
  })
  await page.route('**/api/open-path', (route: Route) => {
    stub.openPaths.push(route.request().postDataJSON() as Json)
    return route.fulfill({ json: { success: true } })
  })
  await page.route('**/api/system/ai-jobs', (route: Route) => route.fulfill({ json: { active: 0, jobs: [] } }))
}

/** Open V4 at an address (once per page, so reloads keep what the test changed). */
async function openAt(page: Page, hash: string, lang: 'en' | 'zh-CN' = 'en', resume: Json | null = null) {
  await page.addInitScript(([l, left]) => {
    if (sessionStorage.getItem('v4models-init')) return
    sessionStorage.setItem('v4models-init', '1')
    localStorage.setItem('sd-image-sorter-lang', l)
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.removeItem('sd-v4-ui-scale')
    if (left) localStorage.setItem('sd-v4-model-resume', left)
    else localStorage.removeItem('sd-v4-model-resume')
  }, [lang, resume ? JSON.stringify(resume) : ''] as const)
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('model-center')).toBeVisible()
}

const resumeList = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('sd-v4-model-resume') ?? 'null') as Json | null)
const cardOf = (page: Page, id: string) => page.getByTestId(`model-card-${id}`)

test('the page: counts, what works now, the download source, and cards that say what each model is for', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openAt(page, '#/settings/models')

  await expect(page.getByTestId('settings-tab-models')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('model-count-ready')).toHaveText('4')
  await expect(page.getByTestId('model-count-missing')).toHaveText('10')
  await expect(page.getByTestId('model-count-total')).toHaveText('14')
  await expect(page.getByTestId('model-count-restart')).toHaveCount(0)
  await expect(page.getByTestId('model-group-essentials').locator('article')).toHaveCount(7)
  await expect(page.getByTestId('model-group-others').locator('article')).toHaveCount(7)

  await page.getByTestId('model-availability').locator('summary').click()
  await expect(page.getByTestId('model-availability')).toContainText('Hand censoring')
  await expect(page.getByTestId('model-availability')).toContainText('Artist style: Kaloscope, about 2.8 GB')
  await page.getByTestId('model-moved').locator('summary').click()
  await expect(page.getByTestId('model-moved')).toContainText('Copy the whole old data folder into the new folder')

  // the tagger card: its versions (the recommended one chosen), PixAI v1.0's weight, the GPU pause and where it is set
  const wd = cardOf(page, 'wd14')
  await expect(wd.getByTestId('model-status')).toHaveText('Ready')
  await expect(wd.getByTestId('model-variant')).toHaveValue('wd-swinv2-tagger-v3')
  await expect(wd.getByTestId('model-facts')).toHaveText('about 446 MB · Downloaded: WD SwinV2 v3, PixAI v0.9')
  const pixai = wd.getByTestId('other-taggers').locator('[data-variant="pixai-tagger-v1.0"]')
  await expect(pixai).toContainText('Best PixAI')
  await expect(pixai).toContainText('about 2 GB · Not downloaded')
  await expect(pixai).toContainText('7.5 GB of GPU memory')
  await expect(pixai).toContainText('5× slower')
  await expect(wd).toContainText('SD_IMAGE_SORTER_GPU_DUTY_CYCLE')
  await wd.getByTestId('model-variant').selectOption('wd-eva02-large-tagger-v3')
  await expect(wd.getByTestId('model-facts')).toContainText('about 1.2 GB')
  await expect(wd.getByTestId('model-prepare')).toHaveText('Get it ready')

  // a source choice only where the backend offers one (Kaloscope); SAM 3 says where it comes from
  await expect(page.getByTestId('model-source')).toHaveCount(1)
  await expect(cardOf(page, 'artist').getByTestId('model-source')).toBeVisible()
  await expect(cardOf(page, 'sam3')).toContainText('Downloads from ModelScope')
  await expect(cardOf(page, 'cl-tagger-v2').getByTestId('model-auth-link')).toHaveAttribute('href', 'https://huggingface.co/cella110n/cl_tagger_v2')
  await expect(cardOf(page, 'clip').getByTestId('model-plan')).toHaveText('Getting it ready also installs runtime packages (1); it works right after, no restart.')
  await expect(cardOf(page, 'censor-nudenet').getByTestId('model-plan')).toContainText('the app then needs one restart')

  // the download source is saved at once
  const mirror = page.getByTestId('model-mirror')
  await mirror.getByText('hf-mirror', { exact: true }).click()
  await expect(mirror.getByRole('status')).toHaveText('Saved')
  expect(stub.mirrorPosts).toEqual([{ mirror: 'hf-mirror' }])
  await expect(mirror).toContainText('hf-mirror.com first')

  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
})

test('a start refused because the AI lock outlived its job offers a restart, which asks first', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub({})
  await stubAll(page, stub)
  await page.route('**/api/models/prepare', (route: Route) =>
    route.fulfill({
      status: 409,
      json: { error: 'busy', type: 'AiRuntimeBusyError', status_code: 409, reason: 'stale_lock_holder_gone', blocker: { label: 'wd14-tagger-load', stuck: true }, waited_seconds: 0 },
    }),
  )
  await openAt(page, '#/settings/models')
  await cardOf(page, 'clip').getByTestId('model-prepare').click()
  const toast = page.locator('[data-tone="error"]').filter({ hasText: 'Waiting will not help' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Restart app…' }).click()
  // the same restart as About's: it asks first, and nothing is posted before the yes
  await expect(page.getByTestId('restart-ask')).toBeVisible()
  expect(stub.restartPosts).toEqual([])
  await page.getByTestId('restart-ask').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('restart-ask')).toHaveCount(0)
  expect(stub.restartPosts).toEqual([])
})

test('getting one model ready: a download in the drawer, then the card is ready; manual install copies and opens its folder', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const stub = newStub({ pollsPerDownload: 4 })
  await stubAll(page, stub)
  await openAt(page, '#/settings/models')

  const clip = cardOf(page, 'clip')
  await expect(clip.getByTestId('model-status')).toHaveText('Missing')
  await clip.getByTestId('model-prepare').click()
  await expect.poll(() => stub.prepares).toEqual([{ model_id: 'clip', variant: null }])
  // while it downloads, the other cards wait for it
  await expect(cardOf(page, 'florence2').getByTestId('model-prepare')).toBeDisabled()
  await expect(cardOf(page, 'florence2')).toContainText('Waiting for CLIP similarity to finish')

  await page.getByTestId('jobs-button').click()
  await expect(page.getByText('CLIP similarity is ready').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(clip.getByTestId('model-status')).toHaveText('Ready')
  await expect(clip.getByTestId('model-prepare')).toHaveText('Check again')
  await expect(page.getByTestId('model-count-ready')).toHaveText('5')

  // Kaloscope from its own source
  const artist = cardOf(page, 'artist')
  await artist.getByTestId('model-source').selectOption('modelscope')
  await artist.getByTestId('model-prepare').click()
  await expect.poll(() => stub.prepares.at(-1)).toEqual({ model_id: 'artist', variant: null, source: 'modelscope' })
  await expect(artist.getByTestId('model-prepare')).toHaveText('Check again')

  // manual install: the folder a model file sits in; the text model's folder too
  await page.getByTestId('model-card-wd14').getByTestId('model-manual').locator('summary').click()
  const wdPath = cardOf(page, 'wd14').getByTestId('model-path')
  await wdPath.getByRole('button', { name: 'Copy path' }).click()
  await expect(page.getByText('Path copied')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('D:\\SD Image Sorter\\data\\models\\wd14\\wd-swinv2-tagger-v3\\model.onnx')
  await wdPath.getByRole('button', { name: 'Open folder' }).click()
  await expect.poll(() => stub.openPaths).toEqual([{ path: 'D:\\SD Image Sorter\\data\\models\\wd14\\wd-swinv2-tagger-v3' }])
  await clip.getByTestId('model-manual').locator('summary').click()
  await expect(clip.getByTestId('model-path')).toHaveCount(2)
  await expect(clip).toContainText('The image model and the text query model each have a folder')
})

test('download models: the recommended ones ticked, the gated one not, then one after another', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openAt(page, '#/settings/models')

  await page.getByTestId('bulk-open').click()
  const dialog = page.getByTestId('bulk-dialog')
  await expect(dialog.getByTestId('bulk-item-wd14')).toContainText('Ready')
  await expect(dialog.getByTestId('bulk-item-wd14').getByRole('checkbox')).toBeDisabled()
  for (const id of ['censor-nudenet', 'clip', 'florence2']) await expect(dialog.getByTestId(`bulk-item-${id}`).getByRole('checkbox')).toBeChecked()
  const gated = dialog.getByTestId('bulk-item-cl-tagger-v2')
  await expect(gated.getByRole('checkbox')).not.toBeChecked()
  await expect(gated).toContainText('needs Hugging Face permission first')
  await expect(gated.getByTestId('bulk-auth-link')).toHaveAttribute('href', 'https://huggingface.co/cella110n/cl_tagger_v2')
  await expect(dialog.getByTestId('bulk-summary')).toHaveText('3 picked · about 1.1 GB')
  await expect(dialog).toContainText('OppaiOracle: a 947 MB alternative tagger')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

  // pick all adds the optional and the gated ones; clear leaves nothing to start; pick recommended goes back
  await dialog.getByRole('button', { name: 'Pick all' }).click()
  await expect(dialog.getByTestId('bulk-summary')).toHaveText('5 picked · about 7.1 GB')
  await dialog.getByRole('button', { name: 'Clear' }).click()
  await expect(dialog.getByTestId('bulk-start')).toBeDisabled()
  await dialog.getByRole('button', { name: 'Pick recommended' }).click()
  await dialog.getByTestId('bulk-start').click()
  await expect(dialog).toHaveCount(0)

  await expect(page.getByTestId('model-queue')).toContainText('Downloading the chosen models 1/3: NudeNet detector')
  await expect(page.getByTestId('bulk-open')).toBeDisabled()
  await expect(page.getByText('The chosen models are downloaded (3).')).toBeVisible({ timeout: 20_000 })
  expect(stub.prepares).toEqual([
    { model_id: 'censor-nudenet', variant: null },
    { model_id: 'clip', variant: null },
    { model_id: 'florence2', variant: 'base' },
  ])
  expect(stub.overlapping, 'a download started while another was running').toEqual([])
  for (const id of ['censor-nudenet', 'clip', 'florence2']) await expect(cardOf(page, id).getByTestId('model-status')).toHaveText('Ready')
  await expect(page.getByTestId('model-queue')).toHaveCount(0)
  expect(await resumeList(page)).toBeNull()
})

test('a model that needs a restart pauses the run; "Restart now and continue" restarts and the rest continues after the reload', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub({ outcome: { 'censor-nudenet': 'needs_restart' }, bootIds: ['boot-A'] })
  await stubAll(page, stub)
  await openAt(page, '#/settings/models')

  await page.getByTestId('bulk-open').click()
  await page.getByTestId('bulk-start').click()
  const banner = page.getByTestId('model-banner')
  await expect(banner).toHaveAttribute('data-kind', 'restart')
  await expect(banner).toContainText('After the restart, downloading continues by itself (3 left).')
  // one toast about it (the download's), not a second one from the Model Center
  await expect(page.locator('[data-tone]').filter({ hasText: 'NudeNet' })).toHaveCount(1)
  expect(stub.prepares).toEqual([{ model_id: 'censor-nudenet', variant: null }])
  await expect(cardOf(page, 'censor-nudenet').getByTestId('model-status')).toHaveText('Restart needed')
  await expect(page.getByTestId('model-count-restart')).toHaveText('1')
  const saved = await resumeList(page)
  expect(saved).toMatchObject({ restart: true, bootId: 'boot-A', items: [{ card: 'censor-nudenet' }, { card: 'clip' }, { card: 'florence2', variant: 'base' }] })

  // the "restart": the old server answers once more, then a new one; NudeNet's packages now load, its model still has to come
  stub.bootIds = ['boot-A', 'boot-A', 'boot-B']
  stub.bootHits = 0
  await page.evaluate(() => ((window as unknown as { beforeRestart: boolean }).beforeRestart = true))
  await banner.getByTestId('banner-restart').click()
  await expect(page.getByTestId('restart-screen')).toHaveAttribute('data-kind', 'wait')
  expect(stub.restartPosts).toEqual([{ reason: 'model_dependency_install', force: false }])
  stub.cards.find((c) => c.id === 'censor-nudenet')!.status = 'missing'
  stub.outcome = {}
  await page.waitForFunction(() => !(window as unknown as { beforeRestart?: boolean }).beforeRestart, undefined, { timeout: 15_000 })

  // after the reload: the list continues by itself, in order, and is gone once done
  await expect(page.getByTestId('model-center')).toBeVisible()
  await expect(page.getByText('The downloads left before the restart (3) continue now.')).toBeVisible()
  await expect(page.getByText('The chosen models are downloaded (3).')).toBeVisible({ timeout: 20_000 })
  expect(stub.prepares.slice(1)).toEqual([
    { model_id: 'censor-nudenet', variant: null },
    { model_id: 'clip', variant: null },
    { model_id: 'florence2', variant: 'base' },
  ])
  expect(stub.overlapping).toEqual([])
  await expect(page.getByTestId('model-banner')).toHaveCount(0)
  expect(await resumeList(page)).toBeNull()
})

test('a download followed from elsewhere ends with its own result when the next one already started; one the app forgot says it was lost', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubAll(page, newStub())
  // another tab (or V3.5) runs the downloads; this page only follows them
  const running = (run: number, model: string, file: string, doneMb: number, totalMb: number, finished: Json = {}) => ({
    active: true,
    downloaded: doneMb * MB,
    total: totalMb * MB,
    filename: file,
    prepare_result: { active: true, run_id: run, model_id: model, status: 'downloading' },
    finished_prepares: finished,
  })
  let answer: Json = running(5, 'clip', 'clip-vision.onnx', 100, 400)
  await page.route('**/api/models/download-progress', (route: Route) => route.fulfill({ json: answer }))
  await openAt(page, '#/settings/models')

  await page.getByTestId('jobs-button').click()
  const job = page.getByTestId('jobs-drawer').getByTestId('job')
  await expect(job).toHaveCount(1)
  await expect(job).toContainText('Downloading clip')
  await expect(job).toContainText('clip-vision.onnx')

  // the next model starts before this page looks again; CLIP's run had ended with an error
  answer = running(6, 'artist', 'kaloscope.pth', 50, 2800, { '5': { active: false, run_id: 5, model_id: 'clip', status: 'error', message: '', error: 'HTTP 403' } })
  await expect(job).toHaveAttribute('data-status', 'error')
  await expect(job).toContainText('Stopped by an error: HTTP 403')
  await expect(job).not.toContainText('kaloscope.pth')
  await expect(job).toHaveCount(1)

  // in Chinese, after a reload: a followed run whose result the app no longer keeps
  answer = running(7, 'florence2', 'florence.safetensors', 10, 465)
  await page.evaluate(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.reload()
  await page.getByTestId('jobs-button').click()
  await expect(job).toHaveCount(1)
  await expect(job).toContainText('正在下载 florence2')
  answer = running(40, 'lucida', 'lucida.safetensors', 1, 885)
  await expect(job).toHaveAttribute('data-status', 'error')
  await expect(job).toContainText('florence2 的下载丢失了，不知道结果（比如程序中途重启过）。请重新下载。')
  await expect(job).not.toContainText('lucida')
})

test('a list left by a closed tab: the banner offers to continue or forget it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  const items = [{ card: 'clip', variant: null, label: 'CLIP similarity' }]
  await openAt(page, '#/settings/models', 'en', { items, restart: false, bootId: null, savedAt: 1 })
  const banner = page.getByTestId('model-banner')
  await expect(banner).toHaveAttribute('data-kind', 'pending')
  await expect(banner).toContainText('The last download did not finish: CLIP similarity.')
  // nothing started by itself: it was not waiting for a restart
  expect(stub.prepares).toEqual([])
  await banner.getByTestId('banner-continue').click()
  await expect(cardOf(page, 'clip').getByTestId('model-status')).toHaveText('Ready')
  expect(stub.prepares).toEqual([{ model_id: 'clip', variant: null }])
  await expect(banner).toHaveCount(0)
})

test('"Which one should I pick?" in the tag panel opens the Model Center at the tagger card, fully in view at 1366', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = newStub()
  await stubAll(page, stub)
  await openLibrary(page, TOKEN, 3)
  const tiles = page.getByTestId('tile')
  await tiles.nth(0).click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Tag…' }).click()
  const dialog = page.getByTestId('tag-dialog')
  await expect(dialog.getByText('WD SwinV2 v3')).toBeVisible()
  await dialog.getByTestId('model-guide-link').click()

  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings\/models$/)
  const wd = cardOf(page, 'wd14')
  await expect(wd).toHaveAttribute('data-focus', 'true')
  await expect(wd).toBeInViewport({ ratio: 1 })
  await expect(wd).toBeFocused()
  // Esc on the page closes nothing and goes nowhere; back returns to the library
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/#\/settings\/models$/)
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('query-input')).toBeVisible()
})

test('Chinese: the page, a card and the bulk dialog have no English left but names and jargon', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const stub = newStub()
  await stubAll(page, stub)
  await openAt(page, '#/settings/models', 'zh-CN')
  await expect(page.getByTestId('settings-tab-models')).toHaveText('模型中心')
  await expect(cardOf(page, 'wd14').getByTestId('model-status')).toHaveText('已就绪')
  await expect(cardOf(page, 'clip').getByTestId('model-prepare')).toHaveText('立即准备')
  await expect(cardOf(page, 'wd14').getByTestId('other-taggers')).toContainText('约占 7.5 GB 显存')
  // strip the names, file names and jargon a Chinese UI keeps; no English words must remain
  const allowed = /(WD14|WD|SwinV2|EVA02|ConvNeXt|ViT|Large|Camie|PixAI|OppaiOracle|CL Tagger|ToriiGate|Florence-2|Base|TIPO|CLIP|FastEmbed|Kaloscope|LSNet|Lucida|rembg|U2Net|YOLO|NudeNet|SAM|Hugging Face|HuggingFace|hf-mirror(\.com)?|ModelScope|Civitai|Danbooru|NVIDIA|CUDA|PyTorch|CPU|GPU|GGUF|Ollama|AI|WASD|app|data|models|yolo|json|txt|onnx|pt|pth|csv|kaloscope2\.0|lsnet_model|comfyui-lsnet-runtime|best_checkpoint|class_mapping|SD_IMAGE_SORTER_GPU_DUTY_CYCLE|off|v\d[\w.-]*|\d+(\.\d+)?\s?(MB|GB|%)|200M-ft|320n)/g
  const text = (await page.getByTestId('model-center').innerText()).replace(allowed, '')
  expect(text.match(/[A-Za-z]{2,}/g) ?? []).toEqual([])
  await page.getByTestId('bulk-open').click()
  const dialogText = (await page.getByTestId('bulk-dialog').innerText()).replace(allowed, '')
  expect(dialogText.match(/[A-Za-z]{2,}/g) ?? []).toEqual([])
})
