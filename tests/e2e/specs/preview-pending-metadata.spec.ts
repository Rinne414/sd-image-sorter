import fs from 'node:fs'
import path from 'node:path'

import { expect, test } from '../fixtures/click-ledger'
import { createTestImage } from '../fixtures/test-helpers'

// The spec may be the first of its shard, so the gallery may be empty:
// seed one picture of its own and scan it before the test opens the grid.
const fixtureDir = path.join(__dirname, '..', '..', '..', '.tmp', 'manual-test', 'preview-pending-metadata')

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(fixtureDir, { recursive: true })
  await createTestImage(fixtureDir, 'preview-pending-seed.png', { generator: 'nai', prompt: 'seed picture' })
  const response = await request.post('/api/scan', { data: { folder_path: fixtureDir, recursive: true } })
  expect(response.ok()).toBeTruthy()
  await expect.poll(async () => {
    const progress = await (await request.get('/api/scan/progress')).json()
    return String(progress.status || '')
  }, { timeout: 60_000 }).toBe('done')
})

/**
 * A picture opened while a quick import is still reading its metadata
 * (2026-10-27). The preview said "Size null×null", "Generator Unknown" and
 * "Couldn't recover a prompt from this file" although the prompt was about to
 * arrive, and kept saying it until the picture was opened again.
 */

const READING = 'Still reading this picture’s details…'.replace('’', "'")

test('a picture opened while its metadata is still being read says so and fills in when ready', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  // The first two reads of the picture answer "still reading"; then the real record.
  let reads = 0
  await page.route(/\/api\/images\/\d+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = await response.json()
    reads += 1
    if (reads <= 2) {
      body.image = {
        ...body.image,
        metadata_status: 'pending',
        width: null,
        height: null,
        prompt: null,
        negative_prompt: null,
        generator: 'unknown',
      }
    }
    return route.fulfill({ response, json: body })
  })

  await page.goto('/')
  await page.waitForFunction(() => (window as any).App?.AppState?.isLoading === false)
  await page.locator('.gallery-item').first().click()
  await expect(page.locator('#image-modal.visible')).toBeVisible()

  await expect(page.locator('#modal-prompt-text')).toHaveText(READING)
  await expect(page.locator('#modal-generator')).toHaveText('Reading…')
  await expect(page.locator('#modal-size')).not.toContainText('null')
  await expect(page.locator('#modal-size')).not.toContainText('×')

  // Once the record is read the preview fills in without being opened again.
  await expect(page.locator('#modal-prompt-text')).not.toHaveText(READING, { timeout: 15000 })
  await expect(page.locator('#modal-size')).toContainText('×')
  await expect(page.locator('#modal-generator')).not.toHaveText('Reading…')
  expect(reads).toBeGreaterThanOrEqual(3)
})
