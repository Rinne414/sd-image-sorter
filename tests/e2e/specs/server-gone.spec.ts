import { expect, test, type Page } from '@playwright/test'

/**
 * With the page open and the program's server stopped, nothing said so: the
 * folder refresh did nothing and the preview only said it failed. One banner now
 * says the program stopped and goes away when it is back; the folder refresh and
 * the preview give a reason and a retry. The server is "stopped" here by
 * refusing every /api request in the browser, so no real server is touched.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openGallery(page: Page) {
  const state = { down: false, detailRequests: 0 }
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: 5201 + index, filename: `gone-${index + 1}.png`, path: `/mock/gone-${index + 1}.png`, width: 64, height: 64,
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/images') {
      await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
    } else {
      await route.fallback()
    }
  })
  // Registered last, so it answers first: a stopped server refuses everything.
  await page.route('**/api/**', async (route) => {
    if (/\/api\/images\/\d+$/.test(new URL(route.request().url()).pathname)) state.detailRequests += 1
    if (state.down) await route.abort('connectionrefused')
    else await route.fallback()
  })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
  return state
}

test('no banner while the server answers', async ({ page }) => {
  await openGallery(page)
  await page.locator('#btn-refresh-folders').click()
  await page.waitForTimeout(500)
  await expect(page.locator('#server-gone-banner')).toHaveCount(0)
})

test('refresh folders with the server gone: one banner, a reason with a retry, banner leaves when it is back', async ({ page }) => {
  const state = await openGallery(page)
  state.down = true
  await page.locator('#btn-refresh-folders').click()
  const banner = page.locator('#server-gone-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('The program stopped')
  await expect(page.locator('.toast.error')).toContainText('Could not refresh the folders: the program is not answering')
  await expect(page.locator('.toast.error .toast-action-btn')).toHaveText('Try again')
  // Asking again does not stack a second banner.
  await page.locator('#btn-refresh-folders').click()
  await expect(banner).toHaveCount(1)

  state.down = false
  await page.locator('#btn-server-retry').click()
  await expect(banner).toHaveCount(0)
})

test('the banner leaves by itself when the server comes back', async ({ page }) => {
  const state = await openGallery(page)
  state.down = true
  await page.locator('#btn-refresh-folders').click()
  await expect(page.locator('#server-gone-banner')).toBeVisible()
  state.down = false
  await expect(page.locator('#server-gone-banner')).toHaveCount(0, { timeout: 12_000 })
})

test('the preview says why the details did not load and retries', async ({ page }) => {
  const state = await openGallery(page)
  state.down = true
  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  const loading = page.locator('#modal-loading-state')
  await expect(loading).toContainText('Could not load the details: the program is not answering')
  await expect(page.locator('#server-gone-banner')).toBeVisible()

  state.down = false
  const before = state.detailRequests
  await loading.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => state.detailRequests).toBeGreaterThan(before)
})
