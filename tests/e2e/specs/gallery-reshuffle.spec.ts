import { expect, test, type Page } from '@playwright/test'

/**
 * The Random sort was one fixed shuffle: the same order on every visit. It now
 * carries a seed, and the button beside the sort menu (Reverse for every other
 * sort, meaningless for a shuffle) reads "Shuffle again" and asks for a new one.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockGallery(page: Page): Promise<{ seeds: () => Array<string | null>; sorts: () => Array<string | null> }> {
  const seeds: Array<string | null> = []
  const sorts: Array<string | null> = []
  const images = Array.from({ length: 30 }, (_, index) => ({
    id: 2001 + index,
    filename: `shuffle-${index + 1}.png`,
    path: `/mock/shuffle-${index + 1}.png`,
    prompt: `mock prompt ${index + 1}`,
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
    seeds.push(url.searchParams.get('random_seed'))
    sorts.push(url.searchParams.get('sort_by'))
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } }).catch(() => {})
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  return { seeds: () => [...seeds], sorts: () => [...sorts] }
}

test('Random sends a seed, and the button beside the sort menu shuffles again', async ({ page }) => {
  const gallery = await mockGallery(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()

  const button = page.locator('#sort-reverse-btn')
  await expect(button).toHaveAttribute('aria-label', 'Reverse sort order')
  // Every other sort sends no seed.
  expect(gallery.seeds().every((seed) => seed === null)).toBe(true)

  await page.locator('#gallery-sort').selectOption('random')
  await expect(button).toHaveAttribute('aria-label', 'Shuffle again')
  await expect(button.locator('use')).toHaveAttribute('href', '#i-dice')
  await expect.poll(() => gallery.sorts().at(-1)).toBe('random')
  const first = gallery.seeds().at(-1)
  expect(Number(first)).toBeGreaterThan(0)

  const before = gallery.seeds().length
  await button.click()
  await expect.poll(() => gallery.seeds().length).toBeGreaterThan(before)
  const second = gallery.seeds().at(-1)
  expect(Number(second)).toBeGreaterThan(0)
  expect(second).not.toBe(first)
  // Still the Random sort: the press did not flip it to something else.
  expect(gallery.sorts().at(-1)).toBe('random')
  await expect(page.locator('#gallery-sort')).toHaveValue('random')

  // Leaving Random gives the button its reverse meaning back.
  await page.locator('#gallery-sort').selectOption('newest')
  await expect(button).toHaveAttribute('aria-label', 'Reverse sort order')
  await button.click()
  await expect.poll(() => gallery.sorts().at(-1)).toBe('oldest')
  expect(gallery.seeds().at(-1)).toBeNull()
})
