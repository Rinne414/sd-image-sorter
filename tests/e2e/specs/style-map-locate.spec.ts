import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map: find one picture (S4f) against mocked /api/*.
 *  - from the Gallery (context menu, image window) to the map: the camera turns
 *    to the picture's dot, a big ring marks it, the side card lists what is most
 *    like it; the exceptions (no style data, outside the filter, merged) are said
 *    in words with a button, never silently ignored;
 *  - the "Locate a picture" box: the Gallery search language, a debounced result
 *    list with thumbnails, keyboard (arrows, Enter, Esc), zero-result reasons;
 *  - the layout at 1366x768, 1920x1080 and 2560x1440.
 * Screenshots are written only when the folder <tmp>/sd-sorter-locate-shots exists.
 */

const MAP_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }
const SHOT_DIR = path.join(os.tmpdir(), 'sd-sorter-locate-shots')
const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#556"/></svg>'

function pointsBody(overrides: Record<string, unknown> = {}) {
  const points = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5, 1])
  return {
    status: 'ok', space: 'kaloscope', method: 'pca', model_version: 'kaloscope:test',
    total_images: 33, missing_vectors: 3, unlocatable: [], merged_away: 0,
    explained_variance: [0.05, 0.04, 0.03], points_layout: ['id', 'x', 'y', 'z', 'members'], points,
    umap: { status: 'unavailable', points: 30, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    map_id: MAP_ID, cached: false, ...overrides,
  }
}

function coord(id: number) {
  const i = id - 1
  return { x: (i % 5) / 4 - 0.5, y: (i % 7) / 6 - 0.5, z: (i % 3) / 2 - 0.5 }
}

const SELF_ID = 8

function nearBody(overrides: Record<string, unknown> = {}) {
  const rows: Array<[number, number, string]> = [
    [3, 0.91, 'near_a.png'], [12, 0.77, 'near_b_with_a_rather_long_file_name_that_must_not_wrap_in_the_list.png'],
    [5, 0.61, 'near_c.png'], [20, 0.2, 'far_a.png'],
  ]
  return {
    status: 'ok',
    query: coord(SELF_ID),
    self: { id: SELF_ID, filename: 'self_picture.png', in_filter: true, located: true, merged: false, ...coord(SELF_ID) },
    neighbors: rows.map(([id, score, filename]) => ({ id, score, filename, weak: score < 0.32, in_filter: true, located: true, merged: false, ...coord(id) })),
    weak_threshold: 0.32, model_version: 'kaloscope:test', ...overrides,
  }
}

function locateBody(overrides: Record<string, unknown> = {}) {
  const hits: Array<[number, string, boolean]> = [[7, 'blue_hair_girl.png', false], [14, 'blue_sky_far_away.png', false], [22, 'blue_twin_merged.png', true]]
  return {
    status: 'ok', space: 'kaloscope', total: 3, outside_filter: 0, without_data: 0,
    results: hits.map(([id, filename, merged]) => ({ id, filename, merged, ...coord(id) })), ...overrides,
  }
}

type Spy = { tokenBodies: any[]; locateBodies: any[]; nearUrls: string[]; vectorStarts: number; pointsCalls: number }

