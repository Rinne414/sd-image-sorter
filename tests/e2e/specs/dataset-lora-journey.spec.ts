import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * The default "LoRA dataset" journey: Smart Tag -> Dataset Maker -> export.
 *
 * A real-browser walkthrough found four defects on the default path; the
 * backend halves are pinned in backend/tests (test_lora_default_caption_export,
 * test_smart_tag_captioner_status, test_dataset_reexport_same_folder). This
 * spec pins what the page does with those answers:
 *
 *   1. a booru-only Smart Tag caption never becomes the NL caption, so the
 *      editor stays on "Booru" and the export does not write every tag twice;
 *   2. the trigger typed in Smart Tag carries over to the Dataset Maker;
 *   3. the confirm says when the output folder already holds files and what
 *      the same-name setting will do, and every name preview matches the
 *      names the export writes;
 *   4. with no captioner set up, Smart Tag's natural-language option starts
 *      off and a run never goes through a model download that then fails.
 *
 * Every backend route the page touches is stubbed; no model is downloaded.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const TAG_LIST = 'mylora_walk, 1girl, solo, twin braids'

async function stubCommonRoutes(page: Page): Promise<void> {
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/local-thumbnail**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
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
    for (const id of imageIds) dm.meta.set(id, { filename: `walk-${id}.png`, width: 1024, height: 1024 })
  }, ids)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await stubCommonRoutes(page)
})

// ---------------------------------------------------------------------------
// 1. Duplicated captions
// ---------------------------------------------------------------------------

test('a booru-only Smart Tag caption is not taken for the natural-language caption', async ({ page }) => {
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({
    json: {
      results: [{
        image_id: 951,
        rendered: TAG_LIST,
        filename: 'walk-951.png',
        thumbnail_path: '',
        // What the backend stores after a booru-only Smart Tag run.
        ai_caption: TAG_LIST,
        nl_caption: '',
        nl_source: '',
      }],
    },
  }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await openDatasetMaker(page, [951])

  const status = await page.evaluate(async () => (await (window as any).DatasetMaker._fetchCaptionsFor([951])).status)
  expect(status).toBe('applied')

  await page.evaluate(() => (window as any).DatasetMaker._setPipelineTab('export'))
  await page.locator('#dataset-output-folder').fill('C:/training/walk')
  const state = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return {
      type: dm._captionTypeFor(951),
      nlBaseline: dm.nlCaptions.has(951),
      imageTypes: dm._buildExportPayload().image_types,
    }
  })
  expect(state).toEqual({ type: 'booru', nlBaseline: false, imageTypes: {} })
})

test('a real sentence still becomes the natural-language caption', async ({ page }) => {
  const sentence = 'A girl walks along a quiet road.'
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({
    json: {
      results: [{
        image_id: 952,
        rendered: TAG_LIST,
        filename: 'walk-952.png',
        thumbnail_path: '',
        ai_caption: `${TAG_LIST}, ${sentence}`,
        nl_caption: sentence,
        nl_source: sentence,
      }],
    },
  }))
  await openDatasetMaker(page, [952])

  await page.evaluate(async () => (window as any).DatasetMaker._fetchCaptionsFor([952]))

  const state = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return { type: dm._captionTypeFor(952), nl: dm._nlTextFor(952) }
  })
  expect(state).toEqual({ type: 'both', nl: sentence })
})

// ---------------------------------------------------------------------------
// 2 + 4. Smart Tag: captioner default, no failing download, trigger carry-over
// ---------------------------------------------------------------------------

async function setField(page: Page, selector: string, value: string, eventName = 'input'): Promise<void> {
  await page.evaluate(({ selector: sel, value: next, eventName: name }) => {
    const field = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement
    field.value = next
    field.dispatchEvent(new Event(name, { bubbles: true }))
  }, { selector, value, eventName })
}

