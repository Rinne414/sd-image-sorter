import { expect, test, type Page } from '../fixtures/click-ledger'

test.describe.configure({ mode: 'serial' })

type ReadinessStatus = 'ready' | 'warnings' | 'blocked'

type ReadinessIssue = {
  severity: 'blocker' | 'warning'
  code: string
  message: string
  issue_id: string
  rule_version: string
  evidence: { observed: string; expected: string }
  action: string
  destination: string | null
  image_id: number | null
  source_path: string | null
}

function readinessReport(status: ReadinessStatus, issues: ReadinessIssue[]) {
  const blockerCount = issues.filter((issue) => issue.severity === 'blocker').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  return {
    report_id: `report-${status}`,
    input_fingerprint: `fingerprint-${status}`,
    rule_version: 'dataset-readiness-v1',
    summary: {
      status,
      total_requested: 2,
      processed: 2,
      trainable_pairs: blockerCount > 0 ? 1 : 2,
      blocker_count: blockerCount,
      warning_count: warningCount,
    },
    issues,
    total_issues: issues.length,
    issues_truncated: false,
    sample_pairs: [],
    sample_pairs_truncated: false,
  }
}

function startResponse(jobId: string) {
  return {
    id: jobId,
    job_id: jobId,
    kind: 'dataset_readiness',
    status: 'queued',
    total: 2,
    processed: 0,
    message: 'Queued',
  }
}

function doneJob(jobId: string, result: ReturnType<typeof readinessReport>) {
  return {
    id: jobId,
    job_id: jobId,
    kind: 'dataset_readiness',
    status: 'done',
    total: 2,
    processed: 2,
    error_count: 0,
    error_samples: [],
    message: `Dataset readiness finished: ${result.summary.status}`,
    result: { ...result, report_id: jobId },
    created_at: 1,
    started_at: 2,
    finished_at: 3,
  }
}

function successfulExportJob(jobId: string) {
  return {
    id: jobId,
    job_id: jobId,
    kind: 'dataset_export',
    status: 'done',
    total: 2,
    processed: 2,
    error_count: 0,
    error_samples: [],
    message: 'Dataset export finished',
    result: {
      status: 'ok',
      exported: 2,
      skipped: 0,
      error_count: 0,
      masks_written: 0,
      masks_missing: 0,
      trainer_config_path: null,
      output_folder: 'C:/training/ready',
      output_mode: 'folder',
      items: [],
      total_items: 2,
      items_truncated: false,
      error_messages: [],
    },
    created_at: 1,
    started_at: 2,
    finished_at: 3,
  }
}

function failedExportJobWithWrittenImage(jobId: string) {
  const job = successfulExportJob(jobId)
  return {
    ...job,
    status: 'error',
    error_count: 1,
    error_samples: ['Caption write failed after copying the image'],
    message: 'Dataset export failed after writing an image',
    result: {
      ...job.result,
      status: 'failed',
      exported: 0,
      error_count: 1,
      items: [{
        image_id: 901,
        src_image_path: 'C:/source/ready-901.png',
        dst_image_path: 'C:/training/ready/ready-a.png',
        dst_caption_path: null,
        skipped_reason: null,
        error: 'Caption write failed after copying the image',
      }],
      total_items: 1,
      error_messages: ['Caption write failed after copying the image'],
    },
  }
}

async function stubDatasetRoutes(page: Page) {
  await page.route(/\/api\/images\/(?:901|902)(?:\?.*)?$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop())
    return route.fulfill({
      json: {
        id,
        filename: id === 901 ? 'ready-a.png' : 'ready-b.png',
        path: `C:/source/ready-${id}.png`,
        width: 1024,
        height: 1024,
      },
    })
  })
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
}

