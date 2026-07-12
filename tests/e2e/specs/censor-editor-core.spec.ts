import { expect, test, type Page, type Route } from '../fixtures/click-ledger'

/**
 * Censor editor characterization pins — part 1 of 2 (canvas core).
 *
 * frontend/js/censor-edit.js is a 7k-line god file queued for redesign. These
 * specs pin the OBSERVABLE editor-core behavior a module split could silently
 * break: queue → canvas load (double-buffer swap), tool switching + keyboard
 * shortcuts, pen strokes → pixels, canvas undo/redo semantics, reset-to-
 * original, the SAVE WIRE FORMATS (/api/censor/save-data vs /save-operations
 * routing + exact payload key sets), the never-fallback-to-uncensored skip,
 * and zoom/queue-navigation. They must pass BEFORE and AFTER the refactor.
 *
 * Detect/review-conveyor behavior is pinned in censor-detect-review.spec.ts.
 * Queue persistence (P3-11) is already pinned by censor-queue-persist.spec.ts.
 *
 * All backend routes the flows touch are stubbed (pattern from
 * dataset-editor-core.spec.ts / mask-editor.spec.ts); state is read through
 * the localhost-only window.__CENSOR_STATE__ debug handle.
 */

test.describe.configure({ mode: 'serial' })

// 1x1 opaque-white PNG. Only used as a stand-in currentDataUrl whose exact
// string must round-trip into the /save-data payload untouched.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
const WHITE_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

// Flat 64x64 test image: the center (32,32) and the corners are the plain
// #d9e2f2 background, so a red pen stroke / black bar is unambiguous.
const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#d9e2f2"/>
  <circle cx="32" cy="10" r="6" fill="#7a93b8"/>
</svg>
`.trim()

const IMAGES = [
  { id: 9301, filename: 'censor-core-a.png', path: 'L:/censor-core-a.png', width: 64, height: 64 },
  { id: 9302, filename: 'censor-core-b.png', path: 'L:/censor-core-b.png', width: 64, height: 64 },
]

const OUTPUT_FOLDER = 'L:/censor-e2e-out'

// Deterministic /api/censor/models payload so the capability panel and the
// detect execution-plan resolution never depend on real local model files.
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

/** Real selection → send-to-censor flow (proven by censor-queue-persist). */
async function seedCensorQueue(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[0].id}"]`).click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGES[1].id}"]`).click()
  await page.locator('#btn-send-to-censor').click()

  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(2)
  // The first queue item auto-loads onto the canvas (100ms defer + RAF swap).
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGES[0].id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
}

/** RGBA of one pixel on the ACTIVE (double-buffered) canvas. */
function activePixel(page: Page, x: number, y: number) {
  return page.evaluate(([px, py]) => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId || 'censor-canvas') as HTMLCanvasElement
    const d = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }, [x, y])
}

async function isCenterRed(page: Page) {
  const [r, g, b] = await activePixel(page, 32, 32)
  return r > 200 && g < 80 && b < 80
}

function itemState(page: Page, id: number) {
  return page.evaluate((imageId) => {
    const item = (window as any).__CENSOR_STATE__.queue.find((entry: any) => entry.id === imageId)
    return {
      isModified: Boolean(item?.isModified),
      hasCurrentDataUrl: Boolean(item?.currentDataUrl),
      editOperations: (item?.editOperations || []).length,
      batchStatus: item?.batchStatus ?? null,
    }
  }, id)
}

/** Draw a short pen stroke across the canvas center via real mouse events. */
async function paintPenStrokeAtCenter(page: Page) {
  await page.locator('.tool-btn-v2[data-tool="pen"]').click()
  const canvasId = await page.evaluate(() => (window as any).__CENSOR_STATE__.activeCanvasId)
  const box = await page.locator(`#${canvasId}`).boundingBox()
  expect(box).not.toBeNull()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 3, cy, { steps: 2 })
  await page.mouse.up()
}

