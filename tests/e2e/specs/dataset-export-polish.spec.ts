import { expect, test, type Page } from '../fixtures/click-ledger'
import { markModelsReady } from '../fixtures/model-status'

/**
 * Dataset Maker / Smart Tag polish found in a 1366x768 walkthrough:
 *
 *  12. Smart Tag says it finished, with counts, where the user is looking,
 *      and its progress is visible without scrolling;
 *  13. the export header count follows the set after a reject + Z restore;
 *  14. a red token count says why and what to do;
 *  15. workbench layout: the zoom bar clears the editor title, the step rail
 *      never covers the setup fields, the tag colour legend starts folded
 *      and remembers, and the export tab opens at its top.
 *
 * Every backend route the page touches is stubbed; no model is downloaded.
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await stubCommonRoutes(page)
})

// ---------------------------------------------------------------------------
// 13. Export header count after reject + Z restore
// ---------------------------------------------------------------------------

test('the export header count follows the set after a reject is undone', async ({ page }) => {
  const ids = Array.from({ length: 25 }, (_, index) => 1001 + index)
  await openDatasetMaker(page, ids)
  // The import flows announce a membership change; seed the same way.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dataset:changed')))
  const line = page.locator('#dataset-steps-line')
  await expect(line).toContainText('25 images')

  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._setPipelineTab('workbench')
    dm._setActive(1005)
    dm._dropImageForReview(1005)
  })
  await expect(line).toContainText('24 images')
  await page.evaluate(() => (window as any).DatasetMaker._undoReviewDrop())
  await expect(line).toContainText('25 images')
})

// ---------------------------------------------------------------------------
// 14. Red token count explains itself
// ---------------------------------------------------------------------------

test('an over-budget token count says why and what to do', async ({ page }) => {
  await openDatasetMaker(page, [991])
  const longCaption = Array.from({ length: 40 }, (_, index) => `long_descriptive_tag_${index}`).join(', ')
  await page.evaluate((caption) => {
    const dm = (window as any).DatasetMaker
    dm._setPipelineTab('workbench')
    dm._setActive(991)
    const box = document.getElementById('dataset-editor-textarea') as HTMLTextAreaElement
    box.value = caption
    ;(window as any).SeparationConsole._updateTokenCounter()
  }, longCaption)

  const counter = page.locator('#dataset-token-counter')
  await expect(counter).toHaveClass(/dataset-token-counter-over/)
  const note = page.locator('#dataset-token-counter-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('75')
  await expect(note).toContainText('max_token_length')
  await expect(counter).toHaveAttribute('title', /75-token/)

  await page.evaluate(() => {
    const box = document.getElementById('dataset-editor-textarea') as HTMLTextAreaElement
    box.value = '1girl, solo'
    ;(window as any).SeparationConsole._updateTokenCounter()
  })
  await expect(counter).not.toHaveClass(/dataset-token-counter-over/)
  await expect(note).toBeHidden()
})

// ---------------------------------------------------------------------------
// 12. Smart Tag completion notice
// ---------------------------------------------------------------------------

type RunPhase = { value: 'idle' | 'running' | 'done' }

async function stubSmartTagRun(page: Page, phase: RunPhase): Promise<void> {
  await markModelsReady(page, ['wd14'], { extraVariants: ['model-a'] })
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
    route.fulfill({ json: { checked: 6, already_tagged: 0 } }))
  await page.route('**/api/vlm/settings', (route) => route.fulfill({
    json: { endpoint: '', use_vertex: false, captioner_ready: false, captioner_problem: 'none' },
  }))
  await page.route('**/api/vlm/local-models/recommended', (route) =>
    route.fulfill({ json: { ollama_installed: false, ollama_running: false } }))
  await page.route('**/api/smart-tag/start', (route) =>
    route.fulfill({ json: { job_id: 'done-job', status: 'running', active: true, total: 6 } }))
  await page.route('**/api/smart-tag/progress**', (route) => {
    if (phase.value === 'idle') return route.fulfill({ json: { status: 'idle' } })
    if (phase.value === 'running') {
      return route.fulfill({
        json: {
          job_id: 'done-job', status: 'running', active: true, total: 6, processed: 2,
          succeeded: 2, failed: 0, skipped: 0, stage: 'tagging', phase_completion: 0.33,
          settings: { enable_wd14: true, enable_vlm: false },
        },
      })
    }
    return route.fulfill({
      json: {
        job_id: 'done-job', status: 'warning', active: false, total: 6, processed: 6,
        succeeded: 3, failed: 1, skipped: 2, caption_result_count: 0,
        message_key: 'done_warning', message_args: {},
        settings: { enable_wd14: true, enable_vlm: false },
      },
    })
  })
}

