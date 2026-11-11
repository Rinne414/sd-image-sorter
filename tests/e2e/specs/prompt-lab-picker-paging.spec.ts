import { expect, test, type Page } from '@playwright/test'

/**
 * Prompt Helper's picture picker lists the whole library a page at a time
 * (it used to stop at the newest 200), and a picture picked from beyond the
 * first page really becomes the chosen one.
 */

const TOTAL = 450
const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'
const record = (n: number) => ({ id: 5000 + n, filename: `picker-${String(n).padStart(3, '0')}.png`, path: `/mock/picker-${n}.png`, prompt: n % 2 ? 'odd one' : 'even one', generator: 'nai' })

async function mockLibrary(page: Page) {
  const asked: Array<{ search: string; cursor: string }> = []
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  })
  await page.route('**/api/images/missing-summary**', async (route) => {
    await route.fulfill({ json: { total: 0, clearable_total: 0, groups: [] } })
  })
  await page.route('**/api/images?**', async (route) => {
    const url = new URL(route.request().url())
    const search = url.searchParams.get('search') || ''
    const cursor = url.searchParams.get('cursor') || ''
    const limit = Number(url.searchParams.get('limit') || 200)
    asked.push({ search, cursor })
    const all = Array.from({ length: TOTAL }, (_, n) => record(n)).filter((image) => !search || image.prompt.startsWith(search) || image.filename.includes(search))
    const from = cursor ? Number(cursor) : 0
    const images = all.slice(from, from + limit)
    const more = from + limit < all.length
    await route.fulfill({ json: { images, total: all.length, has_more: more, next_cursor: more ? String(from + limit) : null } })
  })
  return { asked: () => [...asked] }
}

async function openCompare(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.appReady)).toBe('1')
  await page.evaluate(() => (window as any).App.switchView('promptlab'))
  await expect.poll(() => page.evaluate(() => (window as any).PromptLab?.isReady === true)).toBe(true)
  await page.locator('.promptlab-tab[data-mode="compare"]').click()
}

test('the picker goes on past 200 as it is scrolled, and a later picture can be picked', async ({ page }) => {
  await mockLibrary(page)
  await openCompare(page)

  await page.locator('#pl-pick-a').click()
  const grid = page.locator('#pl-image-picker-grid')
  const cards = grid.locator('.promptlab-image-picker-card')
  await expect(cards).toHaveCount(200)
  await expect(page.locator('#pl-image-picker-count')).toHaveText('200 shown, scroll for more')

  const toEnd = () => grid.evaluate((node) => { node.scrollTop = node.scrollHeight })
  await toEnd()
  await expect(cards).toHaveCount(400)
  await toEnd()
  await expect(cards).toHaveCount(TOTAL)
  await expect(page.locator('#pl-image-picker-count')).toHaveText(`${TOTAL} images`)

  // The very last picture is far outside the selects' own list: picking it must stick.
  await cards.last().click()
  await expect(page.locator('#promptlab-image-picker-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#pl-compare-a')).toHaveValue(String(5000 + TOTAL - 1))
  await expect(page.locator('#pl-compare-a-preview .promptlab-image-preview-title')).toHaveText(`picker-${TOTAL - 1}.png`)
})

test('a search pages through its own hits and says when loading failed', async ({ page }) => {
  const library = await mockLibrary(page)
  await openCompare(page)
  await page.locator('#pl-pick-b').click()
  const grid = page.locator('#pl-image-picker-grid')
  const cards = grid.locator('.promptlab-image-picker-card')
  await expect(cards).toHaveCount(200)

  await page.locator('#pl-image-picker-search').fill('odd')
  await expect(page.locator('#pl-image-picker-count')).toHaveText('200 shown, scroll for more')
  await expect(cards.first().locator('.promptlab-image-picker-name')).toHaveText('picker-001.png')
  await grid.evaluate((node) => { node.scrollTop = node.scrollHeight })
  await expect(cards).toHaveCount(225)
  await expect(page.locator('#pl-image-picker-count')).toHaveText('225 images')
  expect(library.asked().filter((call) => call.search === 'odd')).toEqual([{ search: 'odd', cursor: '' }, { search: 'odd', cursor: '200' }])

  await page.route('**/api/images?**', (route) => route.fulfill({ status: 500, json: { error: 'the disk is asleep' } }))
  await page.locator('#pl-image-picker-search').fill('even')
  await expect(grid).toContainText('The pictures could not be loaded')
  await expect(grid).toContainText('the disk is asleep')
})
