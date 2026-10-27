import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

/**
 * Classic interface: the three Check-step features V Opus got first.
 *
 *  1. Subject-count conflicts: the Review Cockpit health check lists them with a
 *     preview (a tick per picture) and one undoable apply.
 *  2. Blurry / very flat pictures: the Quality Audit scores them in the
 *     background (bulk job, progress, stop), with the sharpness threshold.
 *  3. Long captions: an estimate until Anima's two tokenizer files are
 *     downloaded (14 MB, asked first), exact Qwen3 / T5 counts afterwards.
 *
 * Every backend answer is route-mocked: no model or tokenizer is downloaded and
 * no picture is scored. The backend contracts are pinned by
 * backend/tests/test_dataset_quality.py, test_caption_tokenizers.py and
 * test_dataset_consistency_service.py.
 */

test.describe.configure({ mode: 'serial' })

interface SeedRow {
  id: number
  filename: string
  caption: string
  nl?: string
}

const EMPTY_AUDIT = {
  summary: {
    total: 0, low_quality_count: 0, duplicate_pairs: 0, untagged_count: 0, small_count: 0, missing_count: 0,
    avg_aesthetic: null, near_duplicate_check_limited: false, near_duplicate_checked: false,
    near_duplicate_attempted: 0, near_duplicate_hashes: 0, near_duplicate_failed: 0,
    near_duplicate_unavailable_count: 0, near_duplicate_error: '',
  },
  items: [],
  items_truncated: false,
  items_returned: 0,
  duplicate_groups: [],
}

const TOKENIZER_STATUS = {
  profile: 'anima',
  model: 'Anima',
  limit: 512,
  available: false,
  tokenizers_package: true,
  files: [
    { id: 'qwen3_0_6b', label: 'Qwen3-0.6B', size_bytes: 11422654, present: false },
    { id: 't5_v1_1_xxl', label: 'T5 v1.1 XXL', size_bytes: 2424064, present: false },
  ],
  download_bytes: 13846718,
  download_bytes_total: 13846718,
  preparing: false,
  step: '',
  error: null,
}

async function boot(page: Page, lang = 'en') {
  await page.addInitScript((l: string) => {
    localStorage.setItem('sd-image-sorter-lang', l)
  }, lang)
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/scores/stats', (route) => route.fulfill({
    json: { enabled: true, floor: 0.15, total_rows: 0, images_with_scores: 0, models: [], estimated_bytes: 0 },
  }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () => typeof (window as any).DatasetMaker?._setActive === 'function' && !!(window as any).SeparationConsole,
  )
}

async function seedQueue(page: Page, rows: SeedRow[]) {
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate((seedRows: SeedRow[]) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = seedRows.map((r) => r.id)
    for (const r of seedRows) {
      dm.meta.set(r.id, { filename: r.filename, width: 512, height: 512 })
      dm.captions.set(r.id, r.caption)
      if (r.nl != null) dm.nlCaptions.set(r.id, r.nl)
    }
    dm._setActive(seedRows[0].id)
    // The Import tab shows its audit card once the queue has pictures.
    dm._updateCount?.()
    dm._renderQueue?.()
  }, rows)
}

const json = (route: Route, body: unknown) => route.fulfill({ json: body as object })

async function openReviewCockpit(page: Page) {
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-separation-console summary').click()
  await expect(page.locator('#sepcon-rows')).toBeVisible()
}

const editsOf = (page: Page, ids: number[]) =>
  page.evaluate((list: number[]) => {
    const dm = (window as any).DatasetMaker
    return Object.fromEntries(list.map((id) => [id, dm.captionEdits.has(id) ? dm.captionEdits.get(id) : null]))
  }, ids)

// ---- 1. subject-count fixes ---------------------------------------------------

function subjectReport(proposals: Array<{ image_id: number; keep: string[]; drop: string[] }>) {
  return {
    images: proposals.length,
    findings: [{
      id: 'subject-count-conflict', severity: 'medium',
      title_en: `Subject-count tags contradict each other: ${proposals.length} images`,
      title_zh: `${proposals.length} 张图的人数标签互相矛盾`,
      detail_en: 'Keep the higher count and drop solo.', detail_zh: '保留较高的人数并去掉 solo。',
      fix: { action: 'resolve_subject_counts', proposals },
      data: { count: proposals.length, image_ids: proposals.map((p) => p.image_id) },
    }],
  }
}

