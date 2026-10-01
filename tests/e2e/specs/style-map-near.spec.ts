import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map "drop a picture, find the nearest" (S4c) against mocked
 * /api/style-map/*. The scripted query answer has near neighbours, far ones
 * (weak), one picture outside the filter and a query point; what is under
 * test is the page: the multipart upload, the rings on the map, the list
 * (order, grey far rows, the outside-the-filter flag), the row click, the
 * states (idle, loading, error) and the layout at 1366 and 1920.
 */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const MAP_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }

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

/** Seven placed neighbours (best first; the last two below the threshold) and one outside the filter. */
function queryBody(overrides: Record<string, unknown> = {}) {
  const rows: Array<[number, number, string, boolean]> = [
    [3, 0.91, 'near_a.png', true], [7, 0.84, 'near_b.png', true], [12, 0.77, 'near_c.png', true],
    [5, 0.61, 'a_rather_long_file_name_for_the_list_row_that_must_not_wrap.png', true],
    [9001, 0.52, 'outside_filter.png', false],
    [20, 0.2, 'far_a.png', true], [21, 0.12, 'far_b.png', true],
  ]
  return {
    status: 'ok',
    query: { x: 0.1, y: 0.05, z: -0.1 },
    neighbors: rows.map(([id, score, filename, inFilter]) => ({
      id, score, filename, weak: score < 0.32, in_filter: inFilter,
      ...(inFilter ? coord(id) : { x: null, y: null, z: null }),
    })),
    weak_threshold: 0.32, model_version: 'kaloscope:test', ...overrides,
  }
}

async function mockBase(page: Page, points = pointsBody()) {
  await page.route('**/api/images/selection-token', (route) => route.fulfill({ json: { selection_token: 'tok.e2e', total_estimate: 33 } }))
  await page.route('**/api/style-map/vectors/progress', (route) =>
    route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } }))
  await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: points }))
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', method: 'pca', regions: [], cached: false } }))
  await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', by: 'generator', kind: 'category', ids: Array.from({ length: 30 }, (_, i) => i + 1), values: new Array(30).fill(0), legend: [{ key: 'nai', label: 'nai', count: 30 }], range: null, missing: 0 } }))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }))
  await page.route('**/api/images/*', (route) => {
    if (route.request().method() !== 'GET' || !/\/api\/images\/\d+$/.test(route.request().url())) return route.fallback()
    return route.fulfill({ json: { image: { filename: 'preview_name.png' } } })
  })
}

/** Console errors and failed HTTP calls (4xx/5xx) the page raised; mocked error answers are listed apart. */
function watch(page: Page) {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })
  return { consoleErrors, httpErrors }
}

async function openMap(page: Page, width: number, height: number, lang = 'en') {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
  await page.reload()
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount()).toBe(30)
  return map
}

async function pickFile(page: Page, name = 'drop.png', buffer: Buffer = PNG_1PX, mimeType = 'image/png') {
  await page.locator('#stylemap-near-file').setInputFiles({ name, mimeType, buffer })
}

/** No overlap or clipping inside the card, no page-wide horizontal overflow. */
async function layoutCheck(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('#stylemap-near') as HTMLElement
    const side = document.querySelector('.stylemap-side') as HTMLElement
    const cardRect = card.getBoundingClientRect()
    const sideRect = side.getBoundingClientRect()
    const list = document.querySelector('.stylemap-near-body') as HTMLElement // the scrolling area
    const items = document.querySelector('#stylemap-near-list') as HTMLElement
    const rows = [...items.querySelectorAll('.stylemap-near-row')] as HTMLElement[]
    const listRect = list.getBoundingClientRect()
    const overlapping = rows.some((row, i) => i > 0 && row.getBoundingClientRect().top < rows[i - 1].getBoundingClientRect().bottom - 0.5)
    const textClipped = rows.some((row) => {
      const name = row.querySelector('.stylemap-near-name') as HTMLElement
      const score = row.querySelector('.stylemap-near-score') as HTMLElement | null
      const nameRect = name.getBoundingClientRect()
      return score ? nameRect.right > score.getBoundingClientRect().left + 0.5 : false
    })
    return {
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      sideClipped: side.scrollHeight > side.clientHeight + 1,
      cardInsideSide: cardRect.left >= sideRect.left - 0.5 && cardRect.right <= sideRect.right + 0.5 && cardRect.bottom <= sideRect.bottom + 0.5,
      listInsideCard: listRect.bottom <= cardRect.bottom + 0.5 && listRect.right <= cardRect.right + 0.5,
      listOverflowX: list.scrollWidth > list.clientWidth + 1,
      overlapping,
      textClipped,
      rows: rows.length,
      // Rows fully inside the scrolling body: the list must never be squeezed to nothing.
      rowsVisible: rows.filter((row) => {
        const body = (document.querySelector('.stylemap-near-body') as HTMLElement).getBoundingClientRect()
        const rect = row.getBoundingClientRect()
        return rect.top >= body.top - 0.5 && rect.bottom <= body.bottom + 0.5
      }).length,
    }
  })
}

