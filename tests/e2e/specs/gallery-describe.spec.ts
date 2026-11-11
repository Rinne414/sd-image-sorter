import { expect, test, type Page } from '@playwright/test'

/**
 * When the Gallery's word search finds nothing, the empty page offers
 * "Search by meaning instead": the same words go to the picture-meaning
 * search and the closest pictures open in the Gallery as one set.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'
const library = [61, 62, 63].map((id) => ({ id, filename: `described-${id}.png`, path: `/mock/described-${id}.png`, prompt: '1girl, book, tree', generator: 'nai' }))

async function mockGallery(page: Page, answer: { status?: number; body: Record<string, unknown> }) {
  const asked: Array<Record<string, unknown>> = []
  const pinned: number[][] = []
  const sorts: string[] = []
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  await page.route('**/api/images?**', async (route) => {
    const url = new URL(route.request().url())
    sorts.push(`${url.searchParams.get('collection_id') || '-'}:${url.searchParams.get('sort_by') || ''}`)
    // The words are in no prompt: a word search finds nothing; everything else lists the library.
    const images = url.searchParams.get('search') ? [] : library
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } })
  })
  await page.route('**/api/similarity/search-text', async (route) => {
    asked.push(route.request().postDataJSON())
    await route.fulfill({ status: answer.status ?? 200, json: answer.body })
  })
  await page.route('**/api/collections/pinned', async (route) => {
    const ids = route.request().postDataJSON().image_ids as number[]
    pinned.push(ids)
    await route.fulfill({ json: { collection_id: 9400, count: ids.length } })
  })
  await page.route('**/api/collections/pinned/9400', async (route) => {
    await route.fulfill({ json: { exists: true, count: 2 } })
  })
  return { asked: () => [...asked], pinned: () => [...pinned], sorts: () => [...sorts] }
}

async function searchFor(page: Page, words: string) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.locator('#gallery-search-input').fill(words)
  await page.locator('#gallery-search-input').press('Enter')
  await expect(page.locator('#gallery-empty-state')).toBeVisible()
}

test('words that match no prompt can be searched by meaning, and the closest pictures open as a set', async ({ page }) => {
  const gallery = await mockGallery(page, {
    body: { query: 'girl reading under a tree', results: [{ id: 62, filename: 'described-62.png', similarity: 0.31 }, { id: 63, filename: 'described-63.png', similarity: 0.27 }], count: 2, total: 2, has_more: false },
  })
  await searchFor(page, 'girl reading under a tree')

  const describe = page.locator('#empty-state-describe-btn')
  await expect(describe).toBeVisible()
  await expect(describe).toHaveText('Search by meaning instead: "girl reading under a tree"')
  // It sits beside "Clear all filters", inside the window.
  await expect(describe).toBeInViewport({ ratio: 1 })

  await describe.click()

  await expect.poll(() => gallery.pinned()).toEqual([[62, 63]])
  expect(gallery.asked()).toEqual([{ query: 'girl reading under a tree', limit: 100, offset: 0, threshold: 0, scope: 'library' }])
  await expect(page.locator('#gallery-pin-banner-title')).toHaveText('2 closest to your description')
  // The words left the search box (as text they found nothing and would hide the set).
  await expect(page.locator('#gallery-search-input')).toHaveValue('')
  await expect(page.locator('.toast').filter({ hasText: 'closest in meaning to "girl reading under a tree"' })).toBeVisible()
  await expect(page.locator('#gallery-grid .gallery-item')).toHaveCount(3)

  // The set is asked for in its own order (closest first), and the sort box says so.
  expect(gallery.sorts()).toContain('9400:set_order')
  const sort = page.locator('#gallery-sort')
  await expect(sort).toHaveValue('set_order')
  await expect(sort.locator('option:checked')).toHaveText('Closest first')
  // Leaving the set gives the earlier sort back, and "Closest first" is no longer offered.
  await page.locator('#gallery-pin-banner-clear').click()
  await expect(sort).toHaveValue('newest')
  expect(await sort.locator('option[value="set_order"]').evaluate((option) => (option as HTMLOptionElement).hidden)).toBe(true)
  expect(gallery.sorts().at(-1)).toBe('-:newest')
})

test('a filter-only miss does not offer it, and a missing model is reported as the server says it', async ({ page }) => {
  await mockGallery(page, { status: 503, body: { error: 'CLIP text model is not ready yet — it downloads on first use (~65 MB).' } })
  await searchFor(page, 'sunset over a quiet harbour')
  await page.locator('#empty-state-describe-btn').click()
  await expect(page.locator('.toast').filter({ hasText: 'CLIP text model is not ready yet' })).toBeVisible()
  // Nothing changed: the words are still there, and so is the offer.
  await expect(page.locator('#gallery-search-input')).toHaveValue('sunset over a quiet harbour')
  await expect(page.locator('#empty-state-describe-btn')).toBeVisible()

  // key:value alone is a filter, not a description.
  await page.locator('#gallery-search-input').fill('steps:999')
  await page.locator('#gallery-search-input').press('Enter')
  await expect(page.locator('#gallery-empty-state')).toBeVisible()
  await expect(page.locator('#empty-state-describe-btn')).toBeHidden()
})

test('a Chinese description is not answered by the English-only model: the multilingual model is offered first', async ({ page }) => {
  let multilingual = false
  const gallery = await mockGallery(page, { body: {} })
  await page.unroute('**/api/similarity/search-text')
  await page.route('**/api/similarity/search-text', async (route) => {
    if (!multilingual) {
      await route.fulfill({ json: { query: '树下看书的女孩', results: [{ id: 61, filename: 'described-61.png', similarity: 0.2 }], needs_multilingual: true, multilingual_download_mb: 490 } })
    } else {
      await route.fulfill({ json: { query: '树下看书的女孩', results: [{ id: 63, filename: 'described-63.png', similarity: 0.33 }], count: 1, total: 1 } })
    }
  })
  await searchFor(page, '树下看书的女孩')
  // Declined: nothing is shown as if it were a result, and the reason is said.
  await page.evaluate(() => { (window as any).ensureFeatureModel = async () => ({ ok: false }) })
  await page.locator('#empty-state-describe-btn').click()
  await expect(page.locator('.toast').filter({ hasText: 'reads English only' })).toBeVisible()
  expect(gallery.pinned()).toEqual([])
  await expect(page.locator('#gallery-pin-banner')).toBeHidden()

  // Accepted: the search runs again with the model that reads it.
  await page.evaluate(() => {
    ;(window as any).ensureFeatureModel = async (id: string, spec: { sizeHint: string }) => {
      ;(window as any).__asked = [id, spec.sizeHint]
      return { ok: true }
    }
  })
  multilingual = true
  // (the stand-in flips before the click, as the download would before the second search)
  multilingual = false
  await page.route('**/api/similarity/search-text', async (route) => {
    const again = (await page.evaluate(() => Boolean((window as any).__asked)))
    await route.fulfill({ json: again
      ? { query: 'x', results: [{ id: 63, filename: 'described-63.png', similarity: 0.33 }], count: 1, total: 1 }
      : { query: 'x', results: [], needs_multilingual: true, multilingual_download_mb: 490 } })
  })
  await page.locator('#empty-state-describe-btn').click()
  await expect.poll(() => gallery.pinned()).toEqual([[63]])
  expect(await page.evaluate(() => (window as any).__asked)).toEqual(['clip-multilingual', '490 MB'])
})