async function seedReadyToCheckDataset(page: Page) {
  await stubDatasetRoutes(page)
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
    dm.imageIds = [901, 902]
    dm.meta.set(901, { filename: 'ready-a.png', width: 1024, height: 1024 })
    dm.meta.set(902, { filename: 'ready-b.png', width: 1024, height: 1024 })
    dm.captions.set(901, '1girl, standing')
    dm.captions.set(902, '1girl, sitting')
    dm._setActive(901)
    dm._setPipelineTab('export')
  })
  await page.locator('#dataset-output-folder').fill('C:/training/ready')
  await expect(page.getByTestId('dataset-readiness-check')).toBeEnabled()
  await expect(page.locator('.dataset-maker')).toHaveAttribute('data-active-tab', 'export')
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('starts idle, blocks Export, and Check posts the single export payload', async ({ page }) => {
  let capturedBody: Record<string, unknown> | null = null
  let startRequests = 0
  let releaseStartResponse!: () => void
  const startResponseGate = new Promise<void>((resolve) => {
    releaseStartResponse = resolve
  })
  await page.route('**/api/dataset/readiness/start', async (route) => {
    startRequests += 1
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await startResponseGate
    await route.fulfill({ status: 202, json: startResponse('job-idle') })
  })
  await page.route('**/api/bulk-jobs/job-idle', (route) => route.fulfill({
    json: {
      ...doneJob('job-idle', readinessReport('ready', [])),
      status: 'running',
      processed: 1,
      result: {},
      finished_at: null,
    },
  }))
  await seedReadyToCheckDataset(page)

  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'idle')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
  await expect(page.getByTestId('dataset-readiness-cancel')).toBeHidden()

  const expectedPayload = await page.evaluate(() => (window as any).DatasetMaker._buildExportPayload())
  await page.getByTestId('dataset-readiness-check').click()
  await expect.poll(() => capturedBody).not.toBeNull()
  await expect.poll(() => startRequests).toBe(1)
  await expect(page.getByTestId('dataset-readiness-check')).toBeDisabled()
  releaseStartResponse()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'checking')
  expect(startRequests).toBe(1)
  expect(capturedBody).toEqual(expectedPayload)
})

test('final Export attaches the accepted proof and a backend conflict marks it stale', async ({ page }) => {
  const reportId = 'a'.repeat(32)
  const fingerprint = 'b'.repeat(64)
  const currentFingerprint = 'c'.repeat(64)
  const report = {
    ...readinessReport('ready', []),
    input_fingerprint: fingerprint,
  }
  let readinessBody: Record<string, unknown> | null = null
  let exportBody: Record<string, unknown> | null = null
  await page.route('**/api/dataset/readiness/start', (route) => {
    readinessBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({ status: 202, json: startResponse(reportId) })
  })
  await page.route(`**/api/bulk-jobs/${reportId}`, (route) =>
    route.fulfill({ json: doneJob(reportId, report) }))
  await page.route('**/api/dataset/export/start', (route) => {
    exportBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 409,
      json: {
        code: 'readiness_input_mismatch',
        message: 'Dataset inputs changed after the accepted Readiness report.',
        action: 'Run Readiness Check again.',
        report_id: reportId,
        expected_input_fingerprint: fingerprint,
        observed_input_fingerprint: currentFingerprint,
        rule_version: 'dataset-readiness-v1',
        issues: [],
        error: 'Dataset inputs changed after the accepted Readiness report.',
        type: 'HTTPException',
        status_code: 409,
      },
    })
  })
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  await page.evaluate(async () => {
    await (window as any).DatasetMaker._runExport()
  })

  expect(readinessBody).not.toBeNull()
  expect(readinessBody).not.toHaveProperty('readiness_report_id')
  expect(readinessBody).not.toHaveProperty('readiness_input_fingerprint')
  expect(exportBody).toMatchObject({
    readiness_report_id: reportId,
    readiness_input_fingerprint: fingerprint,
  })
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  await expect(page.locator('#dataset-readiness-message')).toContainText('Run Readiness Check again.')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
  await expect(page.locator('#dataset-result-modal')).toBeHidden()
})

