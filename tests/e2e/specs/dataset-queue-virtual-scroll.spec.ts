import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Issue #5 point 2, virtualized queue: above DATASET_VIRTUAL_THRESHOLD (800)
 * the Dataset Maker queue is virtual-scrolled. Clicking a picture that is
 * already fully on screen must leave the queue where it is; only a picture
 * outside the viewport scrolls, and then just far enough to show it.
 */

const QUEUE_SIZE = 900
const FIRST_ID = 10_000

async function seedLargeQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/image-file/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(({ size, firstId }) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = Array.from({ length: size }, (_, i) => firstId + i)
    for (const id of dm.imageIds) dm.meta.set(id, { filename: `big_${id}.png`, width: 96, height: 96 })
    ;(window as any).App.switchView('dataset')
  }, { size: QUEUE_SIZE, firstId: FIRST_ID })
  await page.locator('#dataset-tab-workbench').click()
  // List rows have a fixed height, so several fit on screen at any viewport
  // width; grid and list share the same scroll-into-view path.
  await page.evaluate(() => (window as any).DatasetMaker._setQueueViewMode('list'))
  await expect(page.locator('#dataset-queue-list.is-virtualized .dataset-queue-item').first()).toBeVisible()
}

/** Scroll the queue to its middle and describe the rows fully inside the viewport. */
async function scrollToMiddle(page: Page) {
  const list = page.locator('#dataset-queue-list')
  await list.evaluate((el) => { el.scrollTop = Math.floor(el.scrollHeight / 2) })
  const describe = () => list.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const visible = [...el.querySelectorAll<HTMLElement>('.dataset-queue-item')]
      .filter((item) => {
        const r = item.getBoundingClientRect()
        return r.top >= box.top && r.bottom <= box.bottom
      })
      .map((item) => Number(item.dataset.imageId))
      .sort((a, b) => a - b)
    return { scrollTop: el.scrollTop, visible }
  })
  // The virtual renderer repaints on the scroll event; wait for the new rows.
  await expect.poll(async () => (await describe()).visible.length).toBeGreaterThan(1)
  return describe()
}

async function itemOffset(page: Page, id: number) {
  return page.locator('#dataset-queue-list').evaluate((el, imageId) => {
    const box = el.getBoundingClientRect()
    const item = el.querySelector<HTMLElement>(`.dataset-queue-item[data-image-id="${imageId}"]`)
    if (!item) return null
    const r = item.getBoundingClientRect()
    return { top: Math.round(r.top - box.top), bottom: Math.round(box.bottom - r.bottom) }
  }, id)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
})

test('clicking a fully visible picture keeps the virtualized queue where it is', async ({ page }) => {
  await seedLargeQueue(page)
  const before = await scrollToMiddle(page)
  expect(before.visible.length).toBeGreaterThan(1)
  const target = before.visible[before.visible.length - 1]

  await page.locator(`#dataset-queue-list .dataset-queue-item[data-image-id="${target}"]`).click()

  await expect.poll(() => page.evaluate(() => Number((window as any).DatasetMaker.activeId))).toBe(target)
  const scrollTop = await page.locator('#dataset-queue-list').evaluate((el) => el.scrollTop)
  expect(Math.abs(scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
})

test('a picture on screen but not yet drawn by the virtual renderer does not move the queue', async ({ page }) => {
  await seedLargeQueue(page)
  await scrollToMiddle(page)
  // Jump and activate in the same task: the renderer repaints on the next
  // frame, so the target row is inside the viewport but has no DOM node yet.
  const result = await page.evaluate(({ firstId }) => {
    const LIST_ROW_HEIGHT = 108 // DATASET_QUEUE_LIST_HEIGHT, one column in list mode
    const list = document.getElementById('dataset-queue-list')!
    list.scrollTop = Math.floor(list.scrollHeight / 4)
    const scrollTop = list.scrollTop
    const row = Math.ceil(scrollTop / LIST_ROW_HEIGHT)
    const id = firstId + row
    const mounted = !!list.querySelector(`.dataset-queue-item[data-image-id="${id}"]`)
    ;(window as any).DatasetMaker._setActive(id)
    return { scrollTop, after: list.scrollTop, clientHeight: list.clientHeight, mounted }
  }, { firstId: FIRST_ID })
  expect(result.mounted).toBe(false)
  expect(result.clientHeight).toBeGreaterThanOrEqual(216)
  expect(Math.abs(result.after - result.scrollTop)).toBeLessThanOrEqual(1)
})

test('moving to a picture below the viewport scrolls only until it is fully shown', async ({ page }) => {
  await seedLargeQueue(page)
  const before = await scrollToMiddle(page)
  const below = before.visible[before.visible.length - 1] + 40

  await page.evaluate((id) => (window as any).DatasetMaker._setActive(id), below)

  await expect.poll(() => itemOffset(page, below)).not.toBeNull()
  const offset = await itemOffset(page, below)
  expect(offset!.top).toBeGreaterThanOrEqual(0)
  expect(offset!.bottom).toBeGreaterThanOrEqual(0)
  // Minimal scroll: the picture lands at the bottom edge, not the top.
  expect(offset!.bottom).toBeLessThan(offset!.top)
})

test('moving to a picture above the viewport aligns it with the top edge', async ({ page }) => {
  await seedLargeQueue(page)
  const before = await scrollToMiddle(page)
  const above = before.visible[0] - 40

  await page.evaluate((id) => (window as any).DatasetMaker._setActive(id), above)

  await expect.poll(() => itemOffset(page, above)).not.toBeNull()
  const offset = await itemOffset(page, above)
  expect(offset!.top).toBeGreaterThanOrEqual(0)
  expect(offset!.top).toBeLessThanOrEqual(1)
})
