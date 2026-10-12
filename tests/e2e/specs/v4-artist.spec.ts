import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, pageOverflow, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V4 Style finder (画风识别) in a library of its own. The numbers, the artist
 * lists and one artist's images come from results written straight into the
 * test database; "View in library" really filters the library by artist:.
 * Identifying never runs a model: identify-batch, batch-progress,
 * batch-cancel, diagnostics and the vocabulary are stubbed, and the tests
 * check what the page asks for (the remembered settings, skip_existing) and
 * what it says. Clearing runs for real on the test database, last.
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4arttoken'
const PREFIX = 'v4art-'
const COUNT = 7
const DIR = 'v4-artist'
const LIBRARY = 'v4art-lib'
const PREFS_KEY = 'sd-image-sorter-artist-defaults-v1'

/** Ids of the seeded rows by index (00..06). */
let ids: number[] = []

/**
 * Results: 00-02 v4art_alpha (0.88, 0.6, 0.3), 03 v4art_beta (0.25) are
 * confident; 04 v4art_gamma (0.1, an old unconfirmed row); 05 no match; 06 none.
 */
function seedLibrary(): number[] {
  const out = runBackendScript(`
import json, sqlite3
prefix = ${JSON.stringify(PREFIX)}
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("INSERT OR IGNORE INTO libraries (id, name, is_default) VALUES (?, 'V4 e2e style finder', 0)", (${JSON.stringify(LIBRARY)},))
    conn.execute("UPDATE images SET library_id = ? WHERE filename LIKE ?", (${JSON.stringify(LIBRARY)}, prefix + "%"))
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename NOT LIKE ? ORDER BY filename", (prefix + "%", prefix + "cache%"))]
    rows = [("v4art_alpha", 0.88), ("v4art_alpha", 0.6), ("v4art_alpha", 0.3), ("v4art_beta", 0.25), ("v4art_gamma", 0.1), ("undefined", 0.01)]
    conn.execute("DELETE FROM artist_predictions WHERE image_id IN (%s)" % ",".join("?" * len(ids)), ids)
    for image_id, (artist, confidence) in zip(ids, rows):
        conn.execute("INSERT INTO artist_predictions (image_id, artist, confidence, top_predictions) VALUES (?, ?, ?, '[]')", (image_id, artist, confidence))
    conn.commit()
print(json.dumps(ids))
`)
  return JSON.parse(out.split('\n').at(-1)!) as number[]
}

function dropLibrary(): void {
  runBackendScript(`
import sqlite3
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    conn.execute("DELETE FROM artist_predictions WHERE image_id IN (SELECT id FROM images WHERE filename LIKE ?)", (${JSON.stringify(PREFIX)} + "%",))
    conn.execute("DELETE FROM libraries WHERE id = ?", (${JSON.stringify(LIBRARY)},))
    conn.commit()
print("ok")
`)
}

test.beforeAll(() => {
  dropLibrary()
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  ids = seedLibrary()
  expect(ids).toHaveLength(COUNT)
})

test.afterAll(() => {
  dropLibrary()
  cleanupImages(PREFIX, [DIR])
})

const json = (route: Route, body: unknown) => route.fulfill({ json: body })

