/**
 * Click-through regressions on desktop widths (1366x768 laptop, 1920x1080, 2560x1440).
 *
 * Each test drives a REAL pointer click, so Playwright's actionability check
 * fails if another layer intercepts the pointer. These two fail on the
 * pre-fix code:
 *   - toast cards had `pointer-events: none`, so the click-to-dismiss was dead;
 *   - "Welcome back" greeted a resume saved in the same browser session.
 * The detail-modal close button, entry update popup and entry tile tests are
 * guards: the empty e2e library does not reproduce the original overlap or
 * the proxied-click close, but they pin the working flows at desktop widths.
 */
import { expect, test, type Page } from '@playwright/test'

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#888"/></svg>'

async function bootGallery(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() =>
    typeof window.Gallery?.setImages === 'function'
    && document.documentElement.dataset.appReady === '1'
    && Boolean((window as any).GalleryComfort))
  await page.waitForFunction(() => window.App?.AppState?.isLoading === false)
}

async function seedCards(page: Page, count: number, firstId = 9101): Promise<void> {
  await page.evaluate(({ n, first }) => {
    const imgs = Array.from({ length: n }, (_v, i) => ({
      id: first + i,
      filename: `click-${first + i}.png`,
      generator: 'webui',
      width: 512,
      height: 512,
      file_size: 1000 + i,
    }))
    window.App.AppState.viewMode = 'grid'
    window.App.AppState.images = imgs
    window.App.AppState.currentView = 'gallery'
    window.Gallery.setImages(imgs)
  }, { n: count, first: firstId })
  await expect
    .poll(() => page.locator('#gallery-grid .gallery-item[data-id]').count())
    .toBeGreaterThanOrEqual(count)
}

async function mockUpdateStatus(page: Page): Promise<void> {
  await page.route('**/api/updates/status**', (route) => route.fulfill({
    json: {
      current_version: '3.5.0',
      latest_version: '3.5.0',
      has_update: false,
      release_notes: '',
      release_url: '',
      error: null,
    },
  }))
  await page.route('**/api/updates/channel', (route) => route.fulfill({
    json: { channel_name: 'GitHub', is_default_github_channel: true },
  }))
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]) {
  test.describe(`click-through at ${viewport.width}x${viewport.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('sd-image-sorter-lang', 'en')
        localStorage.removeItem('sd-gallery-comfort-v1')
      })
      await page.setViewportSize(viewport)
    })

    test('a toast card dismisses on click', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
      await bootGallery(page)
      await page.evaluate(() => (window as any).showToast('Import finished', 'info', { duration: 60000 }))
      const toast = page.locator('#toast-container .toast', { hasText: 'Import finished' })
      await expect(toast).toBeVisible()

      await toast.click()

      await expect(toast).toHaveCount(0)
    })

    test('the detail modal close button closes the modal', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
      const imageId = 9101
      const fulfillImage = (route: any) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
      await page.route(`**/api/image-thumbnail/${imageId}**`, fulfillImage)
      await page.route(`**/api/image-file/${imageId}**`, fulfillImage)
      await page.route(`**/api/images/${imageId}`, (route) => route.fulfill({
        json: {
          image: {
            id: imageId,
            filename: `click-${imageId}.png`,
            path: `L:/click/click-${imageId}.png`,
            generator: 'webui',
            prompt: 'a long prompt, '.repeat(40),
            width: 512,
            height: 512,
            file_size: 1000,
          },
          tags: Array.from({ length: 40 }, (_v, index) => ({ tag: `tag_${index}`, confidence: 0.9 })),
        },
      }))
      await bootGallery(page)
      await seedCards(page, 1, imageId)
      await page.evaluate(async (id) => { await window.Gallery.openPreview(id) }, imageId)
      await expect(page.locator('#image-modal.visible')).toBeVisible()

      await page.locator('#modal-close').click()

      await expect(page.locator('#image-modal.visible')).toHaveCount(0)
    })

    test('entry update button opens the version popup and it stays open', async ({ page }) => {
      await mockUpdateStatus(page)
      // The suite storageState skips the entry page; opt back in.
      await page.addInitScript(() => localStorage.removeItem('aurora-entry-skip'))
      await page.goto('/')
      await expect(page.locator('#entry-page')).toBeVisible()

      const popup = page.locator('#update-popup.visible')
      await page.locator('#entry-update-btn').click()
      await expect(popup).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)

      // Reopen: status and channel are cached now, so the popup opens at once.
      await page.locator('#entry-update-btn').click()
      await expect(popup).toBeVisible()
      await page.waitForTimeout(600)
      await expect(popup).toBeVisible()
    })

    test('entry mosaic tiles take the click through the decorative layers', async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem('aurora-entry-skip'))
      await page.goto('/')
      await expect(page.locator('#entry-page')).toBeVisible()

      await page.locator('#entry-fn-gallery').click()

      await expect(page.locator('#entry-page')).toBeHidden()
    })

    test('welcome back greets only a resume from a previous browser session', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
      await bootGallery(page)
      await seedCards(page, 60)
      const restoreFrom = async (ageMs: number) => page.evaluate(async (age) => {
        const gc = (window as any).GalleryComfort
        const state = gc._read()
        state.resume = {
          scrollTop: 900,
          scope: String(window.App.AppState.filters?.scope || ''),
          sortBy: String(window.App.AppState.filters?.sortBy || ''),
          imageCount: 60,
          savedAt: Date.now() - age,
        }
        state.lastResumeToastAt = 0
        localStorage.setItem('sd-gallery-comfort-v1', JSON.stringify(state))
        gc.restoreSoon()
        window.App.switchView('gallery')
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }, ageMs)
      const welcome = page.locator('#toast-container .toast', { hasText: 'Back where you left off' })

      await restoreFrom(0)
      // Not toHaveCount(0): that retries until a 3 s toast fades on its own.
      expect(await welcome.count()).toBe(0)
      expect(await page.evaluate(() => window.pageYOffset)).toBeGreaterThan(800)

      await restoreFrom(60 * 60 * 1000)
      await expect(welcome).toHaveCount(1)
    })
  })
}
