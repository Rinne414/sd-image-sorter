import { expect, test, type Page } from '@playwright/test'

/**
 * A Publish Set export said nothing about what a file lost (its metadata when
 * the original could not be read, transparency flattened for JPEG), and an
 * export the program refused said only "Export failed: HTTP 500".
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#789"/></svg>'

async function openSet(page: Page, exportAnswer: { status: number, json: unknown }) {
  await page.route(/\/api\/image-(thumbnail|file)\/\d+/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG }))
  await page.route('**/api/publish/censor-pairs', (route) => route.fulfill({
    json: {
      pairs: [{
        image_id: 7101, filename: 'pose.png', path: 'L:/library/pose.png', found: true, missing: false,
        censored_path: 'L:/library/pose_censored.png', censored_filename: 'pose_censored.png', censored_source: 'disk',
      }],
      total: 1,
      found_count: 1,
    },
  }))
  await page.route('**/api/publish/export', (route) => route.fulfill(exportAnswer))
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).PublishSet?.open === 'function')
  await page.evaluate(() => (window as any).PublishSet.open([7101]))
  await expect(page.locator('.pub-item')).toHaveCount(1)
  await page.locator('#pub-folder').fill('L:/publish-out')
}

test('a file that lost its metadata says so in the result, and the finishing toast warns', async ({ page }) => {
  const warning = 'The original picture could not be read, so its prompt and metadata were not copied into this save.'
  await openSet(page, {
    status: 200,
    json: {
      success: true,
      exported: [{ index: 1, output_name: '01.png', image_id: 7101, used_censored: true, source_path: 'L:/library/pose_censored.png', metadata: 'minimal', warnings: [warning] }],
      skipped_existing: [],
      errors: [],
      caption_file: null,
      output_folder: 'L:/publish-out',
      reveal_path: 'L:/publish-out/01.png',
      metadata_option: 'minimal',
    },
  })
  await page.locator('#btn-pub-export').click()
  await expect(page.locator('.pub-result-line.pub-result-warn', { hasText: '01.png' })).toContainText(warning)
  await expect(page.locator('#toast-container .toast.warning').last()).toContainText('Publish set exported')
})

test('an export the program refuses says why', async ({ page }) => {
  await openSet(page, {
    status: 500,
    json: { error: 'The output folder cannot be written.', type: 'HTTPException', status_code: 500 },
  })
  await page.locator('#btn-pub-export').click()
  await expect(page.locator('#toast-container .toast.error').last()).toContainText('Export failed: The output folder cannot be written.')
})