async function mockBase(page: Page, points = pointsBody()): Promise<Spy> {
  const spy: Spy = { tokenBodies: [], locateBodies: [], nearUrls: [], vectorStarts: 0, pointsCalls: 0 }
  await page.route('**/api/images/selection-token', (route) => {
    const body = route.request().postDataJSON() || {}
    spy.tokenBodies.push(body)
    const searching = Boolean(body.search) || (body.tags || []).length > 0 || (body.prompts || []).length > 0
    return route.fulfill({ json: { selection_token: searching ? 'tok.search' : 'tok.e2e', total_estimate: 33 } })
  })
  await page.route('**/api/style-map/vectors/progress', (route) =>
    route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } }))
  await page.route('**/api/style-map/vectors/start', (route) => {
    spy.vectorStarts += 1
    return route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/style-map/points**', (route) => {
    spy.pointsCalls += 1
    return route.fulfill({ json: points })
  })
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', method: 'pca', regions: [], cached: false } }))
  await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', by: 'generator', kind: 'category', ids: Array.from({ length: 30 }, (_, i) => i + 1), values: new Array(30).fill(0), legend: [{ key: 'nai', label: 'nai', count: 30 }], range: null, missing: 0 } }))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_SVG }))
  await page.route('**/api/image-file/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_SVG }))
  await page.route('**/api/images/*', (route) => {
    if (route.request().method() !== 'GET' || !/\/api\/images\/\d+$/.test(route.request().url())) return route.fallback()
    return route.fulfill({ json: { image: { filename: 'preview_name.png' } } })
  })
  await page.route('**/api/images?**', (route) => route.fulfill({
    json: {
      images: [SELF_ID, 3, 12].map((id) => ({ id, filename: `gallery_${id}.png`, path: `D:/pics/gallery_${id}.png`, prompt: `prompt ${id}` })),
      total: 3, has_more: false, next_cursor: null,
    },
  }))
  return spy
}

function watch(page: Page) {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })
  return { consoleErrors, httpErrors }
}

async function setup(page: Page, width: number, height: number, lang = 'en') {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
  await page.reload()
}

async function openMap(page: Page, width: number, height: number, lang = 'en') {
  await setup(page, width, height, lang)
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount()).toBe(30)
  return map
}

async function shot(page: Page, name: string) {
  if (fs.existsSync(SHOT_DIR)) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

const target = (page: Page) => page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())
const ringKinds = (page: Page) =>
  page.evaluate(() => (window as any).StyleMap._state.scene.rings.describe().map((r: any) => `${r.kind}:${r.visible}`))

async function expectCameraAt(page: Page, at: { x: number; y: number; z: number }) {
  await expect.poll(async () => {
    const t = await target(page)
    return Math.hypot(t[0] - at.x, t[1] - at.y, t[2] - at.z)
  }).toBeLessThan(0.01)
}

/** Nothing of the map toolbar or the side column overlaps, clips or overflows the page. */
async function layoutCheck(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.getBoundingClientRect() || null
    const subbar = rect('.stylemap-subbar')!
    const tools = rect('.stylemap-subbar-tools')!
    const scope = rect('#stylemap-scope')!
    const box = rect('#stylemap-locate')!
    const side = document.querySelector('.stylemap-side') as HTMLElement
    const pop = rect('#stylemap-locate-pop')
    const popVisible = !(document.querySelector('#stylemap-locate-pop') as HTMLElement).hidden
    const toolbar = document.querySelector('.stylemap-toolbar') as HTMLElement
    const buttons = [...document.querySelectorAll('.stylemap-subbar-tools > *')].map((node) => (node as HTMLElement).getBoundingClientRect()).filter((r) => r.width > 0)
    const overlaps = buttons.some((a, i) => buttons.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5))
    return {
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth + 1,
      subbarInside: tools.right <= subbar.right + 0.5 && box.left >= subbar.left,
      scopeClear: scope.right <= tools.left + 0.5,
      toolsOverlap: overlaps,
      sideClipped: side.scrollHeight > side.clientHeight + 1,
      popInside: !popVisible || (pop!.left >= 0 && pop!.right <= window.innerWidth && pop!.bottom <= window.innerHeight),
      boxWidth: box.width,
      scopeWidth: scope.width,
    }
  })
}

