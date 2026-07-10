/**
 * Censor queue persistence (QA P3-11).
 *
 * The sort session survives a reload; the censor queue used to vanish on F5.
 * censor-edit.js now persists the queue COMPOSITION (ids / order / output
 * names) in localStorage and restores it when the workspace initializes.
 * Canvas edits and processing state deliberately reset on restore — an item
 * must never look censored without its pixels (never-fallback invariant).
 */
import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#d9e2f2"/>
  <circle cx="32" cy="24" r="10" fill="#7a93b8"/>
  <rect x="14" y="40" width="36" height="10" rx="5" fill="#7a93b8"/>
</svg>
`.trim()

const IMAGES = [
  { id: 8101, filename: 'persist-queue-1.png', path: 'L:/persist-queue-1.png', width: 64, height: 64 },
  { id: 8102, filename: 'persist-queue-2.png', path: 'L:/persist-queue-2.png', width: 64, height: 64 },
]

async function mockRoutes(page: Page) {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  for (const image of IMAGES) {
    await page.route(`**/api/image-thumbnail/${image.id}**`, fulfillImage)
    await page.route(`**/api/image-file/${image.id}**`, fulfillImage)
  }
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({
      json: { images: IMAGES, total: IMAGES.length, has_more: false, next_cursor: null },
    })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({
      json: {
        images: IMAGES.map((image) => ({ id: image.id, prompt: '', tags: [] })),
        missing_ids: [],
      },
    })
  })
}

async function openCensorView(page: Page) {
  await page.locator('.nav-tab[data-view="censor"]').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
}

test('censor queue survives a reload and an emptied queue stays empty', async ({ page }) => {
  await mockRoutes(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Build a 2-image queue through the real selection → send-to-censor flow.
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[0].id}"]`).click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[1].id}"]`).click()
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(2)

  // The persisted copy is written synchronously by the render chokepoint.
  await expect.poll(async () => page.evaluate(() => {
    try {
      const payload = JSON.parse(localStorage.getItem('censor-queue-v1') || 'null')
      return Array.isArray(payload?.items) ? payload.items.length : 0
    } catch {
      return -1
    }
  })).toBe(2)

  // Reload: the queue composition must come back, in order, unprocessed.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await openCensorView(page)
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(2)
  await expect.poll(async () =>
    page.locator('#censor-queue-list .queue-thumb-v2').evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute('data-id')))
    )
  ).toEqual(IMAGES.map((image) => image.id))

  // Empty the queue; the emptied state must ALSO survive a reload (a cleared
  // queue must not resurrect from storage).
  await page.locator('#btn-clear-queue').click()
  const confirmOk = page.locator('#confirm-modal.visible #btn-confirm-ok')
  if (await confirmOk.isVisible().catch(() => false)) {
    await confirmOk.click()
  }
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('censor-queue-v1'))).toBeNull()

  await page.reload()
  await page.waitForLoadState('networkidle')
  await openCensorView(page)
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(0)
})