test('malformed export conflict clears the accepted proof and fails explicitly', async ({ page }) => {
  const reportId = 'd'.repeat(32)
  const fingerprint = 'e'.repeat(64)
  const report = {
    ...readinessReport('ready', []),
    input_fingerprint: fingerprint,
  }
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse(reportId) }))
  await page.route(`**/api/bulk-jobs/${reportId}`, (route) =>
    route.fulfill({ json: doneJob(reportId, report) }))
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    status: 409,
    json: {
      code: 409,
      message: 'Malformed conflict payload',
      action: 'Run Readiness Check again.',
    },
  }))
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  await page.evaluate(async () => {
    await (window as any).DatasetMaker._runExport()
  })

  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#dataset-readiness-message')).toContainText(
    'readiness conflict.code must be a string',
  )
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
})

test('Ready enables Export, while Blocked disables it and renders an image-linked issue', async ({ page }) => {
  const blocker: ReadinessIssue = {
    severity: 'blocker',
    code: 'empty_caption',
    message: 'The rendered caption is empty',
    issue_id: 'issue-empty-902',
    rule_version: 'dataset-readiness-v1',
    evidence: { observed: 'empty caption', expected: 'non-empty caption' },
    action: 'Write or generate a caption in Workbench.',
    destination: 'C:/training/ready/ready-b.txt',
    image_id: null,
    source_path: 'C:/source/ready-b.png',
  }
  const jobs = [
    { id: 'job-ready', report: readinessReport('ready', []) },
    { id: 'job-blocked', report: readinessReport('blocked', [blocker]) },
  ]
  let nextJob = 0
  await page.route('**/api/dataset/readiness/start', (route) => {
    const job = jobs[nextJob]
    nextJob += 1
    return route.fulfill({ status: 202, json: startResponse(job.id) })
  })
  for (const job of jobs) {
    await page.route(`**/api/bulk-jobs/${job.id}`, (route) =>
      route.fulfill({ json: doneJob(job.id, job.report) }))
  }
  await seedReadyToCheckDataset(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [901, -902]
    dm.captions.delete(902)
    dm.meta.delete(902)
    dm.localItemPaths.set(-902, 'C:/source/ready-b.png')
    dm.localItemDsIds.set(-902, 'ds:ready-b')
    dm.captions.set(-902, '1girl, sitting')
    dm.meta.set(-902, {
      source: 'local',
      ds_id: 'ds:ready-b',
      abs_path: 'C:/source/ready-b.png',
      filename: 'ready-b.png',
      width: 1024,
      height: 1024,
    })
    dm._renderQueue()
  })

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  await expect(page.locator('#btn-dataset-export')).toBeEnabled()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'blocked')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
  const issue = page.getByTestId('dataset-readiness-issue').filter({ hasText: blocker.message })
  await expect(issue).toHaveAttribute('data-image-id', '-902')
  await expect(issue).toContainText(blocker.source_path || '')
  await expect(issue).toContainText(blocker.destination || '')
  await expect(issue).toContainText(blocker.action)
  await issue.click()
  await expect(page.locator('.dataset-maker')).toHaveAttribute('data-active-tab', 'workbench')
  expect(await page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(-902)
})

test('Blocked reports revalidate the exact payload and become stale on an unannounced change', async ({ page }) => {
  const blocker: ReadinessIssue = {
    severity: 'blocker',
    code: 'empty_caption',
    message: 'The rendered caption is empty',
    issue_id: 'issue-blocked-currentness',
    rule_version: 'dataset-readiness-v1',
    evidence: { observed: 'empty caption', expected: 'non-empty caption' },
    action: 'Write or generate a caption in Workbench.',
    destination: 'C:/training/ready/ready-b.txt',
    image_id: 902,
    source_path: 'C:/source/ready-902.png',
  }
  const report = readinessReport('blocked', [blocker])
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse('job-blocked-currentness') }))
  await page.route('**/api/bulk-jobs/job-blocked-currentness', (route) =>
    route.fulfill({ json: doneJob('job-blocked-currentness', report) }))
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'blocked')
  const refreshed = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    ;(document.getElementById('dataset-output-folder') as HTMLInputElement).value = 'C:/training/changed-silently'
    const changed = dm._refreshReadinessStaleness()
    return {
      changed,
      state: dm._readinessView.state,
      report: dm._readinessView.report,
      acceptedSignature: dm._readinessAcceptedSignature,
    }
  })

  expect(refreshed).toEqual({
    changed: true,
    state: 'stale',
    report: null,
    acceptedSignature: null,
  })
})

