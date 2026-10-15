import { expect, test, type Page } from '@playwright/test'

/**
 * After a relaunch the Gallery puts the reader back where they left off, then
 * holds that place for about a second while the view settles. A new sort or
 * filter chosen in that time opened its results at the top, as new results
 * do, and the restore then carried the page straight back to the old offset,
 * inside results it means nothing in. A restore now gives way as soon as the
 * results it was for are no longer the ones shown.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'
const COMFORT_KEY = 'sd-gallery-comfort-v1'
const PAGING_PARAMS = ['cursor', 'offset', 'limit', 'skip_count']

/** Every distinct query (sort, filters) gets its own block of ids. */
async function mockQueryGallery(page: Page, count: number) {
  const blocks = new Map<string, number>()
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/images') {
      await route.fallback()
      return
    }
    const query = new URLSearchParams(url.searchParams)
    PAGING_PARAMS.forEach((name) => query.delete(name))
    query.sort()
    const signature = query.toString()
    if (!blocks.has(signature)) blocks.set(signature, 10000 * (blocks.size + 1))
    const base = blocks.get(signature)!
    const cursor = url.searchParams.get('cursor')
    const start = Number(cursor || url.searchParams.get('offset') || 0)
    const end = Math.min(count, start + Number(url.searchParams.get('limit') || 100))
    await route.fulfill({ json: {
      images: Array.from({ length: end - start }, (_, index) => ({
        id: base + start + index,
        filename: `set-${base}-${start + index + 1}.png`,
        path: `/mock/set-${base}-${start + index + 1}.png`,
      })),
      total: cursor ? -1 : count,
      has_more: end < count,
      next_cursor: end < count ? String(end) : null,
      next_offset: end,
    } }).catch(() => {})
  })
  // The missing-files banner would land above the toolbar.
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
}

async function firstShownId(page: Page) {
  return page.evaluate(() => Number((window as any).App.AppState.images?.[0]?.id || 0))
}

test('a sort chosen while the reading place is being restored opens its results at the top', async ({ page }) => {
  await mockQueryGallery(page, 400)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo({ top: 3000, behavior: 'instant' })
    return Math.round(window.scrollY)
  })).toBeGreaterThan(2950)
  await expect.poll(() => page.evaluate((key) => Math.round(
    JSON.parse(localStorage.getItem(key) || '{}').resume?.scrollTop ?? 0,
  ), COMFORT_KEY)).toBeGreaterThan(2900)
  const firstSet = await firstShownId(page)

  await page.reload()
  // Choose another sort the moment the place is back while the restore is
  // still holding it: checked and chosen in one step, so a slow machine cannot
  // slip the choice past the end of the hold (which would test nothing).
  await expect.poll(() => page.evaluate(() => {
    if (window.scrollY < 2900 || !(window as any).GalleryComfort.isRestoring()) return false
    const sort = document.getElementById('gallery-sort') as HTMLSelectElement
    sort.value = 'name_asc'
    sort.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })).toBe(true)
  await expect.poll(() => firstShownId(page)).not.toBe(firstSet)
  await expect.poll(() => page.evaluate(() => (window as any).GalleryComfort.isRestoring())).toBe(false)
  const settled = await page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(window.scrollY))))
  }))
  expect(settled, 'the new results open at their top').toBeLessThan(50)
})
