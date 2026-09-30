import { expect, test } from '../fixtures/click-ledger'

/**
 * The tag library lists the first 500 tags by frequency for speed. It said
 * "Showing 500 of N" but offered no way to see the rest except searching
 * (owner 2026-09-30, DESIGN.md rule 20: never hide the user's own data).
 * "Show all" lifts the cap for the tab.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test('Show all appears when the list is capped and brings every tag in', async ({ page }) => {
  const all = Array.from({ length: 7 }, (_, i) => ({ tag: `tag_${i}`, count: 100 - i }))
  await page.route(/\/api\/tags\/library\?/, async (route) => {
    const url = new URL(route.request().url())
    const limit = url.searchParams.get('limit')
    // Stand-in for the 500 cap: a limited request returns part of the list.
    const tags = limit ? all.slice(0, 3) : all
    await route.fulfill({ json: { tags, total: all.length } })
  })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).openTagsLibrary())

  const rows = page.locator('#library-content .library-tag')
  const showAll = page.locator('#btn-library-show-all')
  await expect(rows).toHaveCount(3)
  await expect(showAll).toBeVisible()

  await showAll.click()
  await expect(rows).toHaveCount(7)
  await expect(showAll).toBeHidden()
})