async function saveAllWithOptions(page: Page, options: { folder?: string, format?: string } = {}) {
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  if (options.folder !== undefined) {
    await page.locator('#save-output-folder').fill(options.folder)
  }
  if (options.format !== undefined) {
    await page.selectOption('#save-format-option', options.format)
  }
  await page.locator('#btn-confirm-save-options').click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('queue → canvas: auto-load, editor chrome, filename, double-buffer swap on item switch', async ({ page }) => {
  await stubCensorBackend(page)
  await seedCensorQueue(page)

  // Loaded-editor chrome: the has-image class shows the toolbar/status bars,
  // the empty-state card hides, the status bar carries the output filename.
  await expect(page.locator('.censor-main-v2')).toHaveClass(/censor-has-image/)
  await expect(page.locator('#censor-no-image')).toBeHidden()
  await expect(page.locator('#censor-filename')).toHaveText(IMAGES[0].filename)

  const first = await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId) as HTMLCanvasElement
    return {
      activeCanvasId: state.activeCanvasId,
      width: canvas.width,
      height: canvas.height,
      proxyEditMode: state.proxyEditMode,
      lowMemoryMode: state.lowMemoryMode,
    }
  })
  // Small image: full-resolution buffer, no proxy/low-memory degradation.
  expect(first.width).toBe(64)
  expect(first.height).toBe(64)
  expect(first.proxyEditMode).toBe(false)
  expect(first.lowMemoryMode).toBe(false)

  // A fresh image starts with no undo/redo history.
  await expect(page.locator('#btn-undo')).toBeDisabled()
  await expect(page.locator('#btn-redo')).toBeDisabled()

  // Clicking another queue thumb loads it and swaps to the OTHER buffer canvas.
  await page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[1].id}"]`).click()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)).toBe(IMAGES[1].id)
  await expect(page.locator('#censor-filename')).toHaveText(IMAGES[1].filename)
  await expect(page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${IMAGES[1].id}"]`)).toHaveClass(/active/)
  const secondCanvasId = await page.evaluate(() => (window as any).__CENSOR_STATE__.activeCanvasId)
  expect(secondCanvasId).not.toBe(first.activeCanvasId)
  expect(['censor-canvas', 'censor-canvas-buffer']).toContain(secondCanvasId)
})

test('tool switching: clicks, B/P/E/G shortcuts, [ ] brush size, editable-target guard', async ({ page }) => {
  await stubCensorBackend(page)
  await seedCensorQueue(page)

  const currentTool = () => page.evaluate(() => (window as any).__CENSOR_STATE__.currentTool)

  // Click-based switching toggles the active class across the toolbar.
  await page.locator('.tool-btn-v2[data-tool="eraser"]').click()
  expect(await currentTool()).toBe('eraser')
  await expect(page.locator('.tool-btn-v2[data-tool="eraser"]')).toHaveClass(/active/)
  await expect(page.locator('.tool-btn-v2[data-tool="brush"]')).not.toHaveClass(/active/)

  // Keyboard shortcuts (view-scoped): p=pen, g=clone, b=brush.
  await page.keyboard.press('p')
  expect(await currentTool()).toBe('pen')
  await expect(page.locator('.tool-btn-v2[data-tool="pen"]')).toHaveClass(/active/)
  await page.keyboard.press('g')
  expect(await currentTool()).toBe('clone')
  await page.keyboard.press('b')
  expect(await currentTool()).toBe('brush')

  // [ / ] step brush size by 5 and sync the slider, label, and indicator.
  const brushSize = () => page.evaluate(() => (window as any).__CENSOR_STATE__.brushSize)
  expect(await brushSize()).toBe(30)
  await page.keyboard.press('[')
  expect(await brushSize()).toBe(25)
  await expect(page.locator('#tool-size')).toHaveValue('25')
  await expect(page.locator('#tool-size-value')).toHaveText('25')
  await expect(page.locator('#brush-size-indicator')).toHaveText('25px')
  await page.keyboard.press(']')
  expect(await brushSize()).toBe(30)

  // Shortcuts must NOT fire while typing in an input: the keystroke goes to
  // the field, the tool stays put.
  await page.locator('#btn-queue-filter').click()
  const filterInput = page.locator('#queue-filter-input')
  await expect(filterInput).toBeVisible()
  await expect(filterInput).toBeFocused()
  await page.keyboard.press('e')
  expect(await currentTool()).toBe('brush')
  await expect(filterInput).toHaveValue('e')
})