test.describe('Style Map: locate a picture from the Gallery', () => {
  for (const [width, height, lang] of [[1366, 768, 'en'], [1920, 1080, 'zh-CN'], [2560, 1440, 'en']] as const) {
    test(`the Gallery context menu opens the map on the picture, ringed, with its nearest list at ${width}x${height} (${lang})`, async ({ page }) => {
      const spy = await mockBase(page)
      await page.route('**/api/style-map/near**', (route) => {
        spy.nearUrls.push(route.request().url())
        return route.fulfill({ json: nearBody() })
      })
      await setup(page, width, height, lang)
      const { consoleErrors, httpErrors } = watch(page)
      const item = page.locator(`#gallery-grid .gallery-item[data-id="${SELF_ID}"]`)
      await expect(item).toBeVisible()
      await item.click({ button: 'right' })
      const menu = page.locator('.gallery-context-menu')
      const entry = menu.getByText(lang === 'en' ? 'View on the Style Map' : '在画风地图中查看')
      await expect(entry).toBeVisible()
      await shot(page, `01-context-menu-${width}-${lang}`)
      await entry.click()

      const map = new StyleMapPage(page)
      await expect(map.view).toHaveClass(/active/)
      await expect.poll(() => map.pointCount()).toBe(30)
      await expect(page.locator('.stylemap-near-row')).toHaveCount(5) // the picture itself + 4 neighbours
      expect(spy.nearUrls).toHaveLength(1)
      const url = new URL(spy.nearUrls[0])
      expect(url.searchParams.get('image_id')).toBe(String(SELF_ID))
      expect(url.searchParams.get('map_id')).toBe(MAP_ID)
      expect(url.searchParams.get('space')).toBe('kaloscope')
      await expect(page.locator('#stylemap-near-for')).toHaveText(lang === 'en' ? 'Most like this picture' : '和这张最像的')
      await expect(page.locator('.stylemap-near-row.is-query')).toContainText('self_picture.png')
      await expect(page.locator('.stylemap-near-row.is-query .stylemap-near-thumb')).toHaveAttribute('src', new RegExp(`/api/image-thumbnail/${SELF_ID}`))
      await expect(page.locator('#stylemap-near-status')).toBeHidden()
      expect(await ringKinds(page)).toEqual(['query:true', 'near:true', 'near:true', 'near:true', 'far:true'])
      await expectCameraAt(page, coord(SELF_ID))
      await shot(page, `02-on-the-map-${width}-${lang}`)

      // The card still fits: nothing overlaps or overflows.
      expect(await layoutCheck(page)).toMatchObject({ pageOverflow: false, sideClipped: false })
      expect(consoleErrors).toEqual([])
      expect(httpErrors).toEqual([])
    })
  }

  test('the image window hands the picture to the map the same way', async ({ page }) => {
    const spy = await mockBase(page)
    await page.route('**/api/style-map/near**', (route) => {
      spy.nearUrls.push(route.request().url())
      return route.fulfill({ json: nearBody() })
    })
    await setup(page, 1920, 1080)
    await page.locator(`#gallery-grid .gallery-item[data-id="${SELF_ID}"]`).click()
    await expect(page.locator('#image-modal')).toBeVisible()
    const handoff = page.locator('[data-modal-handoff="stylemap"]')
    await page.locator('#modal-tools-menu summary').click()
    await expect(handoff).toBeVisible()
    await handoff.click()
    await expect(page.locator('#view-stylemap')).toHaveClass(/active/)
    await expect(page.locator('#image-modal')).toBeHidden()
    await expect(page.locator('.stylemap-near-row')).toHaveCount(5)
    expect(new URL(spy.nearUrls[0]).searchParams.get('image_id')).toBe(String(SELF_ID))
    expect(await ringKinds(page)).toContain('query:true')
  })

  test('a picture without style data says so and offers to build the index', async ({ page }) => {
    const spy = await mockBase(page)
    await page.route('**/api/style-map/near**', (route) => route.fulfill({
      json: { status: 'no_vector', space: 'kaloscope', query: null, neighbors: [], self: { id: SELF_ID, filename: 'self_picture.png' }, weak_threshold: 0.32, model_version: 'kaloscope:test' },
    }))
    await setup(page, 1366, 768, 'zh-CN')
    await page.locator(`#gallery-grid .gallery-item[data-id="${SELF_ID}"]`).click({ button: 'right' })
    await page.locator('.gallery-context-menu').getByText('在画风地图中查看').click()
    const status = page.locator('#stylemap-near-status')
    await expect(status).toContainText('这张图还没有画风数据，先建立画风索引')
    await expect(page.locator('.stylemap-near-row')).toHaveCount(0)
    expect(await ringKinds(page)).toEqual([])
    await shot(page, '03-no-style-data-1366-zh-CN')
    await page.locator('#stylemap-near-action').click()
    await expect.poll(() => spy.vectorStarts).toBe(1)
  })

  test('a CLIP map says a picture without an embedding has no similarity data', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/style-map/near**', (route) => route.fulfill({
      json: { status: 'no_vector', space: 'clip', query: null, neighbors: [], self: { id: SELF_ID, filename: 'self_picture.png' }, weak_threshold: 0.5, model_version: 'clip:test' },
    }))
    const map = await openMap(page, 1366, 768)
    await map.spaceSelect.selectOption('clip')
    await expect.poll(() => page.evaluate(() => (window as any).StyleMap._state.space)).toBe('clip')
    await expect.poll(() => map.pointCount()).toBe(30)
    await page.evaluate((id) => (window as any).StyleMap.locateImage(id), SELF_ID)
    await expect(page.locator('#stylemap-near-status')).toContainText('no similarity data')
    await expect(page.locator('#stylemap-near-action')).toHaveText('Open Find Similar')
  })

  test('a picture outside the Gallery filter says so, lists its matches anyway and Show all clears the filter', async ({ page }) => {
    const spy = await mockBase(page)
    await page.route('**/api/style-map/near**', (route) => route.fulfill({
      json: nearBody({ query: null, self: { id: SELF_ID, filename: 'self_picture.png', in_filter: false, located: false, merged: false, x: null, y: null, z: null } }),
    }))
    await openMap(page, 1366, 768)
    await page.evaluate((id) => (window as any).StyleMap.locateImage(id), SELF_ID)
    const status = page.locator('#stylemap-near-status')
    await expect(status).toContainText('in the current Gallery filter, so it has no dot')
    await expect(page.locator('.stylemap-near-row')).toHaveCount(5)
    expect(await ringKinds(page)).not.toContain('query:true')
    await shot(page, '04-outside-filter-1366-en')
    const before = spy.pointsCalls
    await page.locator('#stylemap-near-action').click()
    await expect.poll(() => spy.pointsCalls, { timeout: 5000 }).toBeGreaterThan(before)
  })

  test('a picture merged into another dot says so and rings that dot', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/style-map/near**', (route) => route.fulfill({
      json: nearBody({ self: { id: SELF_ID, filename: 'self_picture.png', in_filter: true, located: true, merged: true, ...coord(3) }, query: coord(3) }),
    }))
    await openMap(page, 1366, 768, 'zh-CN')
    await page.evaluate((id) => (window as any).StyleMap.locateImage(id), SELF_ID)
    await expect(page.locator('#stylemap-near-status')).toContainText('这张图和另一张合并在同一点')
    await expectCameraAt(page, coord(3))
  })

  test('an unknown picture (404) is said in words', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/style-map/near**', (route) => route.fulfill({ status: 404, json: { detail: 'gone' } }))
    await openMap(page, 1366, 768)
    await page.evaluate((id) => (window as any).StyleMap.locateImage(id), SELF_ID)
    await expect(page.locator('#stylemap-near-status')).toContainText('no longer in the library')
  })
})

