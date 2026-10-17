import { expect, test, type Page } from '@playwright/test'

/**
 * Browser Back (and the mouse back button) goes up one level like Esc: it
 * closes the topmost dialog first, otherwise returns to the page shown before.
 * It never leaves the app on a stray press at the first screen.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openApp(page: Page, { skipEntry = true } = {}) {
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: 5701 + index, filename: `back-${index + 1}.png`, path: `/mock/back-${index + 1}.png`, width: 64, height: 64,
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
  await page.addInitScript((skip) => {
    if (skip) localStorage.setItem('aurora-entry-skip', '1')
    else localStorage.removeItem('aurora-entry-skip')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  }, skipEntry)
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal))
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
}

const currentView = (page: Page) => page.evaluate(() => (window as any).App.AppState.currentView)
const stillInApp = (page: Page) => page.evaluate(() => Boolean((window as any).App?.showModal))

test('Back closes the image preview and stays in the app', async ({ page }) => {
  await openApp(page)
  const url = page.url()
  await page.locator('#gallery-grid .gallery-item').nth(1).click()
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await page.goBack()
  await expect(page.locator('#image-modal')).not.toHaveClass(/visible/)
  expect(page.url()).toBe(url)
  expect(await stillInApp(page)).toBe(true)
  expect(await currentView(page)).toBe('gallery')
})

test('Back goes from another page back to the Gallery', async ({ page }) => {
  await openApp(page)
  await page.locator('#nav-tab-sorting').click()
  await expect.poll(() => currentView(page)).toBe('sorting')
  await page.goBack()
  await expect.poll(() => currentView(page)).toBe('gallery')
  await expect(page.locator('#view-gallery')).toHaveClass(/active/)
  // Forward returns to where the user had been.
  await page.goForward()
  await expect.poll(() => currentView(page)).toBe('sorting')
})

test('Back closes a dialog before it leaves the page', async ({ page }) => {
  await openApp(page)
  await page.locator('#nav-tab-sorting').click()
  await expect.poll(() => currentView(page)).toBe('sorting')
  await page.evaluate(() => (window as any).App.showModal('autosep-settings-modal'))
  await expect(page.locator('#autosep-settings-modal')).toHaveClass(/visible/)
  await page.goBack()
  await expect(page.locator('#autosep-settings-modal')).not.toHaveClass(/visible/)
  expect(await currentView(page)).toBe('sorting')
  await page.goBack()
  await expect.poll(() => currentView(page)).toBe('gallery')
})

test('Back on the first screen stays in the app', async ({ page }) => {
  await openApp(page)
  await page.locator('#gallery-grid .gallery-item').nth(0).hover()
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await page.goBack()
  expect(await stillInApp(page)).toBe(true)
  await expect(page.locator('#view-gallery')).toHaveClass(/active/)
  await expect(page.locator('.toast').filter({ hasText: 'Press Back again to leave' })).toBeVisible()
  // A second press right after really goes back to where the user came from.
  await page.goBack()
  await expect.poll(() => page.url()).toBe('about:blank')
})

test('Back from a page opened on the entry page returns to the entry page', async ({ page }) => {
  await openApp(page, { skipEntry: false })
  await expect(page.locator('#entry-page')).toBeVisible()
  await page.locator('#entry-fn-gallery').click()
  await expect(page.locator('#entry-page')).toBeHidden()
  await page.goBack()
  await expect(page.locator('#entry-page')).toBeVisible()
})

test('Escape still closes the preview and does not move through history', async ({ page }) => {
  await openApp(page)
  await page.locator('#nav-tab-sorting').click()
  await page.locator('#nav-tab-gallery').click()
  await page.locator('#gallery-grid .gallery-item').nth(1).click()
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#image-modal')).not.toHaveClass(/visible/)
  expect(await currentView(page)).toBe('gallery')
  // The history is intact: Back still goes to the page before the Gallery.
  await page.goBack()
  await expect.poll(() => currentView(page)).toBe('sorting')
})
