import path from 'node:path'

import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { cleanupImages, dbPath, pageOverflow, repoRoot, runBackendScript, seedImages, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * V Opus 画风地图 (Style Map, stage 1): the tool page, the index job, the
 * space switch and the 3-D view. The library rows are real and so are their
 * style vectors: the spec writes CSD vectors straight into the test database
 * (three loose clusters, two pictures with the same vector so one dot stands for
 * both, two pictures without any), so the real backend lays out the map,
 * colours it, finds its regions and axes, locates pictures and lists the
 * nearest ones; no model runs. What would download or run a model (UMAP, the
 * index job itself) is answered by route stubs and said as such.
 * Needs the V Opus build: `cd frontend-v4 && npm run build`.
 */

test.describe.configure({ mode: 'serial' })

const TOKEN = 'v4smtoken'
const PREFIX = 'v4sm-'
const COUNT = 30
/** Pictures 28 and 29 get no vector; pictures 0 and 1 share one (one dot, two pictures). */
const WITH_VECTORS = 28
const DIR = 'v4-stylemap'
const SHOTS = path.join(repoRoot, 'artifacts', 'v4-stylemap')

test.beforeAll(() => {
  seedImages({ prefix: PREFIX, token: TOKEN, count: COUNT, dir: DIR })
  const backend = path.join(repoRoot, 'backend')
  runBackendScript(`
import sqlite3, sys
import numpy as np
sys.path.insert(0, ${JSON.stringify(backend)})
from csd_weights import CSD_MODEL_VERSION
from db_style_vectors import pack_style_vector
rng = np.random.default_rng(7)
centers = rng.normal(size=(3, 256))
with sqlite3.connect(${JSON.stringify(dbPath)}) as conn:
    ids = [r[0] for r in conn.execute("SELECT id FROM images WHERE filename LIKE ? AND filename NOT LIKE ? ORDER BY filename", (${JSON.stringify(PREFIX)} + "%", "%sentinel%"))]
    conn.execute("DELETE FROM image_style_vectors WHERE image_id IN (%s)" % ",".join("?" * len(ids)), ids)
    shared = None
    for i, image_id in enumerate(ids[:${WITH_VECTORS}]):
        if i == 1:
            v = shared
        else:
            v = centers[i % 3] + rng.normal(scale=1.5, size=256)
            v = v / np.linalg.norm(v)
        if i == 0:
            shared = v
        blob, dim, dtype = pack_style_vector(v)
        conn.execute(
            "INSERT INTO image_style_vectors (image_id, space, model_version, content_fingerprint, dim, dtype, vector) VALUES (?, 'csd', ?, 'e2e', ?, ?, ?)",
            (image_id, CSD_MODEL_VERSION, dim, dtype, blob),
        )
    conn.commit()
print("ok")
`)
})

/** Batches this spec made (named with the prefix, or remembered by id), also ones an interrupted run left. */
const madeBatches = new Set<number>()

test.afterAll(async ({ request }) => {
  const listed = (await (await request.get('/api/batches', { headers: { 'X-SD-Library-Id': 'main' } })).json()) as { batches: { id: number; name: string; project_revision?: number | null }[] }
  for (const batch of listed.batches.filter((b) => b.name.startsWith(PREFIX) || madeBatches.has(b.id))) {
    const revision = batch.project_revision ? `?expected_project_revision=${batch.project_revision}` : ''
    await request.delete(`/api/batches/${batch.id}${revision}`, { headers: { 'X-SD-Library-Id': 'main' } })
  }
  cleanupImages(PREFIX, [DIR])
})

interface OpenOptions {
  lang?: 'en' | 'zh-CN'
  space?: 'kaloscope' | 'clip' | 'csd'
  /** The library search the map draws (the seeded token by default). */
  query?: string
  route?: string
  base?: '/vopus/' | '/next/'
}

/** Open the Style Map on the seeded pictures (the library search is the map's scope). */
async function openMap(page: Page, { lang = 'en', space = 'csd', query = TOKEN, route = '#/tools/stylemap', base = '/vopus/' }: OpenOptions = {}) {
  await markModelsReady(page, ['wd14', 'artist', 'csd', 'clip'])
  await page.addInitScript(
    ({ lang, space, query }) => {
      const flag = 'v4sm-init'
      if (sessionStorage.getItem(flag)) return
      sessionStorage.setItem(flag, '1')
      localStorage.setItem('sd-image-sorter-lang', lang)
      localStorage.setItem('sd-v4-theme', 'dark')
      localStorage.setItem('sd-v4-update-autocheck', '0')
      localStorage.setItem('sd-stylemap-space', space)
      localStorage.removeItem('sd-stylemap-landmarks')
      localStorage.removeItem('sd-stylemap-axis-labels')
      localStorage.setItem('sd-v4-browse', JSON.stringify(query ? { main: { queryText: query, scope: { generators: [], folder: null, favorites: false } } } : {}))
    },
    { lang, space, query },
  )
  const res = await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V Opus is not built: run npm run build in frontend-v4').toBe(200)
  if (route.includes('stylemap')) await expect(page.getByTestId('stylemap-page')).toBeVisible()
}

const canvas = (page: Page) => page.getByTestId('stylemap-canvas')

/** Wait until the scene drew `count` dots. */
async function expectDots(page: Page, count: number) {
  await expect(canvas(page)).toHaveAttribute('data-points', String(count), { timeout: 20_000 })
}

/** Hide the region landmarks: a drag or a click must land on the canvas, not on a card. */
async function landmarksOff(page: Page) {
  const marks = page.getByTestId('stylemap-landmarks-toggle')
  if ((await marks.getAttribute('aria-pressed')) === 'true') await marks.click()
  await expect(page.getByTestId('stylemap-landmark')).toHaveCount(0)
}

/**
 * A real left-drag over the whole canvas: a box (corner to corner) or a lasso
 * loop around it. With `shift` the Shift key is held down for the whole drag.
 * The drawn shape is checked while the button is still down.
 */
async function dragOverMap(page: Page, shape: 'box' | 'lasso', shift = false) {
  const box = (await canvas(page).boundingBox())!
  const m = 8
  const at = (u: number, v: number) => [box.x + m + u * (box.width - 2 * m), box.y + m + v * (box.height - 2 * m)] as const
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(...at(0, 0))
  await page.mouse.down()
  const path = shape === 'box' ? [[0.5, 0.5], [1, 1]] : [[0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5], [0, 0.02]]
  for (const [u, v] of path) await page.mouse.move(...at(u!, v!), { steps: 5 })
  await expect(page.getByTestId('stylemap-pick-shape')).toHaveAttribute('data-shape', shape)
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
  await expect(page.getByTestId('stylemap-pick-shape')).toHaveCount(0)
}

/** Turn the camera to a seeded picture: its dot ends in the middle of the canvas (returned). */
async function centreOn(page: Page, name: string): Promise<[number, number]> {
  const input = page.getByTestId('stylemap-locate-input')
  await input.fill(name)
  await expect(page.getByTestId('stylemap-locate-row')).toHaveCount(1)
  await expect(page.getByTestId('stylemap-locate-row')).toContainText(name)
  await input.press('Enter')
  await expect(page.getByTestId('stylemap-locate-pop')).toHaveCount(0)
  await input.blur()
  await page.waitForTimeout(600)
  const box = (await canvas(page).boundingBox())!
  return [box.x + box.width / 2, box.y + box.height / 2]
}

/** Shift + click: one dot in or out of the pick. */
async function shiftClick(page: Page, [x, y]: [number, number]) {
  await page.keyboard.down('Shift')
  await page.mouse.click(x, y)
  await page.keyboard.up('Shift')
}

/** The seeded pictures' ids by file name. */
async function seededIds(page: Page): Promise<Record<string, number>> {
  const res = await page.request.get(`/api/images?search=${TOKEN}&limit=100&sort_by=newest`, { headers: { 'X-SD-Library-Id': 'main' } })
  const body = (await res.json()) as { images: { id: number; filename: string }[] }
  return Object.fromEntries(body.images.map((img) => [img.filename, img.id]))
}

test('opens from the Tools menu; each space says what it does and offers its own index', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page, { space: 'kaloscope', route: '#/library' })
  await page.getByTestId('tools-menu').click()
  await page.locator('[data-item="tool-stylemap"]').click()
  await expect(page).toHaveURL(/#\/tools\/stylemap$/)
  await expect(page.getByTestId('stylemap-page')).toBeVisible()

  // Kaloscope: nothing indexed for it yet, so the start card offers the style index.
  await expect(page.getByTestId('stylemap-space-kaloscope')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('stylemap-empty')).toContainText('Build the style index first')
  await expect(page.getByTestId('stylemap-empty-build')).toHaveText('Build style index')
  await expect(page.getByTestId('stylemap-space-what')).toContainText('Kaloscope')
  await expect(page.getByTestId('stylemap-scope')).toContainText(`${COUNT} pictures in the current library filter, ${COUNT} without style data yet.`)

  // CLIP: the similarity index (the seeded rows have no embedding).
  await page.getByTestId('stylemap-space-clip').click()
  await expect(page.getByTestId('stylemap-empty')).toContainText('The similarity index is empty')
  await expect(page.getByTestId('stylemap-empty-similar')).toHaveText('Build similarity index')
  await expect(page.getByTestId('stylemap-space-what')).toContainText('CLIP')

  // CSD: the seeded vectors draw the map (28 pictures, two of them on one dot).
  await page.getByTestId('stylemap-space-csd').click()
  await expectDots(page, WITH_VECTORS - 1)
  await expect(page.getByTestId('stylemap-empty')).toHaveCount(0)
  await expect(page.getByTestId('stylemap-scope')).toContainText(`${COUNT} pictures in the current library filter, 2 without style data yet.`)
  await expect(page.getByTestId('stylemap-build')).toHaveText('Build CSD index')
  await expect(page.getByTestId('stylemap-space-what')).toContainText('CSD')
  expect(await page.evaluate(() => localStorage.getItem('sd-stylemap-space'))).toBe('csd')

  // The map is the library filter; "Map the whole library" clears it (the library shows everything too).
  await expect(page.getByTestId('stylemap-whole-library')).toBeVisible()
  await page.screenshot({ path: path.join(SHOTS, 'map-1920.png') })
})

