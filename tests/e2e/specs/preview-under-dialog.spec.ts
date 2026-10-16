import { expect, test, type Page } from '@playwright/test'

/**
 * The image preview listens for the arrow keys and Escape on the whole page.
 * With a confirmation open over it (Delete asks first), an arrow key switched
 * the picture under the question and Escape closed the preview together with
 * the confirmation. The preview's keys now wait while another dialog is on top.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openPreview(page: Page) {
  const images = Array.from({ length: 6 }, (_, index) => ({
    id: 5101 + index, filename: `under-${index + 1}.png`, path: `/mock/under-${index + 1}.png`, width: 64, height: 64,
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
}

test('with a confirmation over the preview, the arrow keys leave the picture alone', async ({ page }) => {
  await openPreview(page)
  const shown = await page.locator('#modal-filename').textContent()
  await page.evaluate(() => (window as any).App.showConfirm('Over the preview', 'A question about this picture'))
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
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
  await expect(page.locator('#modal-filename')).toHaveText(shown || '')
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
})

test('Escape closes the confirmation over the preview first, then the preview', async ({ page }) => {
  await openPreview(page)
  await page.evaluate(() => (window as any).App.showConfirm('Over the preview', 'A question about this picture'))
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  // The preview's own keys work again once the question is gone.
  const shown = await page.locator('#modal-filename').textContent()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#modal-filename')).not.toHaveText(shown || '')
  await page.keyboard.press('Escape')
  await expect(page.locator('#image-modal')).not.toHaveClass(/visible/)
})
