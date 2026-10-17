import { expect, test, type Page } from '@playwright/test'

/**
 * Single-letter shortcuts (R random picture, L large view, F filters ...) used
 * to fire while Ctrl, Alt or Meta was held and called preventDefault, so the
 * browser's own Ctrl+Shift+R hard reload, Ctrl+L, Ctrl+W, Ctrl+F ... never
 * happened. A held modifier now means the browser's shortcut, not ours.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openGallery(page: Page) {
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: 5601 + index, filename: `combo-${index + 1}.png`, path: `/mock/combo-${index + 1}.png`, width: 64, height: 64,
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
    // First in line, but read once the whole dispatch is over: did anything on
    // the page take the key? Kept in sessionStorage so a key that reloads the
    // page (F5) is still on record.
    window.addEventListener('keydown', (event) => {
      setTimeout(() => {
        const log = JSON.parse(sessionStorage.getItem('keyLog') || '[]')
        log.push({ key: event.key, prevented: event.defaultPrevented })
        sessionStorage.setItem('keyLog', JSON.stringify(log))
      }, 0)
    }, true)
  })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal))
  await expect(page.locator('#gallery-grid .gallery-item').nth(1)).toBeVisible()
}

const lastKey = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('keyLog'))).not.toBeNull()
  const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem('keyLog') || '[]'))
  return log[log.length - 1]
}
const previewOpen = (page: Page) => page.locator('#image-modal').evaluate((el) => el.classList.contains('visible'))
const viewMode = (page: Page) => page.evaluate(() => (window as any).App.AppState.viewMode)

test('Ctrl+Shift+R in the Gallery is left to the browser and shows no random picture', async ({ page }) => {
  await openGallery(page)
  await page.keyboard.press('Control+Shift+R')
  expect((await lastKey(page)).prevented).toBe(false)
  expect(await previewOpen(page)).toBe(false)
})

test('plain R still shows a random picture', async ({ page }) => {
  await openGallery(page)
  await page.keyboard.press('r')
  await expect(page.locator('#image-modal')).toHaveClass(/visible/)
})

for (const combo of [
  'Control+r', 'Control+Shift+R', 'F5', 'Control+F5', 'Control+l', 'Control+w', 'Control+t', 'Control+n',
  'Control+Shift+I', 'Control+Shift+J', 'Control+f', 'Control+g', 'Control+s', 'Control+1', 'Alt+ArrowLeft', 'Alt+g',
]) {
  test(`${combo} in the Gallery is not taken by the page`, async ({ page }) => {
    await openGallery(page)
    const mode = await viewMode(page)
    await page.keyboard.press(combo)
    expect((await lastKey(page)).prevented).toBe(false)
    expect(await previewOpen(page)).toBe(false)
    expect(await viewMode(page)).toBe(mode)
    await expect(page.locator('#filter-modal')).not.toHaveClass(/visible/)
  })
}