test('the map: dot colours with a legend, the layout line, axis meanings, labels and landmarks, reset view', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  // The seeded pictures have no WD14 tags, so the real answer names no axis: this one names the X axis.
  const xIds = Object.values(await seededIds(page)).slice(0, 3)
  await page.route('**/api/style-map/axes**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        axes: {
          x: { low: { representatives: xIds.slice(0, 2), tags: [{ tag: 'monochrome' }] }, high: { representatives: xIds.slice(2, 3), tags: [{ tag: 'colorful' }, { tag: 'flat_color' }] }, weak: false },
          y: { low: { representatives: [], tags: [] }, high: { representatives: [], tags: [] }, weak: true },
          z: { low: { representatives: [], tags: [] }, high: { representatives: [], tags: [] }, weak: true },
        },
      },
    }),
  )
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)

  // Coloured by generator: every seeded picture is NovelAI (the legend counts dots).
  const legend = page.getByTestId('stylemap-legend')
  await expect(legend).toContainText('NovelAI')
  await expect(legend).toContainText(String(WITH_VECTORS - 1))
  await page.getByTestId('stylemap-color-by').selectOption('aesthetic_score')
  await expect(legend).toContainText('No scores yet')
  expect(await page.evaluate(() => localStorage.getItem('sd-stylemap-color-by'))).toBe('aesthetic_score')
  await page.getByTestId('stylemap-color-by').selectOption('generator')
  await expect(legend).toContainText('NovelAI')

  // UMAP is not installed in the test environment: the quick layout, with the install offer.
  await expect(page.getByTestId('stylemap-layout')).toContainText('UMAP not installed')
  await expect(page.getByTestId('stylemap-install-umap')).toHaveText('Install UMAP (~90 MB)')

  // Axis meanings: the card opens and closes with its button, and Esc closes only the card.
  const toggle = page.getByTestId('stylemap-axes-toggle')
  await toggle.click()
  await expect(page.getByTestId('stylemap-axes-panel')).toBeVisible()
  await expect(toggle).toHaveText('Hide axis meanings')
  await expect(page.getByTestId('stylemap-axes-panel')).toContainText('X axis')
  await expect(page.getByTestId('stylemap-axes-panel')).toContainText('colorful · flat color')
  await expect(page.getByTestId('stylemap-axes-thumb')).toHaveCount(3)
  await page.getByTestId('stylemap-axes-thumb').first().click()
  await expect(page.getByTestId('stylemap-preview-img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('stylemap-axes-panel')).toHaveCount(0)
  await expect(page.getByTestId('stylemap-page')).toBeVisible()
  await expect(toggle).toHaveText('Axis meanings')

  // Axis labels on the grid: on by default, the switch says what it will do and is remembered.
  const labels = page.getByTestId('stylemap-labels-toggle')
  await expect(page.getByTestId('stylemap-axis-labels')).toContainText('monochrome')
  await expect(labels).toHaveText('Hide axis labels')
  await labels.click()
  await expect(labels).toHaveText('Show axis labels')
  await expect(page.getByTestId('stylemap-axis-labels')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('sd-stylemap-axis-labels'))).toBe('off')
  await labels.click()
  await expect(page.getByTestId('stylemap-axis-labels')).toBeAttached()

  // Region landmarks: cards with a picture each; the switch hides and shows them.
  const marks = page.getByTestId('stylemap-landmarks-toggle')
  await expect(page.getByTestId('stylemap-landmark').first()).toBeVisible({ timeout: 15_000 })
  await marks.click()
  await expect(marks).toHaveText('Show region landmarks')
  await expect(page.getByTestId('stylemap-landmark')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('sd-stylemap-landmarks'))).toBe('off')
  await marks.click()
  await expect(page.getByTestId('stylemap-landmark').first()).toBeVisible()

  // Orbit, then reset: the dots stay drawn and nothing broke.
  const box = (await canvas(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 40, { steps: 8 })
  await page.mouse.up()
  await page.getByTestId('stylemap-reset-view').click()
  await expectDots(page, WITH_VECTORS - 1)
})

