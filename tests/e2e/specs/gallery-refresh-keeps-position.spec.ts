import { expect, test, type Page } from '@playwright/test'

/**
 * A refresh of the same gallery - a tagging run finishing, images moved to the
 * Trash - used to replace the whole grid with loading placeholders. The page
 * shrank, the browser pulled the scroll offset up, and only the first page came
 * back: the reader lost the image they were on. These refreshes now happen in
 * place and put the reader back on their image.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

interface PagedGallery {
  /** /api/images requests received so far. */
  requests: () => number
  /** Ids the next responses leave out, as if their files went to the Trash. */
  deleted: Set<number>
  /** Hold the next /api/images response until the returned function is called. */
  holdNext: () => () => void
  /** Answer the next /api/images request with a server error. */
  failNext: () => void
}

/**
 * A newest-first library served page by page, the way the backend pages it: the
 * first page counts the results, later cursor pages skip the COUNT (total -1),
 * and cursor pages carry no next_offset.
 */
async function mockPagedGallery(page: Page, count: number): Promise<PagedGallery> {
  const all = Array.from({ length: count }, (_, index) => ({
    id: 1001 + index,
    filename: `refresh-${index + 1}.png`,
    path: `/mock/refresh-${index + 1}.png`,
    prompt: `mock prompt ${index + 1}`,
  }))
  const deleted = new Set<number>()
  let received = 0
  let hold: Promise<void> | null = null
  let failing = false
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
    const held = hold
    hold = null
    if (failing) {
      failing = false
      await route.fulfill({ status: 500, json: { detail: 'mock failure' } })
      return
    }
    if (held) await held
    const images = all.filter((image) => !deleted.has(image.id))
    const cursor = url.searchParams.get('cursor')
    const start = Number(cursor || 0)
    const limit = Number(url.searchParams.get('limit') || 100)
    const end = Math.min(images.length, start + limit)
    // A response the page gave up on (a newer load cancelled it) cannot be fulfilled.
    await route.fulfill({ json: {
      images: images.slice(start, end),
      total: cursor ? -1 : images.length,
      has_more: end < images.length,
      next_cursor: end < images.length ? String(end) : null,
    } }).catch(() => {})
  })
  // The missing-files banner would land above the toolbar and push the grid.
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  return {
    requests: () => received,
    deleted,
    holdNext: () => {
      let release: () => void = () => {}
      hold = new Promise<void>((resolve) => { release = resolve })
      return release
    },
    failNext: () => { failing = true },
  }
}

async function openGallery(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
}

/** Scroll so the card at `index` sits a little below the top of the window. */
async function readAt(page: Page, index: number) {
  await expect.poll(() => page.evaluate((target) => {
    const gallery = (window as any).Gallery
    const image = (window as any).App.AppState.images[target]
    if (!image) return false
    const grid = document.getElementById('gallery-grid')!
    const gridTop = grid.getBoundingClientRect().top + window.scrollY
    // A virtual grid knows where every card goes; a small one has them all in the DOM.
    const layout = gallery.useVirtualScroll ? gallery.virtualList?.getLayoutForIndex?.(target) : null
    const card = document.querySelector(`#gallery-grid .gallery-item[data-id="${image.id}"]`) as HTMLElement | null
    const cardTop = layout ? gridTop + layout.top : (card ? card.getBoundingClientRect().top + window.scrollY : null)
    if (cardTop === null) return false
    window.scrollTo({ top: cardTop - 60, behavior: 'instant' })
    return document.querySelector(`#gallery-grid .gallery-item[data-id="${image.id}"]`) !== null
  }, index)).toBe(true)
  // The image the reader is on, as the gallery itself sees it.
  return page.evaluate(() => {
    const anchor = (window as any).Gallery._captureViewAnchor()
    return { imageId: String(anchor.imageId), top: Math.round(anchor.offset), y: Math.round(window.scrollY) }
  })
}

