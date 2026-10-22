import { expect, test, type Page } from '@playwright/test'

/**
 * Classic gallery fixes (docs/DESIGN.md §redesign-2026-10, round 3):
 * - on a 1366 laptop the search row stays on one line (§gallery-toolbar);
 *   it used to push the aspect toggle and sort onto a third toolbar row;
 * - the missing-files banner puts the rare record clearing last, apart from
 *   Find Moved Files;
 * - a library whose every file is missing says so instead of "No images yet".
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockLibrary(page: Page, count: number, missing: number) {
  const images = Array.from({ length: count }, (_, index) => ({ id: 5001 + index, filename: `fix-${index + 1}.png`, path: `/mock/fix-${index + 1}.png` }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/images/missing-summary**', (route) =>
    route.fulfill({
      json: missing > 0
        ? { total: missing, clearable_total: missing, groups: [{ location: 'D:/old', count: missing, reason: 'missing' }] }
        : { total: 0, clearable_total: 0, groups: [] },
    }),
  )
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') return route.fallback()
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
}

async function open(page: Page, lang: 'en' | 'zh-CN') {
  await page.addInitScript((l) => localStorage.setItem('sd-image-sorter-lang', l), lang)
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
}

for (const lang of ['en', 'zh-CN'] as const) {
  test(`the search row stays on one line at 1366x768 (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await mockLibrary(page, 24, 0)
    await open(page, lang)
    const box = await page.locator('.gallery-search-box').boundingBox()
    const tools = await page.locator('.gallery-search-tools').boundingBox()
    expect(box && tools).toBeTruthy()
    // same line: the tools start level with the box, not under it
    expect(Math.abs(tools!.y - box!.y)).toBeLessThan(box!.height)
    await expect(page.locator('#gallery-sort')).toBeInViewport()
    await expect(page.locator('.aspect-quick-btn[data-aspect="portrait"]')).toBeInViewport()
  })
}

test('missing files: Find Moved Files first, clearing records last; the empty gallery says why', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockLibrary(page, 0, 3)
  await open(page, 'en')
  const banner = page.locator('#gallery-unreadable-banner')
  await expect(banner).toBeVisible()
  const order = await banner.locator('.gallery-banner-actions > *').evaluateAll((els) =>
    els.filter((el) => !(el as HTMLElement).hidden).map((el) => el.id || el.className),
  )
  expect(order.indexOf('gallery-unreadable-banner-cta')).toBeLessThan(order.indexOf('gallery-missing-clear-all'))
  expect(order.indexOf('gallery-banner-divider')).toBe(order.indexOf('gallery-missing-clear-all') - 1)

  const empty = page.locator('#gallery-empty-state')
  await expect(empty.locator('h3')).toHaveText('The images of this library cannot be found on disk')
  await expect(empty.locator('p').first()).toContainText('The library has 3 images')
  // the i18n re-apply keeps it
  await page.evaluate(() => (window as any).UIRefresh.applyTranslations())
  await expect(empty.locator('h3')).toHaveText('The images of this library cannot be found on disk')
})

test('Clear current library is on the gallery page and in Settings, asking with the library\'s name', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockLibrary(page, 6, 0)
  await open(page, 'en')
  const line = page.locator('#sidebar-library-line')
  await expect(line).toBeInViewport()
  await expect(page.locator('#sidebar-library-name')).not.toBeEmpty()
  const name = ((await page.locator('#sidebar-library-name').textContent()) ?? '').split(' · ')[0]!.trim()

  await page.click('#btn-sidebar-clear-library')
  const message = page.locator('#confirm-modal.visible #confirm-message')
  await expect(message).toContainText(name)
  await page.click('#btn-confirm-cancel')
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)

  await page.click('#btn-open-model-manager')
  await page.locator('#btn-settings-clear-library').scrollIntoViewIfNeeded()
  await page.click('#btn-settings-clear-library')
  await expect(message).toContainText(name)
  await page.click('#btn-confirm-cancel')
})
