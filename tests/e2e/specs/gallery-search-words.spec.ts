import { expect, test, type Page } from '@playwright/test'

/**
 * A Chinese or Japanese word typed into the Gallery search found nothing:
 * prompts and captions are in English. A word the bundled tag-name table knows
 * as a whole name is now read as its tag, and the "read as" chip says so.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockGallery(page: Page): Promise<{ queries: () => URLSearchParams[]; asked: () => string[][] }> {
  const queries: URLSearchParams[] = []
  const asked: string[][] = []
  const images = Array.from({ length: 6 }, (_, index) => ({
    id: 4001 + index, filename: `words-${index + 1}.png`, path: `/mock/words-${index + 1}.png`, prompt: 'mock',
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
  // 猫耳: a tag this library has; 泳装: a known name with no pictures here; anything else: unknown.
  await page.route('**/api/tags/words**', async (route) => {
    const words = new URL(route.request().url()).searchParams.getAll('q')
    asked.push(words)
    const table: Record<string, { tag: string; pictures: number }> = {
      猫耳: { tag: 'cat_ears', pictures: 12 },
      泳装: { tag: 'swimsuit', pictures: 0 },
    }
    await route.fulfill({ json: { words: Object.fromEntries(words.filter((word) => table[word]).map((word) => [word, table[word]])) } })
  })
  return { queries: () => [...queries], asked: () => [...asked] }
}

test('a Chinese tag name is searched as its tag, and the chip shows what it was read as', async ({ page }) => {
  const gallery = await mockGallery(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const input = page.locator('#gallery-search-input')

  // While typing: the chip already names the tag.
  await input.fill('猫耳 silver')
  await expect(page.locator('#gallery-search-preview .gsq-chip').first()).toContainText('cat_ears (猫耳)')

  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual(['cat_ears'])
  // The English word beside it stays free text.
  expect(await page.evaluate(() => (window as any).App.AppState.filters.search)).toBe('silver')
  await expect.poll(() => gallery.queries().at(-1)?.get('tags')).toBe('cat_ears')
  expect(gallery.queries().at(-1)?.get('search')).toBe('silver')
  // One question for the word, asked once: English words are never sent.
  expect(gallery.asked().flat()).toEqual(['猫耳'])

  // A known name the library has no pictures of is searched as the tag's English words.
  await input.fill('泳装')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.search)).toBe('swimsuit')
  expect(await page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual([])

  // An unknown word is left exactly as typed.
  await input.fill('不认识的词')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.search)).toBe('不认识的词')

  // Clearing the box removes the tag it added.
  await input.fill('猫耳')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual(['cat_ears'])
  await input.fill('')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.tags)).toEqual([])
})
