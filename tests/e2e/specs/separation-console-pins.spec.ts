import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Step-0 characterization pins for frontend/js/modules/separation-console.js
 * — the per-TAG "Separation Console" curation surface for LoRA dataset prep.
 *
 * The module is a single classic-script IIFE that publishes ONE global,
 * `window.SeparationConsole` (an object literal with a `dm` getter over
 * `window.DatasetMaker`). It also hosts three IIFE-internal top-level
 * bindings — the `t(en, zh)` i18n helper, the `fold(tag)` normalizer, and
 * the SEEN_KEY / PURPOSE_KEY / INTRINSIC_* consts — that a shared-scope
 * split would have to rename. These pins lock the OBSERVABLE behavior so a
 * verbatim decomposition is provably zero-behavior-change; they must pass
 * BEFORE and AFTER the split.
 *
 * All backend responses are route-mocked (no models are ever downloaded);
 * endpoint semantics stay owned by the backend router tests. The three
 * existing sepcon specs (sepcon-rethreshold, tipo-suggest,
 * dataset-editor-core) already lock the re-threshold card, TIPO checklist,
 * tag-info co-occurrence, and the lazy seen/token-counter hook — these pins
 * deliberately cover the rest of the surface: the public method census, the
 * refresh() render (frequency rows, sort/search, intrinsic marker, overflow
 * cap, stats), the prune/remove/locate/next actions, and the
 * find-missed / model-audit / health-check / NL-leak flows.
 *
 * Any behavior pinned here is pinned AS-IS. Notable AS-IS quirks recorded:
 *   - the active image's remove/gap-fix goes through the editor textarea
 *     (debounced), so those effects are pinned via the NON-active branch;
 *   - findGaps/health/re-threshold guard on `id > 0` (gallery-only), while
 *     auditTag posts regardless (see the local-only-queue pin).
 */

test.describe.configure({ mode: 'serial' })

interface SeedRow {
  id: number
  filename: string
  caption: string
  nl?: string
}

const EMPTY_SCORE_STATS = {
  enabled: true,
  floor: 0.15,
  total_rows: 0,
  images_with_scores: 0,
  models: [],
  estimated_bytes: 0,
}

async function boot(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  // Opening the console kicks the re-threshold card's stats fetch; keep it
  // empty so these pins exercise only the surface under test.
  await page.route('**/api/tags/scores/stats', async (route) => {
    await route.fulfill({ json: EMPTY_SCORE_STATS })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(
    () =>
      typeof (window as any).DatasetMaker?._setActive === 'function'
      && !!(window as any).SeparationConsole,
  )
}

async function seedQueue(page: Page, rows: SeedRow[]) {
  await page.evaluate((seedRows: SeedRow[]) => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = seedRows.map((r) => r.id)
    for (const r of seedRows) {
      dm.meta.set(r.id, { filename: r.filename, width: 512, height: 512 })
      dm.captions.set(r.id, r.caption)
      if (r.nl != null) dm.nlCaptions.set(r.id, r.nl)
    }
    ;(window as any).App.switchView('dataset')
    dm._setActive(seedRows[0].id)
  }, rows)
}

async function openConsole(page: Page) {
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-separation-console summary').click()
  await expect(page.locator('#sepcon-rows')).toBeVisible()
}

function rowByTag(page: Page, tag: RegExp) {
  return page.locator('#sepcon-rows .sepcon-row').filter({
    has: page.locator('.sepcon-tag').filter({ hasText: tag }),
  })
}

// Row action buttons live in `.sepcon-actions`, which the stylesheet reveals
// only on row hover (display:none otherwise). dispatchEvent fires the exact
// click handler without depending on hover state or a mid-refresh rebuild.
// Action order per _buildRow: 0 prune, 1 remove, 2 locate, 3 find-missed,
// 4 model-audit.
async function clickRowAction(page: Page, tag: RegExp, index: number) {
  await rowByTag(page, tag).locator('.sepcon-btn').nth(index).dispatchEvent('click')
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('public surface: single SeparationConsole object with the documented method set and a live dm getter', async ({ page }) => {
  await boot(page)
  const surface = await page.evaluate(() => {
    const S = (window as any).SeparationConsole
    const methods = [
      'init', 'refresh', 'computeStats', 'estimateTokens', 'togglePrune',
      'removeEverywhere', 'locateNext', 'jumpToUnseen', 'findGaps',
      'suggestUpsample', 'showTagInfo', 'auditTag', 'runHealthCheck',
    ]
    return {
      isObject: !!S && typeof S === 'object',
      present: methods.filter((m) => typeof S[m] === 'function'),
      expected: methods.length,
      dmIsDatasetMaker: S.dm === (window as any).DatasetMaker,
    }
  })
  expect(surface.isObject).toBe(true)
  expect(surface.present).toHaveLength(surface.expected)
  expect(surface.dmIsDatasetMaker).toBe(true)
})

test('estimateTokens: whitespace/comma token estimate matches the QW-1 budget math', async ({ page }) => {
  await boot(page)
  const out = await page.evaluate(() => {
    const S = (window as any).SeparationConsole
    return {
      empty: S.estimateTokens(''),
      pair: S.estimateTokens('1girl, smile'),
      underscored: S.estimateTokens('long_hair'),
      triple: S.estimateTokens('a, b, c'),
    }
  })
  expect(out.empty).toBe(0)
  expect(out.pair).toBe(5) // ceil(5/4)*2 words + 1 comma
  expect(out.underscored).toBe(2) // "long hair" => 1 + 1, no comma
  expect(out.triple).toBe(5) // three 1-char words + 2 commas
})

test('refresh: one row per folded tag, frequency count, freq-desc order, category dots, stats line', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl, blue_eyes, smile' },
    { id: 602, filename: 'b.png', caption: '1girl, blue_eyes, frown' },
    { id: 603, filename: 'c.png', caption: '1girl, hat' },
  ])
  await openConsole(page)

  const rows = page.locator('#sepcon-rows .sepcon-row')
  await expect(rows).toHaveCount(5)
  // Frequency-descending: 1girl(3) then blue_eyes(2) lead the singletons.
  await expect(rows.nth(0).locator('.sepcon-tag')).toHaveText('1girl')
  await expect(rows.nth(0).locator('.sepcon-count')).toHaveText('3/3')
  await expect(rows.nth(1).locator('.sepcon-tag')).toHaveText('blue_eyes')
  await expect(rows.nth(1).locator('.sepcon-count')).toHaveText('2/3')
  // Every row carries exactly one category dot.
  await expect(page.locator('#sepcon-rows .cap-ac-dot')).toHaveCount(5)
  const stats = page.locator('#sepcon-stats')
  await expect(stats).toContainText('3 images')
  await expect(stats).toContainText('5 tags')
  await expect(stats).toContainText('reviewed 0/3')
})

