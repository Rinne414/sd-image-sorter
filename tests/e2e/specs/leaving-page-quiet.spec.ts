import { expect, test } from '../fixtures/click-ledger'

/**
 * Leaving the page (a reload, another address) cuts off the requests still
 * running. That is not a failure: the classic page must not warn about it.
 * Found as a CI flake 2026-10-28: "Generator tab counts for the current
 * filters failed TypeError: Failed to fetch" logged while a test reloaded.
 */

test('a reload while requests are running logs no warning about them', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`)
  })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.setItem('sd-update-autocheck', '0')
  })
  // the generator tab counts never answer: the reload cuts them off
  let held = 0
  await page.route('**/api/images/generator-counts', () => {
    held += 1
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  // a filter is on, so the tabs ask for counts under it
  await page.locator('#gallery-search-input').fill('leavingquiet')
  await page.locator('#gallery-search-input').press('Enter')
  await expect.poll(() => held).toBeGreaterThan(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  expect(problems.filter((line) => /Failed to fetch|NetworkError|AbortError/.test(line))).toEqual([])
})
