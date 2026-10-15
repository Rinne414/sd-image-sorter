import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * The Dataset Maker export confirmation ("Ready to export") closed only through
 * its Cancel button: Escape did nothing, and focus stayed on the Export button
 * behind the dialog, where a second Enter re-ran the check instead of answering
 * the dialog. It now takes focus on Cancel, Escape answers it like Cancel and
 * hands focus back, and the key stays inside it (a dialog opened above it gets
 * the key first). Every backend route the page touches is stubbed.
 */

test.use({ viewport: { width: 1366, height: 768 } })

function readinessJob(jobId: string) {
  return {
    id: jobId, job_id: jobId, kind: 'dataset_readiness', status: 'done', total: 1, processed: 1,
    error_count: 0, error_samples: [], message: 'Dataset readiness finished: ready',
    result: {
      report_id: jobId, input_fingerprint: `fingerprint-${jobId}`, rule_version: 'dataset-readiness-v1',
      summary: { status: 'ready', total_requested: 1, processed: 1, trainable_pairs: 1, blocker_count: 0, warning_count: 0 },
      issues: [], total_issues: 0, issues_truncated: false, sample_pairs: [], sample_pairs_truncated: false,
    },
    created_at: 1, started_at: 2, finished_at: 3,
  }
}

/** Opens the confirmation from the Export button and reports export requests. */
async function openConfirm(page: Page): Promise<{ exportRequests: () => number }> {
  let exports = 0
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/smart-tag/progress**', (route) => route.fulfill({ json: { status: 'idle' } }))
  await page.route('**/api/dataset/export-preview', (route) => route.fulfill({
    json: { total: 1, returned: 1, items_truncated: false, items: [{
      index: 1, image_id: 971, filename: 'esc-971.png', output_image_name: 'esc_001.png',
      output_caption_name: 'esc_001.txt', caption: '1girl', error: null,
    }] },
  }))
  await page.route('**/api/dataset/output-folder-status', (route) => route.fulfill({
    json: { exists: false, file_count: 0, image_count: 0, caption_count: 0, has_export_manifest: false },
  }))
  await page.route('**/api/dataset/readiness/start', (route) => route.fulfill({
    status: 202,
    json: { id: 'job-ready', job_id: 'job-ready', kind: 'dataset_readiness', status: 'queued', total: 1, processed: 0, message: 'Queued' },
  }))
  await page.route('**/api/bulk-jobs/job-ready', (route) => route.fulfill({ json: readinessJob('job-ready') }))
  await page.route('**/api/dataset/export', (route) => {
    exports += 1
    return route.fulfill({ status: 500, json: { detail: 'export must not start in this test' } })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [971]
    dm.meta.set(971, { filename: 'esc-971.png', width: 1024, height: 1024 })
    dm.captions.set(971, '1girl, solo')
    dm._renderQueue()
    dm._updateCount()
    dm._setActive(971)
    dm._setPipelineTab('export')
  })
  await page.locator('#dataset-output-folder').fill('C:/training/out1')
  await page.locator('#btn-dataset-export').click()
  await expect(page.locator('#dataset-confirm-modal')).toBeVisible()
  return { exportRequests: () => exports }
}

test('the export confirmation takes focus on Cancel, the safe answer', async ({ page }) => {
  await openConfirm(page)
  await expect(page.locator('#btn-dataset-confirm-cancel')).toBeFocused()
})

test('Escape answers the export confirmation like Cancel and hands focus back to Export', async ({ page }) => {
  const { exportRequests } = await openConfirm(page)
  await page.evaluate(() => (window as any).DatasetMaker._setExportOption('skip_blocked_items', true))
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-confirm-modal')).toBeHidden()
  await expect(page.locator('#btn-dataset-export')).toBeFocused()
  // Cancel's reset: the one-time choices made in the dialog are dropped.
  expect(await page.evaluate(() => (window as any).DatasetMaker._exportOptionsForPayload())).toEqual({
    skip_blocked_items: false,
    allow_empty_captions: false,
  })
  expect(exportRequests()).toBe(0)
})

test('Escape on the export confirmation does not also reach other Escape handlers behind it', async ({ page }) => {
  await openConfirm(page)
  // The More menu closes on any Escape that reaches the document.
  await page.evaluate(() => { document.getElementById('nav-tools-menu')!.hidden = false })
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-confirm-modal')).toBeHidden()
  expect(await page.evaluate(() => document.getElementById('nav-tools-menu')!.hidden)).toBe(false)
})

test('Escape leaves the export confirmation open while another dialog sits above it', async ({ page }) => {
  await openConfirm(page)
  await page.evaluate(() => document.getElementById('nav-customize-modal')!.classList.add('visible'))
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-confirm-modal')).toBeVisible()
  await page.evaluate(() => document.getElementById('nav-customize-modal')!.classList.remove('visible'))
  await page.keyboard.press('Escape')
  await expect(page.locator('#dataset-confirm-modal')).toBeHidden()
})
