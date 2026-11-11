import { expect, test, type Page } from '@playwright/test'

/**
 * sampler: / steps: / cfg: in the Gallery search. The server reads these three
 * out of the search text, so the box shows each as its own chip and sends them
 * on inside `search`, in one spelling, beside the ordinary words.
 */

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function mockGallery(page: Page): Promise<{ searches: () => Array<string | null> }> {
  const searches: Array<string | null> = []
  const images = Array.from({ length: 6 }, (_, index) => ({
    id: 9001 + index, filename: `gen-${index + 1}.png`, path: `/mock/gen-${index + 1}.png`, prompt: 'mock',
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
    searches.push(url.searchParams.get('search'))
    await route.fulfill({ json: { images, total: images.length, has_more: false, next_cursor: null } }).catch(() => {})
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  return { searches: () => [...searches] }
}

test('sampler, steps and cfg are shown as chips and sent on inside the search text', async ({ page }) => {
  const gallery = await mockGallery(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => localStorage.setItem('aurora-entry-skip', '1'))
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  const input = page.locator('#gallery-search-input')
  const chips = page.locator('#gallery-search-preview .gsq-chip')

  await input.fill('rain sampler:"Euler a" steps > 28 cfg:7..5')
  // One chip per term, and the free-text chip holds only the ordinary word.
  await expect(chips).toHaveText([/sampler.*Euler a/, /steps ≥ 28/, /CFG = 5\.\.7/, /free text.*rain$/])
  await input.press('Enter')
  await expect.poll(() => gallery.searches().at(-1)).toBe('rain sampler:"Euler a" steps>=28 cfg:5..7')
  expect(await page.evaluate(() => (window as any).App.AppState.filters.search)).toBe('rain sampler:"Euler a" steps>=28 cfg:5..7')

  // A value that is not a number is refused with the reason and sent nowhere.
  await input.fill('steps:many')
  await expect(chips.first()).toContainText('expects a number')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState.filters.search)).toBe('')

  // The Chinese keys are the same terms.
  await input.fill('采样器:karras 步数:30')
  await input.press('Enter')
  await expect.poll(() => gallery.searches().at(-1)).toBe('sampler:karras steps:30')

  // The help lists the three.
  await page.locator('#btn-search-help').click()
  await expect(page.getByText('sampler:VALUE')).toBeVisible()
  await expect(page.getByText('steps>=28')).toBeVisible()
})
