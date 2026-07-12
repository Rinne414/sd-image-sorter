import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * BE-1-UI: the Separation Console's virtual re-threshold card.
 *
 * All backend responses are stubbed — this locks the UI wiring only
 * (model list population, debounced dry-run preview, apply flow, and the
 * no-scores empty state). Endpoint semantics are locked by
 * backend/tests/test_routers/test_tag_scores_api.py.
 */

test.describe.configure({ mode: 'serial' })

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [601, 602]
    dm.meta.set(601, { filename: 'rt-a.png', width: 1024, height: 1024 })
    dm.meta.set(602, { filename: 'rt-b.png', width: 1024, height: 1024 })
    dm.captions.set(601, '1girl, smile')
    dm.captions.set(602, '1girl, frown')
    ;(window as any).App.switchView('dataset')
    dm._setActive(601)
  })
}

async function openConsole(page: Page) {
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-separation-console summary').click()
  await expect(page.locator('#sepcon-rows')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('re-threshold card: models load, dry-run previews, apply reports', async ({ page }) => {
  await seedDatasetQueue(page)

  await page.route('**/api/tags/scores/stats', async (route) => {
    await route.fulfill({
      json: {
        enabled: true, floor: 0.15, total_rows: 40, images_with_scores: 2,
        models: [
          { model: 'wd-swinv2-tagger-v3', rows: 30, images: 2 },
          { model: 'camie-tagger-v2', rows: 10, images: 1 },
        ],
        estimated_bytes: 2400,
      },
    })
  })
  const rethresholdCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/rethreshold', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    rethresholdCalls.push(body)
    await route.fulfill({
      json: {
        dry_run: body.dry_run, model: body.model, threshold: body.threshold,
        character_threshold: 0.85, requested: 2, with_scores: 2,
        skipped_no_scores: 0, images_changed: 1, tags_added: 0,
        tags_removed: 3, diffs: [], applied: body.dry_run === false,
      },
    })
  })

  await openConsole(page)

  // Stats-driven model list: 2 models + the consensus option.
  const model = page.locator('#sepcon-rt-model')
  await expect(model.locator('option')).toHaveCount(3)
  await expect(model.locator('option[value="consensus"]')).toHaveCount(1)

  // Opening the console triggers the initial debounced dry-run.
  await expect(page.locator('#sepcon-rt-status')).toContainText('2/2 images have scores')
  await expect(page.locator('#sepcon-rt-status')).toContainText('1 would change')
  await expect(page.locator('#sepcon-rt-apply')).toBeEnabled()
  expect(rethresholdCalls[0].dry_run).toBe(true)
  expect(rethresholdCalls[0].image_ids).toEqual([601, 602])

  // Slider updates the readout and re-previews at the new cutoff.
  await page.locator('#sepcon-rt-threshold').fill('0.5')
  await expect(page.locator('#sepcon-rt-threshold-value')).toHaveText('0.50')
  await expect.poll(() => rethresholdCalls.some(c => c.threshold === 0.5 && c.dry_run === true)).toBe(true)

  // Apply posts dry_run=false and reports the outcome.
  await page.locator('#sepcon-rt-apply').click()
  await expect(page.locator('#sepcon-rt-status')).toContainText('Applied')
  const applied = rethresholdCalls.find(c => c.dry_run === false)
  expect(applied).toBeTruthy()
  expect(applied!.model).toBe('wd-swinv2-tagger-v3')
})

test('re-threshold card: empty score table disables the control with guidance', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.route('**/api/tags/scores/stats', async (route) => {
    await route.fulfill({
      json: { enabled: true, floor: 0.15, total_rows: 0, images_with_scores: 0, models: [], estimated_bytes: 0 },
    })
  })
  await openConsole(page)
  await expect(page.locator('#sepcon-rt-model')).toBeDisabled()
  await expect(page.locator('#sepcon-rt-status')).toContainText('No stored scores yet')
  await expect(page.locator('#sepcon-rt-apply')).toBeDisabled()
})
test('tag info: clicking a tag name renders category, aliases and implications', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.route('**/api/tags/scores/stats', async (route) => {
    await route.fulfill({
      json: { enabled: true, floor: 0.15, total_rows: 0, images_with_scores: 0, models: [], estimated_bytes: 0 },
    })
  })
  await page.route('**/api/tags/info**', async (route) => {
    await route.fulfill({
      json: {
        tag: '1girl', canonical: '1girl', found_in_vocab: true,
        category: 'general', danbooru_count: 6100000,
        aliases: ['1girls', 'sole_female'], zh: '女孩',
        implies: [], implied_by: [], library_count: 2,
      },
    })
  })
  await openConsole(page)
  await page.locator('.sepcon-tag', { hasText: '1girl' }).first().click()
  const panel = page.locator('#sepcon-gaps')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('1girl · 女孩 — general')
  await expect(panel).toContainText('sole_female')
  await expect(panel).toContainText('6,100,000')
  // Roadmap #5: queue-scope co-occurrence — both seeded captions carry
  // 1girl; "smile" rides one of the two (1/2 = 50%).
  await expect(panel).toContainText('Co-occurs within the queue')
  await expect(panel).toContainText('smile — 1/2 (50%)')
})
