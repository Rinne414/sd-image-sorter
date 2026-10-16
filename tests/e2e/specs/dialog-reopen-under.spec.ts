import { expect, test, type Page } from '@playwright/test'

/**
 * The preview is shown again for every picture switch and refresh (a VLM
 * batch refreshes it while it runs). With a confirmation open above it, that
 * lifted the preview over the question: its arrow keys switched pictures under
 * it, Escape closed the preview instead, and focus left the question. A dialog
 * shown again while it is open now keeps its place.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openPreviewUnderConfirm(page: Page) {
  const images = Array.from({ length: 6 }, (_, index) => ({
    id: 5401 + index, filename: `reopen-${index + 1}.png`, path: `/mock/reopen-${index + 1}.png`, width: 64, height: 64,
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
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await expect(page.locator('#modal-filename')).not.toHaveText('')
  await page.evaluate(() => (window as any).App.showConfirm('Over the preview', 'A question about this picture'))
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await expect.poll(() => page.evaluate(() => Boolean(document.getElementById('confirm-modal')?.contains(document.activeElement)))).toBe(true)
  // The refresh a running batch does: the same picture shown again.
  await page.evaluate(() => (window as any).Gallery.openPreview(5401))
}

test('a preview refreshed under a confirmation leaves the question on top', async ({ page }) => {
  await openPreviewUnderConfirm(page)
  // Count picture switches: the key handler runs during the key press.
  await page.evaluate(() => {
    const gallery = (window as any).Gallery
    const original = gallery.openAdjacentPreview
    ;(window as any).__switches = 0
    gallery.openAdjacentPreview = function (...args: unknown[]) {
      ;(window as any).__switches += 1
      return original.apply(this, args)
    }
  })
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => (window as any).__switches)).toBe(0)
  // Focus stays in the question, also after the delayed focus a show
  // schedules (100 ms in showModal).
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)))
  expect(await page.evaluate(() => Boolean(document.getElementById('confirm-modal')?.contains(document.activeElement)))).toBe(true)
})

test('Escape after the refresh closes the confirmation first, then the preview', async ({ page }) => {
  await openPreviewUnderConfirm(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#image-modal')).not.toHaveClass(/visible/)
})