/** V4 in English, in the test's own library, at `hash`; the style model counts as ready unless the test stubs the model status itself. */
async function openAt(page: Page, hash: string, { ready = true }: { ready?: boolean } = {}) {
  if (ready) await markModelsReady(page, ['wd14', 'artist'])
  await page.route('**/api/artists/diagnostics', (r) => json(r, { status: 'ok', available: true, missing_dependencies: [] }))
  await page.addInitScript(
    ({ library, key }) => {
      if (sessionStorage.getItem('v4art-init')) return
      sessionStorage.setItem('v4art-init', '1')
      localStorage.setItem('sd-image-sorter-lang', 'en')
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: library }))
      localStorage.removeItem('sd-v4-browse')
      localStorage.removeItem(key)
    },
    { library: LIBRARY, key: PREFS_KEY },
  )
  const res = await page.goto(`/v4/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

interface IdentifyStub {
  starts: Record<string, unknown>[]
  cancels: number
}

interface StubOptions {
  /** What identify-batch answers (default: every image, nothing skipped). */
  start?: (body: Record<string, unknown>) => Record<string, unknown>
  /** Polls that report the run still going before it ends (default 1). */
  runningPolls?: number
  /** Results of the finished run (the summary reads them). */
  results?: Record<string, unknown>[]
  /** A run is already going when the page opens. */
  alreadyRunning?: boolean
}

/** Identifying without a model: the start, the progress (running, then done), the stop. */
async function stubIdentify(page: Page, opts: StubOptions = {}): Promise<IdentifyStub> {
  const stub: IdentifyStub = { starts: [], cancels: 0 }
  let total = opts.alreadyRunning ? 5 : 0
  let polls = 0
  let state: 'idle' | 'running' | 'stopped' = opts.alreadyRunning ? 'running' : 'idle'
  await page.route('**/api/artists/identify-batch', (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>
    stub.starts.push(body)
    const answer = opts.start?.(body) ?? { message: 'Batch identification started', total: (body.image_ids as number[]).length, skipped: 0, started: true }
    if (answer.started !== false) {
      total = Number(answer.total)
      polls = 0
      state = 'running'
    }
    return json(r, answer)
  })
  await page.route('**/api/artists/batch-progress**', (r) => {
    const light = r.request().url().includes('include_results=false')
    if (state === 'idle') return json(r, { running: false, total: 0, processed: 0, errors: 0, results: [], step: 'idle', message: '' })
    if (state === 'stopped') return json(r, { running: false, total, processed: 1, errors: 0, results: [], step: 'done', message: '' })
    if (light) polls += 1
    const going = opts.alreadyRunning || polls <= (opts.runningPolls ?? 1)
    if (going) return json(r, { running: true, total, processed: 1, errors: 0, results: [], step: 'identifying', current_item: 'v4art-00.png' })
    return json(r, { running: false, total, processed: total, errors: 0, results: light ? [] : (opts.results ?? []), step: 'done', message: 'done' })
  })
  await page.route('**/api/artists/batch-cancel', (r) => {
    stub.cancels += 1
    state = 'stopped'
    return json(r, { status: 'cancelled' })
  })
  return stub
}

/** The newest toast saying `text`. */
const toast = (page: Page, text: string | RegExp) => page.getByRole('status').locator('div', { hasText: text }).last()
const tile = (page: Page, i: number) => page.locator(`[data-testid="tile"][data-id="${ids[i]}"]`)
const rows = (page: Page, tab: 'confident' | 'candidates') => page.getByTestId(`artist-list-${tab}`).getByTestId('artist-row')

test('the five numbers, both lists and one artist’s images come from the library’s results', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await stubIdentify(page)
  await openAt(page, '#/tools/artist')
  await expect(page.getByTestId('artist-page')).toBeVisible()

  // 7 images: 4 confident (alpha 3, beta 1), 1 unconfirmed (gamma), 1 no match; 2 artists
  await expect(page.getByTestId('artist-stat-total')).toContainText('7')
  await expect(page.getByTestId('artist-stat-confident')).toContainText('4')
  await expect(page.getByTestId('artist-stat-unconfirmed')).toContainText('1')
  await expect(page.getByTestId('artist-stat-none')).toContainText('1')
  await expect(page.getByTestId('artist-stat-artists')).toContainText('2')

  // most images first, with average and peak
  await expect(rows(page, 'confident')).toHaveCount(2)
  await expect(rows(page, 'confident').first()).toHaveAttribute('data-artist', 'v4art_alpha')
  await expect(rows(page, 'confident').first()).toContainText('3 images')
  await expect(rows(page, 'confident').first()).toContainText('average 59% · peak 88%')

  // the candidates are on their own tab, said to be guesses
  await page.getByTestId('artist-tab-candidates').click()
  await expect(rows(page, 'candidates')).toHaveCount(1)
  await expect(rows(page, 'candidates').first()).toHaveAttribute('data-artist', 'v4art_gamma')
  await expect(page.getByTestId('artist-list')).toContainText('these are guesses, not identifications')
  await rows(page, 'candidates').first().click()
  const detail = page.getByTestId('artist-detail')
  await expect(detail).toHaveAttribute('data-artist', 'v4art_gamma')
  await expect(detail).toContainText('Unconfirmed')
  await expect(detail).toContainText('1 image guessed as this name')
  await expect(detail.getByTestId('artist-preview')).toHaveCount(1)
  await expect(detail.getByTestId('artist-preview').first()).toContainText('Unconfirmed')

  // one artist: most confident first, all shown
  await page.getByTestId('artist-tab-confident').click()
  await rows(page, 'confident').first().click()
  await expect(rows(page, 'confident').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(detail).toContainText('3 images identified as this artist')
  const previews = detail.getByTestId('artist-preview')
  await expect(previews).toHaveCount(3)
  await expect(previews.first()).toHaveAttribute('data-id', String(ids[0]))
  await expect(previews.first()).toContainText('88%')
  await expect(page.getByTestId('artist-shown')).toHaveText('3 of 3 shown')
  await expect(page.getByTestId('artist-more')).toHaveCount(0)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0)

  // "View in library" puts artist: in the search, and the library shows those three
  await page.getByTestId('artist-view').click()
  await expect(page).toHaveURL(/#\/library/)
  await expect(page.getByTestId('query-input')).toHaveValue('artist:v4art_alpha')
  await expect(page.getByTestId('result-count')).toHaveText('3 images')
  await expect(toast(page, 'Library search: artist:v4art_alpha')).toBeVisible()
})

test('a preview opens that image in the library, on the card', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubIdentify(page)
  await openAt(page, '#/tools/artist')
  await rows(page, 'confident').first().click()
  await page.getByTestId('artist-detail').locator(`[data-testid="artist-preview"][data-id="${ids[1]}"]`).click()
  await expect(page).toHaveURL(/#\/library/)
  await expect(page.getByTestId('generation-card')).toContainText(`${PREFIX}01.png`)
  await expect(page.getByTestId('result-count')).toHaveText('3 images')
})

test('"is my artist in the vocabulary?" answers per name, and says when the model is not loaded', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubIdentify(page)
  let loaded = false
  const asked: string[][] = []
  await page.route('**/api/artists/vocabulary**', (r) => {
    const names = new URL(r.request().url()).searchParams.getAll('name')
    asked.push(names)
    if (!loaded) return json(r, { vocabulary_size: 0, vocabulary_loaded: false, known: {} })
    return json(r, { vocabulary_size: 39261, vocabulary_loaded: true, known: Object.fromEntries(names.map((n) => [n, n === 'wlop'])) })
  })
  await openAt(page, '#/tools/artist')
  const input = page.getByTestId('artist-vocab-input')
  await page.getByTestId('artist-vocab-check').click()
  await expect(page.getByTestId('artist-vocab')).toContainText('Type an artist name first.')

  await input.fill('wlop，nobody_here')
  await input.press('Enter')
  await expect(page.getByTestId('artist-vocab')).toContainText('Identify once, then check again.')

  loaded = true
  await page.getByTestId('artist-vocab-check').click()
  const result = page.getByTestId('artist-vocab-result')
  await expect(page.getByTestId('artist-vocab')).toContainText('This model knows 39,261 artists.')
  await expect(result.locator('li[data-known="true"]')).toHaveText('wlop: in the vocabulary')
  await expect(result.locator('li[data-known="false"]')).toHaveText('nobody_here: not in the vocabulary, so it can never be identified')
  expect(asked.at(-1)).toEqual(['wlop', 'nobody_here'])
})

test('identifying the picks: the request, the progress, and what it found', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const results = [
    { image_id: ids[0], artist: 'v4art_alpha', confidence: 0.9, confidence_level: 'high', candidate_artist: 'v4art_alpha' },
    { image_id: ids[1], artist: 'undefined', confidence: 0.1, confidence_level: 'low', candidate_artist: 'someone' },
  ]
  const stub = await stubIdentify(page, { runningPolls: 6, results })
  await openAt(page, '#/library')
  await expect(page.getByTestId('result-count')).toHaveText('7 images')
  await tile(page, 0).click({ modifiers: ['Control'] })
  await tile(page, 1).click({ modifiers: ['Control'] })
  await page.getByTestId('tools-menu').click()
  await page.getByRole('menuitem', { name: 'Style finder' }).click()

  await expect(page.getByTestId('artist-source-picks')).toBeChecked()
  await expect(page.getByTestId('artist-model-line')).toHaveText('Kaloscope 2.0 is ready.')
  await page.getByTestId('artist-go').click()
  await expect.poll(() => stub.starts.length).toBe(1)
  expect(stub.starts[0]).toEqual({
    image_ids: [ids[0], ids[1]],
    threshold: 0.03,
    top_k: 5,
    model_source: 'huggingface',
    model_path: null,
    use_gpu: true,
    skip_existing: true,
  })
  await expect(page.getByTestId('artist-running')).toContainText('Identifying 1 / 2')
  // the settings the run took are locked while it runs
  await expect(page.getByTestId('artist-source')).toBeDisabled()
  await expect(toast(page, 'Identified 2 images: 1 confident, 1 unconfirmed, 0 no match')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('artist-running')).toHaveCount(0)
  await expect(page.getByTestId('artist-go')).toHaveText('Identify 2 images')
})

test('"Send to tool ▸ Style finder" opens the page with those images to identify', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = await stubIdentify(page)
  await openAt(page, '#/library')
  await expect(page.getByTestId('result-count')).toHaveText('7 images')
  for (const i of [3, 4, 5]) await tile(page, i).click({ modifiers: ['Control'] })
  await page.getByTestId('selection-bar').getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Style finder' }).click()
  await expect(page).toHaveURL(/#\/tools\/artist$/)
  await expect(page.getByTestId('artist-source-sent')).toBeChecked()
  await expect(page.getByTestId('artist-source-sent')).toBeVisible()
  await expect(page.getByTestId('artist-go')).toHaveText('Identify 3 images')
  await page.getByTestId('artist-go').click()
  await expect.poll(() => stub.starts.at(-1)?.image_ids).toEqual([ids[3], ids[4], ids[5]])
})

test('a run can be stopped from the page; a run already going is followed', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const stub = await stubIdentify(page, { runningPolls: 1000 })
  await openAt(page, '#/tools/artist')
  // the current filter here is the whole test library
  await expect(page.getByTestId('artist-source-filter')).toBeChecked()
  await expect(page.getByTestId('artist-go')).toHaveText('Identify 7 images')
  await page.getByTestId('artist-go').click()
  await expect(page.getByTestId('artist-running')).toContainText('Identifying 1 / 7')
  await page.getByTestId('artist-stop').click()
  await expect.poll(() => stub.cancels).toBe(1)
  await expect(toast(page, 'Stopped after 1 of 7')).toBeVisible()
  await expect(page.getByTestId('artist-go')).toBeEnabled()

  // another page opening while a run goes (V3.5 started it) shows it, with Stop
  const other = await page.context().newPage()
  await stubIdentify(other, { alreadyRunning: true })
  await openAt(other, '#/tools/artist')
  await expect(other.getByTestId('artist-running')).toContainText('Identifying 1 / 5')
  await expect(other.getByTestId('artist-stop')).toBeVisible()
  await other.close()
})

test('only images without a result: skipped ones are counted, and nothing starts when all have one', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  let allDone = false
  const stub = await stubIdentify(page, {
    results: [{ image_id: ids[6], artist: 'v4art_alpha', confidence: 0.5, confidence_level: 'high' }],
    start: (body) => {
      const n = (body.image_ids as number[]).length
      if (allDone) return { message: 'Every image already has an artist result', total: 0, skipped: n, started: false }
      return { message: 'started', total: 1, skipped: n - 1, started: true }
    },
  })
  await openAt(page, '#/tools/artist')
  await expect(page.getByTestId('artist-skip')).toBeChecked()
  await expect(page.getByTestId('artist-run')).toContainText('This library has 6 with a result.')
  await page.getByTestId('artist-go').click()
  await expect(toast(page, '6 already had a result and were skipped.')).toBeVisible()
  await expect(toast(page, /Style: /)).toBeVisible({ timeout: 15_000 })

  allDone = true
  await page.getByTestId('artist-go').click()
  await expect(toast(page, 'All 7 images already have a style result; nothing to identify.')).toBeVisible()
  await expect(page.getByTestId('artist-running')).toHaveCount(0)

  // off: every image runs again
  await page.getByTestId('artist-skip').uncheck()
  allDone = false
  await page.getByTestId('artist-go').click()
  await expect.poll(() => stub.starts.at(-1)?.skip_existing).toBe(false)
})

test('settings are remembered with V3.5, and right-click "Identify style" uses them', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const results = [{ image_id: ids[2], artist: 'v4art_alpha', confidence: 0.876, confidence_level: 'high', candidate_artist: 'v4art_alpha' }]
  const stub = await stubIdentify(page, { results })
  await openAt(page, '#/tools/artist')
  await page.getByTestId('artist-source').selectOption('modelscope')
  await page.getByTestId('artist-threshold').fill('0.1')
  await page.getByTestId('artist-gpu').uncheck()

  await page.reload()
  await expect(page.getByTestId('artist-source')).toHaveValue('modelscope')
  await expect(page.getByTestId('artist-threshold')).toHaveValue('0.1')
  await expect(page.getByTestId('artist-gpu')).not.toBeChecked()
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), PREFS_KEY)
  expect(saved).toMatchObject({ version: 1, modelSource: 'modelscope', modelPath: '', threshold: 0.1, useGpu: false, skipExisting: true })

  // the library's right-click menu runs one image with them and names what it found
  await page.goto('/v4/#/library')
  await expect(page.getByTestId('result-count')).toHaveText('7 images')
  await tile(page, 2).click({ button: 'right' })
  await page.getByTestId('card-menu').getByRole('menuitem', { name: 'Analyze' }).hover()
  await page.locator('[data-ctx-sub]').getByRole('menuitem', { name: 'Identify style' }).click()
  await expect.poll(() => stub.starts.length).toBe(1)
  expect(stub.starts[0]).toMatchObject({ image_ids: [ids[2]], threshold: 0.1, model_source: 'modelscope', model_path: null, use_gpu: false })
  await expect(toast(page, 'Style: v4art alpha (confident, 88%)')).toBeVisible({ timeout: 15_000 })

  // a local model file without its path says so and starts nothing, from the card too
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ version: 1, modelSource: 'local', modelPath: '', threshold: 0.03, useGpu: true })), PREFS_KEY)
  await page.reload()
  await expect(page.getByTestId('result-count')).toHaveText('7 images')
  await tile(page, 3).click()
  await page.getByTestId('card-identify-artist').click()
  await expect(toast(page, 'With a local model file, enter its path first.')).toBeVisible()
  expect(stub.starts).toHaveLength(1)
  await page.goto('/v4/#/tools/artist')
  await expect(page.getByTestId('artist-settings')).toContainText('With a local model file, enter its path first.')
  await page.getByTestId('artist-reset').click()
  await expect(page.getByTestId('artist-source')).toHaveValue('huggingface')
})

test('the first run downloads Kaloscope as its own job, then identifies', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const prepared: unknown[] = []
  let downloadPolls = 0
  await page.route('**/api/models/status', (r) => {
    const ready = prepared.length > 0 && downloadPolls >= 2
    return json(r, { models: [{ id: 'artist', status: ready ? 'ready' : 'missing', available: ready }] })
  })
  await page.route('**/api/models/prepare', (r) => {
    prepared.push(r.request().postDataJSON())
    return json(r, { status: 'started', model_id: 'artist' })
  })
  await page.route('**/api/models/download-progress', (r) => {
    downloadPolls += prepared.length ? 1 : 0
    if (!prepared.length) return json(r, { active: false })
    return json(r, downloadPolls < 2 ? { active: true, downloaded: 40, total: 100, filename: 'best_checkpoint.pth' } : { active: false, prepare_result: { model_id: 'artist', status: 'ok', active: false } })
  })
  const stub = await stubIdentify(page)
  await openAt(page, '#/tools/artist', { ready: false })
  await expect(page.getByTestId('artist-model-line')).toHaveText(/downloads Kaloscope 2\.0 \(about 2\.8 GB\) first/)
  await page.getByTestId('artist-go').click()
  await expect.poll(() => prepared).toEqual([{ model_id: 'artist', variant: null, source: 'huggingface' }])
  await expect.poll(() => stub.starts.length, { timeout: 15_000 }).toBe(1)
})

test('every size: nothing overflows and the main actions are on screen', async ({ page }) => {
  await stubIdentify(page)
  await openAt(page, '#/tools/artist')
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    await rows(page, 'confident').first().click()
    await expect(page.getByTestId('artist-go')).toBeInViewport()
    await expect(page.getByTestId('artist-view')).toBeInViewport()
    await expect(page.getByTestId('artist-stat-artists')).toBeInViewport()
    expect(await pageOverflow(page), `${viewport.width}`).toBeLessThanOrEqual(0)
  }
})

test('clearing asks first with Cancel focused, then removes every result', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await stubIdentify(page)
  await openAt(page, '#/tools/artist')
  await expect(page.getByTestId('artist-stat-confident')).toContainText('4')
  await page.getByTestId('artist-clear-button').click()
  const dialog = page.getByTestId('artist-clear-dialog')
  await expect(dialog).toContainText('the 6 images in this library')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('artist-page')).toBeVisible()

  await page.getByTestId('artist-clear-button').click()
  await page.getByTestId('artist-clear-yes').click()
  await expect(toast(page, 'This library’s style results cleared')).toBeVisible()
  await expect(page.getByTestId('artist-stat-confident')).toContainText('0')
  await expect(page.getByTestId('artist-list-confident')).toContainText('No artists identified yet.')
})
