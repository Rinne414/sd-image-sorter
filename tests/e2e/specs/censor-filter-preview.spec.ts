import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Censor Adjust tab: the filter sliders and presets preview live on the
 * picture you are looking at (owner report 2026-10-04: "调色用不了").
 *
 * The preview is a CSS filter on the active canvas. A Graphite chrome pin
 * (`filter: none !important` on every censor canvas) silently overrode it, so
 * the sliders moved, the histogram changed, and the picture stayed as it was.
 * Apply still baked the pixels, which is why nothing looked broken in code.
 */

test.describe.configure({ mode: 'serial' })

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="32" height="64" fill="#e0245e"/>
  <rect x="32" width="32" height="64" fill="#2b6cd9"/>
</svg>
`.trim()

const IMAGE = { id: 9601, filename: 'colour.png', path: 'L:/filter-preview-colour.png', width: 640, height: 640 }

async function stubCensorBackend(page: Page): Promise<void> {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  await page.route(`**/api/image-thumbnail/${IMAGE.id}**`, fulfillImage)
  await page.route(`**/api/image-file/${IMAGE.id}**`, fulfillImage)
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({ json: { images: [IMAGE], total: 1, has_more: false, next_cursor: null } })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({ json: { images: [{ ...IMAGE, prompt: '', tags: [] }], missing_ids: [] } })
  })
}

async function openAdjustTab(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  await page.locator(`#gallery-grid .gallery-item[data-id="${IMAGE.id}"]`).click()
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGE.id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
  await page.locator('#view-censor [data-censor-tab="adjust"]').click()
  await expect(page.locator('#filter-saturation')).toBeVisible()
}

/** The filter the browser actually paints on the canvas the user sees. */
function paintedFilter(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId || 'censor-canvas') as HTMLCanvasElement
    return getComputedStyle(canvas).filter
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
    localStorage.removeItem('censor_queue')
  })
  await stubCensorBackend(page)
})

for (const viewport of VIEWPORTS) {
  test(`presets, sliders and reset preview on the visible picture at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await openAdjustTab(page)
    expect(await paintedFilter(page)).toBe('none')

    await page.locator('#btn-filter-bw').click()
    await expect.poll(() => paintedFilter(page)).toContain('saturate(0)')

    await page.locator('#filter-hue').fill('180')
    await expect(page.locator('#filter-hue-value')).toHaveText('180°')
    await expect.poll(() => paintedFilter(page)).toContain('hue-rotate(180deg)')

    await page.locator('#btn-filter-reset').click()
    await expect.poll(() => paintedFilter(page)).toBe('none')
  })
}

test('Apply to Current bakes the preview into the pixels and clears the live filter', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAdjustTab(page)

  await page.locator('#btn-filter-bw').click()
  await expect.poll(() => paintedFilter(page)).toContain('saturate(0)')
  await page.locator('#btn-apply-filters').click()

  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
  await expect(page.locator('#filter-saturation')).toHaveValue('0')
  expect(await paintedFilter(page)).not.toContain('saturate(0)')
  const pixel = await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    const canvas = document.getElementById(state.activeCanvasId || 'censor-canvas') as HTMLCanvasElement
    const x = Math.floor(canvas.width / 4)
    const y = Math.floor(canvas.height / 2)
    return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data)
  })
  const [r, g, b] = pixel
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    return state.queue.find((item: any) => item.id === state.activeId)?.isModified
  })).toBe(true)
})

test('an unapplied preview is labelled on the canvas and offered for applying before saving', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAdjustTab(page)
  const badge = page.locator('#censor-filter-preview-badge')
  await expect(badge).toBeHidden()

  await page.locator('#btn-filter-bw').click()
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('Current / Selected / All')

  await page.locator('#btn-save-all-processed').click()
  const notice = page.locator('#save-filter-pending-group')
  await expect(notice).toBeVisible()
  await expect(page.locator('#btn-confirm-save-options')).toBeInViewport()
  await page.locator('#btn-save-apply-filters-current').click()

  await expect(notice).toBeHidden()
  await expect(badge).toBeHidden()
  await expect.poll(() => page.evaluate(() => {
    const state = (window as any).__CENSOR_STATE__
    return state.queue.find((item: any) => item.id === state.activeId)?.isModified
  })).toBe(true)

  await page.locator('#btn-cancel-save-options').click()
  await page.locator('#btn-filter-warm').click()
  await expect(badge).toBeVisible()
  await page.locator('#btn-filter-reset').click()
  await expect(badge).toBeHidden()
})
