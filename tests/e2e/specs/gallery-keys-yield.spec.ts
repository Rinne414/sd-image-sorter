import { expect, test, type Page } from '@playwright/test'

/**
 * The Guide, the first-run tour and the update popup close on Escape
 * themselves, but the Gallery behind them answered the same key too: Escape
 * cleared the selection and G/L/W switched the view. In the image preview,
 * Delete removed the Gallery's selected pictures (after a question) instead
 * of leaving them alone. And the tour's overlay was never recognised, so the
 * Escape that ended the tour also opened the entry page.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

const selectedCount = (page: Page) => page.evaluate(() => (window as any).App.AppState.selectedIds.size)
const viewMode = (page: Page) => page.evaluate(() => (window as any).App.AppState.viewMode)

async function openApp(page: Page, { skipEntry = true } = {}) {
  await page.addInitScript((skip) => {
    // The suite's storage state skips the entry page; a test may want it.
    if (skip) localStorage.setItem('aurora-entry-skip', '1')
    else localStorage.removeItem('aurora-entry-skip')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  }, skipEntry)
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal && (window as any).Guide
    && (window as any).OnboardingTour))
}

/** The Gallery with four (mocked) pictures, two of them selected. */
async function openGalleryWithSelection(page: Page) {
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: 5301 + index, filename: `yield-${index + 1}.png`, path: `/mock/yield-${index + 1}.png`, width: 64, height: 64,
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

test('over the Guide, a view letter and Escape leave the Gallery alone', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.evaluate(() => (window as any).Guide.show((window as any).Guide.getCurrentTab()))
  await expect(page.locator('.guide-overlay')).toHaveClass(/visible/)
  const mode = await viewMode(page)
  await page.keyboard.press(mode === 'large' ? 'g' : 'l')
  expect(await viewMode(page)).toBe(mode)
  await page.keyboard.press('Escape')
  await expect(page.locator('.guide-overlay')).not.toHaveClass(/visible/)
  expect(await selectedCount(page)).toBe(2)
})

test('Escape that ends the first-run tour keeps the Gallery selection', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.evaluate(() => (window as any).OnboardingTour.start())
  await expect(page.locator('.onboarding-overlay')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.onboarding-overlay')).toHaveCount(0)
  expect(await selectedCount(page)).toBe(2)
})

test('Escape that ends the first-run tour does not open the entry page', async ({ page }) => {
  await openApp(page, { skipEntry: false })
  await expect(page.locator('#entry-page')).toBeVisible()
  await page.evaluate(() => (window as any).EntryPage.hide())
  await expect(page.locator('#entry-page')).toBeHidden()
  await page.evaluate(() => (window as any).OnboardingTour.start())
  await expect(page.locator('.onboarding-overlay')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.onboarding-overlay')).toHaveCount(0)
  // The entry page opens during the key press, so this reads the outcome.
  expect(await page.evaluate(() => document.body.classList.contains('entry-active'))).toBe(false)
  await expect(page.locator('#entry-page')).toBeHidden()
})

test('Escape on the update popup closes it and keeps the Gallery selection', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.locator('#btn-app-update').click()
  await expect(page.locator('#update-popup')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#update-popup')).not.toHaveClass(/visible/)
  expect(await selectedCount(page)).toBe(2)
})

test('Delete in the image preview leaves the Gallery selection alone', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.evaluate(() => (window as any).Gallery.openPreview(5303))
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await page.locator('#modal-close').focus()
  // The removal question opens during the key press, so this reads the outcome.
  await page.keyboard.press('Delete')
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  expect(await selectedCount(page)).toBe(2)
})

test('Escape on the image context menu closes it and keeps the Gallery selection', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.locator('#gallery-grid .gallery-item').nth(2).click({ button: 'right' })
  await expect(page.locator('.gallery-context-menu')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.gallery-context-menu')).toHaveCount(0)
  expect(await selectedCount(page)).toBe(2)
})

test('Escape pressed the moment the context menu opens still closes it', async ({ page }) => {
  // The Escape listener used to be attached a tick after the menu appeared, so
  // on a busy machine an early Escape left the menu open (a CI-order flake).
  await openGalleryWithSelection(page)
  const stillOpen = await page.evaluate(() => {
    const card = document.querySelectorAll('#gallery-grid .gallery-item')[2] as HTMLElement
    const box = card.getBoundingClientRect()
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 20 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return document.querySelectorAll('.gallery-context-menu').length
  })
  expect(stillOpen).toBe(0)
})

test('a view letter typed in the More actions menu of a selection leaves the Gallery alone', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.locator('#btn-gallery-action-more').click()
  await expect(page.locator('#gallery-action-more-menu')).toBeVisible()
  const mode = await viewMode(page)
  await page.keyboard.press(mode === 'large' ? 'g' : 'l')
  expect(await viewMode(page)).toBe(mode)
  await expect(page.locator('#gallery-action-more-menu')).toBeVisible()
})

test('Escape on the More menu closes it and keeps the Gallery selection', async ({ page }) => {
  await openGalleryWithSelection(page)
  await page.locator('#nav-tools-toggle').click()
  await expect(page.locator('#nav-tools-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#nav-tools-menu')).toBeHidden()
  expect(await selectedCount(page)).toBe(2)
})