/** Record the scroll offset every frame until stopped. */
async function startScrollRecorder(page: Page) {
  await page.evaluate(() => {
    const ys: number[] = []
    const state = { ys, running: true }
    ;(window as any).__scrollRecorder = state
    const tick = () => {
      ys.push(Math.round(window.scrollY))
      if (state.running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopScrollRecorder(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const state = (window as any).__scrollRecorder
    state.running = false
    return state.ys
  })
}

/** The refresh has landed: no load in flight, and two frames have passed. */
async function waitForRefreshSettled(page: Page, gallery: PagedGallery, requestsBefore: number) {
  await expect.poll(() => gallery.requests()).toBeGreaterThan(requestsBefore)
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.isLoading)).toBe(false)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function imageTop(page: Page, imageId: string) {
  return page.evaluate((id) => {
    const item = document.querySelector(`#gallery-grid .gallery-item[data-id="${id}"]`)
    return item ? Math.round(item.getBoundingClientRect().top) : null
  }, imageId)
}

/** Report a tagging run as running until `finish()` is called, then as done. */
async function mockTaggingRun(page: Page) {
  let finished = false
  await page.route('**/api/tag/progress**', async (route) => {
    await route.fulfill({ json: finished
      ? { status: 'done', processed: 2, total: 2, completed: 2, tagged: 2, errors: 0 }
      : { status: 'running', processed: 1, total: 2, tagged: 1, errors: 0 } })
  })
  return { finish: () => { finished = true } }
}

// 90 results stay below the virtual grid's threshold (96): every card is in the
// DOM and the refresh used to empty the grid. 400 results take the virtual grid.
for (const { count, readIndex } of [{ count: 90, readIndex: 60 }, { count: 400, readIndex: 160 }]) {
  test(`a tagging run that finishes while you read deep in ${count} results leaves you on your image`, async ({ page }) => {
    const gallery = await mockPagedGallery(page, count)
    const tagging = await mockTaggingRun(page)
    await openGallery(page)
    // The launch picked the running tag job up and is polling it.
    await expect(page.locator('#bg-tag-progress')).toBeVisible()

    const reader = await readAt(page, readIndex)
    expect(reader.y).toBeGreaterThan(1000)
    const requestsBefore = gallery.requests()
    await startScrollRecorder(page)
    tagging.finish()
    await waitForRefreshSettled(page, gallery, requestsBefore)
    const ys = await stopScrollRecorder(page)

    // The page never jumped while the gallery refreshed...
    expect(Math.min(...ys), JSON.stringify(ys)).toBeGreaterThanOrEqual(reader.y - 4)
    expect(Math.max(...ys), JSON.stringify(ys)).toBeLessThanOrEqual(reader.y + 4)
    // ...and the reader is still on their image.
    const top = await imageTop(page, reader.imageId)
    expect(top).not.toBeNull()
    expect(Math.abs(top! - reader.top)).toBeLessThanOrEqual(4)
  })
}


async function loadedIds(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as any).App.AppState.images.map((image: any) => image.id))
}

test('a refresh after reading past a thousand images keeps every loaded page and your image', async ({ page }) => {
  test.setTimeout(90_000)
  const gallery = await mockPagedGallery(page, 2500)
  const tagging = await mockTaggingRun(page)
  await openGallery(page)
  await expect(page.locator('#bg-tag-progress')).toBeVisible()

  // Scroll to the end of what is loaded until more than a thousand images are in.
  await expect.poll(async () => page.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
    return (window as any).App.AppState.images.length
  }), { timeout: 60_000 }).toBeGreaterThan(1100)
  const idsBefore = await loadedIds(page)

  const reader = await readAt(page, 1050)
  const requestsBefore = gallery.requests()
  tagging.finish()
  await waitForRefreshSettled(page, gallery, requestsBefore)

  // Every image loaded before is still loaded, in order, once each (the last
  // page refetched is a full one, so a few more may follow them), and the
  // library total comes from the first page, not a later page's -1.
  const idsAfter = await loadedIds(page)
  expect(idsAfter.slice(0, idsBefore.length)).toEqual(idsBefore)
  expect(new Set(idsAfter).size).toBe(idsAfter.length)
  expect(await page.evaluate(() => (window as any).App.AppState.pagination.total)).toBe(2500)
  const top = await imageTop(page, reader.imageId)
  expect(top).not.toBeNull()
  expect(Math.abs(top! - reader.top)).toBeLessThanOrEqual(4)

  // Reading on loads the page after them, not a repeat of the start.
  await expect.poll(async () => page.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
    return (window as any).App.AppState.images.length
  }), { timeout: 30_000 }).toBeGreaterThan(idsAfter.length)
  const idsLater = await loadedIds(page)
  expect(new Set(idsLater).size).toBe(idsLater.length)
  expect(idsLater.slice(0, idsAfter.length)).toEqual(idsAfter)
})

