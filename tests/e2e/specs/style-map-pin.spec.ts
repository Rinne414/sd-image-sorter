import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { expect, test, type Page } from '../fixtures/click-ledger'
import { StyleMapPage } from '../pages/StyleMapPage'

/**
 * "View in Gallery" from a Style Map box selection (S4b): the Gallery shows
 * only the picked pictures, all of them selected across pages, with a banner
 * whose x gives the previous filter back. Real backend and real scanned
 * pictures (80, one more page than the Gallery loads at once); only
 * /api/style-map/* is mocked.
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const folder = path.join(repoRoot, '.tmp', 'manual-test', 's4b-pin')
const COUNT = 80
const MAP_ID = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const UMAP_PARAMS = { n_neighbors: 15, min_dist: 0.1, metric: 'cosine', input_dim: 64, random_state: 0 }

function png(shade: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 32 * 3 }, (_, i) => (i % 3 === 0 ? shade : (i * 7 + shade) % 255)))])
  const raw = Buffer.concat(Array.from({ length: 32 }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function seedPictures(request: any): Promise<number[]> {
  fs.mkdirSync(folder, { recursive: true })
  for (let i = 0; i < COUNT; i += 1) fs.writeFileSync(path.join(folder, `s4bpin_${String(i).padStart(3, '0')}.png`), png(i * 3))
  const started = await request.post('/api/scan', { data: { folder_path: folder, recursive: true } })
  expect(started.ok()).toBeTruthy()
  await expect.poll(async () => String((await (await request.get('/api/scan/progress')).json()).status || ''), { timeout: 60000 }).toBe('done')
  const listed = await (await request.get('/api/images?search=s4bpin_&limit=200')).json()
  const ids = (listed.images as Array<{ id: number }>).map((image) => image.id)
  expect(ids).toHaveLength(COUNT)
  return ids
}

function pointsBody(ids: number[]) {
  const points = ids.map((id, i) => [id, (i % 10) / 9 - 0.5, Math.floor(i / 10) / 7 - 0.5, ((i * 7) % 5) / 4 - 0.5, 1])
  return {
    status: 'ok', space: 'kaloscope', method: 'pca', model_version: 'kaloscope:test',
    total_images: ids.length, missing_vectors: 0, unlocatable: [], merged_away: 0,
    explained_variance: [0.05, 0.04, 0.03], points_layout: ['id', 'x', 'y', 'z', 'members'], points,
    umap: { status: 'unavailable', points: ids.length, min_points: 21, params: UMAP_PARAMS, install: { model_id: 'style-map-umap', packages: ['umap-learn>=0.5.12'] } },
    map_id: MAP_ID, cached: false,
  }
}

async function mockStyleMap(page: Page, ids: number[]) {
  await page.route('**/api/style-map/vectors/progress', (route) =>
    route.fulfill({ json: { running: false, paused: false, total: 0, processed: 0, written: 0, kept: 0, errors: 0, step: 'idle', message: '', recent_issues: [] } }))
  await page.route('**/api/style-map/points**', (route) => route.fulfill({ json: pointsBody(ids) }))
  await page.route('**/api/style-map/regions**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', method: 'pca', regions: [], cached: false } }))
  await page.route('**/api/style-map/colors**', (route) => route.fulfill({ json: { status: 'ok', space: 'kaloscope', by: 'generator', kind: 'category', ids, values: ids.map(() => 0), legend: [{ key: 'nai', label: 'nai', count: ids.length }], range: null, missing: 0 } }))
}

async function pickEverything(page: Page) {
  const rect = (await page.locator('#stylemap-canvas').boundingBox())!
  const x0 = rect.x + rect.width * 0.02
  const y0 = rect.y + rect.height * 0.02
  const x1 = rect.x + rect.width * 0.98
  const y1 = rect.y + rect.height * 0.98
  await page.keyboard.down('Shift')
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 })
  await page.mouse.move(x1, y1, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await expect(page.locator('#stylemap-selbar')).toBeVisible()
}

const appState = (page: Page) => page.evaluate(() => {
  const app = (window as any).App
  return {
    view: app.AppState.currentView,
    collectionId: app.AppState.filters.collectionId,
    total: app.AppState.pagination.total,
    loaded: app.AppState.images.length,
    hasMore: app.AppState.pagination.hasMore,
    scope: app.AppState.selectionScope,
    selected: app.getSelectedGalleryCount(),
  }
})

