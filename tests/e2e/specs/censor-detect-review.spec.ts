import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

/**
 * Censor editor characterization pins — part 2 of 2 (detect + review conveyor).
 *
 * Pins the AI-detection integration a censor-edit.js redesign could silently
 * break: the /api/censor/detect REQUEST wire format (execution-plan output),
 * region ordering + geometry handling (precise mask vs box shape, polygon
 * stripping), the bake-to-item semantics (isProcessed / thumb marking), and
 * the 审核 review conveyor (detect → checklist → exclude → approve → advance,
 * including the fail-loud path when kept regions cannot be baked — the
 * never-fallback-to-uncensored invariant).
 *
 * The detect backend is fully stubbed (route.fulfill); model readiness is
 * pinned to a deterministic NudeNet-recommended payload so the execution plan
 * never depends on the machine's real model files.
 */

test.describe.configure({ mode: 'serial' })

// 1x1 fully-OPAQUE-white PNG → normalizeMaskDataUrl keeps it a solid mask that
// covers the whole canvas when scaled (the combined_mask path). NOTE: the
// widely copy-pasted "TINY_PNG" constant from mask-editor.spec.ts is actually
// a 1x1 semi-transparent RED pixel (255,0,0,127) — do not reuse it for masks.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
const WHITE_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#d9e2f2"/>
  <circle cx="32" cy="10" r="6" fill="#7a93b8"/>
</svg>
`.trim()

const IMAGES = [
  { id: 9401, filename: 'censor-detect-a.png', path: 'L:/censor-detect-a.png', width: 64, height: 64 },
  { id: 9402, filename: 'censor-detect-b.png', path: 'L:/censor-detect-b.png', width: 64, height: 64 },
]

const MODELS_PAYLOAD = {
  status: 'ok',
  recommended_backend: 'nudenet',
  models: [
    {
      id: 'legacy',
      name: 'Local YOLO',
      available: false,
      files: [],
      general_model_count: 0,
      default_model_path: null,
      capabilities: {},
    },
    { id: 'nudenet', name: 'NudeNet', available: true, model_downloaded: true, recommended: true, capabilities: {} },
    { id: 'sam3', name: 'SAM3', available: false, message: 'not installed in e2e', capabilities: {} },
  ],
}

async function stubCensorBackend(page: Page) {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  for (const image of IMAGES) {
    await page.route(`**/api/image-thumbnail/${image.id}**`, fulfillImage)
    await page.route(`**/api/image-file/${image.id}**`, fulfillImage)
  }
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({
      json: { images: IMAGES, total: IMAGES.length, has_more: false, next_cursor: null },
    })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({
      json: { images: IMAGES.map((image) => ({ ...image, prompt: '', tags: [] })), missing_ids: [] },
    })
  })
  await page.route('**/api/censor/models', async (route) => {
    await route.fulfill({ json: MODELS_PAYLOAD })
  })
}

/** Stub /api/censor/detect and capture every request body. */
async function stubDetect(page: Page, detections: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const calls: Array<Record<string, unknown>> = []
  await page.route('**/api/censor/detect', async (route) => {
    calls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      json: { status: 'ok', image_id: IMAGES[0].id, model_type: 'nudenet', detections, warnings: [], ...extra },
    })
  })
  return calls
}

async function seedCensorQueue(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[0].id}"]`).click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[1].id}"]`).click()
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGES[0].id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
}

function activePixel(page: Page, x: number, y: number) {
  return page.evaluate(([px, py]) => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId || 'censor-canvas') as HTMLCanvasElement
    const d = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }, [x, y])
}

async function isPixelBlack(page: Page, x: number, y: number) {
  const [r, g, b] = await activePixel(page, x, y)
  return r < 40 && g < 40 && b < 40
}

