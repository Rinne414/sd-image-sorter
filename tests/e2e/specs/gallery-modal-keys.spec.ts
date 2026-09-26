import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * The image preview's arrow keys switch images. They used to fire while the
 * user typed in the tag or caption editor (switching away and dropping the
 * unsaved edit), and the listener outlived a close by ✕ or backdrop, so an
 * arrow key in the gallery reopened the preview.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState?.isLoading === false)).toBe(true)
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible({ timeout: 20_000 })
})

async function openFirstPreview(page: Page): Promise<string> {
  await page.locator('#gallery-grid .gallery-item').first().click()
  await expect(page.locator('#image-modal.visible')).toBeVisible({ timeout: 10_000 })
  const filename = page.locator('#modal-filename')
  await expect(filename).not.toHaveText('')
  return (await filename.textContent()) || ''
}

test('arrow keys still switch images when nothing is being edited', async ({ page }) => {
  const first = await openFirstPreview(page)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#modal-filename')).not.toHaveText(first)
})

test('arrow keys inside the tag editor move the cursor and keep the image and the typed text', async ({ page }) => {
  const first = await openFirstPreview(page)
  await page.locator('#btn-edit-modal-tags').click()
  const input = page.locator('#modal-tags-add-input')
  await expect(input).toBeVisible()
  await input.fill('unsaved_tag')
  await input.press('ArrowRight')
  await page.waitForTimeout(300)
  await expect(page.locator('#modal-filename')).toHaveText(first)
  await input.press('ArrowLeft')

  await expect(page.locator('#modal-filename')).toHaveText(first)
  await expect(input).toHaveValue('unsaved_tag')
  await expect(input).toBeFocused()
})

for (const how of ['close button', 'backdrop'] as const) {
  test(`after closing with the ${how}, arrow keys do not reopen the preview`, async ({ page }) => {
    await openFirstPreview(page)
    if (how === 'close button') {
      await page.locator('#modal-close').click()
    } else {
      await page.locator('#image-modal .modal-backdrop').click({ position: { x: 5, y: 5 } })
    }
    await expect(page.locator('#image-modal.visible')).toHaveCount(0)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    // Give a wrongly reopened preview time to show up.
    await page.waitForTimeout(400)
    await expect(page.locator('#image-modal.visible')).toHaveCount(0)
  })
}
