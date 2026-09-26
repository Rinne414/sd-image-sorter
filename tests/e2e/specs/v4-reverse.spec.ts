import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Page, type Request } from '@playwright/test'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, openLibrary, pageOverflow, repoRoot, runBackendScript, seedImages, tmpRoot, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Reverse prompt (反推提示词): the prompt the file recorded comes first;
 * the tagger (the one remembered in the tag panel), the vision model, or tags
 * then the vision model work one out; the target model is sent; Cancel stops
 * only our own run (one still queued is stopped when its turn comes); the
 * draft survives a reload and takes TIPO's ticked tags.
 *
 * Nothing runs on the GPU: /api/tag/single, /api/smart-tag/*,
 * /api/tags/suggest-upsample, /api/vlm/settings and /api/models/status are
 * stubbed. Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const TOKEN = 'v4reversetoken'
const PREFIX = 'v4reverse-lib-'
const COUNT = 2
const DIR = 'v4-reverse'
const SAMPLES = path.join(tmpRoot, DIR, 'samples')
const LIBRARY_COPY = path.join(tmpRoot, DIR, `${PREFIX}00.png`)
const NAI = path.join(SAMPLES, 'v4reader-nai.png')
const NO_METADATA = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'no-metadata-screenshot.png')

/** The tagger the tag panel remembers (not the backend default). */
const REMEMBERED = { model: 'wd-vit-tagger-v3', useGpu: false, blacklist: [], maxTags: 0, thresholds: { 'wd-vit-tagger-v3': { general: 0.5, character: null } } }

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  runBackendScript(`
import runpy, sys
sys.argv = ["v4_reader_samples.py", "--images", ${JSON.stringify(SAMPLES)}]
runpy.run_path(${JSON.stringify(path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'v4_reader_samples.py'))}, run_name="__main__")
`)
  fs.copyFileSync(path.join(SAMPLES, 'v4reader-a1111.png'), LIBRARY_COPY)
})

test.afterAll(() => {
  cleanupImages(PREFIX, [DIR])
})

interface Stubs {
  vlm: boolean
  tagSingle: Request[]
  starts: Request[]
  cancels: number
  tipo: Request[]
}

/** Every AI call answered here; the vision model counts as set up when `vlm`. */
async function stubAi(page: Page, vlm = true): Promise<Stubs> {
  const s: Stubs = { vlm, tagSingle: [], starts: [], cancels: 0, tipo: [] }
  await markModelsReady(page, ['wd14', 'tipo'], { extraVariants: ['wd-vit-tagger-v3', 'v2.1', '200m-ft'] })
  await page.route('**/api/vlm/settings', (route) =>
    route.fulfill({ json: s.vlm ? { provider: 'openai_compat', endpoint: 'http://127.0.0.1:11434/v1', model: 'stub-vlm' } : { provider: 'openai_compat', endpoint: '', model: '' } }),
  )
  await page.route('**/api/tag/single', async (route) => {
    s.tagSingle.push(route.request())
    await route.fulfill({ json: { model: 'wd-vit-tagger-v3', all_tags: [{ tag: '1girl' }, { tag: 'silver_hair' }, { tag: 'score_9' }], stored: false } })
  })
  await page.route('**/api/smart-tag/cancel', async (route) => {
    s.cancels += 1
    await route.fulfill({ json: { status: 'cancelled', cancel_requested: true } })
  })
  await page.route('**/api/tags/suggest-upsample', async (route) => {
    s.tipo.push(route.request())
    await route.fulfill({ json: { proposed_tags: [{ tag: 'rain', category: 'background' }, { tag: 'umbrella', category: 'unknown' }] } })
  })
  return s
}

/** A Smart Tag run the test steps through: `start` answers the start, then `progress` in order (the last repeats). */
async function stubSmartTag(page: Page, s: Stubs, start: object, progress: object[], caption = 'A girl standing in the rain.') {
  let i = 0
  await page.route('**/api/smart-tag/start', async (route) => {
    s.starts.push(route.request())
    await route.fulfill({ json: start })
  })
  await page.route('**/api/smart-tag/progress**', async (route) => {
    const body = progress[Math.min(i, progress.length - 1)]
    i += 1
    await route.fulfill({ json: body })
  })
  await page.route('**/api/smart-tag/results**', (route) => route.fulfill({ json: { results: [{ caption, booru_text: '1girl, rain' }], total: 1 } }))
}

