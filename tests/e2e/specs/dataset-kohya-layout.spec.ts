import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * kohya folder structure for Dataset Maker exports (default on).
 *
 * kohya-ss reads one "<repeats>_<name>" folder per concept and takes the
 * repeat count from its name. With the option on, the export payload asks for
 * that layout and every preview of the output (the "Output files will be"
 * chip, the confirm's folder line, the re-export folder check) shows the real
 * path. Unticking keeps the flat layout. The backend half is pinned in
 * backend/tests/test_dataset_kohya_folder_layout.py.
 *
 * Every backend route the page touches is stubbed.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function stubCommonRoutes(page: Page): Promise<void> {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/smart-tag/progress**', (route) => route.fulfill({ json: { status: 'idle' } }))
}

async function openDatasetMaker(page: Page, ids: number[]): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate((imageIds) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = imageIds
    for (const id of imageIds) {
      dm.meta.set(id, { filename: `walk-${id}.png`, width: 1024, height: 1024 })
      dm.captions.set(id, '1girl, solo')
    }
    dm._renderQueue()
    dm._updateCount()
  }, ids)
}

async function setField(page: Page, selector: string, value: string, eventName = 'input'): Promise<void> {
  await page.evaluate(({ selector: sel, value: next, eventName: name }) => {
    const field = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement
    field.value = next
    field.dispatchEvent(new Event(name, { bubbles: true }))
  }, { selector, value, eventName })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await stubCommonRoutes(page)
})

// ---------------------------------------------------------------------------
// 3. kohya folder structure
// ---------------------------------------------------------------------------

function readinessJob(jobId: string) {
  return {
    id: jobId,
    job_id: jobId,
    kind: 'dataset_readiness',
    status: 'done',
    total: 1,
    processed: 1,
    error_count: 0,
    error_samples: [],
    message: 'Dataset readiness finished: ready',
    result: {
      report_id: jobId,
      input_fingerprint: `fingerprint-${jobId}`,
      rule_version: 'dataset-readiness-v1',
      summary: {
        status: 'ready',
        total_requested: 1,
        processed: 1,
        trainable_pairs: 1,
        blocker_count: 0,
        warning_count: 0,
      },
      issues: [],
      total_issues: 0,
      issues_truncated: false,
      sample_pairs: [],
      sample_pairs_truncated: false,
    },
    created_at: 1,
    started_at: 2,
    finished_at: 3,
  }
}

async function stubExportSide(page: Page, statusBodies: unknown[]): Promise<void> {
  await page.route('**/api/dataset/export-preview', (route) => route.fulfill({
    json: {
      total: 1,
      returned: 1,
      items_truncated: false,
      items: [{
        index: 1,
        image_id: 971,
        filename: 'walk-971.png',
        output_image_name: 'mylora_walk_001.png',
        output_caption_name: 'mylora_walk_001.txt',
        caption: '1girl',
        error: null,
      }],
    },
  }))
  await page.route('**/api/dataset/output-folder-status', (route) => {
    statusBodies.push(route.request().postDataJSON())
    return route.fulfill({
      json: { exists: false, file_count: 0, image_count: 0, caption_count: 0, has_export_manifest: false },
    })
  })
  await page.route('**/api/dataset/readiness/start', (route) => route.fulfill({
    status: 202,
    json: { id: 'job-ready', job_id: 'job-ready', kind: 'dataset_readiness', status: 'queued', total: 1, processed: 0, message: 'Queued' },
  }))
  await page.route('**/api/bulk-jobs/job-ready', (route) => route.fulfill({ json: readinessJob('job-ready') }))
}

async function prepareExportTab(page: Page, trigger: string): Promise<void> {
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._setActive(971)
    dm._setPipelineTab('export')
  })
  if (trigger) await setField(page, '#dataset-trigger', trigger)
  await page.locator('input[name="dataset-naming-preset"][value="renumber"]').check()
  await page.locator('#dataset-output-folder').fill('C:/training/out1')
}

