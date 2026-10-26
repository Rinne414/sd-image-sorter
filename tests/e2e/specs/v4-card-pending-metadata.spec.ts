import { expect, test, type Page } from '../fixtures/click-ledger'

import { cleanupImages, openLibrary, seedImages } from '../fixtures/v4-seed'

/**
 * Vopus card for a picture whose metadata a quick import is still reading
 * (2026-10-27): it said "This image carries no generation parameters" until
 * the card was opened again. Now it says it is still reading and fills in by
 * itself once the record is complete.
 */

const TOKEN = 'v4pendingtoken'
const PREFIX = 'v4pending-'
const DIR = 'v4-pending'
const name = (i: number) => `${PREFIX}0${i}.png`

test.beforeAll(() => seedImages({ prefix: PREFIX, token: TOKEN, count: 1, dir: DIR }))
test.afterAll(() => cleanupImages(PREFIX, [DIR]))

const card = (page: Page) => page.getByTestId('generation-card')

test('a picture still being read says so on its card and fills in when ready', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  // The first two reads of the picture answer "still reading"; then the real record.
  let reads = 0
  await page.route(/\/api\/images\/\d+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = await response.json()
    reads += 1
    if (reads <= 2) body.image = { ...body.image, metadata_status: 'pending', prompt: null, generator: 'unknown' }
    return route.fulfill({ response, json: body })
  })

  await openLibrary(page, TOKEN, 1)
  await page.getByTestId('tile').and(page.locator(`[title="${name(0)}"]`)).click()
  await expect(card(page)).toContainText(name(0))

  await expect(card(page).getByTestId('card-reading')).toHaveText("Still reading this picture's details…")
  await expect(card(page).getByTestId('card-no-params')).toHaveCount(0)

  await expect(card(page).getByTestId('card-reading')).toHaveCount(0, { timeout: 15_000 })
  await expect(card(page)).toContainText(TOKEN)
  expect(reads).toBeGreaterThanOrEqual(3)
})
