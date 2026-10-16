import { expect, test, type Page } from '@playwright/test'

/**
 * A failed Dataset export said "No files were written" in every case: also
 * when the backend had written pairs before its error, and when the page had
 * only stopped waiting (the job gone after a restart), right above its own
 * note to check the output folder.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  // Dataset Maker loads its scripts when its view first opens.
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._showResultModal === 'function'
    && typeof (window as any).DatasetMaker?._resumeExportProgress === 'function')
}

test('a failure after some pairs were written counts them and names the folder', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).DatasetMaker._showResultModal('failed', {
    status: 'failed',
    exported: 3,
    error_count: 1,
    output_folder: 'L:/datasets/out',
    error_messages: ['The disk is full.'],
  }))
  const detail = page.locator('#dataset-result-detail')
  await expect(detail).toContainText('The export stopped on an error after 3 image+caption pairs were written.')
  await expect(detail).toContainText('L:/datasets/out')
  await expect(detail).not.toContainText('No files were written')
})

test('an export job lost after a restart says its outcome is not known', async ({ page }) => {
  await page.route('**/api/bulk-jobs/**', (route) => route.fulfill({ status: 404, json: { error: 'Job not found' } }))
  await openApp(page)
  await page.evaluate(async () => {
    const maker = (window as any).DatasetMaker
    maker._exportResumeChecked = false
    maker._storeExportJobId('lost-after-restart')
    await maker._resumeExportProgress()
  })
  const detail = page.locator('#dataset-result-detail')
  await expect(detail).toContainText('It is not known how far the export got.')
  await expect(detail).not.toContainText('No files were written')
})
