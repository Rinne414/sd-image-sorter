import { expect, test, type Page } from '@playwright/test'

/**
 * Five dialogs answered Escape with handlers of their own: Publish Set, the
 * caption editor, the keyboard shortcuts panel, the entry catalog and
 * Customize. None took focus or handed it back, and none knew about a dialog
 * above or below it: the caption editor opens over the batch export dialog,
 * and one Escape closed both. They now go through the app's dialog handling:
 * focus moves in, Escape closes only the topmost, and focus goes back.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openApp(page: Page, { skipEntry = true } = {}) {
  await page.addInitScript((skip) => {
    // The suite's storage state skips the entry page; this test may want it.
    if (skip) localStorage.setItem('aurora-entry-skip', '1')
    else localStorage.removeItem('aurora-entry-skip')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  }, skipEntry)
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal && (window as any).PublishSet
    && (window as any).EntryCatalog && (window as any).V321Integration))
  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'dialog-opener'
    opener.textContent = 'Open'
    document.body.prepend(opener)
  })
}

const focusInside = (page: Page, id: string) => page.evaluate(
  (dialogId) => Boolean(document.getElementById(dialogId)?.contains(document.activeElement)), id)

test('the caption editor over the batch export dialog closes alone on Escape and hands focus back', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).App.showModal('batch-export-modal'))
  await expect(page.locator('#batch-export-modal')).toHaveClass(/visible/)
  await page.locator('#btn-open-caption-editor').click()
  await expect(page.locator('#caption-editor-modal')).toHaveClass(/visible/)
  await expect.poll(() => focusInside(page, 'caption-editor-modal')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('#caption-editor-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#batch-export-modal')).toHaveClass(/visible/)
  await expect(page.locator('#btn-open-caption-editor')).toBeFocused()
})

test('Publish Set takes focus, closes on Escape and hands focus back', async ({ page }) => {
  await openApp(page)
  await page.locator('#dialog-opener').focus()
  await page.evaluate(() => (window as any).PublishSet.open())
  await expect(page.locator('#publish-set-modal')).toHaveClass(/visible/)
  await expect.poll(() => focusInside(page, 'publish-set-modal')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('#publish-set-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#dialog-opener')).toBeFocused()
})

test('Escape on a confirmation over Publish Set closes only the confirmation', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).PublishSet.open())
  await expect(page.locator('#publish-set-modal')).toHaveClass(/visible/)
  await page.evaluate(() => (window as any).App.showConfirm('Over Publish Set', 'A question'))
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#publish-set-modal')).toHaveClass(/visible/)
})

test('the ? shortcuts panel takes focus, closes on Escape and hands focus back', async ({ page }) => {
  await openApp(page)
  await page.locator('#dialog-opener').focus()
  await page.keyboard.press('Shift+Slash')
  await expect(page.locator('#keyboard-shortcuts-panel')).toHaveClass(/visible/)
  await expect(page.locator('#keyboard-shortcuts-panel .shortcuts-panel-close')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#keyboard-shortcuts-panel')).not.toHaveClass(/visible/)
  await expect(page.locator('#dialog-opener')).toBeFocused()
})

test('the entry catalog takes focus and closes alone on Escape, leaving the entry page', async ({ page }) => {
  await openApp(page, { skipEntry: false })
  await expect(page.locator('#entry-page')).toBeVisible()
  await page.locator('#dialog-opener').focus()
  await page.evaluate(() => (window as any).EntryCatalog.open())
  await expect(page.locator('#entry-catalog-modal')).toHaveClass(/visible/)
  await expect.poll(() => focusInside(page, 'entry-catalog-modal')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('#entry-catalog-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#entry-page')).toBeVisible()
  await expect(page.locator('#dialog-opener')).toBeFocused()
})

test('Customize takes focus, closes on Escape and hands focus to the More button', async ({ page }) => {
  await openApp(page)
  await page.locator('#nav-tools-toggle').click()
  await page.locator('#nav-tools-customize').click()
  await expect(page.locator('#nav-customize-modal')).toHaveClass(/visible/)
  await expect.poll(() => focusInside(page, 'nav-customize-modal')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('#nav-customize-modal')).not.toHaveClass(/visible/)
  // The menu item that opened it is hidden with the closed menu.
  await expect(page.locator('#nav-tools-toggle')).toBeFocused()
})

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

const selectedCount = (page: Page) => page.evaluate(() => (window as any).App.AppState.selectedIds.size)
const viewMode = (page: Page) => page.evaluate(() => (window as any).App.AppState.viewMode)

/** The Gallery with four (mocked) pictures, two of them selected. */
async function openGalleryWithSelection(page: Page) {
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: 5201 + index, filename: `own-${index + 1}.png`, path: `/mock/own-${index + 1}.png`, width: 64, height: 64,
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
  await openApp(page)
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
  await page.locator('#btn-toggle-select').click()
  await page.locator('#gallery-grid .gallery-item').nth(0).click()
  await page.locator('#gallery-grid .gallery-item').nth(1).click()
  await expect.poll(() => selectedCount(page)).toBe(2)
}

test('a dialog over the Gallery keeps the Gallery keys away: Escape closes only the dialog, the selection stays', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.locator('#nav-tools-toggle').click()
  await page.locator('#nav-tools-customize').click()
  await expect(page.locator('#nav-customize-modal')).toHaveClass(/visible/)
  await page.locator('#nav-customize-close').focus()
  // A view letter typed in the dialog leaves the Gallery's view alone.
  const mode = await viewMode(page)
  await page.keyboard.press(mode === 'large' ? 'g' : 'l')
  expect(await viewMode(page)).toBe(mode)
  await page.keyboard.press('Escape')
  await expect(page.locator('#nav-customize-modal')).not.toHaveClass(/visible/)
  expect(await selectedCount(page)).toBe(2)
})

test('Escape on the image preview closes it and keeps the Gallery selection', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.evaluate(() => (window as any).Gallery.openPreview(5203))
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#image-modal')).not.toHaveClass(/visible/)
  expect(await selectedCount(page)).toBe(2)
})

test('Escape on the ? panel over the Gallery closes the panel without opening the entry page', async ({ page }) => {
  await openApp(page, { skipEntry: false })
  await expect(page.locator('#entry-page')).toBeVisible()
  await page.evaluate(() => (window as any).EntryPage.hide())
  await expect(page.locator('#entry-page')).toBeHidden()
  await page.locator('#dialog-opener').focus()
  await page.keyboard.press('Shift+Slash')
  await expect(page.locator('#keyboard-shortcuts-panel')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#keyboard-shortcuts-panel')).not.toHaveClass(/visible/)
  // The entry page opens during the key press, so this reads the outcome.
  expect(await page.evaluate(() => document.body.classList.contains('entry-active'))).toBe(false)
  await expect(page.locator('#entry-page')).toBeHidden()
})
