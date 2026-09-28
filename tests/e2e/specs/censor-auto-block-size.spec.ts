import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * Auto mosaic cell (owner 2026-09-28): by default the cell is 1/100 of each
 * picture's long side (at least 4 px), so large and small pictures get an
 * equally coarse mosaic. Moving the slider switches to a hand-picked size,
 * and that choice is remembered.
 */

test.describe.configure({ mode: 'serial' })

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#d9e2f2"/>
</svg>
`.trim()

// Logical sizes drive Auto; the served pixels are a small stand-in.
const IMAGES = [
  { id: 9401, filename: 'big.png', path: 'L:/auto-block-big.png', width: 4000, height: 3000 },
  { id: 9402, filename: 'small.png', path: 'L:/auto-block-small.png', width: 800, height: 600 },
]

async function stubCensorBackend(page: Page): Promise<void> {
  const fulfillImage = async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMAGE_SVG })
  }
  for (const image of IMAGES) {
    await page.route(`**/api/image-thumbnail/${image.id}**`, fulfillImage)
    await page.route(`**/api/image-file/${image.id}**`, fulfillImage)
  }
  await page.route('**/api/images?**', async (route) => {
    await route.fulfill({ json: { images: IMAGES, total: IMAGES.length, has_more: false, next_cursor: null } })
  })
  await page.route('**/api/images/export-data', async (route) => {
    await route.fulfill({ json: { images: IMAGES.map((image) => ({ ...image, prompt: '', tags: [] })), missing_ids: [] } })
  })
}

async function openCensorWithBothImages(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  for (const image of IMAGES) {
    await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  }
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGES[0].id)
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.isLoadingImage)).toBe(false)
}

/** The mosaic cell the brush and new operations use for the picture being edited. */
function activeBlockSize(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).censorActiveBlockSize())
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await stubCensorBackend(page)
})

test('Auto is the default and follows each picture', async ({ page }) => {
  await openCensorWithBothImages(page)

  await expect(page.locator('#censor-block-size-auto')).toBeChecked()
  await expect(page.locator('#censor-block-size-value')).toHaveText('40 px')
  expect(await activeBlockSize(page)).toBe(40)

  await page.locator(`#censor-queue-list [data-id="${IMAGES[1].id}"]`).first().click()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(IMAGES[1].id)
  await expect(page.locator('#censor-block-size-value')).toHaveText('8 px')
})

test('moving the slider picks a size by hand, and Auto comes back when ticked', async ({ page }) => {
  await openCensorWithBothImages(page)

  await page.locator('#censor-block-size').fill('24')

  await expect(page.locator('#censor-block-size-auto')).not.toBeChecked()
  await expect(page.locator('#censor-block-size-value')).toHaveText('24 px')
  expect(await activeBlockSize(page)).toBe(24)

  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    ;(window as any).EntryPage?.hide?.()
    document.getElementById('nav-tab-censor')?.click()
  })
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-block-size-auto')).not.toBeChecked()

  await page.locator('#censor-block-size-auto').check({ force: true })
  await expect(page.locator('#censor-block-size-auto')).toBeChecked()
  expect(await page.evaluate(() => localStorage.getItem('censor_block_size_auto'))).toBe('1')
})

test('the Auto box fits beside the slider at every desktop size', async ({ page }, testInfo) => {
  await openCensorWithBothImages(page)
  await page.locator('.tool-btn-v2[data-tool="brush"]').click()

  for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    await resizeAndSettleUiScale(page, size)
    await page.locator('#censor-block-size-auto').scrollIntoViewIfNeeded()
    await expect(page.locator('#censor-block-size-auto')).toBeVisible()
    await expect(page.locator('#censor-block-size-value')).toBeVisible()
    const layout = await page.evaluate(() => {
      const row = document.getElementById('censor-block-size')!.parentElement!.getBoundingClientRect()
      const auto = document.getElementById('censor-block-size-auto')!.closest('label')!.getBoundingClientRect()
      const slider = document.getElementById('censor-block-size')!.getBoundingClientRect()
      return {
        autoInsideRow: auto.left >= row.left - 1 && auto.right <= row.right + 1 && auto.width > 0,
        sliderUsable: slider.width >= 60,
        overlap: auto.left < slider.right - 1 && auto.right > slider.left + 1,
      }
    })
    expect(layout, `at ${size.width}x${size.height}`).toEqual({ autoInsideRow: true, sliderUsable: true, overlap: false })
    const card = page.locator('#censor-block-size').locator('xpath=ancestor::*[contains(@class, "censor-side-card") or contains(@class, "sidebar-section")][1]')
    await (await card.count() ? card : page.locator('#censor-block-size').locator('xpath=..')).screenshot({ path: testInfo.outputPath(`censor-block-row-${size.width}x${size.height}.png`) })
  }
})