test('Smart Tag progress is visible without scrolling and the finish shows its counts', async ({ page }) => {
  const phase: RunPhase = { value: 'idle' }
  await stubSmartTagRun(page, phase)
  await openDatasetMaker(page, [981, 982, 983, 984, 985, 986])
  await page.evaluate(() => (window as any).SmartTag.open())
  await expect(page.locator('#smart-tag-modal')).toHaveClass(/visible/)
  await expect(page.locator('#smart-tag-tagger-1 option')).toHaveCount(1)

  phase.value = 'running'
  await page.locator('#btn-smart-tag-run').click()
  const progress = page.locator('#smart-tag-progress')
  await expect(progress).toBeVisible()
  await page.evaluate(() => {
    const content = document.querySelector('#smart-tag-modal .smart-tag-modal-content') as HTMLElement
    content.scrollTop = 0
  })
  const box = await progress.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(768)

  phase.value = 'done'
  const done = page.locator('#smart-tag-done')
  await expect(done).toBeVisible({ timeout: 10_000 })
  await expect(done).toContainText('3 tagged')
  await expect(done).toContainText('2 skipped')
  await expect(done).toContainText('1 failed')
  const doneBox = await done.boundingBox()
  expect(doneBox!.y + doneBox!.height).toBeLessThanOrEqual(768)
  await expect(page.locator('.toast').filter({ hasText: 'Smart Tag finished' })).toBeVisible()

  // A new run clears the old notice.
  phase.value = 'running'
  await page.locator('#btn-smart-tag-run').click()
  await expect(done).toBeHidden()
})

// ---------------------------------------------------------------------------
// 15. Workbench layout at 1366x768
// ---------------------------------------------------------------------------

async function openWorkbench(page: Page): Promise<void> {
  await openDatasetMaker(page, [995, 996])
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._setPipelineTab('workbench')
    dm._setActive(995)
  })
  await expect(page.locator('#dataset-zoom-toolbar')).toBeVisible()
}

function overlaps(a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test('the zoom bar does not overlap the caption editor title', async ({ page }) => {
  await openWorkbench(page)
  const title = await page.locator('.dataset-editor-pane .dataset-pane-head > strong').boundingBox()
  const zoom = await page.locator('#dataset-zoom-toolbar').boundingBox()
  expect(title && zoom).toBeTruthy()
  expect(overlaps(title!, zoom!)).toBe(false)
})

test('the step rail never covers the LoRA-type field when the side panel scrolls', async ({ page }) => {
  await openWorkbench(page)
  const covered = await page.evaluate(() => {
    const pane = document.querySelector('#view-dataset .dataset-export-pane') as HTMLElement
    const label = document.querySelector('[data-i18n="dataset.loraPruneLabel"]') as HTMLElement
    const paneTop = pane.getBoundingClientRect().top
    pane.scrollTop = Math.max(0, label.getBoundingClientRect().top - paneTop - 30)
    const rect = label.getBoundingClientRect()
    const x = rect.left + Math.min(20, rect.width / 2)
    const y = rect.top + rect.height / 2
    const paneRect = pane.getBoundingClientRect()
    const inView = y > paneRect.top && y < paneRect.bottom
    const hit = document.elementFromPoint(x, y)
    return { inView, hitsLabel: !!hit && (label === hit || label.contains(hit) || hit.contains(label)) }
  })
  expect(covered.inView).toBe(true)
  expect(covered.hitsLabel).toBe(true)
})

test('the tag colour legend starts folded and remembers being opened', async ({ page }) => {
  await openWorkbench(page)
  const legend = page.locator('#dataset-tag-color-legend')
  await expect(legend).not.toHaveAttribute('open', '')
  await legend.locator('summary').click()
  await expect(legend).toHaveAttribute('open', '')

  await openWorkbench(page)
  await expect(page.locator('#dataset-tag-color-legend')).toHaveAttribute('open', '')
})

test('the export tab opens at its top even after the workbench side panel scrolled', async ({ page }) => {
  await openWorkbench(page)
  await page.evaluate(() => {
    const pane = document.querySelector('#view-dataset .dataset-export-pane') as HTMLElement
    pane.scrollTop = pane.scrollHeight
  })
  await page.locator('#dataset-tab-export').click()
  await expect(page.locator('#dataset-step-export .dataset-card-title')).toBeInViewport()
  expect(await page.evaluate(() =>
    (document.querySelector('#view-dataset .dataset-export-pane') as HTMLElement).scrollTop)).toBe(0)
})

test('the empty-gallery guide no longer talks about narrow screens', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).I18nLang_zhCN && !!(window as any).I18nLang_en)
  const copy = await page.evaluate(() => ({
    zh: (window as any).I18nLang_zhCN['onboarding.step4Hint'],
    en: (window as any).I18nLang_en['onboarding.step4Hint'],
  }))
  expect(copy.zh).not.toContain('窄屏')
  expect(copy.en).not.toMatch(/narrow/i)
})