function firstItemRegions(page: Page) {
  return page.evaluate((id) => {
    const item = (window as any).__CENSOR_STATE__.queue.find((entry: any) => entry.id === id)
    return (item?.regions || []).map((region: any) => ({
      label: region.label,
      confidence: region.confidence,
      hasPolygon: 'polygon' in region,
      hasMask: 'mask' in region,
    }))
  }, IMAGES[0].id)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('detect current: request wire format, region sort, box bake, processed marking', async ({ page }) => {
  await stubCensorBackend(page)
  // Two boxes, deliberately returned LOW-confidence first: the editor must
  // re-sort them descending before storing.
  const detectCalls = await stubDetect(page, [
    { box: [8, 8, 24, 24], label: 'exposed_breasts', confidence: 0.55, source: 'nudenet' },
    { box: [36, 36, 60, 60], label: 'exposed_buttocks', confidence: 0.92, source: 'nudenet' },
  ])
  await seedCensorQueue(page)

  // black_bar makes the bake pixel-verifiable (mosaic on a flat color is a
  // no-op-looking average).
  await page.selectOption('#censor-style', 'black_bar')

  await page.locator('#btn-auto-detect-current').click()
  await expect.poll(() => detectCalls.length).toBe(1)

  // The pinned detect request: execution plan resolved to the recommended
  // NudeNet backend, empty legacy model path, default confidence 0.5, and the
  // state-default quick privacy targets.
  expect(detectCalls[0]).toEqual({
    image_id: IMAGES[0].id,
    model_path: '',
    model_type: 'nudenet',
    confidence_threshold: 0.5,
    target_classes: ['breasts', 'pussy', 'dick', 'penis', 'anus', 'buttocks'],
  })

  await expect(
    page.locator('#toast-container .toast', { hasText: 'Applied box-based auto-censor to 2 region(s)' }).first()
  ).toBeVisible()

  // Regions stored sorted by confidence, highest first.
  await expect.poll(() => firstItemRegions(page)).toEqual([
    { label: 'exposed_buttocks', confidence: 0.92, hasPolygon: false, hasMask: false },
    { label: 'exposed_breasts', confidence: 0.55, hasPolygon: false, hasMask: false },
  ])

  // Baked: thumb marked processed, censored pixels inside the boxes only.
  await expect(page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[0].id}"]`)).toHaveClass(/processed/)
  await expect.poll(() => isPixelBlack(page, 48, 48)).toBe(true)   // inside box 2
  await expect.poll(() => isPixelBlack(page, 12, 12)).toBe(true)   // inside box 1
  expect(await isPixelBlack(page, 2, 40)).toBe(false)              // outside both
})

test('partial detector warnings are deduplicated and malformed warning contracts fail before bake', async ({ page }) => {
  await stubCensorBackend(page)
  const partialWarning = 'NudeNet detection failed; combined mode used Legacy YOLO only. runtime unavailable'
  let detectCalls = 0
  await page.route('**/api/censor/detect', async (route) => {
    detectCalls += 1
    await route.fulfill({
      json: {
        status: 'ok',
        image_id: detectCalls === 1 ? IMAGES[0].id : IMAGES[1].id,
        model_type: 'both',
        detections: [
          { box: [8, 8, 24, 24], label: 'exposed_breasts', confidence: 0.9, source: 'legacy' },
        ],
        warnings: detectCalls === 1 ? [partialWarning, partialWarning] : 'invalid warning payload',
      },
    })
  })
  await seedCensorQueue(page)
  await page.selectOption('#censor-style', 'black_bar')

  await page.locator('#btn-auto-detect-current').click()
  await expect.poll(() => detectCalls).toBe(1)
  await expect(page.locator('#toast-container .toast.warning .toast-message')).toHaveText(partialWarning)
  await expect(
    page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[0].id}"]`)
  ).toHaveClass(/processed/)

  await page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[1].id}"]`).click()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGES[1].id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
  await page.locator('#btn-auto-detect-current').click()

  await expect.poll(() => detectCalls).toBe(2)
  await expect(page.locator('#toast-container .toast.error')).toContainText(
    'Censor detection response requires a warnings array'
  )
  await expect(
    page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[1].id}"]`)
  ).not.toHaveClass(/processed/)
})

test('detect all preserves item failures instead of reporting false success', async ({ page }) => {
  await stubCensorBackend(page)
  const detectImageIds: number[] = []
  await page.route('**/api/censor/detect', async (route) => {
    const body = route.request().postDataJSON() as { image_id: number }
    detectImageIds.push(body.image_id)
    if (body.image_id === IMAGES[0].id) {
      await route.fulfill({ status: 503, json: { detail: 'Both detection engines failed' } })
      return
    }
    await route.fulfill({
      json: {
        status: 'ok',
        image_id: body.image_id,
        model_type: 'both',
        detections: [],
        warnings: [],
      },
    })
  })
  await seedCensorQueue(page)

  await page.locator('#btn-auto-detect-all-sidebar').click()

  await expect.poll(() => detectImageIds).toEqual(IMAGES.map((image) => image.id))
  await expect(
    page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[0].id}"]`)
  ).toHaveClass(/batch-error/)
  await expect(page.locator('#toast-container .toast.warning')).toContainText(
    'Detection: 1/2 processed · 1 failed'
  )
  await expect(page.locator('#toast-container')).not.toContainText('Detection complete: 2/2 images processed')
})