test('a successful export invalidates the accepted Readiness report before another export', async ({ page }) => {
  const reportId = 'f'.repeat(32)
  const exportJobId = 'export-success-currentness'
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse(reportId) }))
  await page.route(`**/api/bulk-jobs/${reportId}`, (route) =>
    route.fulfill({ json: doneJob(reportId, readinessReport('ready', [])) }))
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    status: 202,
    json: {
      status: 'started',
      job_id: exportJobId,
      total: 2,
      output_folder: 'C:/training/ready',
      message: 'Dataset export started',
    },
  }))
  await page.route(`**/api/bulk-jobs/${exportJobId}`, (route) =>
    route.fulfill({ json: successfulExportJob(exportJobId) }))
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  await page.evaluate(async () => {
    await (window as any).DatasetMaker._runExport()
  })

  await expect(page.locator('#dataset-result-modal')).toBeVisible()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
  const readiness = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      report: dm._readinessView.report,
      acceptedSignature: dm._readinessAcceptedSignature,
    }
  })
  expect(readiness).toEqual({ report: null, acceptedSignature: null })
})

test('a failed export invalidates Readiness when an item proves its image was written', async ({ page }) => {
  const reportId = 'g'.repeat(32)
  const exportJobId = 'export-failed-after-image-write'
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse(reportId) }))
  await page.route(`**/api/bulk-jobs/${reportId}`, (route) =>
    route.fulfill({ json: doneJob(reportId, readinessReport('ready', [])) }))
  await page.route('**/api/dataset/export/start', (route) => route.fulfill({
    status: 202,
    json: {
      status: 'started',
      job_id: exportJobId,
      total: 2,
      output_folder: 'C:/training/ready',
      message: 'Dataset export started',
    },
  }))
  await page.route(`**/api/bulk-jobs/${exportJobId}`, (route) =>
    route.fulfill({ json: failedExportJobWithWrittenImage(exportJobId) }))
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  await page.evaluate(async () => {
    await (window as any).DatasetMaker._runExport()
  })

  await expect(page.locator('#dataset-result-modal')).toBeVisible()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  expect(await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      report: dm._readinessView.report,
      acceptedSignature: dm._readinessAcceptedSignature,
    }
  })).toEqual({ report: null, acceptedSignature: null })
})