test('kohya folder structure is on by default and every preview shows the real path', async ({ page }) => {
  const statusBodies: unknown[] = []
  await stubExportSide(page, statusBodies)
  await openDatasetMaker(page, [971])
  await prepareExportTab(page, 'mylora_walk')

  await expect(page.locator('#dataset-kohya-layout')).toBeChecked()
  const payload = await page.evaluate(() => (window as any).DatasetMaker._buildExportPayload())
  expect(payload).toMatchObject({
    output_folder: 'C:/training/out1',
    folder_layout: 'kohya',
    kohya_concept: 'mylora_walk',
    trainer_repeats: 10,
  })

  await page.evaluate(() => (window as any).DatasetMaker._refreshExportPreview())
  await expect(page.locator('#dataset-pair-chip-png')).toHaveText('10_mylora_walk/mylora_walk_001.png')
  await expect(page.locator('#dataset-pair-chip-txt')).toHaveText('10_mylora_walk/mylora_walk_001.txt')

  await page.locator('#btn-dataset-export').click()
  await expect(page.locator('#dataset-confirm-modal')).toBeVisible()
  await expect(page.locator('#dataset-confirm-summary')).toContainText('C:/training/out1/10_mylora_walk')
  await expect.poll(() => statusBodies.length).toBeGreaterThan(0)
  expect(statusBodies.at(-1)).toEqual({ output_folder: 'C:/training/out1/10_mylora_walk' })
})

test('the folder name follows repeats and unticking keeps the flat layout', async ({ page }) => {
  const statusBodies: unknown[] = []
  await stubExportSide(page, statusBodies)
  await openDatasetMaker(page, [971])
  await prepareExportTab(page, 'mylora_walk')

  await setField(page, '#dataset-est-repeats', '4')
  await expect(page.locator('#dataset-pair-chip-png')).toHaveText('4_mylora_walk/mylora_walk_001.png')

  await page.locator('#dataset-kohya-layout').uncheck()
  await expect(page.locator('#dataset-pair-chip-png')).toHaveText('mylora_walk_001.png')
  const payload = await page.evaluate(() => (window as any).DatasetMaker._buildExportPayload())
  expect(payload.folder_layout).toBe('flat')

  await page.locator('#btn-dataset-export').click()
  await expect(page.locator('#dataset-confirm-modal')).toBeVisible()
  await expect.poll(() => statusBodies.length).toBeGreaterThan(0)
  expect(statusBodies.at(-1)).toEqual({ output_folder: 'C:/training/out1' })
  await expect(page.locator('#dataset-confirm-summary')).not.toContainText('4_mylora_walk')
})

test('without a trigger the folder takes the project name, then "dataset"', async ({ page }) => {
  await stubExportSide(page, [])
  await openDatasetMaker(page, [971])
  await prepareExportTab(page, '')

  expect(await page.evaluate(() => (window as any).DatasetMaker._exportSubfolder())).toBe('10_dataset')
  const concept = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._activeProject = { id: 5, revision: 1, name: 'My: Walk/Set ' }
    return { concept: dm._kohyaConcept(), folder: dm._exportSubfolder() }
  })
  expect(concept).toEqual({ concept: 'My_WalkSet', folder: '10_My_WalkSet' })
})

test('an earlier export with other repeats is called out in the confirm', async ({ page }) => {
  await stubExportSide(page, [])
  // Registered later, so it wins over the empty-folder stub.
  await page.route('**/api/dataset/output-folder-status', (route) => route.fulfill({
    json: {
      exists: false, file_count: 0, image_count: 0, caption_count: 0,
      has_export_manifest: false, other_kohya_folders: ['5_mylora_walk'],
    },
  }))
  await openDatasetMaker(page, [971])
  await prepareExportTab(page, 'mylora_walk')

  await page.locator('#btn-dataset-export').click()

  const note = page.locator('#dataset-confirm-folder-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('5_mylora_walk')
  await expect(note).toContainText('trained twice')
})