test('UMAP installs with one click, as a job, and the map is laid out again', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const prepared: unknown[] = []
  let refreshed = 0
  await page.route('**/api/models/prepare', async (route) => {
    prepared.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: 'started', model_id: 'style-map-umap', run_id: 4242 } })
  })
  await page.route('**/api/models/download-progress', (route) =>
    route.fulfill({ json: { active: false, prepare_result: { run_id: 4242, active: false, status: 'ok', model_id: 'style-map-umap', message: 'ready' } } }),
  )
  page.on('request', (req) => {
    if (req.url().includes('/api/style-map/points') && req.url().includes('refresh=true')) refreshed += 1
  })
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)
  await page.getByTestId('stylemap-install-umap').click()
  await expect.poll(() => prepared).toEqual([{ model_id: 'style-map-umap', variant: null }])
  await expect.poll(() => refreshed, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('jobs-drawer')).toContainText('UMAP')
})

test('find a picture: it is ringed and previewed; pointing at its dot previews it, a click opens it, Esc closes only the picture', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)
  const ids = await seededIds(page)
  const name = `${PREFIX}07.png`

  const input = page.getByTestId('stylemap-locate-input')
  await input.fill(name)
  const row = page.getByTestId('stylemap-locate-row')
  await expect(row).toHaveCount(1)
  await expect(page.getByTestId('stylemap-locate-pop')).toContainText('1 match on this map')
  await page.screenshot({ path: path.join(SHOTS, 'locate.png') })
  await input.press('Enter')
  await expect(page.getByTestId('stylemap-locate-pop')).toHaveCount(0)
  await expect(canvas(page)).toHaveAttribute('data-rings', 'query')
  await expect(page.getByTestId('stylemap-preview-img')).toHaveAttribute('data-id', String(ids[name]))

  // The camera turned to the dot, so it sits in the middle of the canvas: point at it.
  await page.waitForTimeout(600)
  const box = (await canvas(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2 - 3)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(canvas(page)).toHaveAttribute('data-hovered', String(ids[name]))
  await expect(page.getByTestId('stylemap-preview')).toContainText(name)

  // A click opens it in the lightbox; Esc closes the lightbox and stays on the map.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(page.getByTestId('stylemap-page')).toBeVisible()

  // Clearing the box removes the ring.
  await page.getByTestId('stylemap-locate-clear').click()
  await expect(input).toHaveValue('')
  await expect(canvas(page)).toHaveAttribute('data-rings', '')

  // What the box does not understand is said; a name that matches nothing says so.
  await input.fill('nosuchpicture-zz.png')
  await expect(page.getByTestId('stylemap-locate-pop')).toContainText('No picture on this map matches.')

  // Enter right after typing another name goes to that picture, never to the answer still listed for the old text.
  await input.fill(`${PREFIX}03.png`)
  await expect(row).toContainText(`${PREFIX}03.png`)
  await input.fill(`${PREFIX}09.png`)
  await input.press('Enter')
  await expect(page.getByTestId('stylemap-locate-pop')).toHaveCount(0)
  await expect(page.getByTestId('stylemap-preview-img')).toHaveAttribute('data-id', String(ids[`${PREFIX}09.png`]))
})