const ringKinds = (page: Page) =>
  page.evaluate(() => (window as any).StyleMap._state.scene.rings.describe().map((r: any) => `${r.kind}:${r.visible}`))

test.describe('Style Map nearest pictures', () => {
  for (const [width, height, lang] of [[1366, 768, 'en'], [1920, 1080, 'zh-CN']] as const) {
    test(`a dropped picture rings the nearest dots, greys the far ones and lists them best first at ${width}x${height} (${lang})`, async ({ page }) => {
      await mockBase(page)
      const uploads: Array<{ url: string; type: string; hasFile: boolean }> = []
      await page.route('**/api/style-map/query**', (route) => {
        const request = route.request()
        uploads.push({ url: request.url(), type: request.headers()['content-type'] || '', hasFile: (request.postData() || '').includes('filename="drop.png"') })
        return route.fulfill({ json: queryBody() })
      })
      const map = await openMap(page, width, height, lang)
      // Watched from here on: the reload that sets the language aborts the boot requests.
      const { consoleErrors, httpErrors } = watch(page)
      const card = page.locator('#stylemap-near')

      // Idle: the drop zone is offered, nothing is listed or ringed.
      await expect(card).toBeVisible()
      // The dictionary must have loaded (a broken language file shows raw keys).
      await expect(page.locator('#stylemap-near-title')).toHaveText(lang === 'en' ? 'Drop a picture, find the nearest' : '丢一张图，找最像的')
      await expect(page.locator('#stylemap-drop-sub')).toContainText(lang === 'en' ? 'uses the model of this map' : '用的是当前坐标的模型')
      await expect(page.locator('#stylemap-drop')).toHaveAttribute('aria-disabled', 'false')
      await expect(page.locator('.stylemap-near-row')).toHaveCount(0)
      expect(await ringKinds(page)).toEqual([])
      await expect(page.locator('#stylemap-near-clear')).toBeHidden()

      await pickFile(page)
      await expect(page.locator('.stylemap-near-row')).toHaveCount(8) // the query row + 7 neighbours
      expect(uploads).toHaveLength(1)
      const url = new URL(uploads[0].url)
      expect(uploads[0].type).toContain('multipart/form-data')
      expect(uploads[0].hasFile).toBe(true)
      expect(url.searchParams.get('space')).toBe('kaloscope')
      expect(url.searchParams.get('map_id')).toBe(MAP_ID)
      expect(url.searchParams.get('k')).toBe('20')

      // Rings: one query disc, 4 near rings, 2 far rings (the outside-the-filter picture has no position).
      expect(await ringKinds(page)).toEqual(['query:true', 'near:true', 'near:true', 'near:true', 'near:true', 'far:true', 'far:true'])

      // Rows best first; far rows carry the grey flag, the outside-the-filter row says so.
      const scores = await page.locator('.stylemap-near-row:not(.is-query) .stylemap-near-score').allTextContents()
      expect(scores).toEqual(['0.91', '0.84', '0.77', '0.61', '0.52', '0.20', '0.12'])
      const far = page.locator('.stylemap-near-row[data-weak="true"]')
      await expect(far).toHaveCount(2)
      await expect(far.first()).toContainText(lang === 'en' ? 'far away' : '离得很远')
      const outside = page.locator('.stylemap-near-row[data-in-filter="false"]')
      await expect(outside).toHaveCount(1)
      await expect(outside).toContainText(lang === 'en' ? 'not in the current filter' : '不在当前筛选里')
      await expect(page.locator('.stylemap-near-row.is-query')).toContainText('drop.png')
      await expect(page.locator('#stylemap-near-note')).toContainText('0.32')
      await expect(page.locator('#stylemap-near-clear')).toBeVisible()

      // Long names stay on one line; nothing overlaps, clips or overflows.
      expect((await layoutCheck(page)).rowsVisible).toBeGreaterThanOrEqual(4)
      expect(await layoutCheck(page)).toMatchObject({ pageOverflow: false, sideClipped: false, cardInsideSide: true, listInsideCard: true, listOverflowX: false, overlapping: false, textClipped: false })

      // A fresh drop turns the camera to the query point (and marks its row).
      const queryAt = queryBody().query as { x: number; y: number; z: number }
      await expect.poll(async () => {
        const t = await page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())
        return Math.hypot(t[0] - queryAt.x, t[1] - queryAt.y, t[2] - queryAt.z)
      }).toBeLessThan(0.01)
      await expect(page.locator('.stylemap-near-row.is-query')).toHaveAttribute('aria-current', 'true')

      // A row turns the camera to its point and shows its picture.
      const before = await page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())
      await page.locator('.stylemap-near-row[data-id="12"]').click()
      await expect(page.locator('.stylemap-near-row[data-id="12"]')).toHaveAttribute('aria-current', 'true')
      await expect(map.previewImage).toHaveAttribute('src', /\/api\/image-thumbnail\/12\?size=512/)
      await expect.poll(async () => page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())).not.toEqual(before)
      const target = await page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())
      const want = coord(12)
      await expect.poll(async () => {
        const t = await page.evaluate(() => (window as any).StyleMap._state.scene.controls.target.toArray())
        return Math.hypot(t[0] - want.x, t[1] - want.y, t[2] - want.z)
      }).toBeLessThan(0.01)
      expect(target).toHaveLength(3)

      // A picture outside the filter shows its preview but cannot be flown to.
      await page.locator('.stylemap-near-row[data-id="9001"]').click()
      await expect(map.previewImage).toHaveAttribute('src', /\/api\/image-thumbnail\/9001\?size=512/)

      // Clear removes list and rings.
      await page.locator('#stylemap-near-clear').click()
      await expect(page.locator('.stylemap-near-row')).toHaveCount(0)
      expect(await ringKinds(page)).toEqual([])
      await expect(page.locator('#stylemap-near-clear')).toBeHidden()

      expect(consoleErrors).toEqual([])
      expect(httpErrors).toEqual([])
    })
  }

  test('shows a working line, then the model-loading line when the answer is slow, and no rings meanwhile', async ({ page }) => {
    await mockBase(page)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/style-map/query**', async (route) => {
      await gate
      await route.fulfill({ json: queryBody() })
    })
    await openMap(page, 1366, 768)
    await pickFile(page)
    const status = page.locator('#stylemap-near-status')
    await expect(status).toBeVisible()
    await expect(status).toContainText('Finding the nearest pictures')
    await expect(status).toContainText('Loading the Style Finder model', { timeout: 4000 })
    expect(await ringKinds(page)).toEqual([])
    release()
    await expect(page.locator('.stylemap-near-row')).toHaveCount(8)
    await expect(status).toBeHidden()
  })

  test('a failed upload says why and leaves the map unmarked: too large, not a picture, busy, model not prepared', async ({ page }) => {
    await mockBase(page)
    const answers = [
      { status: 413, json: { detail: 'File too large (max 50 MB)' }, text: 'too large' },
      { status: 400, json: { error: 'Validation error for \'file\': The file is not a readable image', type: 'ValidationError' }, text: 'not a picture' },
      { status: 409, json: { error: 'busy', type: 'AiRuntimeBusyError' }, text: 'Another AI task is running' },
      { status: 503, json: { detail: 'Artist Identify is not prepared on this machine.' }, text: 'not prepared on this machine' },
    ]
    let call = 0
    await page.route('**/api/style-map/query**', (route) => {
      const answer = answers[call]
      call += 1
      return route.fulfill({ status: answer.status, json: answer.json })
    })
    await openMap(page, 1366, 768)
    for (const answer of answers) {
      await pickFile(page)
      await expect(page.locator('#stylemap-near-status')).toContainText(answer.text)
      await expect(page.locator('#stylemap-near-status')).toHaveAttribute('data-tone', 'error')
      await expect(page.locator('.stylemap-near-row')).toHaveCount(0)
      expect(await ringKinds(page)).toEqual([])
      expect((await layoutCheck(page)).pageOverflow).toBe(false)
    }
    // A text file is refused before any upload.
    const before = call
    await pickFile(page, 'notes.txt', Buffer.from('hello'), 'text/plain')
    await expect(page.locator('#stylemap-near-status')).toContainText('not a picture')
    expect(call).toBe(before)
  })

  test('accepts a drop on the card and refuses it while there is no map', async ({ page }) => {
    await mockBase(page)
    let uploads = 0
    await page.route('**/api/style-map/query**', (route) => { uploads += 1; return route.fulfill({ json: queryBody() }) })
    await openMap(page, 1920, 1080)
    const drop = () => page.evaluate(async () => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'dragged.png', { type: 'image/png' }))
      const target = document.querySelector('#stylemap-near') as HTMLElement
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
      }
    })
    await drop()
    await expect(page.locator('.stylemap-near-row.is-query')).toContainText('dragged.png')
    expect(uploads).toBe(1)

    // An empty filter result: no map, the zone says so and ignores a drop.
    await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody({ status: 'no_vectors', points: [], map_id: MAP_ID }) }))
    await page.evaluate(() => (window as any).StyleMap.refresh({ force: true }))
    await expect(page.locator('#stylemap-drop')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.locator('.stylemap-near-row')).toHaveCount(0)
    await drop()
    expect(uploads).toBe(1)
  })

  test('asks for the map once more when the server lost it, then answers; a space change looks the same picture up again', async ({ page }) => {
    let pointsCalls = 0
    await mockBase(page)
    await page.route('**/api/style-map/points**', (route) => { pointsCalls += 1; return route.fulfill({ json: pointsBody() }) })
    const asked: string[] = []
    let first = true
    await page.route('**/api/style-map/query**', (route) => {
      asked.push(new URL(route.request().url()).searchParams.get('space') || '')
      if (first) {
        first = false
        return route.fulfill({ json: { status: 'not_started', space: 'kaloscope', query: null, neighbors: [], weak_threshold: 0.32, model_version: null } })
      }
      return route.fulfill({ json: queryBody() })
    })
    await openMap(page, 1366, 768)
    const callsBefore = pointsCalls
    await pickFile(page)
    await expect(page.locator('.stylemap-near-row')).toHaveCount(8)
    expect(pointsCalls).toBe(callsBefore + 1)
    expect(asked).toEqual(['kaloscope', 'kaloscope'])

    await page.selectOption('#stylemap-space', 'clip')
    await expect.poll(() => asked.length).toBe(3)
    expect(asked[2]).toBe('clip')
    await expect(page.locator('.stylemap-near-row')).toHaveCount(8)
  })

  test('one rings pool: a second drop replaces the markers, never adds to them', async ({ page }) => {
    await mockBase(page)
    let call = 0
    await page.route('**/api/style-map/query**', (route) => {
      call += 1
      const body = call === 1 ? queryBody() : queryBody({ query: null, neighbors: queryBody().neighbors.slice(0, 2) })
      return route.fulfill({ json: body })
    })
    await openMap(page, 1366, 768)
    await pickFile(page)
    await expect.poll(async () => (await ringKinds(page)).length).toBe(7)
    await pickFile(page, 'second.png')
    await expect.poll(async () => (await ringKinds(page)).length).toBe(2)
    expect(await ringKinds(page)).toEqual(['near:true', 'near:true'])
    // Nothing placed on the map: the note says the query point is not marked.
    await expect(page.locator('#stylemap-near-note')).toContainText('not marked on the map')
    const sprites = await page.evaluate(() => (window as any).StyleMap._state.scene.rings.sprites.filter((s: any) => s.visible).length)
    expect(sprites).toBe(2)
  })
})