async function stubSmartTag(
  page: Page,
  captionerReady: boolean,
  starts: unknown[],
  settingsReads: number[] = [],
): Promise<void> {
  await markModelsReady(page, ['wd14', 'toriigate', 'florence2'], { extraVariants: ['model-a'] })
  await page.route('**/api/tagger/models', (route) => route.fulfill({
    json: {
      default: 'model-a',
      models: [{
        name: 'model-a',
        recommended: true,
        default_threshold: 0.35,
        default_character_threshold: 0.85,
        default_copyright_threshold: 0.35,
        default_max_tags_per_image: 40,
        runtime_safety_tier: 'stable',
      }],
    },
  }))
  await page.route('**/api/smart-tag/tagged-count', (route) =>
    route.fulfill({ json: { checked: 1, already_tagged: 0 } }))
  await page.route('**/api/vlm/settings', (route) => {
    settingsReads.push(Date.now())
    return route.fulfill({
    json: captionerReady
      ? { endpoint: 'http://127.0.0.1:11434/v1', use_vertex: false, captioner_ready: true, captioner_problem: '' }
      : {
          endpoint: '',
          use_vertex: false,
          captioner_ready: false,
          captioner_problem: 'Natural-language captioning is enabled, but VLM Settings has no endpoint configured.',
        },
    })
  })
  await page.route('**/api/vlm/local-models/recommended', (route) =>
    route.fulfill({ json: { ollama_installed: false, ollama_running: false } }))
  await page.route('**/api/smart-tag/start', (route) => {
    starts.push(route.request().postDataJSON())
    return route.fulfill({ json: { job_id: 'journey-job', status: 'running', active: true, total: 1 } })
  })
}

async function openSmartTag(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).SmartTag.open())
  await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
  await expect(page.locator('#smart-tag-tagger-1 option')).toHaveCount(1)
}

test('with no captioner set up, natural-language captioning starts off and says why', async ({ page }) => {
  const starts: unknown[] = []
  await stubSmartTag(page, false, starts)
  await openDatasetMaker(page, [961])
  await openSmartTag(page)

  await expect(page.locator('#smart-tag-enable-vlm')).not.toBeChecked()
  await expect(page.locator('#smart-tag-nl-unconfigured')).toBeVisible()
})

test('with a captioner set up, natural-language captioning stays on', async ({ page }) => {
  const starts: unknown[] = []
  const settingsReads: number[] = []
  await stubSmartTag(page, true, starts, settingsReads)
  await openDatasetMaker(page, [962])
  settingsReads.length = 0
  await openSmartTag(page)

  // Let the settings answer land, then confirm nothing switched it off.
  await expect.poll(() => settingsReads.length).toBeGreaterThan(0)
  await page.waitForTimeout(300)
  await expect(page.locator('#smart-tag-enable-vlm')).toBeChecked()
  await expect(page.locator('#smart-tag-nl-unconfigured')).toBeHidden()
})

test('turning captioning back on without a captioner stops the run before any download', async ({ page }) => {
  const starts: unknown[] = []
  await stubSmartTag(page, false, starts)
  await openDatasetMaker(page, [963])
  await page.evaluate(() => {
    const w = window as any
    w.__ensureCalls = []
    w.ensureFeatureModel = async (modelId: string) => {
      w.__ensureCalls.push(modelId)
      return { ok: true }
    }
  })
  await openSmartTag(page)
  await expect(page.locator('#smart-tag-enable-vlm')).not.toBeChecked()

  await page.locator('#smart-tag-enable-vlm').check()
  await page.locator('#btn-smart-tag-run').click()

  await expect(page.locator('.toast').filter({ hasText: 'no captioner is set up' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__ensureCalls)).toEqual([])
  expect(starts).toEqual([])
  await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
})

test('the trigger typed in Smart Tag carries over to an empty Dataset Maker trigger', async ({ page }) => {
  const starts: unknown[] = []
  await stubSmartTag(page, false, starts)
  await openDatasetMaker(page, [964])
  await openSmartTag(page)

  await page.locator('#smart-tag-trigger').fill('mylora_walk')
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0]).toMatchObject({ trigger_word: 'mylora_walk', enable_vlm: false })
  await expect(page.locator('#dataset-trigger')).toHaveValue('mylora_walk')
})

