import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * In the Censor editor the Save options dialog opened by adding a class by
 * hand, so it skipped the app's dialog handling: focus stayed on Save All
 * behind it (Tab walked the covered page), Escape did nothing, and closing it
 * dropped focus on the page body. It now opens like the Detect dialog: focus
 * moves in, Escape closes it, and closing hands focus back to Save All. The
 * Shortcuts list also folds on Escape. Every backend route is stubbed.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e0245e"/></svg>'
const IMAGE = { id: 9711, filename: 'keys.png', path: 'L:/censor-keys.png', width: 640, height: 640 }

async function openCensorWithImage(page: Page) {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  await page.route(`**/api/image-thumbnail/${IMAGE.id}**`, fulfillImage)
  await page.route(`**/api/image-file/${IMAGE.id}**`, fulfillImage)
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({ json: { images: [IMAGE], total: 1, has_more: false, next_cursor: null } })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({ json: { images: [{ ...IMAGE, prompt: '', tags: [] }], missing_ids: [] } })
  })
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGE.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGE.id)
}

async function openSaveDialog(page: Page) {
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
}

const focusInsideSaveDialog = (page: Page) => page.evaluate(
  () => Boolean(document.getElementById('save-options-modal')?.contains(document.activeElement)),
)

test('the Save options dialog takes focus, and Escape closes it and hands focus back to Save All', async ({ page }) => {
  await openCensorWithImage(page)
  await openSaveDialog(page)
  await expect.poll(() => focusInsideSaveDialog(page)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#btn-save-all-processed')).toBeFocused()
})

for (const [label, button] of [['Cancel', '#btn-cancel-save-options'], ['the close button', '#btn-close-save-options']]) {
  test(`${label} closes the Save options dialog and hands focus back to Save All`, async ({ page }) => {
    await openCensorWithImage(page)
    await openSaveDialog(page)
    await page.locator(button).click()
    await expect(page.locator('#save-options-modal')).not.toHaveClass(/visible/)
    await expect(page.locator('#btn-save-all-processed')).toBeFocused()
  })
}

test('Escape folds the open Shortcuts list', async ({ page }) => {
  await openCensorWithImage(page)
  const disclosure = page.locator('#view-censor details.censor-shortcuts-disclosure')
  await disclosure.locator('> summary').click()
  await expect(disclosure).toHaveAttribute('open', '')
  await page.keyboard.press('Escape')
  await expect(disclosure).not.toHaveAttribute('open', '')
})
