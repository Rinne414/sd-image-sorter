import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * TIPO tag-upsampling assist (roadmap #8, v1) — Separation Console wiring.
 *
 * All backend responses are stubbed — this locks the UI contract only:
 * proposals render as a DEFAULT-UNCHECKED checklist in the shared results
 * panel, applying checked picks appends them to the export Common-tags box
 * without duplicates, and the missing-runtime 400 surfaces the pip hint
 * verbatim. Endpoint semantics are locked by
 * backend/tests/test_tipo_service.py.
 */

test.describe.configure({ mode: 'serial' })

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  // The console open also kicks the re-threshold card's stats fetch — keep
  // it quiet so this spec only exercises the TIPO flow.
  await page.route('**/api/tags/scores/stats', async (route) => {
    await route.fulfill({
      json: { enabled: true, floor: 0.15, total_rows: 0, images_with_scores: 0, models: [], estimated_bytes: 0 },
    })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701, 702]
    dm.meta.set(701, { filename: 'tipo-a.png', width: 1024, height: 1024 })
    dm.meta.set(702, { filename: 'tipo-b.png', width: 1024, height: 1024 })
    dm.captions.set(701, '1girl, smile')
    dm.captions.set(702, '1girl, frown')
    ;(window as any).App.switchView('dataset')
    dm._setActive(701)
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

test('proposals render as an unchecked checklist; apply appends checked picks to Common tags without duplicates', async ({ page }) => {
  await seedDatasetQueue(page)

  const suggestCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/suggest-upsample', async (route) => {
    suggestCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      json: {
        proposed_tags: [
          { tag: 'blue_sky', category: 'background' },
          { tag: 'cloud', category: 'background' },
          { tag: 'outdoors', category: 'background' },
        ],
        model: '200m-ft',
        elapsed_ms: 42,
        input_tags: 3,
      },
    })
  })

  await openConsole(page)
  // Pre-seed the landing zone with one of the proposals to prove dedup.
  await page.locator('#dataset-common-tags').fill('blue_sky')

  await page.locator('#sepcon-tipo-suggest').click()
  const panel = page.locator('#sepcon-gaps')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('TIPO proposes 3 tag(s)')

  // Request carries the queue's tag frequency list, short target.
  expect(suggestCalls).toHaveLength(1)
  expect(suggestCalls[0].target).toBe('short')
  expect(suggestCalls[0].tags).toEqual(expect.arrayContaining(['1girl', 'smile', 'frown']))

  // Checklist renders DEFAULT UNCHECKED with category dots; apply disabled.
  const checks = panel.locator('.sepcon-tipo-check')
  await expect(checks).toHaveCount(3)
  for (let i = 0; i < 3; i += 1) {
    await expect(checks.nth(i)).not.toBeChecked()
  }
  await expect(panel.locator('.cap-ac-dot-background')).toHaveCount(3)
  const apply = page.locator('#sepcon-tipo-apply')
  await expect(apply).toBeDisabled()

  // Check two proposals (one duplicates the pre-seeded Common tag).
  await checks.nth(0).check() // blue_sky — already in the box
  await checks.nth(1).check() // cloud — new
  await expect(apply).toBeEnabled()
  await expect(apply).toContainText('Add 2 checked')

  await apply.click()
  // Appended + deduped: blue_sky NOT doubled, cloud appended, outdoors untouched.
  await expect(page.locator('#dataset-common-tags')).toHaveValue('blue_sky, cloud')

  // Applying again must stay idempotent for the landing zone.
  await apply.click()
  await expect(page.locator('#dataset-common-tags')).toHaveValue('blue_sky, cloud')
})

test('missing-runtime 400 renders the pip install hint verbatim in the panel', async ({ page }) => {
  await seedDatasetQueue(page)

  await page.route('**/api/tags/suggest-upsample', async (route) => {
    await route.fulfill({
      status: 400,
      json: {
        error:
          'TIPO is not installed. Install it into the backend environment with: '
          + 'pip install llama-cpp-python tipo-kgen  (CPU GGUF runtime; the model, ~100-250 MB, '
          + 'downloads on first use into DATA_DIR/models/tipo.) / 未安装 TIPO。',
      },
    })
  })

  await openConsole(page)
  await page.locator('#sepcon-tipo-suggest').click()
  const panel = page.locator('#sepcon-gaps')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('pip install llama-cpp-python tipo-kgen')
  // Button re-enables so the user can retry after installing.
  await expect(page.locator('#sepcon-tipo-suggest')).toBeEnabled()
})