async function openStyleMap(page: Page, lang: string, width = 1366, height = 768) {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.evaluate((code) => localStorage.setItem('sd-image-sorter-lang', code), lang)
  await page.reload()
  const map = new StyleMapPage(page)
  await map.open()
  await expect.poll(() => map.pointCount(), { timeout: 30000 }).toBe(COUNT)
  return map
}

test.describe('Style Map: view in Gallery', () => {
  // The axis meanings (S4e) are not under test here: an empty answer keeps the real backend out of it.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/style-map/axes**', (route) => route.fulfill({ json: { status: 'empty', space: 'kaloscope', layout: 'pca', axes: {} } }))
  })

  test('the Gallery shows only the picked pictures, all selected across pages, and the x restores the Gallery', async ({ page, request }) => {
    const ids = await seedPictures(request)
    const everything = (await (await request.get('/api/images?limit=1')).json()).total
    await mockStyleMap(page, ids)
    await openStyleMap(page, 'en')
    await pickEverything(page)
    await expect(page.locator('#stylemap-selbar-count')).toHaveText(`${COUNT} selected`)
    // Pages of 50 (switching to the Gallery would reset the size, so pin it): the 80 pictures need a second page.
    await page.evaluate(() => { Object.defineProperty((window as any).App.AppState.pagination, 'pageSize', { get: () => 50, set: () => {}, configurable: true }) })

    await page.locator('#stylemap-sel-gallery').click()

    await expect(page.locator('#view-gallery')).toHaveClass(/active/)
    const banner = page.locator('#gallery-pin-banner')
    await expect(banner).toBeVisible()
    await expect(page.locator('#gallery-pin-banner-title')).toHaveText(`${COUNT} from the Style Map`)
    await expect.poll(async () => (await appState(page)).total).toBe(COUNT)
    // Page one only: the selection must still cover every picture, not the loaded ones.
    await expect.poll(async () => {
      const state = await appState(page)
      return `${state.scope}:${state.selected}`
    }).toBe(`filtered:${COUNT}`)
    const first = await appState(page)
    expect(first.loaded).toBeLessThan(COUNT)
    expect(first.hasMore).toBe(true)
    expect(first.scope).toBe('filtered')
    for (let guard = 0; guard < 6 && (await appState(page)).loaded < COUNT; guard += 1) {
      await page.evaluate(() => (window as any).App.loadImages(true))
      await page.waitForTimeout(400)
    }
    const after = await appState(page)
    expect(after.loaded).toBe(COUNT)
    expect(after.selected).toBe(COUNT)
    const shown = await page.evaluate(() => [...(window as any).App.AppState.images].map((image: any) => image.id).sort((a: number, b: number) => a - b))
    expect(shown).toEqual([...ids].sort((a, b) => a - b))

    await page.locator('#gallery-pin-banner-clear').click()
    await expect(banner).toBeHidden()
    await expect.poll(async () => (await appState(page)).collectionId).toBeNull()
    await expect.poll(async () => (await appState(page)).total).toBe(everything)
    expect((await appState(page)).selected).toBe(0)
  })

  test('a pin the server no longer has says so after a reload and never shows the whole Gallery as if it were the pick', async ({ page, request }) => {
    const ids = await seedPictures(request)
    await mockStyleMap(page, ids)
    await openStyleMap(page, 'en')
    await pickEverything(page)
    await page.locator('#stylemap-sel-gallery').click()
    await expect(page.locator('#gallery-pin-banner')).toBeVisible()
    const pinned = await appState(page)
    const removed = await request.delete(`/api/collections/pinned/${pinned.collectionId}`)
    expect(removed.ok()).toBeTruthy()

    await page.reload()
    await expect(page.locator('#gallery-pin-banner')).toBeVisible()
    await expect(page.locator('#gallery-pin-banner-title')).toHaveText('This set of pictures is no longer available')
    await expect.poll(async () => (await appState(page)).total).toBe(0)

    await page.locator('#gallery-pin-banner-clear').click()
    await expect(page.locator('#gallery-pin-banner')).toBeHidden()
    await expect.poll(async () => (await appState(page)).total).toBeGreaterThanOrEqual(COUNT)
  })

  test('a pin removed while it is on screen turns the banner into "no longer available" on the next load', async ({ page, request }) => {
    const ids = await seedPictures(request)
    await mockStyleMap(page, ids)
    await openStyleMap(page, 'en')
    await pickEverything(page)
    await page.locator('#stylemap-sel-gallery').click()
    await expect(page.locator('#gallery-pin-banner-title')).toHaveText(`${COUNT} from the Style Map`)
    await expect.poll(async () => (await appState(page)).total).toBe(COUNT)
    const pinned = await appState(page)
    expect((await request.delete(`/api/collections/pinned/${pinned.collectionId}`)).ok()).toBeTruthy()

    await page.evaluate(() => (window as any).App.loadImages())

    await expect.poll(async () => (await appState(page)).total).toBe(0)
    await expect(page.locator('#gallery-pin-banner-title')).toHaveText('This set of pictures is no longer available')
    await page.locator('#gallery-pin-banner-clear').click()
    await expect(page.locator('#gallery-pin-banner')).toBeHidden()
  })

  test('Send to Censor hands over a selection token that names exactly the picked pictures', async ({ page, request }) => {
    const ids = await seedPictures(request)
    await mockStyleMap(page, ids)
    await openStyleMap(page, 'en')
    await page.evaluate(() => {
      const calls: any[] = []
      ;(window as any).__censorCalls = calls
      ;(window as any).initCensorEdit = () => {}
      ;(window as any).CensorEdit = { addToQueue: (source: unknown) => { calls.push(source); return true } }
    })
    await pickEverything(page)
    await expect(page.locator('#stylemap-selbar-count')).toHaveText(`${COUNT} selected`)
    await page.locator('#stylemap-sel-censor').click()
    await expect.poll(() => page.evaluate(() => (window as any).__censorCalls.length)).toBe(1)
    const source = await page.evaluate(() => (window as any).__censorCalls[0])
    expect(source.total).toBe(COUNT)
    expect(typeof source.selectionToken).toBe('string')
    const chunk = await (await request.get(`/api/images/selection-chunk?selection_token=${encodeURIComponent(source.selectionToken)}&limit=200`)).json()
    expect([...chunk.image_ids].sort((a: number, b: number) => a - b)).toEqual([...ids].sort((a, b) => a - b))
  })

  for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]] as const) {
    for (const lang of ['en', 'zh-CN']) {
      test(`banner layout and screenshot at ${width}x${height} in ${lang}`, async ({ page, request }, testInfo) => {
        const ids = await seedPictures(request)
        await mockStyleMap(page, ids)
        await openStyleMap(page, lang, width, height)
        await pickEverything(page)
        await page.locator('#stylemap-sel-gallery').click()
        await expect(page.locator('#gallery-pin-banner')).toBeVisible()
        await expect.poll(async () => (await appState(page)).total).toBe(COUNT)
        await expect(page.locator('#gallery-pin-banner-title')).toHaveText(lang === 'en' ? `${COUNT} from the Style Map` : `来自画风地图的 ${COUNT} 张`)
        const layout = await page.evaluate(() => {
          const banner = document.querySelector('#gallery-pin-banner') as HTMLElement
          const rect = banner.getBoundingClientRect()
          const x = (document.querySelector('#gallery-pin-banner-clear') as HTMLElement).getBoundingClientRect()
          const title = (document.querySelector('#gallery-pin-banner-title') as HTMLElement).getBoundingClientRect()
          const toolbar = (document.querySelector('#gallery-toolbar') as HTMLElement).getBoundingClientRect()
          return {
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
            xInside: x.right <= rect.right + 0.5 && x.left >= rect.left - 0.5,
            titleInside: title.right <= x.left + 0.5,
            oneLine: rect.height < 70 * (rect.width / 1200 > 1 ? 1.5 : 1),
            aboveToolbar: rect.bottom <= toolbar.top + 1,
          }
        })
        expect(layout).toEqual({ overflowX: false, xInside: true, titleInside: true, oneLine: true, aboveToolbar: true })
        await page.screenshot({ path: testInfo.outputPath(`pin-banner-${width}-${lang}.png`) })
      })
    }
  }
})
