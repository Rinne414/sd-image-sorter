import { expect, test, type Page } from '@playwright/test'

/**
 * The separation console's "add the missing tag" always said "Added X to
 * {every requested} images (undo in Mass Tag Editor)". The backend says how
 * many it changed and, when the undo journal could not be written, that
 * there is no undo. The message now follows the backend.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openConsole(page: Page, answer: Record<string, unknown>) {
  await page.route('**/api/tags/bulk/add', (route) => route.fulfill({ json: answer }))
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => typeof (window as any).SeparationConsole?._applyGapFix === 'function')
}

async function addMissingTag(page: Page) {
  await page.evaluate(async () => {
    const consoleApi = (window as any).SeparationConsole
    // The follow-up refresh of the gaps list is not what this test reads.
    consoleApi.findGaps = () => {}
    consoleApi.refresh = () => {}
    const button = document.createElement('button')
    await consoleApi._applyGapFix(
      { key: 'blue sky', spelling: 'blue sky' },
      [{ image_id: 11 }, { image_id: 12 }, { image_id: 13 }],
      button,
    )
  })
}

test('the message counts what the backend changed and warns when there is no undo', async ({ page }) => {
  await openConsole(page, {
    operation: 'bulk_add',
    affected_images: 2,
    op_id: null,
    undo_available: false,
    warnings: [{ code: 'journal_write_failed', message: 'This change cannot be undone.' }],
  })
  await addMissingTag(page)
  const toast = page.locator('#toast-container .toast.warning').last()
  await expect(toast).toContainText('Added "blue sky" to 2 images. This change cannot be undone.')
  await expect(page.locator('#toast-container')).not.toContainText('undo in Mass Tag Editor')
})

test('the undo hint stays when the backend journaled the change', async ({ page }) => {
  await openConsole(page, { operation: 'bulk_add', affected_images: 3, op_id: 'op-1', undo_available: true, warnings: [] })
  await addMissingTag(page)
  await expect(page.locator('#toast-container .toast.success').last()).toContainText(
    'Added "blue sky" to 3 images (undo in Mass Tag Editor)',
  )
})

test('nothing changed when every picture already had the tag', async ({ page }) => {
  await openConsole(page, { operation: 'bulk_add', affected_images: 0, op_id: null, undo_available: false, warnings: [] })
  await addMissingTag(page)
  await expect(page.locator('#toast-container .toast.info').last()).toContainText(
    'Every one of them already has "blue sky"; nothing changed.',
  )
})