test.describe('subject-count fixes in the health check', () => {
  test('preview with a tick per picture, one apply, one undo; solo_focus and unticked pictures stay', async ({ page }) => {
    await boot(page)
    await page.route('**/api/tags/consistency/report', (route) => json(route, subjectReport([
      { image_id: 701, keep: ['2girls'], drop: ['1girl', 'solo'] },
      { image_id: 702, keep: ['1girl', '1boy'], drop: ['solo'] },
      { image_id: 703, keep: ['multiple girls'], drop: ['1girl'] },
      { image_id: 704, keep: ['2girls'], drop: ['1girl'] },
    ])))
    await seedQueue(page, [
      { id: 701, filename: 'a.png', caption: '1girl, solo, 2girls, long_hair' },
      { id: 702, filename: 'b.png', caption: '1girl, 1boy, solo, solo_focus' },
      { id: 703, filename: 'c.png', caption: '1girl, multiple_girls, smile' },
      { id: 704, filename: 'd.png', caption: 'standing, smile' },
    ])
    await openReviewCockpit(page)
    await page.locator('#sepcon-health-run').click()

    const box = page.locator('[data-testid="check-subject-fixes"]')
    await expect(box).toBeVisible()
    await expect(box.locator('[data-testid="check-subject-row"]')).toHaveCount(4)
    // The first picture keeps 2girls and loses 1girl and solo (struck through).
    const first = box.locator('[data-testid="check-subject-row"][data-image-id="701"]')
    await expect(first.locator('.dchk-tag-keep')).toHaveText(['2girls'])
    await expect(first.locator('.dchk-tag-drop')).toHaveText(['1girl', 'solo'])
    await expect(box.locator('[data-testid="check-subject-apply"]')).toHaveText('Apply to the 4 ticked')

    await box.locator('[data-testid="check-subject-row"][data-image-id="703"] input').uncheck()
    await expect(box.locator('[data-testid="check-subject-apply"]')).toHaveText('Apply to the 3 ticked')
    await box.locator('[data-testid="check-subject-apply"]').click()

    expect(await editsOf(page, [701, 702, 703, 704])).toEqual({
      701: '2girls, long_hair',
      702: '1girl, 1boy, solo_focus',
      703: null, // unticked: untouched
      704: null, // had none of the tags in its tag box: nothing to change
    })
    // Honest result: one ticked picture could not be changed.
    await expect(box.locator('.dchk-note')).toHaveText(/^Changed 2 of 3 captions\./)
    // Each changed picture can also be undone on its own (Ctrl+Z in the editor).
    expect(await page.evaluate(() => (window as any).DatasetMaker._undoStacks.get(701))).toEqual(['1girl, solo, 2girls, long_hair'])

    await box.locator('[data-testid="check-subject-undo"]').click()
    expect(await editsOf(page, [701, 702, 703, 704])).toEqual({ 701: null, 702: null, 703: null, 704: null })
    await expect(box.locator('.dchk-note')).toHaveText('Put back 2 captions.')
    await expect(box.locator('[data-testid="check-subject-apply"]')).toBeVisible()
  })

  test('a caption edited after the fix is left alone by the undo', async ({ page }) => {
    await boot(page)
    await page.route('**/api/tags/consistency/report', (route) => json(route, subjectReport([
      { image_id: 711, keep: ['2girls'], drop: ['1girl'] },
      { image_id: 712, keep: ['2girls'], drop: ['1girl'] },
    ])))
    await seedQueue(page, [
      { id: 711, filename: 'a.png', caption: '1girl, 2girls' },
      { id: 712, filename: 'b.png', caption: '1girl, 2girls, smile' },
    ])
    await openReviewCockpit(page)
    await page.locator('#sepcon-health-run').click()
    const box = page.locator('[data-testid="check-subject-fixes"]')
    await box.locator('[data-testid="check-subject-apply"]').click()
    expect(await editsOf(page, [711, 712])).toEqual({ 711: '2girls', 712: '2girls, smile' })

    await page.evaluate(() => (window as any).DatasetMaker.captionEdits.set(712, '2girls, smile, my own edit'))
    await box.locator('[data-testid="check-subject-undo"]').click()
    expect(await editsOf(page, [711, 712])).toEqual({ 711: null, 712: '2girls, smile, my own edit' })
    await expect(box.locator('.dchk-note')).toHaveText(/^Put back 1 of 2 captions\./)
  })

  test('a long list draws 30 rows, "Show all" draws the rest, and every picture can be ticked', async ({ page }) => {
    await boot(page)
    const ids = Array.from({ length: 40 }, (_, i) => 801 + i)
    await page.route('**/api/tags/consistency/report', (route) => json(route, subjectReport(
      ids.map((id) => ({ image_id: id, keep: ['2girls'], drop: ['solo'] })),
    )))
    await seedQueue(page, ids.map((id) => ({ id, filename: `p${id}.png`, caption: '2girls, solo' })))
    await openReviewCockpit(page)
    await page.locator('#sepcon-health-run').click()
    const box = page.locator('[data-testid="check-subject-fixes"]')
    await expect(box.locator('[data-testid="check-subject-row"]')).toHaveCount(30)
    await expect(box.locator('[data-testid="check-subject-show-all"]')).toHaveText('Show all 40 pictures')
    await box.locator('[data-testid="check-subject-show-all"]').click()
    await expect(box.locator('[data-testid="check-subject-row"]')).toHaveCount(40)

    // Untick all (the label flips), tick one of the last rows, apply only it.
    await box.locator('[data-testid="check-subject-toggle"]').click()
    await expect(box.locator('[data-testid="check-subject-apply"]')).toBeDisabled()
    await expect(box.locator('[data-testid="check-subject-toggle"]')).toHaveText('Tick all')
    await box.locator('[data-testid="check-subject-row"][data-image-id="840"] input').check()
    await box.locator('[data-testid="check-subject-apply"]').click()
    expect(await editsOf(page, [801, 840])).toEqual({ 801: null, 840: '2girls' })
  })

  test('the preview reads in Chinese', async ({ page }) => {
    await boot(page, 'zh-CN')
    await page.route('**/api/tags/consistency/report', (route) => json(route, subjectReport([
      { image_id: 721, keep: ['2girls'], drop: ['1girl'] },
    ])))
    await seedQueue(page, [{ id: 721, filename: 'a.png', caption: '1girl, 2girls' }])
    await openReviewCockpit(page)
    await page.locator('#sepcon-health-run').click()
    const box = page.locator('[data-testid="check-subject-fixes"]')
    await expect(box.locator('[data-testid="check-subject-apply"]')).toHaveText('应用到已勾选的 1 张')
    await box.locator('[data-testid="check-subject-apply"]').click()
    await expect(box.locator('.dchk-note')).toHaveText('已修改 1 条 caption。')
    await expect(box.locator('[data-testid="check-subject-undo"]')).toHaveText('撤销（1）')
  })
  test('pictures imported from a folder are checked by their captions and can be fixed', async ({ page }) => {
    // The real backend: folder pictures have no Library row, only their captions.
    await boot(page)
    const sent: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (request.url().includes('/api/tags/consistency/report')) sent.push(request.postDataJSON())
    })
    await seedQueue(page, [
      { id: -11, filename: 'folder-a.png', caption: '1girl, 2girls, solo, long_hair' },
      { id: -12, filename: 'folder-b.png', caption: '1girl, solo', nl: 'A girl waves.' },
    ])
    await openReviewCockpit(page)
    await page.locator('#sepcon-health-run').click()

    const results = page.locator('#sepcon-health-results')
    await expect(results).toContainText('2 images checked')
    await expect(results).not.toContainText('local-import')
    const box = page.locator('[data-testid="check-subject-fixes"]')
    await expect(box.locator('[data-testid="check-subject-row"]')).toHaveCount(1)
    await expect(box.locator('[data-testid="check-subject-row"][data-image-id="-11"]')).toBeVisible()
    expect(sent[0].image_ids).toEqual([-11, -12])
    expect(sent[0].effective_captions).toEqual([
      { image_id: -11, caption: '1girl, 2girls, solo, long_hair', tags: '1girl, 2girls, solo, long_hair' },
      { image_id: -12, caption: '1girl, solo, A girl waves.', tags: '1girl, solo' },
    ])

    await box.locator('[data-testid="check-subject-apply"]').click()
    await expect(box.locator('.dchk-note')).toHaveText('Changed 1 caption.')
    expect(await editsOf(page, [-11, -12])).toEqual({ '-11': '2girls, long_hair', '-12': null })
  })
})

