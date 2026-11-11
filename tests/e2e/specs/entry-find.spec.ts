import { expect, test, type Page } from '@playwright/test'

/**
 * The Home page's find box: the words go to the Gallery's own search, and the
 * column still fits a short laptop window with the extra row.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockGallery(page: Page): Promise<{ queries: () => URLSearchParams[] }> {
  const queries: URLSearchParams[] = []
  const images = Array.from({ length: 6 }, (_, index) => ({
    id: 9501 + index, filename: `home-${index + 1}.png`, path: `/mock/home-${index + 1}.png`, prompt: 'mock',
  }))
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      await route.continue()
      return
    }
    queries.push(url.searchParams)
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } }).catch(() => {})
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  // The suite skips the Home page by default; these tests are about it.
  await page.addInitScript(() => window.localStorage.removeItem('aurora-entry-skip'))
  return { queries: () => [...queries] }
}

test('words typed on Home open the Gallery on that search', async ({ page }) => {
  const gallery = await mockGallery(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  const find = page.locator('#entry-find-input')
  await expect(find).toBeVisible()

  await find.fill('silver hair model:noob steps>=28')
  await find.press('Enter')

  await expect(page.locator('#view-gallery.active')).toBeVisible()
  await expect(page.locator('#gallery-search-input')).toHaveValue('silver hair model:noob steps>=28')
  await expect.poll(() => gallery.queries().at(-1)?.get('search')).toBe('silver hair steps>=28')
  expect(gallery.queries().at(-1)?.get('checkpoints')).toBe('noob')
})

for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080], [2560, 1440]] as const) {
  test(`the Home column with the find box fits the window at ${width}x${height}`, async ({ page }) => {
    await mockGallery(page)
    await page.setViewportSize({ width, height })
    await page.goto('/')
    await expect(page.locator('#entry-find-go')).toBeVisible()
    const fits = await page.evaluate(() => {
      const kids = Array.from(document.querySelector('.entry-mosaic')!.children).filter((node) => (node as HTMLElement).offsetParent)
      const first = kids[0].getBoundingClientRect()
      const last = kids[kids.length - 1].getBoundingClientRect()
      // One row: the field and its button share a line (the page may be zoomed on large screens).
      const field = document.getElementById('entry-find-input')!.getBoundingClientRect()
      const button = document.getElementById('entry-find-go')!.getBoundingClientRect()
      return { top: first.top >= 0, bottom: last.bottom <= window.innerHeight, oneRow: Math.abs((field.top + field.bottom) / 2 - (button.top + button.bottom) / 2) < 4 && button.left >= field.right, noSideScroll: document.documentElement.scrollWidth <= window.innerWidth }
    })
    expect(fits).toEqual({ top: true, bottom: true, oneRow: true, noSideScroll: true })
  })
}
