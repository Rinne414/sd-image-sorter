import { expect, test } from '../fixtures/click-ledger'

/**
 * Collection rows in the gallery sidebar lead with the app's folder line icon
 * (Favorites keeps its heart). They used to print a coloured folder emoji.
 */

test('a collection row draws the folder line icon, Favorites keeps its heart', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await page.route('**/api/collections', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({
      json: {
        collections: [
          { id: 1, slug: 'favorites', name: 'Favorites', item_count: 0 },
          { id: 2, slug: 'training-set', name: 'Training set', item_count: 4 },
        ],
      },
    })
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')

  const custom = page.locator('#collections-list .collection-row[data-id="2"] .collection-row-icon')
  await expect(custom.locator('svg.icon use')).toHaveAttribute('href', '#i-folder')
  expect((await custom.textContent())?.trim()).toBe('')
  await expect(page.locator('#collections-list .collection-row.is-favorites .collection-row-icon')).toHaveText('♥')
})
