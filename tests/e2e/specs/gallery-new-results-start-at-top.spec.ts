import { expect, test, type Page } from '@playwright/test'

/**
 * A new sort or filter while scrolled deep used to keep the old scroll offset:
 * the loading placeholders kept the grid's height, so the new results opened
 * somewhere in their middle (a big grid) or wherever the browser clamped the
 * shrunken page (a small one). New results now open at their top. A refresh of
 * the same results still keeps the reader on their image.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

/** Request parameters that page through one result set without changing it. */
const PAGING_PARAMS = ['cursor', 'offset', 'limit', 'skip_count']

/**
 * Every distinct query (sort, filters) gets its own block of ids, so the page can
 * tell which result set it is showing. Cursor or offset paging, like the backend.
 */
async function mockQueryGallery(page: Page, count: number) {
  const blocks = new Map<string, number>()
  let received = 0
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      await route.continue()
      return
    }
    received += 1
    const query = new URLSearchParams(url.searchParams)
    PAGING_PARAMS.forEach((name) => query.delete(name))
    query.sort()
    const signature = query.toString()
    if (!blocks.has(signature)) blocks.set(signature, 10000 * (blocks.size + 1))
    const base = blocks.get(signature)!
    const cursor = url.searchParams.get('cursor')
    const start = Number(cursor || url.searchParams.get('offset') || 0)
    const limit = Number(url.searchParams.get('limit') || 100)
    const end = Math.min(count, start + limit)
    const images = Array.from({ length: end - start }, (_, index) => ({
      id: base + start + index,
      filename: `set-${base}-${start + index + 1}.png`,
      path: `/mock/set-${base}-${start + index + 1}.png`,
      prompt: `mock prompt ${start + index + 1}`,
    }))
    // A response the page gave up on (a newer load cancelled it) cannot be fulfilled.
    await route.fulfill({ json: {
      images,
      total: cursor ? -1 : count,
      has_more: end < count,
      next_cursor: cursor !== null || start === 0 ? (end < count ? String(end) : null) : null,
      next_offset: end,
    } }).catch(() => {})
  })
  // The missing-files banner would land above the toolbar and push the grid.
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  return { requests: () => received }
}

async function openGallery(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
}

/** Scroll deep, instantly, and wait until the offset holds. */
async function scrollDeep(page: Page, top: number) {
  await expect.poll(() => page.evaluate((target) => {
    window.scrollTo({ top: target, behavior: 'instant' })
    return Math.round(window.scrollY)
  }, top)).toBeGreaterThan(top - 50)
}

/** The id the gallery shows first, and the ids it holds. */
async function shownResults(page: Page) {
  return page.evaluate(() => {
    const images = (window as any).App.AppState.images as Array<{ id: number }>
    return { firstId: images[0]?.id ?? null, count: images.length }
  })
}

/**
 * Wait until the gallery shows a result set other than `oldFirstId` with no load
 * in flight, then two frames more; report where the page is and whether the new
 * first image is on screen.
 */
async function landedOnNewResults(page: Page, oldFirstId: number) {
  await expect.poll(() => page.evaluate((oldId) => {
    const app = (window as any).App
    const first = app.AppState.images[0]?.id
    return !app.AppState.isLoading && first !== undefined && first !== oldId
      && !document.querySelector('#gallery-grid .skeleton-item')
  }, oldFirstId)).toBe(true)
  return page.evaluate(() => new Promise<{ y: number, firstCardTop: number | null }>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const first = (window as any).App.AppState.images[0]
      const card = document.querySelector(`#gallery-grid .gallery-item[data-id="${first.id}"]`)
      resolve({
        y: Math.round(window.scrollY),
        firstCardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      })
    }))
  }))
}

