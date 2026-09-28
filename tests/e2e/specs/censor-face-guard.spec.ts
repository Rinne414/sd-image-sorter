import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Face guard (2026-09-28): detections that are really a face are skipped by
 * the backend when the anime face model is installed. The Censor page sends
 * the choice with every detect (on by default, remembered) and says when the
 * guard skipped something, so the user can check that face.
 */

test.describe.configure({ mode: 'serial' })

const MOCK_IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#d9e2f2"/></svg>'
const IMAGE = { id: 9501, filename: 'face.png', path: 'L:/face-guard.png', width: 64, height: 64 }
const MODELS_PAYLOAD = {
  status: 'ok',
  recommended_backend: 'nudenet',
  models: [
    { id: 'legacy', name: 'Local YOLO', available: false, files: [], general_model_count: 0, default_model_path: null, capabilities: {} },
    { id: 'nudenet', name: 'NudeNet', available: true, model_downloaded: true, recommended: true, capabilities: {} },
    { id: 'sam3', name: 'SAM3', available: false, message: 'not installed in e2e', capabilities: {} },
  ],
}

async function openCensor(page: Page, dropped: number): Promise<Array<Record<string, unknown>>> {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  await page.route(`**/api/image-thumbnail/${IMAGE.id}**`, fulfillImage)
  await page.route(`**/api/image-file/${IMAGE.id}**`, fulfillImage)
  await page.route('**/api/images?**', (route) => route.fulfill({ json: { images: [IMAGE], total: 1, has_more: false, next_cursor: null } }))
  await page.route('**/api/images/export-data', (route) => route.fulfill({ json: { images: [{ ...IMAGE, prompt: '', tags: [] }], missing_ids: [] } }))
  await page.route('**/api/censor/models', (route) => route.fulfill({ json: MODELS_PAYLOAD }))
  const calls: Array<Record<string, unknown>> = []
  await page.route('**/api/censor/detect', async (route) => {
    calls.push(route.request().postDataJSON())
    await route.fulfill({
      json: {
        status: 'ok', image_id: IMAGE.id, model_type: 'nudenet', detections: [], warnings: [],
        face_guard: { active: true, faces: 1, dropped },
      },
    })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGE.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
  await page.evaluate(() => { (window as any).ensureFeatureModel = async () => ({ ok: true }) })
  return calls
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
})

test('detect sends face guard on by default and says when it skipped a face', async ({ page }) => {
  const calls = await openCensor(page, 2)

  await expect(page.locator('#censor-face-guard')).toBeChecked()
  await page.locator('#btn-auto-detect-current').click()

  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0].face_guard).toBe(true)
  await expect(page.locator('#toast-container .toast', { hasText: 'Face guard skipped 2 detection(s)' }).first()).toBeVisible()
})

test('turning face guard off is sent and remembered', async ({ page }) => {
  const calls = await openCensor(page, 0)

  await page.locator('#censor-face-guard').scrollIntoViewIfNeeded()
  await page.locator('#censor-face-guard').uncheck()
  await page.locator('#btn-auto-detect-current').click()

  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0].face_guard).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('censor_face_guard'))).toBe('0')
  await expect(page.locator('#toast-container .toast', { hasText: 'Face guard skipped' })).toHaveCount(0)
})

test('the chosen region shape and edge growth are sent and remembered', async ({ page }) => {
  const calls = await openCensor(page, 0)

  await page.locator('#censor-mask-shape').scrollIntoViewIfNeeded()
  await page.locator('#censor-mask-shape').selectOption('fit')
  await page.locator('#censor-expand-percent').fill('15')
  await expect(page.locator('#censor-expand-percent-value')).toHaveText('15%')
  await page.locator('#btn-auto-detect-current').click()

  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]).toMatchObject({ shape: 'fit', expand_percent: 15 })
  expect(await page.evaluate(() => [localStorage.getItem('censor_mask_shape'), localStorage.getItem('censor_expand_percent')]))
    .toEqual(['fit', '15'])
})

test('the detection rows can be scrolled clear of the sticky Save card at every desktop size', async ({ page }) => {
  await openCensor(page, 0)

  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    await page.setViewportSize(size)
    const layout = await page.evaluate(() => {
      let scroller: HTMLElement | null = document.getElementById('censor-face-guard-row')
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      if (scroller) scroller.scrollTop = scroller.scrollHeight
      const saveTop = document.getElementById('btn-save-all-processed')!.closest('.censor-side-card')!.getBoundingClientRect().top
      return ['censor-mask-shape-row', 'censor-expand-row', 'censor-face-guard-row']
        .filter((id) => document.getElementById(id)!.getBoundingClientRect().bottom > saveTop + 1)
    })
    expect(layout, `rows under the Save card at ${size.width}x${size.height}`).toEqual([])
  }
})