test('pen stroke paints pixels; canvas undo/redo round-trips pixels and item state', async ({ page }) => {
  await stubCensorBackend(page)
  await seedCensorQueue(page)

  await paintPenStrokeAtCenter(page)

  // Default pen is pure red at full opacity.
  await expect.poll(() => isCenterRed(page)).toBe(true)
  await expect.poll(() => itemState(page, IMAGES[0].id)).toEqual({
    isModified: true,
    hasCurrentDataUrl: true,
    editOperations: 0,
    batchStatus: null,
  })
  await expect(page.locator('#btn-undo')).toBeEnabled()
  await expect(page.locator('#btn-redo')).toBeDisabled()

  // Undo restores the original pixels AND resets the item back to unmodified
  // (undoing to the base state must not leave a stale currentDataUrl behind).
  await page.locator('#btn-undo').click()
  await expect.poll(() => isCenterRed(page)).toBe(false)
  await expect.poll(() => itemState(page, IMAGES[0].id)).toEqual({
    isModified: false,
    hasCurrentDataUrl: false,
    editOperations: 0,
    batchStatus: null,
  })
  await expect(page.locator('#btn-redo')).toBeEnabled()

  // Redo re-applies the stroke.
  await page.locator('#btn-redo').click()
  await expect.poll(() => isCenterRed(page)).toBe(true)
  await expect.poll(() => itemState(page, IMAGES[0].id)).toEqual({
    isModified: true,
    hasCurrentDataUrl: true,
    editOperations: 0,
    batchStatus: null,
  })
})

test('reset-to-original clears edits after confirm and wipes the history', async ({ page }) => {
  await stubCensorBackend(page)
  await seedCensorQueue(page)

  await paintPenStrokeAtCenter(page)
  await expect.poll(() => isCenterRed(page)).toBe(true)

  await page.locator('#btn-clear-edits').click()
  await expect(page.locator('#confirm-modal.visible')).toBeVisible()
  await page.locator('#confirm-modal #btn-confirm-ok').click()

  await expect.poll(() => isCenterRed(page)).toBe(false)
  await expect.poll(() => itemState(page, IMAGES[0].id)).toEqual({
    isModified: false,
    hasCurrentDataUrl: false,
    editOperations: 0,
    batchStatus: null,
  })
  // History is reset, not merely stepped back: nothing to undo OR redo.
  await expect(page.locator('#btn-undo')).toBeDisabled()
  await expect(page.locator('#btn-redo')).toBeDisabled()
})

test('save-all wire format: /save-data payload, strip default, un-censored items skipped', async ({ page }) => {
  await stubCensorBackend(page)
  const saveDataCalls: Array<Record<string, unknown>> = []
  const saveOpsCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/censor/save-data', async (route) => {
    saveDataCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { status: 'ok', saved_path: `${OUTPUT_FOLDER}/out.png` } })
  })
  await page.route('**/api/censor/save-operations', async (route) => {
    saveOpsCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { status: 'ok' } })
  })
  await seedCensorQueue(page)

  // Attempt 1 — nothing censored yet. The never-fallback-to-uncensored
  // invariant: no request may leave the browser, and the toast says so.
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  // Privacy default pinned: metadata option starts on 'strip', format on png.
  await expect(page.locator('#save-metadata-option')).toHaveValue('strip')
  await expect(page.locator('#save-format-option')).toHaveValue('png')
  await page.locator('#save-output-folder').fill(OUTPUT_FOLDER)
  await page.locator('#btn-confirm-save-options').click()
  await expect(page.locator('#toast-container .toast', { hasText: 'Nothing saved' }).first()).toBeVisible()
  expect(saveDataCalls).toHaveLength(0)
  expect(saveOpsCalls).toHaveLength(0)

  // Seed a baked canvas edit on item 1 only (the established in-page pattern).
  await page.evaluate(({ id, dataUrl }) => {
    const item = (window as any).__CENSOR_STATE__.queue.find((entry: any) => entry.id === id)
    item.currentDataUrl = dataUrl
    item.isProcessed = true
  }, { id: IMAGES[0].id, dataUrl: WHITE_PNG_DATA_URL })

  // Attempt 2 — the output folder round-trips through localStorage into the
  // reopened modal; exactly ONE save-data POST goes out (item 2 is skipped).
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  await expect(page.locator('#save-output-folder')).toHaveValue(OUTPUT_FOLDER)
  await page.locator('#btn-confirm-save-options').click()

  await expect.poll(() => saveDataCalls.length).toBe(1)
  expect(saveOpsCalls).toHaveLength(0)
  // The pinned save-data wire format (exact key set + values).
  expect(saveDataCalls[0]).toEqual({
    image_data: WHITE_PNG_DATA_URL,
    filename: 'censor-core-a.png',
    output_folder: OUTPUT_FOLDER,
    metadata_option: 'strip',
    output_format: 'png',
    original_image_id: IMAGES[0].id,
    allow_overwrite: false,
  })

  await expect(page.locator('#toast-container .toast', { hasText: 'skipped 1' }).first()).toBeVisible()
  expect((await itemState(page, IMAGES[0].id)).batchStatus).toBe('saved')
  expect((await itemState(page, IMAGES[1].id)).batchStatus).toBe('skipped')
  expect(await page.evaluate(() => localStorage.getItem('censor_output_folder'))).toBe(OUTPUT_FOLDER)
})