test.describe('Style Map: the Locate a picture box', () => {
  async function typeQuery(page: Page, text: string) {
    const input = page.locator('#stylemap-locate-input')
    await input.click()
    await input.fill(text)
  }

  for (const [width, height, lang] of [[1366, 768, 'en'], [1920, 1080, 'zh-CN'], [2560, 1440, 'en']] as const) {
    test(`typing lists the matches with thumbnails; arrows, Enter and Esc work, at ${width}x${height} (${lang})`, async ({ page }) => {
      const spy = await mockBase(page)
      await page.route('**/api/style-map/locate', (route) => {
        spy.locateBodies.push(route.request().postDataJSON())
        return route.fulfill({ json: locateBody() })
      })
      const map = await openMap(page, width, height, lang)
      const { consoleErrors, httpErrors } = watch(page)
      const input = page.locator('#stylemap-locate-input')
      await expect(input).toHaveAttribute('placeholder', lang === 'en' ? 'Locate a picture...' : '定位图片…')
      await expect(input).toHaveAttribute('aria-label', lang === 'en' ? 'Locate a picture' : '定位图片')
      expect(await layoutCheck(page)).toMatchObject({ pageOverflow: false, toolbarOverflow: false, subbarInside: true, scopeClear: true, toolsOverlap: false })
      await shot(page, `05-locate-box-idle-${width}-${lang}`)

      await typeQuery(page, 'blue')
      // Debounced: one search for the whole word, not one per key.
      await expect(page.locator('.stylemap-locate-row')).toHaveCount(3)
      expect(spy.locateBodies).toHaveLength(1)
      expect(spy.locateBodies[0]).toMatchObject({ space: 'kaloscope', map_id: MAP_ID, search_token: 'tok.search' })
      // The Gallery's own grammar: the free text reaches the filter as `search`, nothing else is filtered.
      expect(spy.tokenBodies.at(-1)).toMatchObject({ search: 'blue' })
      await expect(page.locator('.stylemap-locate-count')).toHaveText(lang === 'en' ? '3 matches on this map' : '地图上有 3 张符合')
      await expect(page.locator('.stylemap-locate-row').nth(2)).toContainText(lang === 'en' ? 'merged into the same dot' : '合并在同一点')
      await expect(page.locator('.stylemap-locate-thumb').first()).toHaveAttribute('src', /\/api\/image-thumbnail\/7\?size=96/)
      await expect(input).toHaveAttribute('aria-expanded', 'true')
      expect(await layoutCheck(page)).toMatchObject({ popInside: true, pageOverflow: false })
      await shot(page, `06-locate-results-${width}-${lang}`)

      // Keyboard: the first row is active, ArrowDown moves, Enter flies there and rings it.
      await expect(page.locator('.stylemap-locate-row').nth(0)).toHaveClass(/is-active/)
      await page.keyboard.press('ArrowDown')
      await expect(page.locator('.stylemap-locate-row').nth(1)).toHaveClass(/is-active/)
      await page.keyboard.press('Enter')
      await expect(page.locator('#stylemap-locate-pop')).toBeHidden()
      await expectCameraAt(page, coord(14))
      expect(await ringKinds(page)).toEqual(['query:true'])
      await expect(map.previewImage).toHaveAttribute('src', /\/api\/image-thumbnail\/14\?size=512/)

      // Esc closes an open list and does not open the entry page.
      await page.keyboard.press('ArrowDown')
      await expect(page.locator('#stylemap-locate-pop')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('#stylemap-locate-pop')).toBeHidden()
      await expect(page.locator('#entry-page')).toBeHidden()
      await expect(map.view).toHaveClass(/active/)

      // A click on a row does the same; clearing the box removes the ring.
      await typeQuery(page, 'blue hair')
      await expect(page.locator('.stylemap-locate-row')).toHaveCount(3)
      await page.locator('.stylemap-locate-row').nth(2).click()
      await expectCameraAt(page, coord(22))
      await page.locator('#stylemap-locate-clear').click()
      await expect(input).toHaveValue('')
      expect(await ringKinds(page)).toEqual([])
      expect(consoleErrors).toEqual([])
      expect(httpErrors).toEqual([])
    })
  }

  test('tag: and prompt: use the Gallery search language', async ({ page }) => {
    const spy = await mockBase(page)
    await page.route('**/api/style-map/locate', (route) => route.fulfill({ json: locateBody() }))
    await openMap(page, 1366, 768)
    await typeQuery(page, 'tag:blue_hair prompt:sky')
    await expect(page.locator('.stylemap-locate-row')).toHaveCount(3)
    const body = spy.tokenBodies.at(-1)
    expect(body.tags).toEqual(['blue_hair'])
    expect(body.prompts).toEqual(['sky'])
    expect(body.sort_by ?? body.sortBy).toBe('newest')
  })

  test('a query the grammar does not understand says what to type and asks the server nothing', async ({ page }) => {
    const spy = await mockBase(page)
    await page.route('**/api/style-map/locate', (route) => {
      spy.locateBodies.push(route.request().postDataJSON())
      return route.fulfill({ json: locateBody() })
    })
    await openMap(page, 1366, 768)
    await typeQuery(page, 'rating:nonsense')
    await expect(page.locator('#stylemap-locate-status')).toContainText('Type a file name')
    expect(spy.locateBodies).toHaveLength(0)
  })

  test('zero matches say why: outside the Gallery filter (with Show all), no style data, or nothing at all', async ({ page }) => {
    const spy = await mockBase(page)
    const answers = [
      locateBody({ total: 0, results: [], outside_filter: 4 }),
      locateBody({ total: 0, results: [], without_data: 2 }),
      locateBody({ total: 0, results: [] }),
    ]
    let call = 0
    await page.route('**/api/style-map/locate', (route) => route.fulfill({ json: answers[Math.min(call++, answers.length - 1)] }))
    await openMap(page, 1366, 768)
    await typeQuery(page, 'first')
    const status = page.locator('#stylemap-locate-status')
    await expect(status).toContainText('4 matching pictures are outside the current Gallery filter')
    await expect(page.locator('#stylemap-locate-action')).toHaveText('Show all pictures')
    await expect(page.locator('.stylemap-locate-row')).toHaveCount(0)
    await shot(page, '07-locate-outside-filter-1366-en')
    const before = spy.pointsCalls
    await page.locator('#stylemap-locate-action').click()
    await expect.poll(() => spy.pointsCalls, { timeout: 5000 }).toBeGreaterThan(before)
    await typeQuery(page, 'second')
    await expect(status).toContainText('2 matching pictures have no style data yet')
    await expect(page.locator('#stylemap-locate-action')).toBeHidden()
    await typeQuery(page, 'third')
    await expect(status).toContainText('No picture on this map matches')
  })

  test('more than the shown matches say how many there are', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/style-map/locate', (route) => route.fulfill({ json: locateBody({ total: 132 }) }))
    await openMap(page, 1366, 768)
    await typeQuery(page, 'blue')
    await expect(page.locator('.stylemap-locate-count')).toHaveText('3 of 132 matches on this map')
  })

  test('a server that lost the map is rebuilt once, never in a loop', async ({ page }) => {
    const spy = await mockBase(page)
    let calls = 0
    await page.route('**/api/style-map/locate', (route) => {
      calls += 1
      return route.fulfill({ json: { status: 'not_started', space: 'kaloscope', total: 0, results: [], outside_filter: 0, without_data: 0 } })
    })
    await openMap(page, 1366, 768)
    const before = spy.pointsCalls
    await typeQuery(page, 'blue')
    await expect(page.locator('#stylemap-locate-status')).toContainText('The search failed')
    expect(calls).toBe(2) // the first answer, then one retry after the map was rebuilt
    expect(spy.pointsCalls - before).toBe(1)
  })

  test('a failed search says why', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/style-map/locate', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }))
    await openMap(page, 1366, 768)
    await typeQuery(page, 'blue')
    await expect(page.locator('#stylemap-locate-status')).toContainText('The search failed')
    await expect(page.locator('#stylemap-locate-status')).toHaveAttribute('data-tone', 'error')
  })

  test('the box and its tooltip are named; a dropped-picture marker and the search marker coexist', async ({ page }) => {
    await mockBase(page)
    await page.route('**/api/style-map/locate', (route) => route.fulfill({ json: locateBody() }))
    await page.route('**/api/style-map/query**', (route) => route.fulfill({ json: nearBody() }))
    await openMap(page, 1366, 768)
    await expect(page.locator('#stylemap-locate')).toHaveAttribute('title', /Gallery search language/)
    await page.locator('#stylemap-near-file').setInputFiles({ name: 'drop.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') })
    await expect(page.locator('.stylemap-near-row')).toHaveCount(5)
    const dropped = await ringKinds(page)
    await typeQuery(page, 'blue')
    await page.locator('.stylemap-locate-row').first().click()
    expect((await ringKinds(page)).length).toBe(dropped.length + 1)
  })
})
