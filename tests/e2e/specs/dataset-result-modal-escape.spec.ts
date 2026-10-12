import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Issue #5 point 8b: the export result dialog closed only through its Close
 * button; Escape did nothing. Escape must close it, hand focus back, and stay
 * contained (it must not also reach the Dataset hotkeys or the Gallery
 * selection behind the dialog).
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openResultModal(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._showResultModal === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [801, 802]
    for (const id of dm.imageIds) dm.meta.set(id, { filename: `esc-${id}.png`, width: 512, height: 512 })
    ;(window as any).App.switchView('dataset')
  })
  await page.locator('#dataset-tab-export').click()
  await page.locator('#dataset-tab-export').focus()
  await page.evaluate(() => (window as any).DatasetMaker._showResultModal('ok', {
    exported: 2, skipped: 0, error_count: 0, output_folder: 'C:/out', warnings: [], error_messages: [],
  }))
  await expect(page.locator('#dataset-result-modal')).toBeVisible()
}

test('Escape closes the export result dialog and returns focus', async ({ page }) => {
  await openResultModal(page)
  await expect(page.locator('#btn-dataset-result-close')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-result-modal')).toBeHidden()
  await expect(page.locator('#dataset-tab-export')).toBeFocused()
})

test('Escape with no dialog open leaves the Dataset workbench alone', async ({ page }) => {
  await openResultModal(page)
  await page.locator('#btn-dataset-result-close').click()
  await expect(page.locator('#dataset-result-modal')).toBeHidden()
  const before = await page.evaluate(() => [...(window as any).DatasetMaker.imageIds])
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => [...(window as any).DatasetMaker.imageIds])).toEqual(before)
  await expect(page.locator('#view-dataset')).toHaveClass(/active/)
})

test('Escape on the result dialog does not also reach other Escape handlers behind it', async ({ page }) => {
  await openResultModal(page)
  // The More menu closes on any Escape that reaches the document.
  await page.evaluate(() => { document.getElementById('nav-tools-menu')!.hidden = false })
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-result-modal')).toBeHidden()
  expect(await page.evaluate(() => document.getElementById('nav-tools-menu')!.hidden)).toBe(false)
})

test('Escape leaves the result dialog open while another dialog sits above it', async ({ page }) => {
  await openResultModal(page)
  await page.evaluate(() => document.getElementById('nav-customize-modal')!.classList.add('visible'))
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-result-modal')).toBeVisible()
  await page.evaluate(() => document.getElementById('nav-customize-modal')!.classList.remove('visible'))
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-result-modal')).toBeHidden()
})