test('partial, mask-only, and config-only export results invalidate Readiness', async ({ page }) => {
  const cases = [
    {
      jobId: 'export-partial-evidence',
      jobStatus: 'done',
      resultStatus: 'partial',
      masksWritten: 0,
      trainerConfigPath: null,
    },
    {
      jobId: 'export-mask-only-evidence',
      jobStatus: 'error',
      resultStatus: 'failed',
      masksWritten: 1,
      trainerConfigPath: null,
    },
    {
      jobId: 'export-config-only-evidence',
      jobStatus: 'error',
      resultStatus: 'failed',
      masksWritten: 0,
      trainerConfigPath: 'C:/training/ready/dataset_config.toml',
    },
  ] as const
  let readinessIndex = 0
  let exportIndex = 0
  await page.route('**/api/dataset/readiness/start', (route) => {
    const reportId = `report-export-evidence-${readinessIndex}`
    readinessIndex += 1
    return route.fulfill({ status: 202, json: startResponse(reportId) })
  })
  for (let index = 0; index < cases.length; index += 1) {
    const reportId = `report-export-evidence-${index}`
    await page.route(`**/api/bulk-jobs/${reportId}`, (route) =>
      route.fulfill({ json: doneJob(reportId, readinessReport('ready', [])) }))
  }
  await page.route('**/api/dataset/export/start', (route) => {
    const current = cases[exportIndex]
    exportIndex += 1
    return route.fulfill({
      status: 202,
      json: {
        status: 'started',
        job_id: current.jobId,
        total: 2,
        output_folder: 'C:/training/ready',
        message: 'Dataset export started',
      },
    })
  })
  for (const current of cases) {
    const base = successfulExportJob(current.jobId)
    await page.route(`**/api/bulk-jobs/${current.jobId}`, (route) => route.fulfill({
      json: {
        ...base,
        status: current.jobStatus,
        error_count: current.jobStatus === 'error' ? 1 : 0,
        error_samples: current.jobStatus === 'error' ? ['Export artifact write failed'] : [],
        result: {
          ...base.result,
          status: current.resultStatus,
          exported: 0,
          error_count: current.jobStatus === 'error' ? 1 : 0,
          masks_written: current.masksWritten,
          trainer_config_path: current.trainerConfigPath,
          error_messages: current.jobStatus === 'error' ? ['Export artifact write failed'] : [],
        },
      },
    }))
  }
  await seedReadyToCheckDataset(page)

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    await page.getByTestId('dataset-readiness-check').click()
    await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
    await page.evaluate(async () => {
      await (window as any).DatasetMaker._runExport()
    })
    await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
    expect(await page.evaluate(() => {
      const dm = (window as any).DatasetMaker
      return {
        report: dm._readinessView.report,
        acceptedSignature: dm._readinessAcceptedSignature,
      }
    })).toEqual({ report: null, acceptedSignature: null })
    await page.evaluate(() => (window as any).DatasetMaker._hideResultModal())
  }
})

test('output-folder and caption edits mark a Ready report stale before confirmation', async ({ page }) => {
  let jobNumber = 0
  await page.route('**/api/dataset/readiness/start', (route) => {
    jobNumber += 1
    return route.fulfill({ status: 202, json: startResponse(`job-stale-${jobNumber}`) })
  })
  await page.route('**/api/bulk-jobs/job-stale-*', (route) => {
    const jobId = route.request().url().split('/').pop() || ''
    return route.fulfill({ json: doneJob(jobId, readinessReport('ready', [])) })
  })
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.locator('#btn-dataset-export')).toBeEnabled()
  await page.locator('#dataset-output-folder').fill('C:/training/changed')
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.locator('#btn-dataset-export')).toBeEnabled()
  await page.evaluate(() => (window as any).DatasetMaker._setPipelineTab('workbench'))
  await page.locator('#dataset-editor-textarea').fill('1girl, standing, changed caption')
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
})

test('Warnings keeps Export enabled and renders the backend warning verbatim', async ({ page }) => {
  const warning: ReadinessIssue = {
    severity: 'warning',
    code: 'existing_destination',
    message: 'The destination file already exists',
    issue_id: 'issue-existing-901',
    rule_version: 'dataset-readiness-v1',
    evidence: { observed: 'destination exists', expected: 'unused destination' },
    action: 'Review the overwrite policy before exporting.',
    destination: 'C:/training/ready/ready-a.png',
    image_id: 901,
    source_path: 'C:/source/ready-a.png',
  }
  const report = readinessReport('warnings', [warning])
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse('job-warnings') }))
  await page.route('**/api/bulk-jobs/job-warnings', (route) =>
    route.fulfill({ json: doneJob('job-warnings', report) }))
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'warnings')
  await expect(page.locator('#btn-dataset-export')).toBeEnabled()
  const issue = page.getByTestId('dataset-readiness-issue')
  await expect(issue).toContainText(warning.message)
  await expect(issue).toContainText(warning.action)
})

