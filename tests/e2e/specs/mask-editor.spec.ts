import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Phase 4 masked-training mask editor: UI wiring pins (backend stubbed).
 * Endpoint semantics are locked by backend/tests/test_mask_service.py.
 *
 *  - the 🎭 entry appears for gallery images only (local ids have no masks);
 *  - open -> paint -> save PUTs a PNG data URL and closes;
 *  - the auto-subject error path surfaces the backend's install hint.
 */

test.describe.configure({ mode: 'serial' })

// 1x1 white PNG for stubbing /api/image-file responses.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function seedDatasetQueue(page: Page) {
  await page.route('**/api/image-thumbnail/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/image-file/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG })
  })
  await page.route('**/api/masks/status', async (route) => {
    await route.fulfill({ json: { masks: {} } })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701]
    dm.meta.set(701, { filename: 'mask-a.png', width: 1024, height: 1024 })
    dm.captions.set(701, '1girl, standing')
    ;(window as any).App.switchView('dataset')
    dm._setActive(701)
  })
  await page.locator('#dataset-tab-workbench').click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
})

test('mask editor: open, paint, save PUTs a PNG data URL', async ({ page }) => {
  await seedDatasetQueue(page)

  let savedBody: Record<string, unknown> | null = null
  await page.route('**/api/masks/701', async (route) => {
    if (route.request().method() === 'PUT') {
      savedBody = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({ json: { saved: true, image_id: 701, width: 1, height: 1 } })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'no mask' } })
  })

  await expect(page.locator('#dataset-mask-controls')).toBeVisible()
  await page.locator('#btn-dataset-mask-edit').click()
  const modal = page.locator('#mask-editor-modal')
  await expect(modal).toBeVisible()
  await expect(page.locator('#mask-editor-status')).toContainText('No mask yet')

  // Paint one stroke (exclude tool) across the canvas.
  await page.locator('#mask-tool-exclude').click()
  const canvas = page.locator('#mask-editor-canvas')
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5, { steps: 4 })
  await page.mouse.up()

  await page.locator('#mask-editor-save').click()
  await expect(modal).toBeHidden()
  expect(savedBody).not.toBeNull()
  expect(String(savedBody!.data_url)).toMatch(/^data:image\/png;base64,/)
})

test('mask entry hides for local-source items', async ({ page }) => {
  await seedDatasetQueue(page)
  await expect(page.locator('#dataset-mask-controls')).toBeVisible()
  // Local-source items carry negative ids; the active-changed hook must
  // hide the entry for them (masks are keyed by gallery id only). Driving
  // the hook directly avoids simulating the whole local-import state.
  await page.evaluate(() => (window as any).MaskEditor._refreshEntry(-5))
  await expect(page.locator('#dataset-mask-controls')).toBeHidden()
})

test('auto subject surfaces the rembg install hint on 400', async ({ page }) => {
  await seedDatasetQueue(page)
  await page.route('**/api/masks/701', async (route) => {
    await route.fulfill({ status: 404, json: { error: 'no mask' } })
  })
  await page.route('**/api/masks/701/auto', async (route) => {
    await route.fulfill({
      status: 400,
      json: { error: 'rembg is not installed. Install it with: pip install rembg' },
    })
  })
  await page.locator('#btn-dataset-mask-edit').click()
  await expect(page.locator('#mask-editor-modal')).toBeVisible()
  await page.locator('#mask-tool-auto').click()
  await expect(page.locator('#mask-editor-status')).toContainText('pip install rembg')
})
