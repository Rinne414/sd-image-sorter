import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Issue #5 point 7: at 1366x768 the Dataset Maker queue column is ~214px of
 * content. Its toolbar labels were clipped (scrollWidth 229 > clientWidth 214),
 * the bottom multi-select bar ran past the pane edge, and 144px thumbnails fit
 * one per row. Nothing may clip or overlap at the laptop and desktop widths.
 */

const WIDTHS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
]

async function openQueueWithSelection(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/image-file/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = Array.from({ length: 24 }, (_, i) => 500 + i)
    for (const id of dm.imageIds) dm.meta.set(id, { filename: `img_${id}.png`, width: 512, height: 512 })
    ;(window as any).App.switchView('dataset')
  })
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#dataset-queue-list .dataset-queue-item').first().waitFor()
  await page.locator('#btn-dataset-queue-select-all').click()
  await expect(page.locator('#dataset-multiselect-bar')).toBeVisible()
}

for (const size of WIDTHS) {
  test(`queue toolbar, multi-select bar and grid fit the column at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await openQueueWithSelection(page)

    const report = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('#view-dataset .dataset-queue-pane')!
      const toolbar = pane.querySelector<HTMLElement>('.dataset-queue-toolbar')!
      const bar = pane.querySelector<HTMLElement>('#dataset-multiselect-bar')!
      const paneBox = pane.getBoundingClientRect()
      const buttons = [...toolbar.querySelectorAll<HTMLElement>('.btn'), ...bar.querySelectorAll<HTMLElement>('.btn')]
      const rects = buttons.map((b) => b.getBoundingClientRect())
      const overlaps: string[] = []
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j]
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
            overlaps.push(`${buttons[i].id} x ${buttons[j].id}`)
          }
        }
      }
      const items = [...pane.querySelectorAll<HTMLElement>('#dataset-queue-list .dataset-queue-item')]
      const firstRowTop = items[0].getBoundingClientRect().top
      return {
        toolbarClipped: toolbar.scrollWidth > toolbar.clientWidth,
        paneClipped: pane.scrollWidth > pane.clientWidth,
        clippedLabels: buttons.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.id),
        outsidePane: buttons.filter((b, i) => rects[i].right > paneBox.right + 0.5).map((b) => b.id),
        overlaps,
        columns: items.filter((el) => Math.abs(el.getBoundingClientRect().top - firstRowTop) < 2).length,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })

    expect(report.toolbarClipped, 'toolbar scrollWidth > clientWidth').toBe(false)
    expect(report.paneClipped, 'queue pane scrollWidth > clientWidth').toBe(false)
    expect(report.clippedLabels, 'buttons whose label is wider than the button').toEqual([])
    expect(report.outsidePane, 'buttons past the pane edge').toEqual([])
    expect(report.overlaps, 'overlapping buttons').toEqual([])
    expect(report.columns, 'thumbnails per row').toBeGreaterThanOrEqual(2)
    expect(report.pageOverflow, 'horizontal page overflow').toBe(false)
  })
}