// ---- 2. blurry / flat pictures in the Quality Audit --------------------------------
  test('pictures imported from a folder are checked by their captions and can be fixed', async ({ page }) => {
    // The real backend: folder pictures have no Library row, only their captions.
    await boot(page)
    const sent: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (request.url().includes('/api/tags/consistency/report')) sent.push(request.postDataJSON())
    })
    await seedQueue(page, [
      { id: -11, filename: 'folder-a.png', caption: '1girl, 2girls, solo, long_hair' },
      { id: -12, filename: 'folder-b.png', caption: '1girl, solo', nl: 'A girl waves.' },
    ])
    await openReviewCockpit(page)
    await page.locator('#sepcon-health-run').click()

    const results = page.locator('#sepcon-health-results')
    await expect(results).toContainText('2 images checked')
    await expect(results).not.toContainText('local-import')
    const box = page.locator('[data-testid="check-subject-fixes"]')
    await expect(box.locator('[data-testid="check-subject-row"]')).toHaveCount(1)
    await expect(box.locator('[data-testid="check-subject-row"][data-image-id="-11"]')).toBeVisible()
    expect(sent[0].image_ids).toEqual([-11, -12])
    expect(sent[0].effective_captions).toEqual([
      { image_id: -11, caption: '1girl, 2girls, solo, long_hair', tags: '1girl, 2girls, solo, long_hair' },
      { image_id: -12, caption: '1girl, solo, A girl waves.', tags: '1girl, solo' },
    ])

    await box.locator('[data-testid="check-subject-apply"]').click()
    await expect(box.locator('.dchk-note')).toHaveText('Changed 1 caption.')
    expect(await editsOf(page, [-11, -12])).toEqual({ '-11': '2girls, long_hair', '-12': null })
  })

