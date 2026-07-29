import { expect, Page, test } from '../fixtures/click-ledger'

test.describe.configure({ mode: 'serial' })

const storageKey = 'sd-image-sorter-dataset-export-job'
const jobId = 'dataset-export-job-resume'

function runningJob(message = 'Exporting dataset...') {
  return {
    id: jobId,
    job_id: jobId,
    kind: 'dataset_export',
    status: 'running',
    total: 2,
    processed: 1,
    error_count: 0,
    error_samples: [],
    message,
    result: {
      progress: {
        current: 1,
        total: 2,
        exported: 1,
        skipped: 0,
        errors: 0,
        output_folder: 'C:/training/export-resume',
      },
    },
    created_at: 1,
    started_at: 2,
    finished_at: null,
  }
}

function cancelledJob() {
  return {
    ...runningJob('Cancelled at 1/2. Exported 1 images.'),
    status: 'cancelled',
    result: {
      status: 'cancelled',
      exported: 1,
      skipped: 0,
      error_count: 0,
      masks_written: 0,
      masks_missing: 0,
      trainer_config_path: null,
      output_folder: 'C:/training/export-resume',
      output_mode: 'folder',
      items: [],
      total_items: 1,
      items_truncated: false,
      error_messages: [],
    },
    finished_at: 3,
  }
}

function queuedJob() {
  return {
    ...runningJob('Queued'),
    status: 'queued',
    processed: 0,
    result: {},
    started_at: null,
  }
}

function queuedCancelledJob() {
  return {
    ...queuedJob(),
    status: 'cancelled',
    message: 'Cancelled before start',
    result: {
      ...cancelledJob().result,
      exported: 0,
      total_items: 0,
    },
    finished_at: 3,
  }
}

async function startExportFromPage(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._startExportJob === 'function')
  await page.evaluate(() => {
    ;(window as any).App.switchView('dataset')
    ;(window as any).DatasetMaker._setPipelineTab('export')
    void (window as any).DatasetMaker._startExportJob({
      image_ids: [901, 902],
      output_folder: 'C:/training/export-resume',
      naming_pattern: 'resume_{index:03d}',
      image_op: 'copy',
      overwrite_policy: 'unique',
    })
  })
}

async function startExportWithAcceptedReadiness(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._startExportJob === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._readinessAcceptedSignature = 'accepted-readiness-signature'
    dm._setReadinessView({
      state: 'ready',
      message: 'Dataset readiness finished: ready',
      activeJobId: null,
      processed: 2,
      total: 2,
      report: {
        report_id: 'accepted-readiness-report',
        input_fingerprint: 'accepted-readiness-input',
        summary: {
          status: 'ready',
          total_requested: 2,
          processed: 2,
          trainable_pairs: 2,
          blocker_count: 0,
          warning_count: 0,
        },
        issues: [],
      },
    })
    void dm._startExportJob({
      image_ids: [901, 902],
      output_folder: 'C:/training/export-resume',
      naming_pattern: 'resume_{index:03d}',
      image_op: 'copy',
      overwrite_policy: 'unique',
    })
  })
}