test('nearest pictures of a library picture sent from the library, with a clear', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page, { route: '#/library' })
  await page.getByTestId('query-input').fill(`${TOKEN}`)
  await page.getByTestId('query-input').press('Enter')
  const tile = page.getByTestId('tile').first()
  await expect(tile).toBeVisible()
  await tile.click({ button: 'right' })
  await page.getByTestId('card-menu').locator('[data-item="send-to"]').hover()
  await page.locator('[data-ctx-sub] [data-item="send-stylemap"]').click()
  await expect(page).toHaveURL(/#\/tools\/stylemap$/)

  const list = page.getByTestId('stylemap-near-list')
  await expect(list).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('stylemap-near-query')).toContainText('This picture')
  await expect(page.getByTestId('stylemap-near-row').first()).toBeVisible()
  await expect(canvas(page)).toHaveAttribute('data-rings', /query/)
  await expect(canvas(page)).toHaveAttribute('data-rings', /near/)
  await page.getByTestId('stylemap-near-row').first().click()
  await expect(page.getByTestId('stylemap-near-row').first()).toHaveAttribute('aria-current', 'true')
  await page.screenshot({ path: path.join(SHOTS, 'near.png') })

  await page.getByTestId('stylemap-near-clear').click()
  await expect(list).toHaveCount(0)
  await expect(canvas(page)).toHaveAttribute('data-rings', '')
  await expect(page.getByTestId('stylemap-near-drop')).toContainText('Drop a picture here')
})

test('the index job: build, pause, resume and cancel on the page and in the Jobs drawer; a failure says why', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const state = { running: false, paused: false, step: 'idle', processed: 0, total: 2, written: 0, errors: 0, message: '' }
  const calls: string[] = []
  await page.route('**/api/style-map/vectors/**', async (route) => {
    const url = route.request().url()
    const action = url.split('/vectors/')[1]!.split('?')[0]!
    calls.push(action)
    if (action === 'start') {
      Object.assign(state, { running: true, paused: false, step: 'extracting', processed: 1 })
      return route.fulfill({ json: { status: 'started', total: 2, space: 'csd' } })
    }
    if (action === 'pause') state.paused = true
    if (action === 'resume') state.paused = false
    if (action === 'cancel') Object.assign(state, { running: false, paused: false, step: 'cancelled' })
    if (action === 'progress') return route.fulfill({ json: { ...state, space: 'csd' } })
    return route.fulfill({ json: { status: 'ok' } })
  })
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)
  await page.getByTestId('stylemap-build').click()
  const progress = page.getByTestId('stylemap-index-progress')
  await expect(progress).toContainText('Building the style index: 1 / 2')
  expect(calls).toContain('start')

  await page.getByTestId('stylemap-index-pause').click()
  await expect(progress).toContainText('paused')
  await expect(page.getByTestId('stylemap-index-pause')).toHaveText('Resume')
  // The same job in the drawer, paused there too.
  await page.getByTestId('jobs-button').click()
  await expect(page.getByTestId('job-pause')).toHaveText('Resume')
  await page.screenshot({ path: path.join(SHOTS, 'index-paused.png') })
  await page.getByTestId('job-pause').click()
  await expect(page.getByTestId('stylemap-index-pause')).toHaveText('Pause')
  await page.keyboard.press('Escape')

  await page.getByTestId('stylemap-index-cancel').click()
  await expect(page.getByTestId('stylemap-index-result')).toContainText('Stopped', { timeout: 10_000 })
  expect(calls).toEqual(expect.arrayContaining(['pause', 'resume', 'cancel']))

  // A run that fails as a whole says the reason, not "0 added".
  await page.getByTestId('stylemap-index-result').getByRole('button').click()
  Object.assign(state, { running: false, step: 'idle', processed: 0 })
  await page.unroute('**/api/style-map/vectors/**')
  await page.route('**/api/style-map/vectors/**', async (route) => {
    const action = route.request().url().split('/vectors/')[1]!.split('?')[0]!
    if (action === 'start') {
      Object.assign(state, { running: true, step: 'loading_runtime' })
      return route.fulfill({ json: { status: 'started', total: 2, space: 'csd' } })
    }
    if (action === 'progress') {
      const answer = { ...state, space: 'csd' }
      Object.assign(state, { running: false, step: 'error', message: 'The CSD model is not downloaded.' })
      return route.fulfill({ json: answer })
    }
    return route.fulfill({ json: { status: 'ok' } })
  })
  await page.getByTestId('stylemap-build').click()
  await expect(page.getByTestId('stylemap-index-result')).toContainText('The CSD model is not downloaded.', { timeout: 10_000 })
})

test('Chinese: the page, the start card and the switches read in Chinese', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page, { lang: 'zh-CN', space: 'kaloscope' })
  await expect(page.getByTestId('tool-page')).toContainText('画风地图')
  await expect(page.getByTestId('stylemap-empty')).toContainText('先建立画风索引')
  await expect(page.getByTestId('stylemap-empty-build')).toHaveText('建立画风索引')
  await page.getByTestId('stylemap-space-csd').click()
  await expectDots(page, WITH_VECTORS - 1)
  await expect(page.getByTestId('stylemap-labels-toggle')).toHaveText('隐藏轴标签')
  await expect(page.getByTestId('stylemap-landmarks-toggle')).toHaveText('隐藏区域标记')
  await expect(page.getByTestId('stylemap-axes-toggle')).toHaveText('轴的含义')
  await expect(page.getByTestId('stylemap-scope')).toContainText('2 张还没有画风数据')
  await expect(page.getByTestId('stylemap-build')).toHaveText('建立 CSD 索引')
  await page.screenshot({ path: path.join(SHOTS, 'map-zh-1920.png') })
})

test('/next/: the Style Map place opens the same tool', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page, { base: '/next/', route: '#/library' })
  await page.getByTestId('next-place-stylemap').click()
  await expect(page).toHaveURL(/\/next\/#\/tools\/stylemap$/)
  await expectDots(page, WITH_VECTORS - 1)
  await expect(page.getByTestId('next-place-stylemap')).toHaveAttribute('aria-current', 'page')
})

