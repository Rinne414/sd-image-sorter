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

test.afterAll(() => {
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
})

for (const viewport of VIEWPORTS) {
  for (const lang of ['en', 'zh-CN'] as const) {
    test(`Style Map fits at ${viewport.width}x${viewport.height} (${lang})`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openMap(page, { lang })
      await expectDots(page, WITH_VECTORS - 1)
      await expect(page.getByTestId('stylemap-landmark').first()).toBeVisible({ timeout: 15_000 })
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
      for (const id of ['stylemap-space-csd', 'stylemap-color-by', 'stylemap-build', 'stylemap-locate-input', 'stylemap-axes-toggle', 'stylemap-labels-toggle', 'stylemap-landmarks-toggle', 'stylemap-reset-view', 'stylemap-near-drop']) {
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
      await page.keyboard.press('Escape')
      await page.screenshot({ path: path.join(SHOTS, `fits-${viewport.width}-${lang}.png`) })
    })
  }
}