async function openAudit(page: Page) {
  await page.locator('#dataset-tab-import').click()
  await page.locator('#btn-dataset-import-audit').click()
  await expect(page.locator('#dataset-audit-modal')).toBeVisible()
}

function qualityAnswer(extra: Record<string, unknown>) {
  return {
    scores_version: 1, total: 3, scored: 3, pending: 0, unreadable: 0, missing: 0, job_id: null, started: false,
    thresholds: { blur_below: 50, flat_above: 0.92 }, items: [], ...extra,
  }
}

test.describe('blurry and flat pictures in the Quality Audit', () => {
  test('scored in the background with progress, then listed as badges that filter the queue', async ({ page }) => {
    await boot(page)
    const qualityBodies: Array<Record<string, any>> = []
    let jobPolls = 0
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', async (route) => {
      const body = route.request().postDataJSON() as Record<string, any>
      qualityBodies.push(body)
      if (qualityBodies.length === 1) {
        await json(route, qualityAnswer({ scored: 0, pending: 3, job_id: 'job-q1', started: true }))
        return
      }
      await json(route, qualityAnswer({
        items: [
          { image_id: 701, abs_path: 'C:/pics/a.png', blur: 12, edge: 0.001, flat: 0.2, flags: ['blurry'] },
          { image_id: 702, abs_path: 'C:/pics/b.png', blur: 0, edge: 0, flat: 0.97, flags: ['flat'] },
        ],
      }))
    })
    await page.route('**/api/bulk-jobs/job-q1', async (route) => {
      jobPolls += 1
      await json(route, jobPolls < 3
        ? { job_id: 'job-q1', status: 'running', total: 3, processed: 1, error_samples: [], message: 'Scoring picture quality' }
        : { job_id: 'job-q1', status: 'done', total: 3, processed: 3, error_samples: [], message: 'done' })
    })
    await seedQueue(page, [
      { id: 701, filename: 'a.png', caption: '1girl' },
      { id: 702, filename: 'b.png', caption: '1girl' },
      { id: 703, filename: 'c.png', caption: '1girl' },
    ])
    await page.evaluate(() => {
      const dm = (window as any).DatasetMaker
      dm.localItemPaths.set(-5, 'C:/pics/local-one.png')
      dm.imageIds = [...dm.imageIds, -5]
      dm.meta.set(-5, { filename: 'local-one.png', width: 512, height: 512, abs_path: 'C:/pics/local-one.png' })
      dm._updateCount?.()
    })
    await openAudit(page)

    // The sharpness field starts at the backend's default and the controls are in the audit.
    await expect(page.locator('#dataset-audit-blur-below')).toHaveValue('50')
    // Progress shows while the job runs, with a way to stop it.
    await expect(page.locator('#dataset-audit-hints-progress')).toBeVisible()
    await expect(page.locator('#btn-dataset-audit-quality-stop')).toBeVisible()
    await expect(page.locator('#dataset-audit-status')).toContainText('Scoring pictures… 1 of 3')

    await expect(page.locator('#dataset-audit-hints-progress')).toBeHidden()
    await expect(page.locator('#btn-dataset-audit-quality-stop')).toBeHidden()
    await expect(page.locator('#dataset-audit-status')).toContainText('Blur check: 3 pictures scored, 1 may be soft or blurry, 1 very flat.')
    await expect(page.locator('.dataset-audit-badge[data-flag="blurry"]')).toContainText('May be soft or blurry')
    await expect(page.locator('.dataset-audit-badge[data-flag="blurry"]')).toContainText('1')
    await expect(page.locator('.dataset-audit-badge[data-flag="flat"]')).toContainText('Very flat')

    // Library pictures go by id, a folder file by path; the default threshold is sent; a job is started.
    expect(qualityBodies[0]).toMatchObject({ image_ids: [701, 702, 703], image_paths: ['C:/pics/local-one.png'], start: true, blur_below: 50 })

    // The first finding becomes the queue filter (the queue highlights what it lists) and offers the next step.
    expect(await page.evaluate(() => (window as any).DatasetMaker._auditState.activeFilter)).toBe('blurry')
    await page.locator('.dataset-audit-badge[data-flag="flat"]').click()
    expect(await page.evaluate(() => (window as any).DatasetMaker._auditState.activeFilter)).toBe('flat')
    await expect(page.locator('#dataset-audit-next-steps')).toContainText('almost one colour')
  })

  test('the sharpness threshold is sent, 0 keeps only flat pictures, and unticking skips the check', async ({ page }) => {
    await boot(page)
    const bodies: Array<Record<string, any>> = []
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', async (route) => {
      const body = route.request().postDataJSON() as Record<string, any>
      bodies.push(body)
      await json(route, qualityAnswer({
        items: body.blur_below > 0
          ? [{ image_id: 701, abs_path: 'a', blur: 12, edge: 0, flat: 0.2, flags: ['blurry'] }]
          : [{ image_id: 702, abs_path: 'b', blur: 0, edge: 0, flat: 0.97, flags: ['flat'] }],
      }))
    })
    await seedQueue(page, [
      { id: 701, filename: 'a.png', caption: '1girl' },
      { id: 702, filename: 'b.png', caption: '1girl' },
      { id: 703, filename: 'c.png', caption: '1girl' },
    ])
    await openAudit(page)
    await expect(page.locator('.dataset-audit-badge[data-flag="blurry"]')).toBeVisible()

    await page.locator('#dataset-audit-blur-below').fill('0')
    await page.locator('#btn-dataset-audit-run').click()
    await expect(page.locator('.dataset-audit-badge[data-flag="flat"]')).toBeVisible()
    await expect(page.locator('.dataset-audit-badge[data-flag="blurry"]')).toHaveCount(0)
    expect(bodies.map((b) => b.blur_below)).toEqual([50, 0])

    await page.locator('#dataset-audit-check-blur').uncheck()
    await expect(page.locator('#dataset-audit-blur-below')).toBeDisabled()
    await page.locator('#btn-dataset-audit-run').click()
    await expect(page.locator('#btn-dataset-audit-run')).toBeEnabled()
    expect(bodies).toHaveLength(2)
    await expect(page.locator('.dataset-audit-badge[data-flag="flat"]')).toHaveCount(0)
  })

  test('Stop scoring cancels the job and the audit says how far it got', async ({ page }) => {
    await boot(page)
    let cancelled = false
    let askedAfterStop: Record<string, any> | null = null
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', async (route) => {
      const body = route.request().postDataJSON() as Record<string, any>
      if (!cancelled) {
        await json(route, qualityAnswer({ scored: 0, pending: 3, job_id: 'job-q2', started: true }))
        return
      }
      askedAfterStop = body
      await json(route, qualityAnswer({ scored: 1, pending: 2, items: [] }))
    })
    await page.route('**/api/bulk-jobs/job-q2', (route) => json(route, cancelled
      ? { job_id: 'job-q2', status: 'cancelled', total: 3, processed: 1, error_samples: [], message: 'cancelled' }
      : { job_id: 'job-q2', status: 'running', total: 3, processed: 1, error_samples: [], message: 'Scoring picture quality' }))
    await page.route('**/api/bulk-jobs/job-q2/cancel', (route) => {
      cancelled = true
      return json(route, { status: 'cancelling' })
    })
    await seedQueue(page, [
      { id: 701, filename: 'a.png', caption: '1girl' },
      { id: 702, filename: 'b.png', caption: '1girl' },
      { id: 703, filename: 'c.png', caption: '1girl' },
    ])
    await openAudit(page)
    await expect(page.locator('#dataset-audit-status')).toContainText('Scoring pictures… 1 of 3')
    await page.locator('#btn-dataset-audit-quality-stop').click()
    await expect(page.locator('#dataset-audit-status')).toContainText('Stopped: 1 of 3 pictures scored.')
    await expect(page.locator('#dataset-audit-hints-progress')).toBeHidden()
    // After a stop it only reads what is scored; it does not start another job.
    expect(askedAfterStop).toMatchObject({ start: false })
  })

  test('a failed scoring job is reported in words and the audit itself still shows', async ({ page }) => {
    await boot(page)
    await page.route('**/api/dataset/audit', (route) => json(route, {
      ...EMPTY_AUDIT, summary: { ...EMPTY_AUDIT.summary, untagged_count: 3 },
      items: [{ image_id: 701, abs_path: 'a', flags: ['untagged'] }],
    }))
    await page.route('**/api/dataset/quality', (route) => route.fulfill({ status: 500, json: { detail: 'Quality check failed.' } }))
    await seedQueue(page, [{ id: 701, filename: 'a.png', caption: '' }])
    await openAudit(page)
    await expect(page.locator('#dataset-audit-status')).toContainText('Blur check failed:')
    await expect(page.locator('.dataset-audit-badge[data-flag="untagged"]')).toBeVisible()
  })

  test('the audit controls and result read in Chinese', async ({ page }) => {
    await boot(page, 'zh-CN')
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', (route) => json(route, qualityAnswer({
      items: [{ image_id: 701, abs_path: 'a', blur: 12, edge: 0, flat: 0.2, flags: ['blurry'] }],
    })))
    await seedQueue(page, [{ id: 701, filename: 'a.png', caption: '1girl' }])
    await openAudit(page)
    await expect(page.locator('label:has(#dataset-audit-check-blur)')).toContainText('糊图 / 过平：清晰度低于')
    await expect(page.locator('.dataset-audit-badge[data-flag="blurry"]')).toContainText('可能偏软或糊')
    await expect(page.locator('#dataset-audit-status')).toContainText('糊图检查：已评分 3 张，可能偏软或糊 1 张，过于平 0 张。')
  })
})