async function openReverse(page: Page) {
  await page.addInitScript((remembered) => {
    if (sessionStorage.getItem('v4reverse-init')) return
    sessionStorage.setItem('v4reverse-init', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-tag-options', JSON.stringify(remembered))
    localStorage.removeItem('sd-v4-reverse-options')
    localStorage.removeItem('sd-v4-reverse-draft')
  }, REMEMBERED)
  const res = await page.goto('/v4/#/tools/reverse', { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
  await expect(page.getByTestId('reverse-page')).toBeVisible()
}

const bodyOf = (r: Request) => r.postDataJSON() as Record<string, unknown>

test('the file record comes first; a file without one says so', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await stubAi(page)
  await openReverse(page)
  await expect(page.getByTestId('intake-zone')).toContainText('the prompt the file recorded comes first')

  await page.getByTestId('intake-file').setInputFiles(NAI)
  const recorded = page.getByTestId('reverse-recorded')
  await expect(recorded).toContainText('Recorded in the file')
  await expect(recorded).toContainText('NovelAI')
  await expect(recorded).toContainText('v4reader nai prompt')
  await expect(recorded).toContainText('lowres, bad anatomy')
  await expect(page.getByTestId('reverse-run-button')).toHaveText('Work one out anyway (to compare)')
  await expect(page.getByTestId('reverse-inferred')).toHaveCount(0)

  await page.getByTestId('intake-file').setInputFiles(NO_METADATA)
  await expect(page.getByTestId('reverse-no-record')).toBeVisible()
  await expect(page.getByTestId('reverse-run-button')).toHaveText('Work out a prompt')
})

test('the tagger alone uses the tagger remembered in the tag panel', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const s = await stubAi(page)
  await openReverse(page)
  await page.getByTestId('intake-file').setInputFiles(NAI)
  await expect(page.getByTestId('reverse-models')).toContainText('Tagger: WD ViT v3')
  await page.getByTestId('reverse-mode-tagger').check()
  await page.getByTestId('reverse-run-button').click()

  const inferred = page.getByTestId('reverse-inferred')
  await expect(inferred).toContainText('1girl, silver hair, score_9')
  await expect(inferred).toContainText('read by the tagger WD ViT v3')
  await expect(inferred).toContainText('For comparison only')
  expect(s.tagSingle).toHaveLength(1)
  const body = bodyOf(s.tagSingle[0]!)
  expect(body).toMatchObject({ tagger_model: 'wd-vit-tagger-v3', general_threshold: 0.5, use_gpu: false })
  // the kept copy parse-image made of the upload
  expect(String(body.image_path)).toMatch(/reader_uploads/)
  expect(s.starts).toHaveLength(0)
})

test('tags then the vision model: waits its turn, sends the target model, shows the caption', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const s = await stubAi(page)
  await stubSmartTag(page, s, { status: 'queued', queue_id: 'q7', queue_position: 2 }, [
    { active: true, job_id: 'someone-else', status: 'running', pipeline_queue: { queued: [{ queue_id: 'q7', kind: 'smart', position: 1 }] } },
    { active: true, job_id: 'someone-else', status: 'running', pipeline_queue: { queued: [{ queue_id: 'q7', kind: 'smart', position: 1 }] } },
    { active: true, job_id: 'j1', status: 'running', pipeline_queue: { queued: [] } },
    { active: false, job_id: 'j1', status: 'completed', processed: 1, total: 1 },
  ])
  await openReverse(page)
  await page.getByTestId('intake-file').setInputFiles(NO_METADATA)
  await page.getByTestId('reverse-target').selectOption('krea2')
  await expect(page.getByTestId('reverse-run')).toContainText('long natural-language descriptions')
  await page.getByTestId('reverse-run-button').click()
  await expect(page.getByTestId('reverse-status')).toContainText('Queued')
  await expect(page.getByTestId('reverse-inferred')).toContainText('A girl standing in the rain.', { timeout: 10_000 })
  await expect(page.getByTestId('reverse-inferred')).toContainText('tagged by WD ViT v3, then described by the vision model stub-vlm')
  await expect(page.getByTestId('reverse-inferred')).toContainText('The file records no prompt')

  const body = bodyOf(s.starts[0]!)
  expect(body).toMatchObject({ enable_wd14: true, enable_vlm: true, vlm_grounding: true, caption_profile: 'krea2_long_nl', skip_existing: false, tagger_model: 'wd-vit-tagger-v3', use_gpu: false })
  expect((body.image_paths as string[])[0]).toMatch(/reader_uploads/)
  expect(s.cancels).toBe(0)
  // the way and target are remembered
  await page.reload()
  await page.getByTestId('intake-file').setInputFiles(NO_METADATA)
  await expect(page.getByTestId('reverse-target')).toHaveValue('krea2')
  await expect(page.getByTestId('reverse-mode-grounded')).toBeChecked()
})

test('Cancel stops a running vision-model run, and a queued one only when its turn comes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const s = await stubAi(page)
  const queued = { active: true, job_id: 'someone-else', status: 'running', pipeline_queue: { queued: [{ queue_id: 'q9', kind: 'smart', position: 1 }] } }
  await stubSmartTag(page, s, { status: 'queued', queue_id: 'q9' }, [
    queued,
    queued,
    queued,
    queued,
    { active: true, job_id: 'j9', status: 'running', pipeline_queue: { queued: [] } },
    { active: true, job_id: 'j9', status: 'running' },
  ])
  await openReverse(page)
  await page.getByTestId('intake-file').setInputFiles(NO_METADATA)
  await page.getByTestId('reverse-mode-vlm').check()
  await page.getByTestId('reverse-run-button').click()
  await expect(page.getByTestId('reverse-status')).toContainText('Queued')
  await page.getByTestId('reverse-cancel').click()
  await expect(page.getByTestId('reverse-status')).toContainText('Cancelling')
  // someone else's run is active: nothing is cancelled until ours starts
  expect(s.cancels).toBe(0)
  await expect(page.getByTestId('reverse-status')).toHaveText('Cancelled.', { timeout: 10_000 })
  expect(s.cancels).toBe(1)
  expect(bodyOf(s.starts[0]!)).toMatchObject({ enable_wd14: false, enable_vlm: true, vlm_grounding: false })
  await expect(page.getByTestId('reverse-inferred')).toHaveCount(0)
})

