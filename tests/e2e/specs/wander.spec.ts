import { expect, test, type Page } from '@playwright/test'

/**
 * Find Similar > Wander: a walk that starts somewhere, goes on from where the
 * last batch ended, never sends a picture twice, and can be opened in the Gallery.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openWander(page: Page) {
  const asked: Array<{ start_id: number | null; seen_ids: number[]; count: number }> = []
  const pinned: Array<Record<string, unknown>> = []
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/similarity/wander', async (route) => {
    const body = route.request().postDataJSON()
    asked.push(body)
    const seen = new Set<number>(body.seen_ids)
    const start = body.start_id ?? 100
    // Nine pictures in all: 100 (start) and 101..108.
    const fresh = [101, 102, 103, 104, 105, 106, 107, 108].filter((id) => !seen.has(id) && id !== start).slice(0, 4)
    await route.fulfill({ json: {
      start: { id: start, filename: `w-${start}.png` },
      images: fresh.map((id, index) => ({ id, filename: `w-${id}.png`, similarity: 0.9 - index / 10 })),
      next_start_id: fresh.length ? fresh[fresh.length - 1] : null,
      left: Math.max(0, 8 - seen.size - fresh.length),
    } })
  })
  await page.route('**/api/collections/pinned', async (route) => {
    pinned.push(route.request().postDataJSON())
    await route.fulfill({ json: { collection_id: 9400, count: (route.request().postDataJSON().image_ids as number[]).length } })
  })
  // The page as it is with the model installed and the library indexed.
  await page.route('**/api/similarity/model-status', async (route) => {
    await route.fulfill({ json: { available: true, runtime_loaded: true, message: 'ready' } })
  })
  await page.route('**/api/similarity/stats', async (route) => {
    await route.fulfill({ json: { total_images: 9, embedded_images: 9, embedded_count: 9, pending: 0, pending_count: 0 } })
  })
  await page.route('**/api/similarity/progress', async (route) => {
    await route.fulfill({ json: { running: false, total: 0, processed: 0, errors: 0 } })
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('similar-guide-seen', 'true')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('similar'))
  await page.locator('.similar-tab[data-target="panel-similar-wander"]').click()
  await expect(page.locator('#panel-similar-wander')).toBeVisible()
  return { asked: () => [...asked], pinned: () => [...pinned] }
}

test('a wander goes on from where the last batch ended and never repeats', async ({ page }) => {
  const walk = await openWander(page)
  // Before a start: only the two ways to begin.
  await expect(page.locator('#btn-wander-more')).toBeHidden()
  await expect(page.locator('#btn-wander-to-gallery')).toBeHidden()

  // Nothing is selected in the Gallery: it says so and asks nothing.
  await page.locator('#btn-wander-from-selection').click()
  await expect(page.locator('#wander-status')).toContainText('Select a picture in the Gallery first')
  expect(walk.asked()).toEqual([])

  await page.locator('#btn-wander-random').click()
  await expect(page.locator('#wander-results .wander-item:not(.wander-more-tile)')).toHaveCount(5)
  await expect(page.locator('.wander-item.is-start')).toHaveCount(1)
  expect(walk.asked()[0]).toEqual({ start_id: null, seen_ids: [], count: 24 })
  await expect(page.locator('#wander-status')).toHaveText('5 seen so far, 4 not yet.')

  // The last cell of the grid goes on: from the last picture shown, with everything seen so far.
  await page.locator('.wander-more-tile').click()
  await expect(page.locator('#wander-results .wander-item:not(.wander-more-tile)')).toHaveCount(9)
  expect(walk.asked()[1]).toEqual({ start_id: 104, seen_ids: [100, 101, 102, 103, 104], count: 24 })
  const shown = await page.locator('#wander-results .wander-item:not(.wander-more-tile)').evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.id))
  expect(new Set(shown).size).toBe(9)

  // Everything seen: it says so and offers no further step.
  await page.locator('#btn-wander-more').click()
  await expect(page.locator('#wander-status')).toHaveText('You have seen every picture in the similarity index.')
  await expect(page.locator('.wander-more-tile')).toHaveCount(0)
  await expect(page.locator('#btn-wander-more')).toBeDisabled()

  // The pictures seen open in the Gallery as one set.
  await expect(page.locator('#btn-wander-to-gallery')).toHaveText('Open the 9 seen in the Gallery')
  await page.locator('#btn-wander-to-gallery').click()
  await expect.poll(() => walk.pinned()).toEqual([{ image_ids: [100, 101, 102, 103, 104, 105, 106, 107, 108] }])
  await expect(page.locator('#gallery-pin-banner-title')).toHaveText('9 seen while wandering')
})
