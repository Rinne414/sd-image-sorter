import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Whole-library AI runs say how many images they will process before they
 * start. "AI Tag Images" with nothing selected tags the whole library, VLM
 * captioning with nothing selected covers every image the Gallery filter
 * shows (possibly on a paid API), and the Aesthetic tab said "selected images"
 * while it scored the whole library.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

async function openApp(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#view-gallery')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).App.AppState?.isLoading === false)).toBe(true)
}

test('AI Tag Images with nothing selected says how many library images it will tag', async ({ page }) => {
  await page.route('**/api/tag/scope-count**', async (route) => {
    const retagAll = new URL(route.request().url()).searchParams.get('retag_all') === 'true'
    await route.fulfill({ json: { count: retagAll ? 1500 : 1234, retag_all: retagAll } })
  })
  await openApp(page)
  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
  await page.evaluate(() => (window as any).V321Integration.setTaggerTab('local'))
  await page.locator('#tag-modal .tagger-tab[data-tagger-tab="local"]').click()

  const note = page.locator('#tag-scope-note-text')
  await expect(note).toContainText('1,234')
  await expect(page.locator('#tag-scope-note')).toBeInViewport()

  await page.evaluate(() => {
    const box = document.getElementById('tag-retag-all') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(note).toContainText('1,500')
})

test('VLM captioning with nothing selected asks first, with the count and the cost', async ({ page }) => {
  // "Nothing selected" means the images the Gallery shows, so it must show one (the test's own:
  // a fresh test library is empty).
  const image = { id: 9301, filename: 'scope-count.png', path: 'L:/scope-count.png', width: 64, height: 64 }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#d9e2f2"/></svg>'
  await page.route(`**/api/image-thumbnail/${image.id}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }))
  await page.route('**/api/images?**', (route) =>
    route.fulfill({ json: { images: [image], total: 1, has_more: false, next_cursor: null } }))
  let batchPosts = 0
  await page.route('**/api/images/selection-token', async (route) => {
    await route.fulfill({ json: { selection_token: 'e2e', total_estimate: 4321, exact_total: true, chunk_size: 2000 } })
  })
  await page.route('**/api/vlm/caption-batch', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    batchPosts += 1
    await route.fulfill({ json: { status: 'started' } })
  })
  await page.route('**/api/vlm/caption-batch/progress', (route) =>
    route.fulfill({ json: { running: false, total: 0, completed: 0, failed: 0 } }))
  await openApp(page)
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })

  await page.evaluate(() => { void (window as any).VLMCaption.startBatchCaption() })
  const confirmModal = page.locator('#confirm-modal')
  await expect(confirmModal).toHaveClass(/visible/)
  await expect(page.locator('#confirm-title')).toContainText('4,321')
  await expect(page.locator('#confirm-message')).toContainText('bills')
  await page.locator('#btn-confirm-cancel').click()
  await expect(confirmModal).not.toHaveClass(/visible/)
  await page.waitForTimeout(300)
  expect(batchPosts).toBe(0)

  await page.evaluate(() => { void (window as any).VLMCaption.startBatchCaption() })
  await expect(confirmModal).toHaveClass(/visible/)
  await page.locator('#btn-confirm-ok').click()
  await expect.poll(() => batchPosts).toBe(1)
  await page.evaluate(() => (window as any).VLMCaption.stopPolling())
})

test('the Aesthetic tab says it scores the unscored library images, and how many', async ({ page }) => {
  await page.route('**/api/aesthetic/status', async (route) => {
    await route.fulfill({ json: { available: true, message: null, scored_count: 3, to_score_count: 77 } })
  })
  await openApp(page)
  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
  await page.locator('#tag-modal .tagger-tab[data-tagger-tab="aesthetic"]').click()

  await expect(page.locator('#tagger-aesthetic-scope')).toContainText('77')
  await expect(page.locator('#tagger-aesthetic-scope')).toBeInViewport()
  await expect(page.locator('#tag-modal .modal-description')).not.toContainText('selected')
})

test('the counts and Start stay on screen at desktop sizes', async ({ page }) => {
  await page.route('**/api/tag/scope-count**', (route) => route.fulfill({ json: { count: 12853, retag_all: false } }))
  await page.route('**/api/aesthetic/status', (route) =>
    route.fulfill({ json: { available: true, message: null, scored_count: 3, to_score_count: 12850 } }))
  await openApp(page)
  await page.locator('#btn-tag').click()
  await expect(page.locator('#tag-modal')).toHaveClass(/visible/)
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    for (const [tab, ids] of [
      ['local', ['#tag-scope-note-text', '#btn-start-tag']],
      ['aesthetic', ['#tagger-aesthetic-scope', '#btn-tagger-aesthetic-start']],
    ] as const) {
      await page.locator(`#tag-modal .tagger-tab[data-tagger-tab="${tab}"]`).click()
      await expect(page.locator(ids[0])).toContainText('12,85')
      for (const id of ids) await expect(page.locator(id)).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      await page.screenshot({ path: `../../.tmp/v35-fix/ai-scope-${tab}-${viewport.width}x${viewport.height}.png` })
    }
  }
})