test('without a vision model only the tagger is offered, and says where to set one up', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubAi(page, false)
  await openReverse(page)
  await page.getByTestId('intake-file').setInputFiles(NAI)
  await expect(page.getByTestId('reverse-vlm-missing')).toBeVisible()
  await expect(page.getByTestId('reverse-run-button')).toBeDisabled()
  await page.getByTestId('reverse-mode-tagger').check()
  await expect(page.getByTestId('reverse-vlm-missing')).toHaveCount(0)
  await expect(page.getByTestId('reverse-run-button')).toBeEnabled()
})

test('the draft survives a reload and takes the tags ticked in TIPO; Krea 2 turns TIPO off', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const s = await stubAi(page)
  await openReverse(page)
  await page.getByTestId('intake-file').setInputFiles(NAI)
  await page.getByTestId('reverse-draft-recorded').click()
  const draft = page.getByTestId('reverse-draft-text')
  await expect(draft).toHaveValue('2girls, outdoors, v4reader nai prompt')
  await draft.fill('1girl, silver hair')

  await page.reload()
  await page.getByTestId('intake-file').setInputFiles(NAI)
  await expect(page.getByTestId('reverse-draft-text')).toHaveValue('1girl, silver hair')

  await page.getByTestId('reverse-tipo-open').click()
  await page.getByTestId('edit-tipo-run').click()
  await expect(page.getByTestId('edit-tipo-pick')).toHaveCount(2)
  expect(bodyOf(s.tipo[0]!)).toMatchObject({ tags: ['1girl', 'silver hair'] })
  await page.getByTestId('edit-tipo-pick').first().check()
  await page.getByTestId('edit-tipo-add').click()
  await expect(page.getByTestId('reverse-draft-text')).toHaveValue('1girl, silver hair, rain')

  await page.getByTestId('reverse-target').selectOption('krea2')
  await expect(page.getByTestId('reverse-tipo-open')).toBeDisabled()
  await expect(page.getByTestId('reverse-draft')).toContainText('TIPO only adds Booru tags')
})

test('a library image opens from the right-click menu, and the tagger reads its library file', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const s = await stubAi(page)
  const id = Number(
    runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    print(conn.execute("SELECT id FROM images WHERE filename = ?", (${JSON.stringify(`${PREFIX}00.png`)},)).fetchone()[0])
`),
  )
  const reparse = await page.request.post(`/api/images/${id}/reparse`, { headers: { 'X-SD-Library-Id': 'main' } })
  expect(reparse.ok(), await reparse.text()).toBe(true)
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO image_prompt_tokens (image_id, token) VALUES (?, ?)", (${id}, ${JSON.stringify(TOKEN)}))
    conn.commit()
print("ok")
`)
  const uploads: string[] = []
  page.on('request', (r) => r.url().includes('/api/parse-image') && uploads.push(r.url()))
  await page.addInitScript((remembered) => localStorage.setItem('sd-v4-tag-options', JSON.stringify(remembered)), REMEMBERED)
  await openLibrary(page, TOKEN, COUNT)
  await page.locator(`[data-testid="tile"][data-id="${id}"]`).click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Send to tool' }).hover()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'Reverse prompt' }).click()
  await expect(page).toHaveURL(/#\/tools\/reverse$/)
  await expect(page.getByTestId('reverse-recorded')).toContainText('v4reader webui prompt')

  await page.getByTestId('reverse-mode-tagger').check()
  await page.getByTestId('reverse-run-button').click()
  await expect(page.getByTestId('reverse-inferred')).toBeVisible()
  expect(path.resolve(String(bodyOf(s.tagSingle[0]!).image_path))).toBe(path.resolve(LIBRARY_COPY))
  expect(uploads, 'a library image is read from the database, not uploaded').toEqual([])
})

test('fits the desktop sizes with nothing cut off', async ({ page }) => {
  await stubAi(page)
  await openReverse(page)
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp)
    await page.getByTestId('intake-file').setInputFiles(NAI)
    await expect(page.getByTestId('reverse-recorded')).toBeVisible()
    expect(await pageOverflow(page), `overflow at ${vp.width}`).toBeLessThanOrEqual(0)
    for (const id of ['intake-pick', 'reader-clear', 'reverse-recorded', 'reverse-mode-grounded']) await expect(page.getByTestId(id), `${id} at ${vp.width}`).toBeInViewport()
    await page.getByTestId('reverse-run-button').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('reverse-run-button')).toBeInViewport()
    await page.getByTestId('reader-clear').click()
    await expect(page.getByTestId('intake-zone')).toBeVisible()
  }
})