test('a trigger already typed in the Dataset Maker is left alone', async ({ page }) => {
  const starts: unknown[] = []
  await stubSmartTag(page, false, starts)
  await openDatasetMaker(page, [965])
  await setField(page, '#dataset-trigger', 'my_set')
  await openSmartTag(page)

  await page.locator('#smart-tag-trigger').fill('other_word')
  await page.locator('#btn-smart-tag-run').click()

  await expect.poll(() => starts.length).toBe(1)
  await expect(page.locator('#dataset-trigger')).toHaveValue('my_set')
})

// ---------------------------------------------------------------------------
// 3. Re-export into the same folder + name previews
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

async function stubExportSide(page: Page, folderStatus: Record<string, unknown>): Promise<void> {
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) => route.fulfill({
    json: {
      total: 1,
      returned: 1,
      items_truncated: false,
      items: [{
        index: 1,
        image_id: 971,
        filename: 'walk-971.png',
        output_image_name: '001_2.png',
        output_caption_name: '001_2.txt',
        caption: '1girl',
        error: null,
      }],
    },
  }))
  await page.route('**/api/dataset/output-folder-status', (route) => route.fulfill({ json: folderStatus }))
  await page.route('**/api/dataset/readiness/start', (route) => route.fulfill({
    status: 202,
    json: { id: 'job-ready', job_id: 'job-ready', kind: 'dataset_readiness', status: 'queued', total: 1, processed: 0, message: 'Queued' },
  }))
  await page.route('**/api/bulk-jobs/job-ready', (route) => route.fulfill({ json: readinessJob('job-ready') }))
}

async function openConfirm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.captions.set(971, '1girl')
    dm._setActive(971)
    dm._setPipelineTab('export')
  })
  await page.locator('input[name="dataset-naming-preset"][value="renumber"]').check()
  await page.locator('#dataset-output-folder').fill('C:/training/out1')
  await page.locator('#btn-dataset-export').click()
  await expect(page.locator('#dataset-confirm-modal')).toBeVisible()
}

test('the confirm says the folder already holds a dataset and what "add a number" will do', async ({ page }) => {
  await stubExportSide(page, {
    exists: true, file_count: 51, image_count: 25, caption_count: 25, has_export_manifest: true,
  })
  await openDatasetMaker(page, [971])
  await openConfirm(page)

  const note = page.locator('#dataset-confirm-folder-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('51')
  await expect(note).toContainText('25')
  await expect(note).toContainText('both sets')
  // The naming line describes the names the export writes (no trigger set).
  await expect(page.locator('#dataset-confirm-summary')).toContainText('001.png')
  await expect(page.locator('#dataset-confirm-summary')).not.toContainText('subject_001')
})

test('the confirm says same-name files are replaced when the setting is Replace', async ({ page }) => {
  await stubExportSide(page, {
    exists: true, file_count: 4, image_count: 2, caption_count: 2, has_export_manifest: false,
  })
  await openDatasetMaker(page, [971])
  await setField(page, '#dataset-overwrite', 'overwrite', 'change')
  await openConfirm(page)

  const note = page.locator('#dataset-confirm-folder-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('replaced')
})

test('the confirm adds no folder note for an empty or new folder', async ({ page }) => {
  await stubExportSide(page, {
    exists: false, file_count: 0, image_count: 0, caption_count: 0, has_export_manifest: false,
  })
  await openDatasetMaker(page, [971])
  await openConfirm(page)

  await expect(page.locator('#dataset-confirm-check-status')).not.toBeEmpty()
  await expect(page.locator('#dataset-confirm-folder-note')).toBeHidden()
})

test('the output-name chip shows the name the export will write', async ({ page }) => {
  await stubExportSide(page, {
    exists: true, file_count: 51, image_count: 25, caption_count: 25, has_export_manifest: true,
  })
  await openDatasetMaker(page, [971])
  await page.evaluate(() => (window as any).DatasetMaker._setPipelineTab('export'))
  await page.locator('input[name="dataset-naming-preset"][value="renumber"]').check()
  await page.locator('#dataset-output-folder').fill('C:/training/out1')
  await page.evaluate(() => (window as any).DatasetMaker._refreshExportPreview())

  await expect(page.locator('#dataset-pair-chip-png')).toHaveText('001_2.png')
  await expect(page.locator('#dataset-pair-chip-txt')).toHaveText('001_2.txt')
})