/** Over `ms`, the largest scroll offset seen: something pulling the page back down shows here. */
async function maxScrollOver(page: Page, ms: number) {
  return page.evaluate((span) => new Promise<number>((resolve) => {
    let max = Math.round(window.scrollY)
    const startedAt = performance.now()
    const tick = () => {
      max = Math.max(max, Math.round(window.scrollY))
      if (performance.now() - startedAt > span) resolve(max)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), ms)
}

async function clickWhereItIs(page: Page, selector: string) {
  // locator.click() would scroll the pinned toolbar into view first and move the page.
  const box = await page.locator(selector).boundingBox()
  expect(box, `${selector} is on screen`).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

for (const count of [90, 400]) {
  test(`a new sort while deep in ${count} results opens the new order at its top`, async ({ page }) => {
    await mockQueryGallery(page, count)
    await openGallery(page)
    await scrollDeep(page, 3000)
    const before = await shownResults(page)

    await page.locator('#gallery-sort').selectOption('name_asc')

    const landed = await landedOnNewResults(page, before.firstId!)
    expect(landed.y).toBe(0)
    expect(landed.firstCardTop).not.toBeNull()
    expect(landed.firstCardTop!).toBeGreaterThan(0)
    expect(landed.firstCardTop!).toBeLessThan(768)
    // Nothing carries the page back to where the old results were read.
    expect(await maxScrollOver(page, 800)).toBe(0)
  })
}

test('a quick filter switched on while deep opens its results at their top', async ({ page }) => {
  await mockQueryGallery(page, 400)
  await openGallery(page)
  await scrollDeep(page, 3000)
  const before = await shownResults(page)

  await clickWhereItIs(page, '#chip-no-caption')

  const landed = await landedOnNewResults(page, before.firstId!)
  expect(landed.y).toBe(0)
  expect(landed.firstCardTop).not.toBeNull()
  expect(landed.firstCardTop!).toBeLessThan(768)
  expect(await maxScrollOver(page, 800)).toBe(0)
})

test('a search typed while deep opens its results at their top', async ({ page }) => {
  await mockQueryGallery(page, 90)
  await openGallery(page)
  await scrollDeep(page, 3000)
  const before = await shownResults(page)

  const input = page.locator('#gallery-search-input')
  await input.fill('sunset')
  await input.press('Enter')

  const landed = await landedOnNewResults(page, before.firstId!)
  expect(landed.y).toBe(0)
  expect(landed.firstCardTop).not.toBeNull()
  expect(landed.firstCardTop!).toBeLessThan(768)
  expect(await maxScrollOver(page, 800)).toBe(0)
})

test('a reload of the same results (an import dropped on the window) leaves the page where it is', async ({ page }) => {
  const gallery = await mockQueryGallery(page, 400)
  await openGallery(page)
  await scrollDeep(page, 3000)
  const y = await page.evaluate(() => Math.round(window.scrollY))
  const requestsBefore = gallery.requests()

  // What a drop import does after the files are in: reload the same query.
  await page.evaluate(() => (window as any).App.loadImages())
  await expect.poll(async () => gallery.requests() > requestsBefore && await page.evaluate(() => (
    !(window as any).App.AppState.isLoading && !document.querySelector('#gallery-grid .skeleton-item')
  ))).toBe(true)

  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(y)
})

test('a filter change made from another view leaves that view where it is', async ({ page }) => {
  await mockQueryGallery(page, 90)
  await openGallery(page)
  await page.evaluate(() => (window as any).switchView('autosep'))
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.currentView)).toBe('autosep')
  // Stand down the view as far as it goes (up to 200 px), held across frames.
  let viewTop = -1
  await expect.poll(async () => {
    viewTop = await page.evaluate(() => new Promise<number>((resolve) => {
      const target = Math.min(200, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo({ top: target, behavior: 'instant' })
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(Math.round(window.scrollY) === target ? target : -1)
      }))
    }))
    return viewTop
  }).toBeGreaterThanOrEqual(40)

  await page.evaluate(() => {
    const app = (window as any).App
    app.updateFilters((filters: any) => { filters.sortBy = 'name_asc' })
    app.loadImages()
  })
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.galleryNeedsRefresh)).toBe(true)

  expect(await maxScrollOver(page, 400)).toBe(viewTop)
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(viewTop)
})