// ---- 3. exact Anima token counts ----------------------------------------------

test.describe('the empty-caption check reads the captions the export writes', () => {
  test('typed and cleared Dataset Maker captions are counted for Library and folder pictures', async ({ page }) => {
    await boot(page)
    const audits: Array<Record<string, any>> = []
    await page.route('**/api/dataset/audit', (route) => {
      audits.push(route.request().postDataJSON() as Record<string, any>)
      return json(route, EMPTY_AUDIT)
    })
    await page.route('**/api/dataset/quality', (route) => json(route, qualityAnswer({})))
    await seedQueue(page, [
      { id: 701, filename: 'typed.png', caption: '1girl, smile, outdoors' },
      { id: 702, filename: 'cleared.png', caption: '' },
    ])
    await page.evaluate(() => {
      const dm = (window as any).DatasetMaker
      dm.localItemPaths.set(-5, 'C:/pics/local-one.png')
      dm.imageIds = [...dm.imageIds, -5]
      dm.meta.set(-5, { filename: 'local-one.png', width: 512, height: 512, abs_path: 'C:/pics/local-one.png' })
      dm.captions.set(-5, 'sky, cloud')
      dm._updateCount?.()
    })
    await openAudit(page)
    await expect.poll(() => audits.length).toBeGreaterThan(0)
    // Library tags would call 701 untagged and 702 tagged; the export writes the opposite.
    expect(audits[0].caption_tag_counts).toEqual({ 701: 3, 702: 0 })
    expect(audits[0].extra_tag_counts).toEqual({ 'C:/pics/local-one.png': 2 })
  })
})