test('Cancel posts to the shared bulk-job endpoint and leaves Export disabled', async ({ page }) => {
  let cancelMethod = ''
  let statusRequests = 0
  let releaseRunningResponse!: () => void
  const runningResponseGate = new Promise<void>((resolve) => {
    releaseRunningResponse = resolve
  })
  const running = {
    ...doneJob('job-cancel', readinessReport('ready', [])),
    status: 'running',
    processed: 1,
    result: {},
    finished_at: null,
    message: 'Checking 1/2',
  }
  const cancelled = {
    ...running,
    status: 'cancelled',
    message: 'Cancelled',
    finished_at: 3,
  }
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse('job-cancel') }))
  await page.route('**/api/bulk-jobs/job-cancel/cancel', (route) => {
    cancelMethod = route.request().method()
    return route.fulfill({ json: cancelled })
  })
  await page.route('**/api/bulk-jobs/job-cancel', async (route) => {
    statusRequests += 1
    await runningResponseGate
    await route.fulfill({ json: running })
  })
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-cancel')).toBeVisible()
  await expect.poll(() => statusRequests).toBe(1)
  await page.getByTestId('dataset-readiness-cancel').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'cancelled')
  expect(cancelMethod).toBe('POST')
  const stalePollResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/bulk-jobs/job-cancel') && response.request().method() === 'GET')
  releaseRunningResponse()
  await stalePollResponse
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'cancelled')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
})

test('reload resumes the readiness job stored in sessionStorage', async ({ page }) => {
  let statusRequests = 0
  await page.addInitScript(() => {
    sessionStorage.setItem('sd-image-sorter-dataset-readiness-job', JSON.stringify({
      jobId: 'job-resume',
      signature: 'stored-signature',
    }))
    localStorage.setItem('sd-image-sorter-dataset-session', JSON.stringify({
      imageIds: [901, 902],
      captionEdits: { 901: '1girl, standing', 902: '1girl, sitting' },
      nlEdits: {},
      captionType: {},
      activeId: 901,
      local: null,
    }))
  })
  await stubDatasetRoutes(page)
  const cancelled = {
    ...doneJob('job-resume', readinessReport('ready', [])),
    status: 'cancelled',
    result: {},
    message: 'Cancelled while the page was reloading',
  }
  await page.route('**/api/bulk-jobs/job-resume', (route) => {
    statusRequests += 1
    return route.fulfill({ json: cancelled })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))

  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'cancelled')
  expect(statusRequests).toBe(1)
  expect(await page.evaluate(() => sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).toBeNull()
})

