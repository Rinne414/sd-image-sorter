import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Semantic text-to-image search (competitive roadmap #1): UI wiring pins
 * with a stubbed backend. Endpoint semantics are locked by
 * backend/tests/test_semantic_text_search.py; encoder-pairing evidence
 * (Qdrant/clip-ViT-B-32-text = the vision model's text tower) lives in
 * similarity.py.
 */

test.describe.configure({ mode: 'serial' })

async function openSimilarView(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('similar-guide-seen', 'true')
  })
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/similarity/model-status', async (route) => {
    await route.fulfill({
      json: { available: true, runtime_loaded: true, message: 'ready' },
    })
  })
  await page.route('**/api/similarity/stats', async (route) => {
    await route.fulfill({
      json: {
        total_images: 5, embedded_images: 5, embedded_count: 5,
        pending: 0, pending_count: 0,
      },
    })
  })
  await page.route('**/api/similarity/progress', async (route) => {
    await route.fulfill({
      json: { running: false, total: 0, processed: 0, errors: 0 },
    })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => (window as any).App.switchView('similar'))
  await expect(page.locator('#view-similar.active')).toBeVisible()
}

test('semantic search: query posts rank-only body and renders server results', async ({ page }) => {
  await openSimilarView(page)

  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/api/similarity/search-text', async (route) => {
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      json: {
        query: capturedBody.query,
        results: [
          { id: 11, filename: 'semantic-hit.png', similarity: 0.31 },
          { id: 12, filename: 'semantic-second.png', similarity: 0.27 },
        ],
        count: 2, total: 2, has_more: false, offset: 0, limit: 60,
      },
    })
  })

  const input = page.locator('#similar-search-text')
  await expect(input).toBeVisible()
  await input.fill('a smiling girl in a red dress')
  await page.locator('#btn-similar-search-text').click()

  await expect(page.locator('#similar-results .similar-name').first()).toContainText('semantic-hit.png')
  expect(capturedBody).not.toBeNull()
  expect(capturedBody!.query).toBe('a smiling girl in a red dress')
  // Cross-modal scores sit ~0.2-0.35: the UI must send rank-only threshold 0.
  expect(capturedBody!.threshold).toBe(0)
})

test('semantic search: Enter key triggers, model-not-ready 503 surfaces the message', async ({ page }) => {
  await openSimilarView(page)
  await page.route('**/api/similarity/search-text', async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: 'CLIP text model is not ready yet — it downloads on first use (~65 MB).' },
    })
  })
  await page.locator('#similar-search-text').fill('anything')
  await page.locator('#similar-search-text').press('Enter')
  await expect(page.locator('#similar-results .empty-state')).toContainText('not ready')
})
