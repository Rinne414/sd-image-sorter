import { expect, test, type Page } from '@playwright/test'

/**
 * "Pick the most different..." in the selection bar's More menu: asks how many,
 * sends the selected pictures, and opens exactly the picked ones in the Gallery.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockLibrary(page: Page, answer: Record<string, unknown>) {
  const asked: Array<Record<string, unknown>> = []
  const pinned: Array<Record<string, unknown>> = []
  const images = Array.from({ length: 9 }, (_, index) => ({
    id: 7001 + index, filename: `varied-${index + 1}.png`, path: `/mock/varied-${index + 1}.png`, prompt: 'mock',
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      await route.continue()
      return
    }
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } }).catch(() => {})
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  await page.route('**/api/similarity/pick-varied', async (route) => {
    asked.push(route.request().postDataJSON())
    await route.fulfill({ json: answer })
  })
  await page.route('**/api/collections/pinned', async (route) => {
    pinned.push(route.request().postDataJSON())
    await route.fulfill({ json: { collection_id: 9100, count: (route.request().postDataJSON().image_ids as number[]).length } })
  })
  return { asked: () => [...asked], pinned: () => [...pinned] }
}

async function selectFive(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.evaluate(() => {
    const app = (window as any).App
    app.setSelectionMode(true)
    app.mutateSelectedIds((ids: Set<number>) => { [7001, 7002, 7003, 7004, 7005].forEach((id) => ids.add(id)) }, { scope: 'visible' })
    app.updateSelectionUI()
    app.emitSelectionStateChanged()
  })
  await expect(page.locator('#gallery-action-bar')).toBeVisible()
  await page.locator('#btn-gallery-action-more').click()
  await page.locator('#btn-pick-varied').click()
  await expect(page.locator('#input-modal-message')).toContainText('5 selected pictures')
}

test('the picked pictures open in the Gallery, selected, and the banner says what they are', async ({ page }) => {
  const library = await mockLibrary(page, { picked: [7003, 7001], considered: 5, not_indexed: 0 })
  await selectFive(page)

  // A number outside 1..4 is refused with the reason.
  await page.locator('#input-modal-field').fill('9')
  await page.locator('#btn-input-ok').click()
  await expect(page.locator('#toast-container .toast.error').last()).toContainText('from 1 to 4')
  expect(library.asked()).toEqual([])

  await page.locator('#btn-gallery-action-more').click()
  await page.locator('#btn-pick-varied').click()
  await page.locator('#input-modal-field').fill('2')
  await page.locator('#btn-input-ok').click()

  await expect.poll(() => library.asked()).toEqual([{ image_ids: [7001, 7002, 7003, 7004, 7005], count: 2 }])
  await expect.poll(() => library.pinned()).toEqual([{ image_ids: [7003, 7001] }])
  await expect(page.locator('#gallery-pin-banner-title')).toHaveText('2 picked for variety')
  await expect(page.locator('#toast-container .toast.success').last()).toContainText('Picked 2 of 5 for variety')
})

test('pictures outside the similarity index are counted, and none at all says where to build it', async ({ page }) => {
  const library = await mockLibrary(page, { picked: [7002], considered: 3, not_indexed: 2 })
  await selectFive(page)
  await page.locator('#input-modal-field').fill('1')
  await page.locator('#btn-input-ok').click()
  await expect(page.locator('#toast-container .toast.warning').last()).toContainText('2 pictures are not in the similarity index')
  expect(library.pinned()).toEqual([{ image_ids: [7002] }])
})

test('with no picture in the similarity index nothing is opened and the Similar page is one press away', async ({ page }) => {
  const library = await mockLibrary(page, { picked: [], considered: 0, not_indexed: 5 })
  await selectFive(page)
  await page.locator('#input-modal-field').fill('2')
  await page.locator('#btn-input-ok').click()
  const toast = page.locator('#toast-container .toast.warning').last()
  await expect(toast).toContainText('similarity index')
  expect(library.pinned()).toEqual([])
  await toast.getByRole('button', { name: 'Open Similar' }).click()
  await expect(page.locator('#view-similar.active')).toBeVisible()
})