test('picking dots: Shift + drag boxes, the lasso draws around, a click toggles one; every picture behind a dot counts; Esc clears; a redrawn map keeps the picks', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const members: unknown[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/style-map/members')) members.push(req.postDataJSON())
  })
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)
  await landmarksOff(page)
  await expect(page.getByTestId('stylemap-drag-rotate')).toHaveAttribute('aria-checked', 'true')
  await expect(canvas(page)).toHaveAttribute('data-drag', 'rotate')

  // Shift + drag a box over the whole map: every dot, and the dot two pictures share brings its second one.
  await dragOverMap(page, 'box', true)
  const count = page.getByTestId('stylemap-selbar-count')
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS))
  await expect(count).toHaveText(`${WITH_VECTORS} picked`)
  await expect(canvas(page)).toHaveAttribute('data-picked', String(WITH_VECTORS - 1))
  expect(members).toHaveLength(1)
  await page.screenshot({ path: path.join(SHOTS, 'picked-box.png') })

  // Esc clears the pick (nothing floats above the map).
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('stylemap-selbar')).toHaveCount(0)
  await expect(canvas(page)).toHaveAttribute('data-picked', '0')

  // The lasso: a plain drag around the dots once it is chosen.
  await page.getByTestId('stylemap-drag-lasso').click()
  await expect(page.getByTestId('stylemap-drag-lasso')).toHaveAttribute('aria-checked', 'true')
  await expect(canvas(page)).toHaveAttribute('data-drag', 'lasso')
  await dragOverMap(page, 'lasso')
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS))

  // A click on a dot (lasso chosen) takes that dot out; with Turn chosen, Shift + click puts it back.
  const dot = await centreOn(page, `${PREFIX}07.png`)
  await page.mouse.click(...dot)
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS - 1))
  await expect(canvas(page)).toHaveAttribute('data-picked', String(WITH_VECTORS - 2))
  await page.getByTestId('stylemap-drag-rotate').click()
  await shiftClick(page, dot)
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS))
  await expect(page.getByTestId('lightbox')).toHaveCount(0)

  // Another space and back: the map is drawn again and the picks still on it stay picked.
  await page.getByTestId('stylemap-space-kaloscope').click()
  await expect(page.getByTestId('stylemap-empty')).toBeVisible()
  await page.getByTestId('stylemap-space-csd').click()
  await expectDots(page, WITH_VECTORS - 1)
  await expect(canvas(page)).toHaveAttribute('data-picked', String(WITH_VECTORS - 1))
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS))

  await page.getByTestId('stylemap-sel-clear').click()
  await expect(page.getByTestId('stylemap-selbar')).toHaveCount(0)
})

test('the pick goes to a new batch, a dataset batch, the Library (exactly those pictures, then everything again) and Censor', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)
  await landmarksOff(page)
  await dragOverMap(page, 'box', true)
  const count = page.getByTestId('stylemap-selbar-count')
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS))
  const picked = new Set(Object.entries(await seededIds(page)).filter(([name]) => !/2[89]\.png$/.test(name)).map(([, id]) => id))
  const batchByName = async (name: string) => {
    const listed = (await (await page.request.get('/api/batches', { headers: { 'X-SD-Library-Id': 'main' } })).json()) as { batches: { id: number; name: string; kind: string }[] }
    return listed.batches.find((b) => b.name === name) ?? null
  }
  const itemsOf = async (id: number) => {
    const batch = (await (await page.request.get(`/api/batches/${id}`, { headers: { 'X-SD-Library-Id': 'main' } })).json()) as { kind: string; item_count: number; items: { image_id: number }[] }
    return { kind: batch.kind, count: batch.item_count, ids: new Set(batch.items.map((i) => i.image_id)) }
  }

  // Add to batch ▸ New ▸ custom: the library's own batch menu and dialog, and the map stays on screen.
  await page.getByTestId('stylemap-sel-batch').click()
  await expect(page.locator('[data-item="batch-new-dataset"]')).toBeVisible()
  await page.locator('[data-item="batch-new-custom"]').click()
  await expect(page.getByTestId('batch-create-dialog')).toBeVisible()
  await page.getByTestId('batch-name-input').fill(`${PREFIX}batch`)
  await expect(page.getByTestId('batch-create-ok')).toContainText(String(WITH_VECTORS))
  await page.getByTestId('batch-create-ok').click()
  await expect(page.getByTestId('batch-create-dialog')).toHaveCount(0)
  await expect.poll(async () => (await batchByName(`${PREFIX}batch`))?.id ?? 0).toBeGreaterThan(0)
  const custom = (await batchByName(`${PREFIX}batch`))!
  expect((await itemsOf(custom.id)).ids).toEqual(picked)
  await expect(page.getByTestId('stylemap-page')).toBeVisible()

  // Dataset batch: a new dataset batch made of the same pictures.
  await page.getByTestId('stylemap-sel-dataset').click()
  await expect(page.getByTestId('batch-create-dialog')).toContainText('dataset')
  await page.getByTestId('batch-name-input').fill(`${PREFIX}dataset`)
  await page.getByTestId('batch-create-ok').click()
  await expect.poll(async () => (await batchByName(`${PREFIX}dataset`))?.id ?? 0).toBeGreaterThan(0)
  const dataset = (await batchByName(`${PREFIX}dataset`))!
  // A dataset batch keeps its pictures in its dataset project: the batch says how many.
  const datasetItems = await itemsOf(dataset.id)
  expect(datasetItems.kind).toBe('dataset')
  expect(datasetItems.count).toBe(WITH_VECTORS)

  // The Library shows exactly these pictures, under a banner; Esc gives the whole search back.
  const pinned = page.waitForResponse((res) => res.url().includes('/api/images?') && res.url().includes('collection_id='))
  await page.getByTestId('stylemap-sel-library').click()
  await expect(page).toHaveURL(/#\/library$/)
  const answer = (await (await pinned).json()) as { total: number; images: { id: number }[] }
  expect(answer.total).toBe(WITH_VECTORS)
  expect(new Set(answer.images.map((img) => img.id))).toEqual(picked)
  await expect(page.getByTestId('pinned-banner')).toContainText(`${WITH_VECTORS} pictures from the Style Map`)
  await page.screenshot({ path: path.join(SHOTS, 'library-pinned.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pinned-banner')).toHaveCount(0)
  await expect(page.getByTestId('query-input')).toHaveValue(TOKEN)

  // Back on the map the pick is still there; Show in Library again, and the banner's button is the way back too.
  await page.getByTestId('tools-menu').click()
  await page.locator('[data-item="tool-stylemap"]').click()
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS), { timeout: 20_000 })
  await page.getByTestId('stylemap-sel-library').click()
  await expect(page.getByTestId('pinned-banner')).toBeVisible()
  await page.getByTestId('pinned-back').click()
  await expect(page.getByTestId('pinned-banner')).toHaveCount(0)
  await expect(page.getByTestId('query-input')).toHaveValue(TOKEN)

  // Censor: a quick censor batch of these pictures, opened on its censor step.
  await page.getByTestId('tools-menu').click()
  await page.locator('[data-item="tool-stylemap"]').click()
  await expect(count).toHaveAttribute('data-count', String(WITH_VECTORS), { timeout: 20_000 })
  await page.getByTestId('stylemap-sel-censor').click()
  await expect(page).toHaveURL(/#\/batch\/\d+$/, { timeout: 20_000 })
  const censorId = Number(/#\/batch\/(\d+)$/.exec(page.url())![1])
  madeBatches.add(censorId)
  expect((await itemsOf(censorId)).ids).toEqual(picked)
})

