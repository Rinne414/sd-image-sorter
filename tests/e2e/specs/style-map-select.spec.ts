import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * Style Map box selection (S4b) against mocked /api/style-map/*: Shift + drag
 * (and the toolbar switch) pick the dots inside a rectangle, merged dots are
 * expanded into their members before the ids reach the shared selection, the
 * floating bar hands the ids to the existing tools, ESC cancels a drag and
 * clears a pick without opening the entry page, and a plain drag still rotates.
 */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const MAP_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }
const MERGED_ID = 3
const MERGED_MEMBERS = [3, 301, 302]

function pointsBody(overrides: Record<string, unknown> = {}) {
  const points = Array.from({ length: 30 }, (_, i) => [i + 1, (i % 5) / 4 - 0.5, (i % 7) / 6 - 0.5, (i % 3) / 2 - 0.5, i + 1 === MERGED_ID ? MERGED_MEMBERS.length : 1])
  return {
    status: 'ok', space: 'kaloscope', method: 'pca', model_version: 'kaloscope:test',
    total_images: 33, missing_vectors: 3, unlocatable: [], merged_away: 2,
    explained_variance: [0.05, 0.04, 0.03], points_layout: ['id', 'x', 'y', 'z', 'members'], points,
    umap: { status: 'unavailable', points: 30, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    map_id: MAP_ID, cached: false, ...overrides,
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
}

/** The members answer the server would give: the merged dot expands to its pictures. */
async function mockMembers(page: Page, requests: Array<Record<string, any>> = []) {
  await page.route('**/api/style-map/members**', (route) => {
    const body = route.request().postDataJSON()
    requests.push(body)
    const ids = (body.rep_ids as number[]).flatMap((id) => (id === MERGED_ID ? MERGED_MEMBERS : [id]))
    return route.fulfill({ json: { status: 'ok', space: body.space, ids } })
  })
  return requests
}

/** Console errors and 4xx/5xx answers after the page was (re)loaded: the aborted first load is not under test. */
function watch(page: Page) {
  const consoleErrors: string[] = []
  const httpErrors: string[] = []
  const watcher = { consoleErrors, httpErrors, armed: false }
  page.on('console', (message) => { if (watcher.armed && message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => { if (watcher.armed) consoleErrors.push(String(error)) })
  page.on('response', (response) => { if (watcher.armed && response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })
  return watcher
}

async function openMap(page: Page, width: number, height: number, lang = 'en', count = 30, watcher?: { armed: boolean }) {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
  await page.reload()
  if (watcher) watcher.armed = true
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount(), { timeout: 30000 }).toBe(count)
  return map
}

/** Tools the bar calls: replaced by spies that remember what they were given. */
async function installSpies(page: Page) {
  await page.evaluate(() => {
    const calls: Record<string, any[]> = { censor: [], dataset: [], collection: [] }
    ;(window as any).__calls = calls
    ;(window as any).initCensorEdit = () => {}
    ;(window as any).CensorEdit = { addToQueue: (ids: unknown) => { calls.censor.push(ids); return true } }
    ;(window as any).DatasetMaker = { ...(window as any).DatasetMaker, addImageIds: async (ids: unknown) => { calls.dataset.push(ids) } }
    ;(window as any).CollectionsUI = { ...(window as any).CollectionsUI, openAddToCollectionPicker: async (ids: unknown, options: unknown) => { calls.collection.push({ ids, options }) } }
  })
}

type Box = { x0: number, y0: number, x1: number, y1: number }

/** A box that spans the given share of the canvas around its centre (page pixels). */
async function boxOf(page: Page, share: number): Promise<Box> {
  const rect = (await page.locator('#stylemap-canvas').boundingBox())!
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return { x0: cx - (rect.width * share) / 2, y0: cy - (rect.height * share) / 2, x1: cx + (rect.width * share) / 2, y1: cy + (rect.height * share) / 2 }
}

async function dragBox(page: Page, box: Box, { shift = true, finish = true }: { shift?: boolean, finish?: boolean } = {}) {
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(box.x0, box.y0)
  await page.mouse.down()
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 })
  await page.mouse.move(box.x1, box.y1, { steps: 4 })
  if (finish) {
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
  }
}

/** Ids whose projected screen position lies in the box, computed here with THREE's own projection. */
async function expectedIds(page: Page, box: Box): Promise<number[]> {
  return page.evaluate((b) => {
    const scene = (window as any).StyleMap._state.scene
    const rect = scene.canvas.getBoundingClientRect()
    const position = scene.geometry.getAttribute('position')
    const Vec = scene.camera.position.constructor
    const found: number[] = []
    for (let i = 0; i < scene.count; i += 1) {
      const p = new Vec(position.getX(i), position.getY(i), position.getZ(i)).project(scene.camera)
      const px = rect.left + ((p.x + 1) / 2) * rect.width
      const py = rect.top + ((1 - p.y) / 2) * rect.height
      if (p.z >= -1 && p.z <= 1 && px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) found.push(scene.ids[i])
    }
    return found
  }, box)
}

const selectedIds = (page: Page) => page.evaluate(() => [...(window as any).App.AppState.selectedIds].map(Number).sort((a, b) => a - b))
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)

async function layoutCheck(page: Page) {
  return page.evaluate(() => {
    const card = (document.querySelector('#stylemap-canvas-card') as HTMLElement).getBoundingClientRect()
    const bar = document.querySelector('#stylemap-selbar') as HTMLElement
    const reset = (document.querySelector('#stylemap-reset-view') as HTMLElement).getBoundingClientRect()
    const barRect = bar.getBoundingClientRect()
    const buttons = [...bar.children].map((el) => el.getBoundingClientRect())
    const barVisible = !bar.hidden
    return {
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      barVisible,
      barInside: !barVisible || (barRect.left >= card.left && barRect.right <= card.right && barRect.bottom <= card.bottom && barRect.top >= card.top),
      barOverlapsReset: barVisible && barRect.left < reset.right && barRect.right > reset.left && barRect.top < reset.bottom && barRect.bottom > reset.top,
      barOneRow: !barVisible || buttons.every((r) => Math.abs((r.top + r.bottom) / 2 - (buttons[0].top + buttons[0].bottom) / 2) < 6),
      barClipped: barVisible && bar.scrollWidth > bar.clientWidth + 1,
      buttonsOverlap: buttons.some((r, i) => i > 0 && r.left < buttons[i - 1].right - 0.5),
      subbarExtra: Math.round((document.querySelector('.stylemap-subbar') as HTMLElement).getBoundingClientRect().height - (document.querySelector('#stylemap-box-toggle') as HTMLElement).getBoundingClientRect().height),
      sideClipped: (document.querySelector('.stylemap-side') as HTMLElement).scrollHeight > (document.querySelector('.stylemap-side') as HTMLElement).clientHeight + 1,
    }
  })
}

test.describe('Style Map box selection', () => {
  // The axis meanings (S4e) are not under test here: an empty answer keeps the real backend out of it.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/style-map/axes**', (route) => route.fulfill({ json: { status: 'empty', space: 'kaloscope', layout: 'pca', axes: {} } }))
  })

  test('Shift + drag picks exactly the dots inside the box, expands merged dots, and writes the shared selection', async ({ page }) => {
    const watcher = watch(page)
    await mockBase(page)
    const requests = await mockMembers(page)
    const map = await openMap(page, 1366, 768, 'en', 30, watcher)
    const box = await boxOf(page, 0.55)
    const inside = await expectedIds(page, box)
    expect(inside.length).toBeGreaterThan(2)
    expect(inside.length).toBeLessThan(30)
    expect(inside).toContain(MERGED_ID)

    await dragBox(page, box)

    const expected = inside.flatMap((id) => (id === MERGED_ID ? MERGED_MEMBERS : [id]))
    await expect.poll(() => selectedIds(page)).toEqual(sorted(expected))
    expect(requests).toHaveLength(1)
    expect(sorted(requests[0].rep_ids)).toEqual(sorted(inside))
    expect(requests[0].map_id).toBe(MAP_ID)
    await expect(page.locator('#stylemap-selbar')).toBeVisible()
    await expect(page.locator('#stylemap-selbar-count')).toHaveText(`${expected.length} selected`)
    const state = await page.evaluate(() => ({ mode: (window as any).App.AppState.selectionMode, scope: (window as any).App.AppState.selectionScope }))
    expect(state).toEqual({ mode: true, scope: 'visible' })
    expect(await page.evaluate(() => [...(window as any).StyleMap._state.scene.selected].filter(Boolean).length)).toBe(inside.length)
    expect(await map.pointCount()).toBe(30)
    expect(watcher.consoleErrors).toEqual([])
    expect(watcher.httpErrors).toEqual([])
  })

  test('skips the members call when no picked dot is merged', async ({ page }) => {
    await mockBase(page)
    const requests = await mockMembers(page)
    await openMap(page, 1366, 768)
    // A small box around dot 1 alone (the merged dot 3 is not in it).
    const picked = await page.evaluate(() => {
      const scene = (window as any).StyleMap._state.scene
      const rect = scene.canvas.getBoundingClientRect()
      const position = scene.geometry.getAttribute('position')
      const Vec = scene.camera.position.constructor
      const at = (index: number) => {
        const p = new Vec(position.getX(index), position.getY(index), position.getZ(index)).project(scene.camera)
        return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
      }
      const a = at(0)
      return { x0: a.x - 6, y0: a.y - 6, x1: a.x + 6, y1: a.y + 6 }
    })
    await dragBox(page, picked)
    await expect.poll(() => selectedIds(page)).toEqual([1])
    expect(requests).toHaveLength(0)
  })

  test('the bar hands the expanded ids to Censor, Dataset Maker and the collection picker, and opens the Gallery', async ({ page }) => {
    await mockBase(page)
    await mockMembers(page)
    await openMap(page, 1366, 768)
    await installSpies(page)
    const box = await boxOf(page, 0.55)
    const inside = await expectedIds(page, box)
    const expected = sorted(inside.flatMap((id) => (id === MERGED_ID ? MERGED_MEMBERS : [id])))
    await dragBox(page, box)
    await expect(page.locator('#stylemap-selbar')).toBeVisible()
    // Censor and the Gallery both store the pick as a pinned set first (js/gallery-pin.js).
    const pinRequests: Array<{ image_ids: number[] }> = []
    await page.route('**/api/collections/pinned', (route) => {
      pinRequests.push(route.request().postDataJSON())
      return route.fulfill({ json: { collection_id: 777, count: expected.length } })
    })

    await page.locator('#stylemap-sel-censor').click()
    await page.locator('#stylemap-sel-dataset').click()
    await page.locator('#stylemap-sel-collection').click()
    const calls = await page.evaluate(() => (window as any).__calls)
    // Censor reads a selection token in chunks: the token names the pinned set of exactly these ids.
    expect(calls.censor[0]).toMatchObject({ selectionToken: 'tok.e2e', total: expected.length })
    expect(sorted(pinRequests[0].image_ids)).toEqual(expected)
    expect(sorted(calls.dataset[0])).toEqual(expected)
    expect(calls.collection).toHaveLength(1)
    // The picker reads the shared selection: no token, the same ids.
    expect(await selectedIds(page)).toEqual(expected)

    // The Gallery opens on a pinned set of exactly these ids (js/gallery-pin.js).
    await page.locator('#stylemap-sel-gallery').click()
    await expect(page.locator('#view-gallery')).toHaveClass(/active/)
    expect(pinRequests).toHaveLength(2)
    expect(sorted(pinRequests[1].image_ids)).toEqual(expected)
    await expect(page.locator('#gallery-pin-banner')).toBeVisible()
    expect(await page.evaluate(() => (window as any).App.AppState.filters.collectionId)).toBe(777)
  })

  test('clear empties the selection and the bar; the Gallery mode it found before is restored', async ({ page }) => {
    await mockBase(page)
    await mockMembers(page)
    await openMap(page, 1366, 768)
    await dragBox(page, await boxOf(page, 0.55))
    await expect(page.locator('#stylemap-selbar')).toBeVisible()
    await page.locator('#stylemap-sel-clear').click()
    await expect(page.locator('#stylemap-selbar')).toBeHidden()
    expect(await selectedIds(page)).toEqual([])
    expect(await page.evaluate(() => (window as any).App.AppState.selectionMode)).toBe(false)
    expect(await page.evaluate(() => [...(window as any).StyleMap._state.scene.selected ?? []].filter(Boolean).length)).toBe(0)
  })

  test('ESC cancels a drag in progress: nothing is picked, no box stays, the entry page stays closed', async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('stylemap-entry-booted')) {
        window.sessionStorage.setItem('stylemap-entry-booted', '1')
        window.localStorage.removeItem('aurora-entry-skip')
      }
    })
    await mockBase(page)
    await mockMembers(page)
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeVisible()
    await page.locator('#entry-fn-gallery').click()
    await expect(page.locator('#entry-page')).toBeHidden()
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)

    await dragBox(page, await boxOf(page, 0.55), { finish: false })
    await expect(page.locator('.stylemap-lasso')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.stylemap-lasso')).toBeHidden()
    await expect(page.locator('#entry-page')).toBeHidden()
    await page.mouse.up()
    await page.keyboard.up('Shift')
    expect(await selectedIds(page)).toEqual([])
    await expect(page.locator('#stylemap-selbar')).toBeHidden()
  })

  test('ESC on a finished pick clears it and does not jump to the entry page; the next ESC is the entry page\'s', async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('stylemap-entry-booted')) {
        window.sessionStorage.setItem('stylemap-entry-booted', '1')
        window.localStorage.removeItem('aurora-entry-skip')
      }
    })
    await mockBase(page)
    await mockMembers(page)
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeVisible()
    await page.locator('#entry-fn-gallery').click()
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount()).toBe(30)

    await dragBox(page, await boxOf(page, 0.55))
    await expect(page.locator('#stylemap-selbar')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#stylemap-selbar')).toBeHidden()
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(map.view).toHaveClass(/active/)
    expect(await selectedIds(page)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeVisible()
  })

  test('a plain drag still rotates the map and picks nothing; right-drag pans and the wheel zooms', async ({ page }) => {
    await mockBase(page)
    await mockMembers(page)
    await openMap(page, 1366, 768)
    const camera = () => page.evaluate(() => {
      const scene = (window as any).StyleMap._state.scene
      return { position: scene.camera.position.toArray(), target: scene.controls.target.toArray() }
    })
    const before = await camera()
    const box = await boxOf(page, 0.4)
    await page.mouse.move(box.x0, box.y0)
    await page.mouse.down()
    await page.mouse.move(box.x1, box.y1, { steps: 6 })
    await page.mouse.up()
    const rotated = await camera()
    expect(rotated.position).not.toEqual(before.position)
    expect(rotated.target).toEqual(before.target)
    expect(await selectedIds(page)).toEqual([])
    await expect(page.locator('#stylemap-selbar')).toBeHidden()

    await page.mouse.move(box.x0, box.y0)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(box.x1, box.y1, { steps: 6 })
    await page.mouse.up({ button: 'right' })
    const panned = await camera()
    expect(panned.target).not.toEqual(rotated.target)

    await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)
    await page.mouse.wheel(0, -400)
    await expect.poll(async () => JSON.stringify((await camera()).position)).not.toBe(JSON.stringify(panned.position))
  })

  test('the Box select switch flips its words, makes a plain drag pick, and leaves rotating to the switch being off', async ({ page }) => {
    await mockBase(page)
    await mockMembers(page)
    const map = await openMap(page, 1366, 768, 'en')
    const toggle = page.locator('#stylemap-box-toggle')
    await expect(toggle).toHaveText('Box select: off')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveText('Box select: on')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    const box = await boxOf(page, 0.55)
    const inside = await expectedIds(page, box)
    await dragBox(page, box, { shift: false })
    const expected = inside.flatMap((id) => (id === MERGED_ID ? MERGED_MEMBERS : [id]))
    await expect.poll(() => selectedIds(page)).toEqual(sorted(expected))

    await page.evaluate(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
    await page.reload()
    await map.open()
    await expect(toggle).toHaveText('框选：关')
    await toggle.click()
    await expect(toggle).toHaveText('框选：开')
    await toggle.click()
    await expect(toggle).toHaveText('框选：关')
  })

  test('Shift + click toggles one dot', async ({ page }) => {
    await mockBase(page)
    await mockMembers(page)
    await openMap(page, 1366, 768)
    const spot = await page.evaluate(() => {
      const scene = (window as any).StyleMap._state.scene
      const rect = scene.canvas.getBoundingClientRect()
      const position = scene.geometry.getAttribute('position')
      const Vec = scene.camera.position.constructor
      const p = new Vec(position.getX(7), position.getY(7), position.getZ(7)).project(scene.camera)
      return { id: scene.ids[7], x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
    })
    await page.keyboard.down('Shift')
    await page.mouse.click(spot.x, spot.y)
    await expect.poll(() => selectedIds(page)).toEqual([spot.id])
    await page.mouse.click(spot.x, spot.y)
    await expect.poll(() => selectedIds(page)).toEqual([])
    await page.keyboard.up('Shift')
  })

  for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]] as const) {
    for (const lang of ['en', 'zh-CN']) {
      test(`layout and screenshots at ${width}x${height} in ${lang}`, async ({ page }, testInfo) => {
        const watcher = watch(page)
        await mockBase(page)
        await mockMembers(page)
        const map = await openMap(page, width, height, lang, 30, watcher)
        const shot = async (name: string) => {
          await page.screenshot({ path: testInfo.outputPath(`${name}-${width}-${lang}.png`) })
        }
        const box = await boxOf(page, 0.55)
        await dragBox(page, box, { finish: false })
        await expect(page.locator('.stylemap-lasso')).toBeVisible()
        await shot('1-dragging')
        await page.mouse.up()
        await page.keyboard.up('Shift')
        await expect(page.locator('#stylemap-selbar')).toBeVisible()
        await shot('2-selected')
        const layout = await layoutCheck(page)
        expect(layout).toMatchObject({ pageOverflow: false, barInside: true, barOverlapsReset: false, barOneRow: true, barClipped: false, buttonsOverlap: false, sideClipped: false })
        expect(layout.subbarExtra).toBeLessThanOrEqual(8) // one row: the bar is no taller than its button
        await page.locator('#stylemap-sel-clear').click()
        await page.locator('#stylemap-box-toggle').click()
        await expect(page.locator('#stylemap-box-toggle')).toHaveAttribute('aria-pressed', 'true')
        await shot('3-box-select-on')
        expect((await layoutCheck(page)).subbarExtra).toBeLessThanOrEqual(8)
        void map
        expect(watcher.consoleErrors).toEqual([])
        expect(watcher.httpErrors).toEqual([])
      })
    }
  }

  test('50k dots: projecting and testing a box takes milliseconds', async ({ page }, testInfo) => {
    const n = 50000
    const rows = Array.from({ length: n }, (_, i) => [i + 1, ((i * 7919) % 2000) / 1000 - 1, ((i * 104729) % 2000) / 1000 - 1, ((i * 1299709) % 2000) / 1000 - 1, 1])
    await mockBase(page, pointsBody({ total_images: n, missing_vectors: 0, points: rows, umap: { status: 'unavailable', points: n, min_points: 21, params: UMAP_PARAMS } }))
    await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', by: 'generator', kind: 'category', ids: [], values: [], legend: [], range: null, missing: 0 } }))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/')
    const map = new StyleMapPage(page)
    await map.open()
    await expect.poll(() => map.pointCount(), { timeout: 30000 }).toBe(n)
    const stats = await page.evaluate(async () => {
      const { projectPoints, dotsInRect } = await import('/static/js/style-map/lasso.js')
      const scene = (window as any).StyleMap._state.scene
      const positions = scene.geometry.getAttribute('position').array
      const runs: number[] = []
      let hits = 0
      for (let i = 0; i < 7; i += 1) {
        const started = performance.now()
        const projected = projectPoints(positions, scene.count, scene.camera)
        hits = dotsInRect(projected, scene.count, { u: 0.2, v: 0.2 }, { u: 0.8, v: 0.8 }).length
        runs.push(performance.now() - started)
      }
      runs.sort((a, b) => a - b)
      return { median: runs[3], worst: runs[6], hits }
    })
    testInfo.annotations.push({ type: 'perf', description: `50k project+box median ${stats.median.toFixed(2)} ms worst ${stats.worst.toFixed(2)} ms, ${stats.hits} hits` })
    expect(stats.hits).toBeGreaterThan(1000)
    expect(stats.median).toBeLessThan(20)
  })
})