test('box shape mode strips polygon/mask geometry from stored regions', async ({ page }) => {
  await stubCensorBackend(page)
  const detectCalls = await stubDetect(page, [
    {
      box: [8, 8, 24, 24],
      polygon: [[8, 8], [24, 8], [24, 24], [8, 24]],
      mask: WHITE_PNG_DATA_URL,
      label: 'exposed_breasts',
      confidence: 0.9,
      source: 'legacy',
    },
  ])
  await seedCensorQueue(page)

  await page.selectOption('#censor-style', 'black_bar')
  await page.selectOption('#censor-mask-shape', 'box')
  // The shape choice persists for the next session.
  expect(await page.evaluate(() => localStorage.getItem('censor_mask_shape'))).toBe('box')

  await page.locator('#btn-auto-detect-current').click()
  await expect.poll(() => detectCalls.length).toBe(1)

  // Box mode: the polygon and per-region mask are DROPPED before storing, so
  // every downstream consumer censors rectangles.
  await expect.poll(() => firstItemRegions(page)).toEqual([
    { label: 'exposed_breasts', confidence: 0.9, hasPolygon: false, hasMask: false },
  ])
  await expect(
    page.locator('#toast-container .toast', { hasText: 'Applied box-based auto-censor to 1 region(s)' }).first()
  ).toBeVisible()
  await expect.poll(() => isPixelBlack(page, 12, 12)).toBe(true)
})

test('precise shape: combined_mask drives a mask bake (not boxes)', async ({ page }) => {
  await stubCensorBackend(page)
  const detectCalls = await stubDetect(
    page,
    [
      {
        box: [8, 8, 24, 24],
        polygon: [[8, 8], [24, 8], [24, 24], [8, 24]],
        label: 'exposed_breasts',
        confidence: 0.9,
        source: 'legacy',
      },
    ],
    { combined_mask: WHITE_PNG_DATA_URL, image_width: 64, image_height: 64 }
  )
  await seedCensorQueue(page)
  await page.selectOption('#censor-style', 'black_bar')

  await page.locator('#btn-auto-detect-current').click()
  await expect.poll(() => detectCalls.length).toBe(1)

  // The mask path announces itself distinctly from the box path.
  await expect(
    page.locator('#toast-container .toast', { hasText: 'Applied auto-censor mask to 1 matched region(s)' }).first()
  ).toBeVisible()
  await expect(page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[0].id}"]`)).toHaveClass(/processed/)
  // The all-white combined mask covers the WHOLE image — including pixels far
  // outside the detection box, which a box bake would never touch.
  await expect.poll(() => isPixelBlack(page, 2, 60)).toBe(true)
})

test('review conveyor: detect → checklist → exclude one → approve bakes and advances', async ({ page }) => {
  await stubCensorBackend(page)
  // Both regions carry polygons AND a combined mask; excluding one must force
  // the approve path onto the per-region BOXES (the precise mask covers all
  // regions and cannot stand in for a subset — the bug the review caught).
  const detectCalls = await stubDetect(
    page,
    [
      {
        box: [4, 4, 20, 20],
        polygon: [[4, 4], [20, 4], [20, 20], [4, 20]],
        label: 'exposed_breasts',
        confidence: 0.9,
        source: 'legacy',
      },
      {
        box: [40, 40, 60, 60],
        polygon: [[40, 40], [60, 40], [60, 60], [40, 60]],
        label: 'exposed_pussy',
        confidence: 0.7,
        source: 'legacy',
      },
    ],
    { combined_mask: WHITE_PNG_DATA_URL, image_width: 64, image_height: 64 }
  )
  await seedCensorQueue(page)
  await page.selectOption('#censor-style', 'black_bar')

  await page.locator('.censor-tab[data-censor-tab="review"]').click()
  await expect(page.locator('#censor-review-progress')).toContainText('1 / 2')
  await expect(page.locator('#btn-review-approve')).toBeDisabled()
  await expect(page.locator('#censor-review-status')).toContainText('Detect first')

  await page.locator('#btn-review-detect').click()
  await expect.poll(() => detectCalls.length).toBe(1)
  await expect(page.locator('#censor-review-status')).toContainText('2 region(s) found')

  // Checklist rows: label (underscores humanized) + confidence, sorted desc.
  const rows = page.locator('#censor-review-regions .censor-review-region')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).locator('.censor-review-region-label')).toHaveText('exposed breasts')
  await expect(rows.nth(0).locator('.censor-review-region-conf')).toHaveText('90%')
  await expect(rows.nth(1).locator('.censor-review-region-conf')).toHaveText('70%')
  // The annotation overlay lights up while reviewing.
  await expect.poll(() =>
    page.evaluate(() => (document.getElementById('censor-review-overlay') as HTMLElement).style.opacity)
  ).toBe('1')
  await expect(page.locator('#btn-review-approve')).toBeEnabled()

  // Exclude the second region.
  await rows.nth(1).locator('input[type="checkbox"]').uncheck()
  await expect(rows.nth(1)).toHaveClass(/is-excluded/)

  await page.locator('#btn-review-approve').click()
  await expect(
    page.locator('#toast-container .toast', { hasText: 'Approved 1 region(s)' }).first()
  ).toBeVisible()

  // The kept region baked (thumb processed) and the conveyor auto-advanced.
  await expect(page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[0].id}"]`)).toHaveClass(/processed/)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[1].id)
  await expect(page.locator('#censor-review-progress')).toContainText('2 / 2')
  // Review state resets for the next image: checklist emptied, overlay off.
  await expect(rows).toHaveCount(0)
  await expect.poll(() =>
    page.evaluate(() => (document.getElementById('censor-review-overlay') as HTMLElement).style.opacity)
  ).toBe('0')
})