test('My axes: example pictures from the pick, named ends, Apply lays the map out along them and is kept; Back restores the model layout', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const ids = await seededIds(page)
  const sent: { axes: Record<string, { a: number[]; b: number[] }>; map_id: string; layout: string }[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/style-map/custom-axes')) sent.push(req.postDataJSON())
  })
  await openMap(page)
  await expectDots(page, WITH_VECTORS - 1)
  await landmarksOff(page)
  await page.getByTestId('stylemap-axes-toggle').click()
  await page.getByTestId('stylemap-axes-tab-custom').click()
  await expect(page.getByTestId('stylemap-axes-tab-custom')).toHaveAttribute('aria-selected', 'true')
  const add = (end: 'a' | 'b') => page.locator(`[data-testid="stylemap-custom-add"][data-axis="x"][data-end="${end}"]`)
  const chips = (end: 'a' | 'b') => page.locator(`[data-testid="stylemap-custom-axis"][data-axis="x"] [data-end="${end}"] [data-testid="stylemap-custom-chip"]`)
  await expect(add('a')).toBeDisabled()
  await expect(page.getByTestId('stylemap-custom-apply')).toBeDisabled()
  await expect(page.getByTestId('stylemap-custom-open-y')).toBeVisible()

  // End A: pictures 02 and 05, picked by Shift + click on their dots; end B: 03 and 06.
  for (const [end, names] of [['a', ['02', '05']], ['b', ['03', '06']]] as const) {
    for (const n of names) await shiftClick(page, await centreOn(page, `${PREFIX}${n}.png`))
    await expect(page.getByTestId('stylemap-selbar-count')).toHaveAttribute('data-count', '2')
    await add(end).click()
    await expect(chips(end)).toHaveCount(2)
    await page.getByTestId('stylemap-sel-clear').click()
  }
  const name = (end: 'a' | 'b') => page.locator(`[data-testid="stylemap-custom-name"][data-axis="x"][data-end="${end}"]`)
  await name('a').fill('thick paint')
  await name('b').fill('flat colour')

  // Apply: the real backend lays every dot out along the axis; the labels on the grid carry the names.
  await page.getByTestId('stylemap-custom-apply').click()
  const card = page.getByTestId('stylemap-canvas-card')
  await expect(card).toHaveAttribute('data-custom', 'true', { timeout: 20_000 })
  expect(sent.at(-1)?.axes).toEqual({ x: { a: [ids[`${PREFIX}02.png`], ids[`${PREFIX}05.png`]], b: [ids[`${PREFIX}03.png`], ids[`${PREFIX}06.png`]] } })
  await expect(page.getByTestId('stylemap-custom-note').first()).toBeVisible()
  await expect(page.getByTestId('stylemap-custom')).toContainText('Applied: the map is laid out along your axes')
  await expect(page.getByTestId('stylemap-axis-labels')).toContainText('thick paint')
  await expect(page.getByTestId('stylemap-axis-labels')).toContainText('flat colour')
  await expectDots(page, WITH_VECTORS - 1)
  await page.screenshot({ path: path.join(SHOTS, 'my-axes.png') })

  // While the user's axes are on, the model's meanings and the region landmarks are hidden.
  await page.getByTestId('stylemap-axes-tab-model').click()
  await expect(page.getByTestId('stylemap-axes-hidden')).toContainText('Your own axes are on')
  await page.getByTestId('stylemap-landmarks-toggle').click()
  await expect(page.getByTestId('stylemap-landmarks-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('stylemap-landmark')).toHaveCount(0)

  // Kept per library in this browser, in the classic page's format: a reload lays the map out again.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sd-stylemap-custom-axes:main') ?? 'null'))
  expect(stored).toMatchObject({ v: 1, applied: true, axes: { x: { nameA: 'thick paint', nameB: 'flat colour' } } })
  await page.reload()
  await expect(page.getByTestId('stylemap-canvas-card')).toHaveAttribute('data-custom', 'true', { timeout: 20_000 })

  // Back to the model layout: the landmarks and the model's meanings return.
  await page.getByTestId('stylemap-axes-toggle').click()
  await page.getByTestId('stylemap-axes-tab-custom').click()
  await expect(chips('a')).toHaveCount(2)
  await page.getByTestId('stylemap-custom-revert').click()
  await expect(page.getByTestId('stylemap-canvas-card')).not.toHaveAttribute('data-custom', 'true')
  await expect(page.getByTestId('stylemap-landmark').first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('stylemap-axes-tab-model').click()
  await expect(page.getByTestId('stylemap-axes-hidden')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sd-stylemap-custom-axes:main') ?? 'null')?.applied)).toBe(false)

  // Removing a picture: the end shows one, and Apply says why it cannot run.
  await page.getByTestId('stylemap-axes-tab-custom').click()
  await chips('a').first().getByTestId('stylemap-custom-remove').click()
  await expect(chips('a')).toHaveCount(1)
  await expect(page.getByTestId('stylemap-custom-apply')).toBeDisabled()
  await expect(page.getByTestId('stylemap-custom')).toContainText('Each end needs at least 2 pictures')
})

test('the picture window has a Style Map button (V Opus and /next/): the map turns to the picture and lists the pictures most like it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const ids = await seededIds(page)
  const id = ids[`${PREFIX}04.png`]!
  await openMap(page, { route: '#/library' })
  const tile = page.locator(`[data-testid="tile"][data-id="${id}"]`)
  await tile.dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.getByTestId('lightbox-stylemap').click()
  await expect(page).toHaveURL(/#\/tools\/stylemap$/)
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(page.getByTestId('stylemap-near-query')).toContainText('This picture', { timeout: 20_000 })
  await expect(page.getByTestId('stylemap-preview-img')).toHaveAttribute('data-id', String(id))

  // The map's own picture window: the button turns the map to that picture instead.
  const row = page.getByTestId('stylemap-near-row').first()
  const other = Number(await row.getAttribute('data-id'))
  await row.dblclick()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.getByTestId('lightbox-stylemap').click()
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
  await expect(page.getByTestId('stylemap-preview-img')).toHaveAttribute('data-id', String(other), { timeout: 20_000 })

  // /next/ shares the lightbox.
  await openMap(page, { base: '/next/', route: '#/library' })
  await page.locator(`[data-testid="tile"][data-id="${id}"]`).dblclick()
  await page.getByTestId('lightbox-stylemap').click()
  await expect(page).toHaveURL(/\/next\/#\/tools\/stylemap$/)
  await expect(page.getByTestId('stylemap-near-query')).toContainText('This picture', { timeout: 20_000 })
})

test('Chinese: the drag switch, the pick bar, the Library banner and My axes read in Chinese', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openMap(page, { lang: 'zh-CN' })
  await expectDots(page, WITH_VECTORS - 1)
  await landmarksOff(page)
  await expect(page.getByTestId('stylemap-drag')).toContainText('旋转')
  await expect(page.getByTestId('stylemap-drag-box')).toHaveText('框选')
  await expect(page.getByTestId('stylemap-drag-lasso')).toHaveText('套索')
  await dragOverMap(page, 'box', true)
  await expect(page.getByTestId('stylemap-selbar-count')).toHaveText(`已选 ${WITH_VECTORS} 张`)
  await expect(page.getByTestId('stylemap-sel-batch')).toContainText('加入批次')
  await expect(page.getByTestId('stylemap-sel-library')).toHaveText('在图库中查看')
  await expect(page.getByTestId('stylemap-sel-dataset')).toHaveText('数据集批次…')
  await page.getByTestId('stylemap-axes-toggle').click()
  await page.getByTestId('stylemap-axes-tab-custom').click()
  await expect(page.getByTestId('stylemap-axes-tab-custom')).toHaveText('我的轴')
  await expect(page.getByTestId('stylemap-custom')).toContainText('加入选中的图')
  await expect(page.getByTestId('stylemap-custom-apply')).toHaveText('应用')
  await page.screenshot({ path: path.join(SHOTS, 'picks-zh.png') })
  await page.getByTestId('stylemap-axes-close').click()
  await page.getByTestId('stylemap-sel-library').click()
  await expect(page.getByTestId('pinned-banner')).toContainText(`来自画风地图的 ${WITH_VECTORS} 张`)
  await expect(page.getByTestId('pinned-back')).toContainText('显示全部')
})

test('30,000 dots stay smooth: drawn, turned and pointed at without long frames', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const N = 30_000
  await page.route('**/api/style-map/points**', async (route) => {
    const points = Array.from({ length: N }, (_, i) => {
      const a = (i / N) * Math.PI * 24
      const r = 0.2 + (i % 997) / 1400
      return [i + 1, Math.round(Math.cos(a) * r * 1000) / 1000, Math.round(Math.sin(a * 0.7) * 0.6 * 1000) / 1000, Math.round(Math.sin(a) * r * 1000) / 1000, 1 + (i % 4 === 0 ? 1 : 0)]
    })
    await route.fulfill({ json: { status: 'ok', space: 'csd', method: 'pca', total_images: N, missing_vectors: 0, unlocatable: [], points_layout: ['id', 'x', 'y', 'z', 'members'], points, umap: { status: 'unavailable' }, map_id: 'f'.repeat(32) } })
  })
  await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'not_started' } }))
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', regions: [] } }))
  await page.route('**/api/style-map/axes**', (route) => route.fulfill({ json: { status: 'empty' } }))
  await openMap(page)
  const started = Date.now()
  await expectDots(page, N)
  const drawMs = Date.now() - started

  // Frame gaps while the map is turned and the pointer sweeps over the dots.
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[] }
    w.__gaps = []
    let last = performance.now()
    const tick = (now: number) => {
      w.__gaps.push(now - last)
      last = now
      if (w.__gaps.length < 400) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const box = (await canvas(page).boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 300, cy + 60, { steps: 30 })
  await page.mouse.up()
  for (let i = 0; i < 30; i += 1) await page.mouse.move(cx - 300 + i * 20, cy - 100 + i * 6)
  await page.waitForTimeout(500)
  const gaps = await page.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps.slice(1))
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  const perf = `30k dots: first draw ${drawMs} ms (request to dots), frame gap median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${gaps.length} frames (headless software WebGL)`
  test.info().annotations.push({ type: 'perf', description: perf })
  console.log(perf)
  // Software rendering in headless Chromium is far slower than a graphics card; the bar is "no frozen page".
  expect(p95).toBeLessThan(250)

  // A box over all 30,000 dots: every dot is picked and counted (a quarter stand for two pictures each).
  await page.route('**/api/style-map/members**', async (route) => {
    const body = route.request().postDataJSON() as { rep_ids: number[] }
    await route.fulfill({ json: { status: 'ok', ids: body.rep_ids.flatMap((id) => (id % 4 === 1 ? [id, id + 100_000] : [id])) } })
  })
  const picking = Date.now()
  await dragOverMap(page, 'box', true)
  await expect(page.getByTestId('stylemap-selbar-count')).toHaveAttribute('data-count', String(N + N / 4), { timeout: 20_000 })
  await expect(canvas(page)).toHaveAttribute('data-picked', String(N))
  const pickMs = Date.now() - picking
  test.info().annotations.push({ type: 'perf', description: `30k dots: box pick to counted bar ${pickMs} ms` })
  console.log(`30k dots: box pick to counted bar ${pickMs} ms`)
})

