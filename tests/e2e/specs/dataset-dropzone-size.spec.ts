import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Dataset Maker import: the empty drop zone has a sensible height
 * (V3.5 subtraction 5).
 *
 * The empty #dataset-dropzone grew to fill the rest of the Import tab —
 * 566 px at 1920x1080, 774 px at 2560x1440 — for one line of text. It now
 * keeps a fixed band (180-240 CSS px); dropping files on it still imports them.
 */

test.describe.configure({ mode: 'serial' })

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

async function openDatasetImport(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await expect(page.locator('#view-dataset.active')).toBeVisible()
  await expect(page.locator('#dataset-dropzone')).toBeVisible()
  await expect(page.locator('#dataset-import-gallery')).toBeHidden()
}

test('the empty drop zone stays a 180-240 px band at desktop sizes', async ({ page }) => {
  const shotPhase = process.env.SUBTRACT_SHOT_PHASE
  for (const viewport of VIEWPORTS) {
    // Load at each size: ui-scale.js zooms the whole UI at 2560 (1.3x) when
    // the page starts, so a band of 240 CSS px draws 312 device px there.
    await page.setViewportSize(viewport)
    await openDatasetImport(page)
    const dropzone = page.locator('#dataset-dropzone')
    await expect(dropzone).toBeInViewport()
    await expect(page.locator('#dataset-dropzone .dataset-dropzone-text')).toBeInViewport()
    const layout = await page.evaluate(() => {
      const zone = document.getElementById('dataset-dropzone')!
      const box = zone.getBoundingClientRect()
      const content = zone.querySelector('.dataset-dropzone-content')!.getBoundingClientRect()
      return {
        cssHeight: parseFloat(getComputedStyle(zone).height),
        windowShare: box.height / window.innerHeight,
        contentFits: content.top >= box.top && content.bottom <= box.bottom,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    const at = `at ${viewport.width}x${viewport.height}`
    expect(layout.cssHeight, `drop zone CSS height ${at}`).toBeGreaterThanOrEqual(180)
    expect(layout.cssHeight, `drop zone CSS height ${at}`).toBeLessThanOrEqual(240)
    // It used to take a third to over half of the window (254/768, 566/1080, 774/1440).
    expect(layout.windowShare, `share of the window ${at}`).toBeLessThanOrEqual(0.3)
    expect(layout.contentFits).toBe(true)
    expect(layout.overflowX).toBeLessThanOrEqual(0)
    if (shotPhase) {
      await page.screenshot({ path: `../../.tmp/v35-subtract/dataset-${shotPhase}-spec-${viewport.width}.png` })
    }
  }
})

test('dropping an image on the smaller zone still uploads it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const uploads: string[] = []
  await page.route('**/api/dataset/upload-files', async (route) => {
    uploads.push(route.request().postDataBuffer()?.toString('latin1') ?? '')
    await route.fulfill({ json: { items: [], skipped_unreadable: 0, truncated: false } })
  })
  await openDatasetImport(page)

  const dropzone = page.locator('#dataset-dropzone')
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'drop-dataset.png', { type: 'image/png' }))
    return transfer
  })
  await dropzone.dispatchEvent('dragover', { dataTransfer })
  await expect(dropzone).toHaveClass(/drag-over/)
  await dropzone.dispatchEvent('drop', { dataTransfer })
  await expect(dropzone).not.toHaveClass(/drag-over/)

  await expect.poll(() => uploads.length).toBe(1)
  expect(uploads[0]).toContain('drop-dataset.png')
})
