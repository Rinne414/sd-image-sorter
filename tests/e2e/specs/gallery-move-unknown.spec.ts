import { expect, test } from '@playwright/test'

/**
 * A Gallery move whose job is gone without a report (the program restarted
 * mid-move: progress reads 'idle') was summed up from an empty result list:
 * "Move completed for 0 image(s)" or "0 completed, N failed". The outcome is
 * not known, and the page now says so.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

test('a move whose job is gone without a report says the outcome is not known', async ({ page }) => {
  const images = Array.from({ length: 3 }, (_, index) => ({
    id: 5601 + index, filename: `unknown-${index + 1}.png`, path: `/mock/unknown-${index + 1}.png`, width: 64, height: 64,
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
  await page.route('**/api/move/start', (route) => route.fulfill({ json: { status: 'running', total: 2 } }))
  await page.route('**/api/move/progress', (route) => route.fulfill({ json: { status: 'idle', results: [] } }))
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
  await page.locator('#btn-toggle-select').click()
  await page.locator('#gallery-grid .gallery-item').nth(0).click()
  await page.locator('#gallery-grid .gallery-item').nth(1).click()

  await page.locator('#btn-move-selected').click()
  await expect(page.locator('#input-modal')).toHaveClass(/visible/)
  await page.locator('#input-modal-field').fill('L:/moved-here')
  await page.locator('#btn-input-ok').click()
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.locator('#btn-confirm-ok').click()

  await expect(page.locator('#toast-container .toast.warning').last()).toContainText(
    'Move ended without a report; the program may have restarted. Check the destination folder.',
  )
  await expect(page.locator('#toast-container')).not.toContainText('completed for')
})