for (const viewport of VIEWPORTS) {
  for (const lang of ['en', 'zh-CN'] as const) {
    test(`Style Map fits at ${viewport.width}x${viewport.height} (${lang})`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openMap(page, { lang })
      await expectDots(page, WITH_VECTORS - 1)
      await expect(page.getByTestId('stylemap-landmark').first()).toBeVisible({ timeout: 15_000 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      for (const id of ['stylemap-space-csd', 'stylemap-color-by', 'stylemap-build', 'stylemap-locate-input', 'stylemap-drag-rotate', 'stylemap-drag-box', 'stylemap-drag-lasso', 'stylemap-axes-toggle', 'stylemap-labels-toggle', 'stylemap-landmarks-toggle', 'stylemap-reset-view', 'stylemap-near-drop']) {
        await expect(page.getByTestId(id), id).toBeInViewport({ ratio: 1 })
      }
      // Toolbar and bar rows: nothing spills out of its row or sits on its neighbour.
      const problems = await page.evaluate(() => {
        const out: string[] = []
        for (const row of document.querySelectorAll('[data-testid="stylemap-toolbar"], [data-testid="stylemap-toolbar"] + div')) {
          const r = row.getBoundingClientRect()
          const kids = [...row.children].map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0)
          for (const b of kids) if (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1) out.push(`child outside its row: ${JSON.stringify([b.left, b.right, r.left, r.right])}`)
          for (let i = 0; i < kids.length; i += 1)
            for (let j = i + 1; j < kids.length; j += 1) {
              const a = kids[i]!
              const b = kids[j]!
              if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`overlap ${i}/${j}`)
            }
          if (row.scrollWidth > row.clientWidth + 1) out.push('row scrolls sideways')
        }
        return out
      })
      expect(problems).toEqual([])
      await page.getByTestId('stylemap-axes-toggle').click()
      await expect(page.getByTestId('stylemap-axes-close')).toBeInViewport({ ratio: 1 })
      // My axes: the Apply and Back buttons stay in view at the foot of the card.
      await page.getByTestId('stylemap-axes-tab-custom').click()
      for (const id of ['stylemap-custom-apply', 'stylemap-custom-revert', 'stylemap-axes-tab-model']) await expect(page.getByTestId(id), id).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')

      // The pick bar: every button in view, none on another, and clear of "Reset view".
      await landmarksOff(page)
      await dragOverMap(page, 'box', true)
      await expect(page.getByTestId('stylemap-selbar-count')).toHaveAttribute('data-count', String(WITH_VECTORS))
      for (const id of ['stylemap-selbar-count', 'stylemap-sel-batch', 'stylemap-sel-censor', 'stylemap-sel-dataset', 'stylemap-sel-library', 'stylemap-sel-clear']) {
        await expect(page.getByTestId(id), id).toBeInViewport({ ratio: 1 })
      }
      const barProblems = await page.evaluate(() => {
        const out: string[] = []
        const bar = document.querySelector('[data-testid="stylemap-selbar"]')!.getBoundingClientRect()
        const card = document.querySelector('[data-testid="stylemap-canvas-card"]')!.getBoundingClientRect()
        const reset = document.querySelector('[data-testid="stylemap-reset-view"]')!.getBoundingClientRect()
        if (bar.left < card.left || bar.right > card.right) out.push('bar wider than the map')
        if (bar.left < reset.right && reset.left < bar.right && bar.top < reset.bottom && reset.top < bar.bottom) out.push('bar on Reset view')
        const kids = [...document.querySelectorAll('[data-testid="stylemap-selbar"] > *')].map((el) => el.getBoundingClientRect())
        for (let i = 0; i < kids.length; i += 1)
          for (let j = i + 1; j < kids.length; j += 1) {
            const a = kids[i]!
            const b = kids[j]!
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`bar overlap ${i}/${j}`)
          }
        return out
      })
      expect(barProblems).toEqual([])
      await page.screenshot({ path: path.join(SHOTS, `fits-${viewport.width}-${lang}.png`) })

      // The axis card and the pick bar together: the card stops above the bar, Apply stays in view.
      await page.getByTestId('stylemap-axes-toggle').click()
      await page.getByTestId('stylemap-axes-tab-custom').click()
      await page.getByTestId('stylemap-custom-open-y').click()
      await page.getByTestId('stylemap-custom-open-z').click()
      await expect(page.getByTestId('stylemap-custom-apply')).toBeInViewport({ ratio: 1 })
      const cardOverBar = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="stylemap-axes-panel"]')!.getBoundingClientRect()
        const bar = document.querySelector('[data-testid="stylemap-selbar"]')!.getBoundingClientRect()
        return card.bottom > bar.top && card.left < bar.right && bar.left < card.right
      })
      expect(cardOverBar).toBe(false)
    })
  }
}
