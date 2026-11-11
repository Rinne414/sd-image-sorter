import { expect, test, type Page } from '../fixtures/click-ledger'
import { seedPictures } from '../fixtures/seed-library'

/**
 * The last Keep / Reject result stays after its finish line is gone: the
 * setup page says what it was and offers the same file actions again
 * (modules/last-cull.js).
 */

test.beforeAll(async ({ request }) => {
  await seedPictures(request, 'last-cull', 2)
})

async function openCullSetup(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
    w.setManualSortSelectedMode('cull')
  })
  await expect(page.locator('#sort-cull-intro')).toBeVisible()
}

test('with no result remembered the setup page says nothing, and asking for it says so', async ({ page }) => {
  await openCullSetup(page)
  await expect(page.locator('#sort-cull-last')).toHaveCount(0)

  await page.evaluate(() => (window as any).LastCull.offer())
  await expect(page.locator('.toast').filter({ hasText: 'No Keep / Reject result is remembered for this library yet.' })).toBeVisible()
})

test('a finished cull is remembered: its actions come back after the line was closed and the page reloaded', async ({ page }) => {
  await openCullSetup(page)
  // What the end of a Keep / Reject session hands over (manual-sort/cull.js finishCullSorting).
  await page.evaluate(() => (window as any).LastCull.remember([11], [12, 13]))

  const line = page.locator('#sort-cull-last')
  await expect(line).toContainText('kept 1, rejected 2.')
  await expect(line).toContainText(/Last time \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/)
  await expect(line).toBeInViewport({ ratio: 1 })

  await page.reload()
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
    w.setManualSortSelectedMode('cull')
  })
  await page.locator('#btn-cull-last-actions').click()
  const next = page.locator('.pipeline-next-step')
  await expect(next).toContainText('Kept 1, rejected 2.')
  await expect(next.locator('.pns-actions button')).toHaveText(['Move the kept to a folder...', 'Look at the rejected', 'Rejected to the recycle bin'])
})
