import { expect, test, type Page } from '@playwright/test'

/**
 * Remove and Move to Recycle Bin are mass actions and stay confirmed (restoring
 * from the Recycle Bin is not wired to an undo), but the question now names the
 * count and the consequence in its title and on its button, and starts on Cancel
 * instead of the generic "Confirm". A copy sort leaves the originals alone, so
 * starting it asks nothing and says afterwards what is happening.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openWithSelection(page: Page, lang: 'en' | 'zh-CN') {
  const images = Array.from({ length: 5 }, (_, index) => ({
    id: 5301 + index, filename: `ask-${index + 1}.png`, path: `/mock/ask-${index + 1}.png`, width: 64, height: 64,
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/images**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/images') {
      await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
    } else {
      await route.fallback()
    }
  })
  await page.addInitScript((value) => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', value)
  }, lang)
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').nth(2)).toBeVisible()
  await page.locator('#btn-toggle-select').click()
  for (const index of [0, 1, 2]) await page.locator('#gallery-grid .gallery-item').nth(index).click()
  await expect(page.locator('#selection-count')).toContainText('3')
  await page.locator('#btn-gallery-action-more').click()
}

test('Remove names the count and the consequence, and starts on Cancel', async ({ page }) => {
  await openWithSelection(page, 'en')
  await page.locator('#btn-remove-selected-gallery').click()
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await expect(page.locator('#confirm-title')).toHaveText('Remove 3 images from the gallery?')
  await expect(page.locator('#confirm-message')).toContainText('Files stay on disk')
  await expect(page.locator('#btn-confirm-ok')).toHaveText('Remove 3 from gallery')
  await expect(page.locator('#btn-confirm-cancel')).toBeFocused()
  await page.locator('#btn-confirm-cancel').click()
  // The next question does not inherit this button label.
  await page.evaluate(() => (window as any).App.showConfirm('Another', 'Question'))
  await expect(page.locator('#btn-confirm-ok')).not.toContainText('Remove')
})

test('Move to Recycle Bin names the count on the title and the button (Chinese)', async ({ page }) => {
  await openWithSelection(page, 'zh-CN')
  await page.locator('#btn-delete-selected-files').click()
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await expect(page.locator('#confirm-title')).toHaveText('把 3 张图片的文件移到回收站？')
  await expect(page.locator('#btn-confirm-ok')).toHaveText('移到回收站（3 张）')
  await expect(page.locator('#btn-confirm-cancel')).toBeFocused()
})