test('items with edit operations save via /save-operations with the operation list intact', async ({ page }) => {
  await stubCensorBackend(page)
  const saveDataCalls: Array<Record<string, unknown>> = []
  const saveOpsCalls: Array<Record<string, unknown>> = []
  await page.route('**/api/censor/save-data', async (route) => {
    saveDataCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { status: 'ok' } })
  })
  await page.route('**/api/censor/save-operations', async (route) => {
    saveOpsCalls.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { status: 'ok' } })
  })
  await seedCensorQueue(page)

  // Representative non-destructive edit-op list (the proxy-editor format) on
  // the NON-active item 2. A small image with editOperations must STILL route
  // through /save-operations — the routing keys off the op list, not off
  // proxy mode.
  const OPS = [
    {
      kind: 'stroke',
      tool: 'pen',
      points: [{ x: 5, y: 6 }, { x: 9, y: 6 }],
      brush_size: 30,
      pen_color: '#ff0000',
      pen_opacity: 1,
    },
    {
      kind: 'geometry_effect',
      style: 'mosaic',
      block_size: 16,
      blur_radius: 8,
      regions: [{ box: [1, 1, 20, 20], label: 'exposed_breasts', confidence: 0.9 }],
    },
  ]
  await page.evaluate(({ id, ops }) => {
    const item = (window as any).__CENSOR_STATE__.queue.find((entry: any) => entry.id === id)
    item.editOperations = ops
  }, { id: IMAGES[1].id, ops: OPS })

  // Pin that the export extension follows the chosen format (webp here).
  await saveAllWithOptions(page, { folder: OUTPUT_FOLDER, format: 'webp' })

  await expect.poll(() => saveOpsCalls.length).toBe(1)
  expect(saveDataCalls).toHaveLength(0)
  expect(saveOpsCalls[0]).toEqual({
    original_image_id: IMAGES[1].id,
    operations: OPS,
    filename: 'censor-core-b.webp',
    output_folder: OUTPUT_FOLDER,
    metadata_option: 'strip',
    output_format: 'webp',
    allow_overwrite: false,
  })
})

test('zoom controls scale the shared canvas container and fit resets it', async ({ page }) => {
  await stubCensorBackend(page)
  await seedCensorQueue(page)

  const containerTransform = () =>
    page.evaluate(() => (document.getElementById('canvas-container') as HTMLElement).style.transform)

  await expect(page.locator('#zoom-level')).toHaveText('100%')

  await page.locator('#btn-zoom-in').click()
  await expect(page.locator('#zoom-level')).toHaveText('125%')
  expect(await containerTransform()).toContain('scale(1.25)')

  await page.locator('#btn-zoom-in').click()
  await expect(page.locator('#zoom-level')).toHaveText('150%')

  await page.locator('#btn-zoom-out').click()
  await expect(page.locator('#zoom-level')).toHaveText('125%')

  await page.locator('#btn-zoom-fit').click()
  await expect(page.locator('#zoom-level')).toHaveText('100%')
  // Fit also resets the pan offset, not just the scale.
  expect(await containerTransform()).toBe('translate(0px, 0px) scale(1)')
})

test('ArrowRight / ArrowLeft navigate the queue', async ({ page }) => {
  await stubCensorBackend(page)
  await seedCensorQueue(page)

  const activeId = () => page.evaluate(() => (window as any).__CENSOR_STATE__.activeId)

  await page.keyboard.press('ArrowRight')
  await expect.poll(activeId).toBe(IMAGES[1].id)
  await expect(page.locator('#censor-filename')).toHaveText(IMAGES[1].filename)

  // At the end of the queue, ArrowRight is a no-op.
  await page.keyboard.press('ArrowRight')
  await expect.poll(activeId).toBe(IMAGES[1].id)

  await page.keyboard.press('ArrowLeft')
  await expect.poll(activeId).toBe(IMAGES[0].id)
  await expect(page.locator('#censor-filename')).toHaveText(IMAGES[0].filename)
})