test('review detection surfaces partial warnings and rejects malformed warnings before approval', async ({ page }) => {
  await stubCensorBackend(page)
  const partialWarning = 'NudeNet detection failed; combined mode used Legacy YOLO only. runtime unavailable'
  let detectCalls = 0
  await page.route('**/api/censor/detect', async (route) => {
    detectCalls += 1
    await route.fulfill({
      json: {
        status: 'ok',
        image_id: IMAGES[0].id,
        model_type: 'both',
        detections: [
          { box: [8, 8, 24, 24], label: 'exposed_breasts', confidence: 0.9, source: 'legacy' },
        ],
        warnings: detectCalls === 1 ? [partialWarning, partialWarning] : 'invalid warning payload',
      },
    })
  })
  await seedCensorQueue(page)
  await page.locator('.censor-tab[data-censor-tab="review"]').click()

  const rows = page.locator('#censor-review-regions .censor-review-region')
  await page.locator('#btn-review-detect').click()
  await expect.poll(() => detectCalls).toBe(1)
  await expect(page.locator('#toast-container .toast.warning .toast-message')).toHaveText(partialWarning)
  await expect(rows).toHaveCount(1)
  await expect(page.locator('#btn-review-approve')).toBeEnabled()

  await page.locator('#btn-review-detect').click()
  await expect.poll(() => detectCalls).toBe(2)
  await expect(page.locator('#censor-review-status')).toContainText(
    'Censor detection response requires a warnings array'
  )
  await expect(rows).toHaveCount(0)
  await expect(page.locator('#btn-review-approve')).toBeDisabled()
  await expect.poll(() =>
    page.evaluate(() => (document.getElementById('censor-review-overlay') as HTMLElement).style.opacity)
  ).toBe('0')
})

test('review approve fails loud when kept regions cannot be baked (never-fallback)', async ({ page }) => {
  await stubCensorBackend(page)
  // Polygon-only detections (no boxes). Excluding one strips the polygons off
  // the kept region, which then has NO usable geometry — the approve must
  // refuse to pass the image off as censored and must stay on it.
  const detectCalls = await stubDetect(
    page,
    [
      { polygon: [[4, 4], [20, 4], [20, 20], [4, 20]], label: 'exposed_breasts', confidence: 0.9, source: 'legacy' },
      { polygon: [[40, 40], [60, 40], [60, 60], [40, 60]], label: 'exposed_pussy', confidence: 0.7, source: 'legacy' },
    ],
    { combined_mask: WHITE_PNG_DATA_URL, image_width: 64, image_height: 64 }
  )
  await seedCensorQueue(page)

  await page.locator('.censor-tab[data-censor-tab="review"]').click()
  await page.locator('#btn-review-detect').click()
  await expect.poll(() => detectCalls.length).toBe(1)

  const rows = page.locator('#censor-review-regions .censor-review-region')
  await expect(rows).toHaveCount(2)
  await rows.nth(1).locator('input[type="checkbox"]').uncheck()

  await page.locator('#btn-review-approve').click()
  await expect(
    page.locator('#toast-container .toast', { hasText: 'Could not censor the kept regions' }).first()
  ).toBeVisible()

  // Fail-loud semantics: no advance, nothing marked processed, and the
  // checklist stays so the user can retry (e.g. with Box shape).
  expect(await page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[0].id)
  await expect(page.locator('#censor-review-progress')).toContainText('1 / 2')
  await expect(
    page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[0].id}"]`)
  ).not.toHaveClass(/processed/)
  await expect(rows).toHaveCount(2)
  await expect(page.locator('#btn-review-approve')).toBeEnabled()
})