async function expectRejectedJobResponse(page: Page, expectedError: string) {
  await expect(page.locator('#dataset-result-modal')).toBeVisible()
  await expect(page.locator('#dataset-result-title')).toContainText('Export failed')
  await expect(page.locator('#dataset-result-title')).not.toContainText('Done')
  await expect(page.locator('#dataset-result-title')).not.toContainText('Export cancelled')
  await expect(page.locator('#dataset-result-error-list')).toContainText(expectedError)
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(jobId)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('started export survives reload, resumes, and cancels through the shared job API', async ({ page }) => {
  let startRequests = 0
  let statusRequests = 0
  let cancelRequests = 0
  let cancellationRequested = false
  const legacyRequests: string[] = []

  page.on('request', (request) => {
    if (request.url().includes('/api/dataset/export/progress') || request.url().includes('/api/dataset/export/cancel')) {
      legacyRequests.push(request.url())
    }
  })
  await page.route('**/api/dataset/export/start', (route) => {
    startRequests += 1
    return route.fulfill({
      json: {
        status: 'started',
        job_id: jobId,
        total: 2,
        output_folder: 'C:/training/export-resume',
        message: 'Dataset export started for 2 images.',
      },
    })
  })
  await page.route(`**/api/bulk-jobs/${jobId}/cancel`, (route) => {
    cancelRequests += 1
    expect(route.request().method()).toBe('POST')
    cancellationRequested = true
    return route.fulfill({ json: runningJob('Cancellation requested') })
  })
  await page.route(`**/api/bulk-jobs/${jobId}`, (route) => {
    statusRequests += 1
    expect(route.request().method()).toBe('GET')
    return route.fulfill({ json: cancellationRequested ? cancelledJob() : runningJob() })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._startExportJob === 'function')
  await page.evaluate(() => {
    void (window as any).DatasetMaker._startExportJob({
      image_ids: [901, 902],
      output_folder: 'C:/training/export-resume',
      naming_pattern: 'resume_{index:03d}',
      image_op: 'copy',
      overwrite_policy: 'unique',
    })
  })

  await expect.poll(() => startRequests).toBe(1)
  await expect.poll(() => statusRequests).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(jobId)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._cancelExportJob === 'function')
  await page.evaluate(() => {
    ;(window as any).App.switchView('dataset')
    ;(window as any).DatasetMaker._setPipelineTab('export')
  })
  await expect.poll(() => page.evaluate((key) => {
    const dm = (window as any).DatasetMaker
    return {
      storedJobId: sessionStorage.getItem(key),
      activeJobId: dm._activeExportJobId || null,
      boundOnce: dm.boundOnce === true,
      resumeChecked: dm._exportResumeChecked === true,
    }
  }, storageKey)).toEqual({
    storedJobId: jobId,
    activeJobId: jobId,
    boundOnce: true,
    resumeChecked: true,
  })
  await expect(page.locator('#btn-dataset-export-cancel')).toBeVisible()
  await page.locator('#btn-dataset-export-cancel').click()

  await expect(page.locator('#dataset-result-modal')).toBeVisible()
  await expect(page.locator('#dataset-result-title')).toContainText('Export cancelled')
  await expect(page.locator('#dataset-result-detail')).toContainText('1 image+caption pairs')
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBeNull()
  expect(cancelRequests).toBe(1)
  expect(statusRequests).toBeGreaterThan(1)
  expect(legacyRequests).toEqual([])
})

test('queued cancellation accepts the complete zero-item result and clears recovery state', async ({ page }) => {
  let cancellationRequested = false
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    json: {
      status: 'started',
      job_id: jobId,
      total: 2,
      output_folder: 'C:/training/export-resume',
      message: 'Dataset export started for 2 images.',
    },
  }))
  await page.route(`**/api/bulk-jobs/${jobId}/cancel`, (route) => {
    cancellationRequested = true
    return route.fulfill({ json: queuedCancelledJob() })
  })
  await page.route(`**/api/bulk-jobs/${jobId}`, (route) => route.fulfill({
    json: cancellationRequested ? queuedCancelledJob() : queuedJob(),
  }))

  await startExportFromPage(page)
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(jobId)
  await expect(page.locator('#btn-dataset-export-cancel')).toBeVisible()
  await page.locator('#btn-dataset-export-cancel').click()

  await expect(page.locator('#dataset-result-modal')).toBeVisible()
  await expect(page.locator('#dataset-result-title')).toContainText('Export cancelled')
  await expect(page.locator('#dataset-result-detail')).toContainText('0 image+caption pairs')
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBeNull()
})

test('zero-write cancellation preserves the accepted Readiness report', async ({ page }) => {
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    json: {
      status: 'started',
      job_id: jobId,
      total: 2,
      output_folder: 'C:/training/export-resume',
      message: 'Dataset export started for 2 images.',
    },
  }))
  await page.route(`**/api/bulk-jobs/${jobId}`, (route) =>
    route.fulfill({ json: queuedCancelledJob() }))

  await startExportWithAcceptedReadiness(page)

  await expect.poll(() => page.evaluate(() => (
    (window as any).DatasetMaker._activeExportJobId
  ))).toBeNull()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  expect(await page.evaluate(() => (window as any).DatasetMaker._readinessView.report)).not.toBeNull()
})

test('a lost export job invalidates the process-local accepted Readiness proof', async ({ page }) => {
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    json: {
      status: 'started',
      job_id: jobId,
      total: 2,
      output_folder: 'C:/training/export-resume',
      message: 'Dataset export started for 2 images.',
    },
  }))
  await page.route(`**/api/bulk-jobs/${jobId}`, (route) =>
    route.fulfill({ status: 404, json: { detail: 'Bulk job not found' } }))

  await startExportWithAcceptedReadiness(page)

  await expect.poll(() => page.evaluate(() => (
    (window as any).DatasetMaker._activeExportJobId
  ))).toBeNull()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  expect(await page.evaluate(() => (window as any).DatasetMaker._readinessView.report)).toBeNull()
})

test('rejects a terminal job envelope for a different job and keeps recovery state', async ({ page }) => {
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    json: {
      status: 'started',
      job_id: jobId,
      total: 2,
      output_folder: 'C:/training/export-resume',
      message: 'Dataset export started for 2 images.',
    },
  }))
  await page.route(`**/api/bulk-jobs/${jobId}`, (route) => route.fulfill({
    json: {
      ...cancelledJob(),
      id: 'different-job',
      job_id: 'different-job',
    },
  }))

  await startExportFromPage(page)

  await expectRejectedJobResponse(page, 'job_id must match the requested job')
})

test('rejects a malformed terminal export result and keeps recovery state', async ({ page }) => {
  const malformedJob = cancelledJob()
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    json: {
      status: 'started',
      job_id: jobId,
      total: 2,
      output_folder: 'C:/training/export-resume',
      message: 'Dataset export started for 2 images.',
    },
  }))
  await page.route(`**/api/bulk-jobs/${jobId}`, (route) => route.fulfill({
    json: {
      ...malformedJob,
      result: {
        ...malformedJob.result,
        items: 'not-an-array',
      },
    },
  }))

  await startExportFromPage(page)

  await expectRejectedJobResponse(page, 'result.items must be an array')
})
