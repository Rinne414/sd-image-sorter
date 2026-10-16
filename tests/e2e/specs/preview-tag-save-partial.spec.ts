import { expect, test } from '@playwright/test'

/**
 * Saving tags in the image preview writes the new tags, then takes the
 * dropped ones out. When the second step failed after the first had written,
 * the page said "Failed to update tags" and kept the editor open on the old
 * list: the new tags were saved without a word, and their undo was dropped.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'
const IMAGE = { id: 5701, filename: 'tag-save.png', path: '/mock/tag-save.png', width: 64, height: 64 }

test('a save whose removal fails says the new tags were saved and offers their undo', async ({ page }) => {
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/images') {
      await route.fulfill({ json: { images: [IMAGE], total: 1, has_more: false, next_cursor: null } })
    } else if (url.pathname === `/api/images/${IMAGE.id}`) {
      await route.fulfill({ json: { image: IMAGE, tags: [{ tag: 'old_tag', confidence: 1, category: 'general' }] } })
    } else {
      await route.fallback()
    }
  })
  await page.route('**/api/tags/bulk/add', (route) => route.fulfill({
    json: { operation: 'bulk_add', affected_images: 1, op_id: 'op-add-1', undo_available: true, warnings: [] },
  }))
  await page.route('**/api/tags/bulk/remove', (route) => route.fulfill({
    status: 500, json: { error: 'Internal server error', type: 'UnhandledException' },
  }))
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await expect(page.locator('#modal-filename')).toHaveText(IMAGE.filename)

  // Swap old_tag for new_tag and save.
  await page.evaluate(async () => {
    const gallery = (window as any).Gallery
    gallery._tagEditOriginal = ['old_tag']
    gallery._tagEditWorking = ['new_tag']
    await gallery._saveModalTags()
  })

  const toast = page.locator('#toast-container .toast.warning').last()
  await expect(toast).toContainText('The new tags were saved, but removing tags failed.')
  await expect(toast.locator('.toast-action-btn')).toHaveText('Undo')
  await expect(page.locator('#toast-container')).not.toContainText('Failed to update tags')
})