// Both grids shift when an image above the reader goes: the small one draws
// every card, the virtual one positions them.
for (const { count, readIndex, deleteIndex } of [
  { count: 90, readIndex: 60, deleteIndex: 30 },
  { count: 400, readIndex: 160, deleteIndex: 100 },
]) {
  test(`moving an image above you to the Trash keeps you on your image (${count} results)`, async ({ page }) => {
    const gallery = await mockPagedGallery(page, count)
    let deletedId = 0
    await page.route('**/api/images/delete-selected/start', async (route) => {
      gallery.deleted.add(deletedId)
      await route.fulfill({ json: { status: 'started', total: 1 } })
    })
    await page.route('**/api/images/delete-selected/progress', async (route) => {
      await route.fulfill({ json: { status: 'done', total: 1, processed: 1, deleted: 1, failed: [] } })
    })
    await openGallery(page)

    const reader = await readAt(page, readIndex)
    deletedId = (await loadedIds(page))[deleteIndex]
    const requestsBefore = gallery.requests()
    // What the card's right-click "Move to Trash..." runs, then the real confirm.
    await page.evaluate((id) => { void (window as any).App.deleteGalleryImagesByIds([id]) }, deletedId)
    await page.locator('#btn-confirm-ok').click()
    await waitForRefreshSettled(page, gallery, requestsBefore)

    expect(await loadedIds(page)).not.toContain(deletedId)
    const top = await imageTop(page, reader.imageId)
    expect(top).not.toBeNull()
    expect(Math.abs(top! - reader.top)).toBeLessThanOrEqual(4)
  })
}

test('a refresh that lands while new results are loading, and fails, does not leave placeholders up', async ({ page }) => {
  const gallery = await mockPagedGallery(page, 400)
  const tagging = await mockTaggingRun(page)
  await openGallery(page)
  await expect(page.locator('#bg-tag-progress')).toBeVisible()
  await readAt(page, 160)

  // A new sort order: the grid shows placeholders while its results are held back.
  const release = gallery.holdNext()
  const requestsBefore = gallery.requests()
  await page.locator('#sort-reverse-btn').click()
  await expect.poll(() => gallery.requests()).toBeGreaterThan(requestsBefore)
  await expect(page.locator('#gallery-grid .skeleton-item').first()).toBeAttached()

  // The tagging run finishes now, and the refresh it starts fails.
  gallery.failNext()
  const requestsBeforeRefresh = gallery.requests()
  tagging.finish()
  await expect.poll(() => gallery.requests()).toBeGreaterThan(requestsBeforeRefresh)
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.isLoading)).toBe(false)
  release()

  // The gallery shows real cards again, not placeholders.
  await expect(page.locator('#gallery-grid .skeleton-item')).toHaveCount(0)
  await expect(page.locator('#gallery-grid .gallery-item[data-id]').first()).toBeVisible()
})

test('two refreshes that overlap still leave you on your image', async ({ page }) => {
  const gallery = await mockPagedGallery(page, 90)
  await openGallery(page)

  const reader = await readAt(page, 60)
  expect(reader.y).toBeGreaterThan(1000)
  await startScrollRecorder(page)
  // A job finishes and its refresh is still on the way when a second one lands
  // (another job finishing, a Trash move): the second takes over.
  const release = gallery.holdNext()
  const requestsBefore = gallery.requests()
  await page.evaluate(() => { void (window as any).App.loadImages(false, { keepPosition: true }) })
  await expect.poll(() => gallery.requests()).toBeGreaterThan(requestsBefore)
  await page.evaluate(() => { void (window as any).App.loadImages(false, { keepPosition: true }) })
  await waitForRefreshSettled(page, gallery, requestsBefore + 1)
  release()
  const ys = await stopScrollRecorder(page)

  expect(Math.min(...ys), JSON.stringify(ys)).toBeGreaterThanOrEqual(reader.y - 4)
  expect(Math.max(...ys), JSON.stringify(ys)).toBeLessThanOrEqual(reader.y + 4)
  const top = await imageTop(page, reader.imageId)
  expect(top).not.toBeNull()
  expect(Math.abs(top! - reader.top)).toBeLessThanOrEqual(4)
})