test('refresh: sort toggles frequency vs alphabetical, search narrows the list', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: 'zebra, apple' },
    { id: 602, filename: 'b.png', caption: 'zebra' },
  ])
  await openConsole(page)
  const rows = page.locator('#sepcon-rows .sepcon-row')

  // Default frequency sort: zebra(2) outranks apple(1).
  await expect(rows.nth(0).locator('.sepcon-tag')).toHaveText('zebra')
  // #sepcon-sort is wrapped by the dataset custom-dropdown (the native select
  // is display:none), so drive value+change exactly as an option click does.
  await page.evaluate(() => {
    const sel = document.getElementById('sepcon-sort') as HTMLSelectElement
    sel.value = 'alpha'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(rows.nth(0).locator('.sepcon-tag')).toHaveText('apple')
  // Debounced search filters to matching tags only.
  await page.locator('#sepcon-search').fill('zeb')
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0).locator('.sepcon-tag')).toHaveText('zebra')
})

test('refresh: high-frequency innate-trait tags earn the intrinsic marker; plain tags do not', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl, blue_eyes' },
    { id: 602, filename: 'b.png', caption: '1girl, blue_eyes' },
  ])
  await openConsole(page)
  // blue_eyes: 2/2 ratio AND matches the innate-trait families -> marked.
  await expect(rowByTag(page, /^blue_eyes$/).locator('.sepcon-intrinsic')).toHaveCount(1)
  // 1girl: also 2/2 but not an innate trait -> no marker.
  await expect(rowByTag(page, /^1girl$/).locator('.sepcon-intrinsic')).toHaveCount(0)
})

test('refresh: caps the rendered list at 800 rows and shows the overflow notice', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    const many = Array.from({ length: 810 }, (_, i) => `tag${i}`).join(', ')
    dm.imageIds = [601]
    dm.meta.set(601, { filename: 'a.png', width: 512, height: 512 })
    dm.captions.set(601, many)
    ;(window as any).App.switchView('dataset')
    dm._setActive(601)
  })
  await openConsole(page)
  await expect(page.locator('#sepcon-rows .sepcon-row')).toHaveCount(800)
  const overflow = page.locator('#sepcon-overflow')
  await expect(overflow).toBeVisible()
  await expect(overflow).toContainText('800 of 810')
})

