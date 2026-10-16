import { expect, test, type Page, type Route } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * Save, Auto Censor and Detect All walk the queue and then the rest of a
 * "select all matches" selection page by page. When a later page could not be
 * read, the error escaped every batch: the full-screen loading screen stayed
 * up for good and nothing said how many pictures were already done. Each batch
 * now hides its loading screen and says where it stopped and why.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#d9e2f2"/></svg>'

const IMAGES = [
  { id: 9501, filename: 'censor-stop-a.png', path: 'L:/censor-stop-a.png', width: 64, height: 64 },
  { id: 9502, filename: 'censor-stop-b.png', path: 'L:/censor-stop-b.png', width: 64, height: 64 },
]

const MODELS_PAYLOAD = {
  status: 'ok',
  recommended_backend: 'nudenet',
  models: [
    { id: 'legacy', name: 'Local YOLO', available: false, files: [], general_model_count: 0, default_model_path: null, capabilities: {} },
    { id: 'nudenet', name: 'NudeNet', available: true, model_downloaded: true, recommended: true, capabilities: {} },
    { id: 'sam3', name: 'SAM3', available: false, message: 'not installed in e2e', capabilities: {} },
  ],
}

/** A Censor queue of two pictures whose selection goes on past them, but the next page cannot be read. */
async function openCensorWithUnreadableRest(page: Page): Promise<() => number> {
  let unreadablePageRequests = 0
  await markModelsReady(page, ['censor-nudenet'])
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  const fulfillImage = (route: Route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  for (const image of IMAGES) {
    await page.route(`**/api/image-thumbnail/${image.id}**`, fulfillImage)
    await page.route(`**/api/image-file/${image.id}**`, fulfillImage)
  }
  await page.route('**/api/images?**', (route) => route.fulfill({
    json: { images: IMAGES, total: IMAGES.length, has_more: false, next_cursor: null },
  }))
  await page.route('**/api/images/export-data', async (route) => {
    const body = route.request().postDataJSON() as { selection_token?: string }
    if (body?.selection_token === 'unreadable-rest') {
      unreadablePageRequests += 1
      await route.fulfill({ status: 500, json: { error: 'The selection could not be read.', type: 'HTTPException', status_code: 500 } })
      return
    }
    await route.fulfill({ json: { images: IMAGES.map((image) => ({ ...image, prompt: '', tags: [] })), missing_ids: [] } })
  })
  await page.route('**/api/censor/models', (route) => route.fulfill({ json: MODELS_PAYLOAD }))
  await page.route('**/api/censor/detect', async (route) => {
    const body = route.request().postDataJSON() as { image_id: number }
    await route.fulfill({ json: { status: 'ok', image_id: body.image_id, model_type: 'nudenet', detections: [], warnings: [] } })
  })
  await page.route('**/api/censor/save-operations', (route) => route.fulfill({
    json: { status: 'ok', output_path: 'L:/censor-output/out.png', filename: 'out.png', warnings: [] },
  }))

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[0].id}"]`).click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[1].id}"]`).click()
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
  await page.evaluate(() => {
    (window as any).__CENSOR_STATE__.tokenQueueSource = { selectionToken: 'unreadable-rest', hasMore: true, nextOffset: 2 }
  })
  return () => unreadablePageRequests
}

async function expectStoppedSummary(page: Page, unreadablePageRequests: () => number) {
  // The batch has reached the page it cannot read; its loading screen must go.
  await expect.poll(unreadablePageRequests).toBeGreaterThan(0)
  await expect(page.locator('#censor-loading')).toBeHidden()
  await expect(page.locator('#toast-container .toast.error').last()).toContainText(
    'Stopped after 2 of 2 image(s): the rest of the selection could not be loaded',
  )
}

test('Detect All says where it stopped when the rest of the selection cannot be read', async ({ page }) => {
  const unreadablePageRequests = await openCensorWithUnreadableRest(page)
  await page.locator('#btn-auto-detect-all-sidebar').click()
  await expectStoppedSummary(page, unreadablePageRequests)
})

test('Auto Censor says where it stopped when the rest of the selection cannot be read', async ({ page }) => {
  const unreadablePageRequests = await openCensorWithUnreadableRest(page)
  await page.locator('#btn-run-auto-censor').click()
  await expectStoppedSummary(page, unreadablePageRequests)
})

test('Save says where it stopped when the rest of the selection cannot be read', async ({ page }) => {
  const unreadablePageRequests = await openCensorWithUnreadableRest(page)
  // Started like the Save dialog does; the outcome is read from the page.
  await page.evaluate(() => { void (window as any).saveAllProcessed('png', 'strip', 'unique', { includeUnedited: true }) })
  await expectStoppedSummary(page, unreadablePageRequests)
  await expect(page.locator('#toast-container')).not.toContainText('Saved 2 images to')
})

test('Send to Publish Set stops and does not open a set of only the pictures read so far', async ({ page }) => {
  const unreadablePageRequests = await openCensorWithUnreadableRest(page)
  await page.waitForFunction(() => typeof (window as any).PublishSet?.open === 'function')
  await page.evaluate(() => { void (window as any).sendCensorQueueToPublishSet() })
  await expectStoppedSummary(page, unreadablePageRequests)
  await expect(page.locator('#publish-set-modal')).not.toHaveClass(/visible/)
})
