import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Aesthetic scores from before the QuickGELU fix (2026-09-28) are kept but
 * redone by the next run; the Aesthetic tab says how many of each.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function openAestheticTab(page: Page, status: Record<string, unknown>) {
  await page.route('**/api/aesthetic/status', (route) => route.fulfill({ json: status }))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState?.isLoading === false)).toBe(true)
  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
  await page.locator('#tag-modal .tagger-tab[data-tagger-tab="aesthetic"]').click()
}

test('the Aesthetic tab says how many scores are old and will be redone', async ({ page }) => {
  await openAestheticTab(page, { available: true, message: null, scored_count: 10, outdated_count: 4, to_score_count: 9 })

  const scope = page.locator('#tagger-aesthetic-scope')
  await expect(scope).toContainText('This run scores 9 images: 5 without a score and 4 whose score came from an older build')
  await expect(scope).toBeInViewport()
})

test('with no old scores the Aesthetic tab keeps the plain wording', async ({ page }) => {
  await openAestheticTab(page, { available: true, message: null, scored_count: 10, outdated_count: 0, to_score_count: 3 })

  await expect(page.locator('#tagger-aesthetic-scope')).toContainText('This run scores the 3 images in this library that have no aesthetic score yet.')
})
