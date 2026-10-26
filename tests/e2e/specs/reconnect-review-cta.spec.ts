import path from 'node:path'

import { expect, test } from '../fixtures/click-ledger'

/**
 * Find Moved Files: a review left from an earlier run stays in reach
 * (2026-10-26). The "Need your choice" group opened only when THIS run found
 * an ambiguous match, so with an older pending review (the count said 1) its
 * "Review & fix these matches" button sat inside a closed group.
 */

const FOLDER = path.join(__dirname, '..', 'fixtures')

test('an earlier pending review keeps its button in sight after a run without new ones', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  let polls = 0
  await page.route('**/api/images/reconnect-missing/start', (route) =>
    route.fulfill({ json: { status: 'started', message: 'started' } }))
  await page.route('**/api/images/reconnect-missing/progress', (route) => {
    polls += 1
    if (polls < 2) return route.fulfill({ json: { status: 'running', step: 'searching', current: 1, total: 2 } })
    return route.fulfill({
      json: {
        status: 'done',
        matched: 0,
        ambiguous: 0,
        missing_total: 1,
        library_missing_total: 1,
        review_pending_total: 1,
        result: { matched: 0, ambiguous: 0, still_missing: 1, missing_total: 1, review_pending_total: 1, updated: [], needs_review: [] },
      },
    })
  })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).App?.AppState?.isLoading === false)

  await page.locator('#btn-reconnect-missing').click()
  await expect(page.locator('#reconnect-modal.visible')).toBeVisible()
  await page.locator('#reconnect-folder-path').fill(FOLDER)
  await page.locator('#btn-start-reconnect').click()

  // The search runs in the background; its result is read in the reopened dialog.
  await expect.poll(() => polls, { timeout: 15000 }).toBeGreaterThanOrEqual(2)
  if (!await page.locator('#reconnect-modal.visible').isVisible()) {
    await page.locator('#btn-reconnect-missing').click()
  }
  const cta = page.locator('#btn-open-repair-review')
  await expect(cta).toBeVisible({ timeout: 15000 })
  await expect(cta).toContainText('(1)')
})
