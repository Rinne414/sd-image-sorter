import { expect, test, type Page } from '@playwright/test'

/**
 * In the Dataset Maker queue grid, every thumbnail carries its queue-order
 * number in the bottom-left corner, and the filename strip (shown on the
 * picture being edited and on hover) ran along the same bottom edge: the name
 * was drawn straight over the number. The number stays put and the name now
 * sits above it. The strip is tallest with a caption-type chip (NL / B+N)
 * under the name, so both tested thumbnails carry one; the widths cover the
 * three grid cell sizes (100 px below 1440, 108 px up to ~1894, 144 px above).
 */

const NAMES = ['a.png', 'portrait_of_a_girl_in_the_rain_0042.png', 'c.png', 'very_long_filename_for_testing_layout_2026.png']
const FIRST_ID = 701

async function openQueueGrid(page: Page, width: number, height: number) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(({ names, firstId }) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = names.map((_: string, index: number) => firstId + index)
    names.forEach((name: string, index: number) => dm.meta.set(firstId + index, { filename: name, width: 1024, height: 1024 }))
    dm.captionType.set(firstId + 1, 'nl')
    dm.captionType.set(firstId + 3, 'both')
    ;(window as any).App.switchView('dataset')
  }, { names: NAMES, firstId: FIRST_ID })
  await page.locator('#dataset-tab-workbench').click()
  await page.evaluate((activeId) => {
    const dm = (window as any).DatasetMaker
    dm._setQueueViewMode('grid')
    dm._setActive(activeId)
  }, FIRST_ID + 1)
  await expect(page.locator('#dataset-queue-list.dataset-queue-grid-mode .dataset-queue-item.active')).toBeVisible()
}

/** The number and the filename of one thumbnail, once the strip is fully shown. */
async function badgeAndName(page: Page, imageId: number) {
  const item = page.locator(`#dataset-queue-list .dataset-queue-item[data-image-id="${imageId}"]`)
  await expect.poll(() => item.locator('.dataset-queue-meta').evaluate((meta) => getComputedStyle(meta).opacity)).toBe('1')
  return item.evaluate((node) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
    const order = node.querySelector('.dataset-queue-order')!
    const orderBox = box(order)
    const chip = node.querySelector('.dataset-queue-captype')
    const hit = document.elementFromPoint((orderBox.left + orderBox.right) / 2, (orderBox.top + orderBox.bottom) / 2)
    return {
      item: box(node),
      order: orderBox,
      name: box(node.querySelector('.dataset-queue-filename')!),
      chip: chip ? box(chip) : null,
      numberShows: Boolean(hit && (hit === order || order.contains(hit))),
    }
  })
}

type Box = { left: number, top: number, right: number, bottom: number }
const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

function expectClear(found: Awaited<ReturnType<typeof badgeAndName>>) {
  const { item, order, name, chip } = found
  expect(overlap(name, order), `filename ${JSON.stringify(name)} covers the number ${JSON.stringify(order)}`).toBe(false)
  expect(found.numberShows).toBe(true)
  expect(name.top).toBeGreaterThanOrEqual(item.top)
  expect(name.bottom).toBeLessThanOrEqual(order.top)
  expect(chip, 'the tested thumbnail carries a caption-type chip').not.toBeNull()
  expect(overlap(chip!, order), `chip ${JSON.stringify(chip)} covers the number ${JSON.stringify(order)}`).toBe(false)
  expect(chip!.top).toBeGreaterThanOrEqual(item.top)
}

for (const [width, height] of [[1366, 768], [1600, 900], [1920, 1080], [2560, 1440]]) {
  test(`the picture being edited shows its name above its queue number at ${width}x${height}`, async ({ page }) => {
    await openQueueGrid(page, width, height)
    expectClear(await badgeAndName(page, FIRST_ID + 1))
  })

  test(`a hovered thumbnail shows its name above its queue number at ${width}x${height}`, async ({ page }) => {
    await openQueueGrid(page, width, height)
    const hovered = FIRST_ID + 3
    await page.locator(`#dataset-queue-list .dataset-queue-item[data-image-id="${hovered}"] .dataset-queue-thumb`).hover()
    expectClear(await badgeAndName(page, hovered))
  })
}