test('prune action: writes the underscored tag to the export blacklist and toggles back off', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: 'blue_eyes' },
    { id: 602, filename: 'b.png', caption: 'blue_eyes' },
  ])
  await openConsole(page)
  // The prune button is the first action in the row.
  await clickRowAction(page, /^blue_eyes$/, 0)
  await expect(page.locator('#dataset-blacklist')).toHaveValue('blue_eyes')
  await expect(rowByTag(page, /^blue_eyes$/)).toHaveClass(/sepcon-row-pruned/)
  // Toggling again un-prunes: the blacklist clears and the row resets.
  await clickRowAction(page, /^blue_eyes$/, 0)
  await expect(page.locator('#dataset-blacklist')).toHaveValue('')
  await expect(rowByTag(page, /^blue_eyes$/)).not.toHaveClass(/sepcon-row-pruned/)
})

test('remove-everywhere action: strips the tag from every caption it appears in', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: 'hat' }, // active, does NOT carry 1girl
    { id: 602, filename: 'b.png', caption: '1girl' },
    { id: 603, filename: 'c.png', caption: '1girl' },
  ])
  await openConsole(page)
  // The remove button is the second action; 602/603 are non-active so the
  // captionEdits path runs synchronously (no editor-textarea debounce).
  await clickRowAction(page, /^1girl$/, 1)

  await expect(page.locator('#sepcon-rows .sepcon-tag', { hasText: /^1girl$/ })).toHaveCount(0)
  await expect(rowByTag(page, /^hat$/)).toHaveCount(1)
  const edits = await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    return { e602: dm.captionEdits.get(602), e603: dm.captionEdits.get(603) }
  })
  expect(edits.e602).toBe('')
  expect(edits.e603).toBe('')
  await expect(page.locator('.toast-message', { hasText: 'Removed' })).toBeVisible()
})

test('locate + next-unreviewed: both drive DatasetMaker._setActive', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl' },
    { id: 602, filename: 'b.png', caption: '1girl' },
    { id: 603, filename: 'c.png', caption: 'hat' },
  ])
  await openConsole(page)

  // Locate (third action) cycles through images carrying 1girl (ids 601,602).
  await clickRowAction(page, /^1girl$/, 2)
  expect(await page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(602)
  await clickRowAction(page, /^1girl$/, 2)
  expect(await page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(601)

  // Next-unreviewed jumps to the first not-yet-seen queue id.
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm._setActive(601) // the open-console hook marks each visited id seen
    dm._setActive(602)
  })
  await page.locator('#sepcon-next-unseen').click()
  expect(await page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(603)

  // With everything seen, it reports completion instead of moving.
  await page.evaluate(() => (window as any).DatasetMaker._setActive(603))
  await page.locator('#sepcon-next-unseen').click()
  expect(await page.evaluate(() => (window as any).DatasetMaker.activeId)).toBe(603)
  await expect(page.locator('.toast-message', { hasText: 'All images reviewed' })).toBeVisible()
})

test('find-missed action: posts the queue ids to coverage-gaps and bulk-adds the fix', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl' },
    { id: 602, filename: 'b.png', caption: '1girl' },
  ])
  const gapCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/coverage-gaps', async (route) => {
    gapCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      json: {
        tag: '1girl', band_low: 0.28, band_high: 0.35,
        gaps: [
          { image_id: 901, filename: 'miss-a.png', score: 0.31 },
          { image_id: 902, filename: 'miss-b.png', score: 0.29 },
        ],
      },
    })
  })
  const bulkCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/bulk/add', async (route) => {
    bulkCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { operation: 'bulk_add', updated: 2 } })
  })

  await openConsole(page)
  // Find-missed is the fourth action.
  await clickRowAction(page, /^1girl$/, 3)

  const panel = page.locator('#sepcon-gaps')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('2 image(s) probably missed')
  await expect(panel).toContainText('miss-a.png')
  await expect(panel).toContainText('0.31')
  expect(gapCalls).toHaveLength(1)
  expect(gapCalls[0].tag).toBe('1girl')
  expect(gapCalls[0].image_ids).toEqual([601, 602])

  // "Add to all" bulk-adds the tag to the missed image ids.
  await panel.getByRole('button', { name: /to all 2/ }).click()
  await expect.poll(() => bulkCalls.length).toBe(1)
  expect(bulkCalls[0].image_ids).toEqual([901, 902])
  expect(bulkCalls[0].tags).toEqual(['1girl'])
})