test('reload waits for trainer contracts before settling a completed readiness job', async ({ page }) => {
  let releaseTrainerContracts!: () => void
  const trainerContractsGate = new Promise<void>((resolve) => {
    releaseTrainerContracts = resolve
  })
  let statusRequests = 0
  let trainerContractRequests = 0
  await page.addInitScript(() => {
    sessionStorage.setItem('sd-image-sorter-dataset-readiness-job', JSON.stringify({
      jobId: 'job-resume-before-contracts',
      signature: 'stored-signature',
    }))
    localStorage.setItem('sd-image-sorter-dataset-session', JSON.stringify({
      imageIds: [901, 902],
      captionEdits: { 901: '1girl, standing', 902: '1girl, sitting' },
      nlEdits: {},
      captionType: {},
      activeId: 901,
      local: null,
    }))
  })
  await stubDatasetRoutes(page)
  await page.route('**/api/dataset/trainers', async (route) => {
    trainerContractRequests += 1
    await trainerContractsGate
    await route.continue()
  })
  await page.route('**/api/bulk-jobs/job-resume-before-contracts', (route) => {
    statusRequests += 1
    return route.fulfill({
      json: doneJob('job-resume-before-contracts', readinessReport('ready', [])),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => typeof (window as any).App?.switchView === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'checking')
  await expect.poll(() => trainerContractRequests).toBe(1)
  expect(statusRequests).toBe(0)
  expect(await page.evaluate(() =>
    sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).not.toBeNull()

  releaseTrainerContracts()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  expect(statusRequests).toBe(1)
  await expect.poll(() => page.evaluate(() =>
    sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).toBeNull()
})

test('trainer contract Retry preserves and resumes the stored readiness job', async ({ page }) => {
  let trainerContractRequests = 0
  let statusRequests = 0
  await page.addInitScript(() => {
    sessionStorage.setItem('sd-image-sorter-dataset-readiness-job', JSON.stringify({
      jobId: 'job-resume-after-contract-retry',
      signature: 'stored-signature',
    }))
    localStorage.setItem('sd-image-sorter-dataset-session', JSON.stringify({
      imageIds: [901, 902],
      captionEdits: { 901: '1girl, standing', 902: '1girl, sitting' },
      nlEdits: {},
      captionType: {},
      activeId: 901,
      local: null,
    }))
  })
  await stubDatasetRoutes(page)
  await page.route('**/api/dataset/trainers', (route) => {
    trainerContractRequests += 1
    if (trainerContractRequests === 1) {
      return route.fulfill({ status: 503, json: { detail: 'contracts unavailable' } })
    }
    return route.continue()
  })
  await page.route('**/api/bulk-jobs/job-resume-after-contract-retry', (route) => {
    statusRequests += 1
    return route.fulfill({
      json: doneJob('job-resume-after-contract-retry', readinessReport('ready', [])),
    })
  })

  await page.goto('/', { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof (window as any).App?.switchView === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  expect(statusRequests).toBe(0)
  expect(await page.evaluate(() =>
    sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).not.toBeNull()

  await page.locator('#dataset-tab-export').click()
  await page.locator('#dataset-trainer-package-panel').evaluate((panel) => {
    const advanced = panel.closest('details')
    if (!(advanced instanceof HTMLDetailsElement)) {
      throw new TypeError('Trainer package panel must be inside the Advanced details element')
    }
    advanced.open = true
  })
  await page.getByTestId('dataset-trainer-contract-retry').click()
  await expect(page.getByTestId('dataset-trainer-contract-state')).toHaveAttribute('data-state', 'ready')
  await page.locator('#dataset-output-folder').fill('C:/training/ready')
  await expect(page.getByTestId('dataset-readiness-check')).toContainText('Resume')
  await expect(page.getByTestId('dataset-readiness-check')).toBeEnabled()
  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'stale')
  expect(statusRequests).toBe(1)
  expect(await page.evaluate(() =>
    sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).toBeNull()
})

test('transient status failures retry without discarding the resumable job', async ({ page }) => {
  let statusRequests = 0
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse('job-retry') }))
  await page.route('**/api/bulk-jobs/job-retry', (route) => {
    statusRequests += 1
    if (statusRequests === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Temporary status outage' } })
    }
    return route.fulfill({ json: doneJob('job-retry', readinessReport('ready', [])) })
  })
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  expect(statusRequests).toBe(2)
  expect(await page.evaluate(() => sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).toBeNull()
})

test('exhausted status retries can resume the same job without another start request', async ({ page }) => {
  let startRequests = 0
  let statusRequests = 0
  await page.route('**/api/dataset/readiness/start', (route) => {
    startRequests += 1
    return route.fulfill({ status: 202, json: startResponse('job-resume-after-error') })
  })
  await page.route('**/api/bulk-jobs/job-resume-after-error', (route) => {
    statusRequests += 1
    if (statusRequests <= 3) {
      return route.fulfill({ status: 503, json: { detail: 'Status endpoint remains unavailable' } })
    }
    return route.fulfill({ json: doneJob('job-resume-after-error', readinessReport('ready', [])) })
  })
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('dataset-readiness-check')).toBeEnabled()
  await expect(page.getByTestId('dataset-readiness-check')).toContainText('Resume')
  expect(await page.evaluate(() => sessionStorage.getItem('sd-image-sorter-dataset-readiness-job'))).not.toBeNull()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')
  expect(startRequests).toBe(1)
  expect(statusRequests).toBe(4)
})

test('malformed, backend-error, and lost jobs render explicit non-exportable states', async ({ page }) => {
  const inconsistentReport = readinessReport('ready', [])
  inconsistentReport.summary.blocker_count = 1
  const incompleteReport = readinessReport('ready', [])
  incompleteReport.summary.processed = 0
  let startNumber = 0
  await page.route('**/api/dataset/readiness/start', (route) => {
    startNumber += 1
    if (startNumber === 1) return route.fulfill({ status: 202, json: { id: 42 } })
    const jobId = startNumber === 2
      ? 'job-inconsistent'
      : (startNumber === 3
          ? 'job-incomplete'
          : (startNumber === 4 ? 'job-mismatched' : (startNumber === 5 ? 'job-error' : 'job-lost')))
    return route.fulfill({ status: 202, json: startResponse(jobId) })
  })
  await page.route('**/api/bulk-jobs/job-inconsistent', (route) =>
    route.fulfill({ json: doneJob('job-inconsistent', inconsistentReport) }))
  await page.route('**/api/bulk-jobs/job-incomplete', (route) =>
    route.fulfill({ json: doneJob('job-incomplete', incompleteReport) }))
  await page.route('**/api/bulk-jobs/job-mismatched', (route) => route.fulfill({
    json: {
      ...doneJob('job-mismatched', readinessReport('ready', [])),
      result: { ...readinessReport('ready', []), report_id: 'different-job' },
    },
  }))
  const errorJob = {
    ...doneJob('job-error', readinessReport('ready', [])),
    status: 'error',
    result: {},
    error_count: 1,
    error_samples: ['Readiness worker could not inspect source 902'],
    message: 'Job failed due to an internal error',
  }
  await page.route('**/api/bulk-jobs/job-error', (route) => route.fulfill({ json: errorJob }))
  await page.route('**/api/bulk-jobs/job-lost', (route) =>
    route.fulfill({ status: 404, json: { detail: 'Bulk job not found' } }))
  await seedReadyToCheckDataset(page)

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#dataset-readiness-message')).toContainText('must be a string')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#dataset-readiness-message')).toContainText('ready status cannot include blockers or warnings')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#dataset-readiness-message')).toContainText('must inspect every requested item')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#dataset-readiness-message')).toContainText('does not match requested job')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'error')
  await expect(page.locator('#dataset-readiness-message')).toContainText('could not inspect source 902')

  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'lost')
  await expect(page.locator('#dataset-readiness-message')).toContainText('no longer has this readiness job')
  await expect(page.locator('#btn-dataset-export')).toBeDisabled()
})

test('readiness stays unclipped and error-free at supported desktop widths', async ({ page }) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await page.route('**/api/dataset/readiness/start', (route) =>
    route.fulfill({ status: 202, json: startResponse('job-layout') }))
  await page.route('**/api/bulk-jobs/job-layout', (route) =>
    route.fulfill({ json: doneJob('job-layout', readinessReport('ready', [])) }))
  await seedReadyToCheckDataset(page)
  await page.getByTestId('dataset-readiness-check').click()
  await expect(page.getByTestId('dataset-readiness-state')).toHaveAttribute('data-state', 'ready')

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const band = document.getElementById('dataset-readiness')
      const actions = document.querySelector('.dataset-readiness-actions')
      const heading = document.querySelector('.dataset-readiness-heading')
      if (!band || !actions || !heading) throw new Error('Readiness layout nodes are missing')
      const bandRect = band.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      const headingRect = heading.getBoundingClientRect()
      const overlap = !(
        headingRect.right <= actionsRect.left || actionsRect.right <= headingRect.left ||
        headingRect.bottom <= actionsRect.top || actionsRect.bottom <= headingRect.top
      )
      return {
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bandLeft: bandRect.left,
        bandRight: bandRect.right,
        viewportWidth: window.innerWidth,
        bandHeight: bandRect.height,
        overlap,
      }
    })
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1)
    expect(layout.bandLeft).toBeGreaterThanOrEqual(0)
    expect(layout.bandRight).toBeLessThanOrEqual(layout.viewportWidth)
    expect(layout.bandHeight).toBeGreaterThan(0)
    expect(layout.overlap).toBe(false)
  }

  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])
})