async function chooseAnima(page: Page) {
  await page.evaluate(() => {
    const select = document.getElementById('dataset-target-model') as HTMLSelectElement
    select.value = 'anima'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const LONG_CAPTION = Array.from({ length: 300 }, (_, i) => `detail_${i.toString(36)}x`).join(', ')

/** The status as the backend answers it: for the profile the page asked about. */
const profileOf = (route: Route) => new URL(route.request().url()).searchParams.get('profile') || 'anima'

const ANIMA_METRICS = [{ id: 'qwen3_0_6b', label: 'Qwen3-0.6B' }, { id: 't5_v1_1_xxl', label: 'T5 v1.1 XXL' }]

test.describe('exact token counts per base model', () => {
  test('estimate first with the download asked for (14 MB), exact counts once the tokenizers are there', async ({ page }) => {
    await boot(page)
    let available = false
    let preparing = 0
    const counted: Array<Record<string, any>> = []
    const prepareCalls: string[] = []
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', (route) => json(route, qualityAnswer({})))
    await page.route('**/api/dataset/caption-tokens/status**', (route) => json(route, {
      ...TOKENIZER_STATUS,
      profile: profileOf(route),
      available,
      preparing: preparing > 0 && !available,
      files: TOKENIZER_STATUS.files.map((f) => ({ ...f, present: available })),
      download_bytes: available ? 0 : TOKENIZER_STATUS.download_bytes,
    }))
    await page.route('**/api/dataset/caption-tokens/prepare**', (route) => {
      prepareCalls.push(profileOf(route))
      preparing = 1
      // The download "finishes" a moment later.
      setTimeout(() => { available = true }, 1500)
      return json(route, { status: 'started' })
    })
    await page.route('**/api/dataset/caption-tokens', async (route) => {
      const body = route.request().postDataJSON() as { profile: string; texts: string[] }
      counted.push(body)
      await json(route, {
        profile: 'anima', limit: 512, available: true, metrics: ANIMA_METRICS, missing: [],
        counts: body.texts.map((text) => (text.length > 1000
          ? { qwen3_0_6b: 640, t5_v1_1_xxl: 655 }
          : { qwen3_0_6b: 8, t5_v1_1_xxl: 9 })),
      })
    })
    await seedQueue(page, [
      { id: 701, filename: 'long.png', caption: LONG_CAPTION },
      { id: 702, filename: 'short.png', caption: '1girl, solo' },
    ])
    await chooseAnima(page)

    // The editor's counter is an estimate and offers the download, with its size.
    await page.locator('#dataset-tab-workbench').click()
    await page.evaluate(() => (window as any).DatasetMaker._setActive(701))
    const counter = page.locator('#dataset-token-counter')
    await expect(counter).toContainText('300 tags · ≈')
    await expect(counter.locator('[data-testid="token-counter-get-exact"]')).toHaveText('Exact counts (14 MB, once)')

    // The audit says so too: estimated counts, and the download button states the size.
    await openAudit(page)
    await expect(page.locator('#dataset-audit-tokens-prepare')).toBeVisible()
    await expect(page.locator('#dataset-audit-tokens-note')).toContainText('only estimates')
    await expect(page.locator('#dataset-audit-tokens-note')).toContainText('about 14 MB, downloaded once')
    await expect(page.locator('#btn-dataset-audit-tokens-prepare')).toHaveText('Download for exact counts (14 MB)')
    await expect(page.locator('label:has(#dataset-audit-check-tokens)')).toContainText('over 512 tokens')
    await expect(page.locator('#dataset-audit-status')).toContainText('These are estimates')
    await expect(page.locator('.dataset-audit-badge[data-flag="too_long"]')).toContainText('1')
    expect(counted).toHaveLength(0) // no exact count is asked for before the download
    expect(prepareCalls).toHaveLength(0) // and nothing is downloaded until the button is pressed

    await page.locator('#btn-dataset-audit-tokens-prepare').click()
    await expect(page.locator('#btn-dataset-audit-tokens-prepare')).toHaveText('Downloading…')
    await expect(page.locator('#dataset-audit-tokens-note')).toHaveText(
      'Exact token counts are ready: every caption is counted with Qwen3-0.6B + T5 v1.1 XXL, as the Anima text encoder reads it.',
      { timeout: 15000 },
    )
    expect(prepareCalls).toEqual(['anima'])

    await page.locator('#btn-dataset-audit-run').click()
    await expect(page.locator('#dataset-audit-status')).toContainText('exact counts with Qwen3-0.6B + T5 v1.1 XXL')
    await expect(page.locator('.dataset-audit-badge[data-flag="too_long"]')).toContainText('1')
    const auditCall = counted.find((c) => c.texts.length === 2)
    expect(auditCall).toMatchObject({ profile: 'anima' })
    expect(auditCall!.texts[0]).toBe(LONG_CAPTION)

    // Back in the editor the counter shows both exact counts.
    await page.locator('#btn-dataset-audit-close').click()
    await page.locator('#dataset-tab-workbench').click()
    await page.evaluate(() => { (window as any).DatasetMaker._setActive(702); (window as any).DatasetMaker._setActive(701) })
    await expect(counter).toContainText('300 tags · Qwen3 640 · T5 655 tokens')
    await expect(counter).toHaveAttribute('title', /Over 512 tokens/)
  })

  test('SDXL counts with CLIP: its own 2 MB download, 75 tokens, CLIP counts in the editor', async ({ page }) => {
    await boot(page)
    let available = false
    const statusProfiles: string[] = []
    const prepared: string[] = []
    const counted: Array<{ profile: string; texts: string[] }> = []
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', (route) => json(route, qualityAnswer({})))
    await page.route('**/api/dataset/caption-tokens/status**', (route) => {
      statusProfiles.push(profileOf(route))
      return json(route, {
        profile: 'sdxl', model: 'SDXL', limit: 75, available, tokenizers_package: true,
        files: [{ id: 'clip_vit_l_14', label: 'CLIP ViT-L/14', size_bytes: 2224003, present: available }],
        download_bytes: available ? 0 : 2224003, download_bytes_total: 2224003, preparing: false, step: '', error: null,
      })
    })
    await page.route('**/api/dataset/caption-tokens/prepare**', (route) => {
      prepared.push(profileOf(route))
      available = true
      return json(route, { status: 'started' })
    })
    await page.route('**/api/dataset/caption-tokens', async (route) => {
      const body = route.request().postDataJSON() as { profile: string; texts: string[] }
      counted.push(body)
      await json(route, {
        profile: 'sdxl', limit: 75, available: true, metrics: [{ id: 'clip_vit_l_14', label: 'CLIP ViT-L/14' }], missing: [],
        counts: body.texts.map((text) => ({ clip_vit_l_14: text.length > 1000 ? 600 : 5 })),
      })
    })
    await seedQueue(page, [
      { id: 701, filename: 'long.png', caption: LONG_CAPTION },
      { id: 702, filename: 'short.png', caption: '1girl, solo' },
    ])
    await page.evaluate(() => {
      const select = document.getElementById('dataset-target-model') as HTMLSelectElement
      select.value = 'sdxl'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await openAudit(page)
    await expect(page.locator('label:has(#dataset-audit-check-tokens)')).toContainText('over 75 tokens')
    await expect(page.locator('#dataset-audit-tokens-note')).toContainText(
      'Token counts for SDXL are only estimates until its tokenizer files are here (CLIP ViT-L/14): about 2 MB, downloaded once.',
    )
    await expect(page.locator('#btn-dataset-audit-tokens-prepare')).toHaveText('Download for exact counts (2 MB)')
    expect(counted).toEqual([])

    await page.locator('#btn-dataset-audit-tokens-prepare').click()
    await expect(page.locator('#dataset-audit-tokens-note')).toHaveText(
      'Exact token counts are ready: every caption is counted with CLIP ViT-L/14, as the SDXL text encoder reads it.',
    )
    await page.locator('#btn-dataset-audit-run').click()
    await expect(page.locator('#dataset-audit-status')).toContainText('exact counts with CLIP ViT-L/14')
    await expect(page.locator('.dataset-audit-badge[data-flag="too_long"]')).toContainText('1')
    expect(prepared).toEqual(['sdxl'])
    expect(new Set(statusProfiles)).toEqual(new Set(['sdxl']))
    expect(counted.every((c) => c.profile === 'sdxl')).toBe(true)

    await page.locator('#btn-dataset-audit-close').click()
    await page.locator('#dataset-tab-workbench').click()
    await page.evaluate(() => { (window as any).DatasetMaker._setActive(702); (window as any).DatasetMaker._setActive(701) })
    await expect(page.locator('#dataset-token-counter')).toContainText('300 tags · CLIP 600 tokens')
  })

  test('the download prompt reads in Chinese', async ({ page }) => {
    await boot(page, 'zh-CN')
    await page.route('**/api/dataset/audit', (route) => json(route, EMPTY_AUDIT))
    await page.route('**/api/dataset/quality', (route) => json(route, qualityAnswer({})))
    await page.route('**/api/dataset/caption-tokens/status**', (route) => json(route, { ...TOKENIZER_STATUS, profile: profileOf(route) }))
    await seedQueue(page, [{ id: 701, filename: 'long.png', caption: LONG_CAPTION }])
    await chooseAnima(page)
    await openAudit(page)
    await expect(page.locator('#dataset-audit-tokens-note')).toContainText('只是估算：约 14 MB，只下载一次')
    await expect(page.locator('#btn-dataset-audit-tokens-prepare')).toHaveText('下载以获得精确计数（14 MB）')
    await expect(page.locator('#dataset-audit-status')).toContainText('这是估算')
  })
})