test('model-audit action: posts to tag-audit and renders one line per scoring model', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl' },
    { id: 602, filename: 'b.png', caption: '1girl' },
  ])
  const auditCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/scores/tag-audit', async (route) => {
    auditCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      json: {
        tag: '1girl', scope_images: 2,
        models: [
          { model: 'wd-swinv2-tagger-v3', images: 2, avg_score: 0.91, max_score: 0.98 },
          { model: 'camie-tagger-v2', images: 1, avg_score: 0.5, max_score: 0.5 },
        ],
      },
    })
  })
  await openConsole(page)
  // Model-audit is the fifth action.
  await clickRowAction(page, /^1girl$/, 4)

  const panel = page.locator('#sepcon-gaps')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Who scored')
  await expect(panel).toContainText('2 images in scope')
  await expect(panel).toContainText('wd-swinv2-tagger-v3')
  await expect(panel).toContainText('avg 0.91')
  await expect(panel).toContainText('max 0.98')
  expect(auditCalls).toHaveLength(1)
  expect(auditCalls[0].tag).toBe('1girl')
  expect(auditCalls[0].image_ids).toEqual([601, 602])
})

test('health check: posts the consistency report, renders findings, and the trigger fix bulk-adds', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl' },
    { id: 602, filename: 'b.png', caption: '1girl' },
    { id: 603, filename: 'c.png', caption: '1girl' },
  ])
  const reportCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/consistency/report', async (route) => {
    reportCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      json: {
        images: 3,
        findings: [
          {
            id: 'trigger-coverage', severity: 'warn',
            title_en: 'Trigger word missing from 2 images', title_zh: 'trigger zh',
            detail_en: 'Two images do not carry the trigger word.', detail_zh: 'detail zh',
            fix: { endpoint: '/api/tags/bulk/add', body: { image_ids: [602, 603], tags: ['mychar'] } },
          },
        ],
      },
    })
  })
  const bulkCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/tags/bulk/add', async (route) => {
    bulkCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { operation: 'bulk_add', updated: 2 } })
  })

  await openConsole(page)
  await page.locator('#sepcon-health-run').click()

  const out = page.locator('#sepcon-health-results')
  await expect(out).toBeVisible()
  await expect(out).toContainText('3 images checked')
  await expect(out).toContainText('1 finding(s)')
  await expect(out).toContainText('[warn] Trigger word missing from 2 images')
  expect(reportCalls).toHaveLength(1)
  expect(reportCalls[0].image_ids).toEqual([601, 602, 603])
  expect(reportCalls[0].training_purpose).toBe('character')

  // The trigger-coverage finding exposes a one-click fix that bulk-adds the
  // trigger (dry_run=false) and then re-runs the health check.
  await out.getByRole('button', { name: /Add trigger to 2 images/ }).click()
  await expect.poll(() => bulkCalls.length).toBe(1)
  expect(bulkCalls[0].image_ids).toEqual([602, 603])
  expect(bulkCalls[0].dry_run).toBe(false)
  await expect.poll(() => reportCalls.length).toBe(2)
})

test('NL leak scan: a blacklisted trait still present in a natural-language caption is flagged', async ({ page }) => {
  await boot(page)
  await seedQueue(page, [
    { id: 601, filename: 'a.png', caption: '1girl', nl: 'a girl with blue eyes' },
    { id: 602, filename: 'b.png', caption: '1girl', nl: 'a girl smiling' },
  ])
  await openConsole(page)
  // Blacklist a trait that still appears verbatim in one NL caption.
  await page.evaluate(() => {
    const box = document.getElementById('dataset-blacklist') as HTMLTextAreaElement
    box.value = 'blue_eyes'
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const leaks = page.locator('#sepcon-leaks')
  await expect(leaks).toBeVisible()
  await expect(leaks).toContainText('blue eyes')
  await expect(leaks).toContainText('appears in 1 NL caption')
})

test('local-only queue: gallery-scored flows report no gallery images instead of firing requests', async ({ page }) => {
  await boot(page)
  // A queue of only local-import ids (negative) — no DB-scored images.
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [-101]
    dm.meta.set(-101, { source: 'local', filename: 'loc.png', width: 512, height: 512 })
    dm.captions.set(-101, '1girl, blue_eyes')
    ;(window as any).App.switchView('dataset')
  })
  await openConsole(page)

  // Find-missed guards on id>0 and must never touch the network.
  let coverageHit = false
  await page.route('**/api/tags/coverage-gaps', async (route) => {
    coverageHit = true
    await route.fulfill({ json: {} })
  })
  await clickRowAction(page, /^1girl$/, 3)
  await expect(page.locator('#sepcon-gaps')).toContainText('No gallery images in the queue')

  // The health check shows the same guard.
  await page.locator('#sepcon-health-run').click()
  await expect(page.locator('#sepcon-health-results')).toContainText('No gallery images in the queue')

  expect(coverageHit).toBe(false)
})
