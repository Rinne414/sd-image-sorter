import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Adding a tag to the selected queue images opens a field with Add and Cancel
 * beside it at the bottom of the queue column. On a laptop that column is only
 * ~214 px wide, so the field was squeezed to 68 px (88 at 1440, 128 at 1600):
 * not even its own "Tag to add:" placeholder fit, and a typical tag scrolled
 * out of sight while typing. The field now has a line of its own, with Add
 * and Cancel sharing the line below, at every width.
 */

const TYPICAL_TAG = 'looking_at_viewer'

async function openAddTagField(page: Page, width: number, height: number) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'en'))
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/tags/export-preview', (route) => route.fulfill({ json: { results: [] } }))
  await page.route('**/api/dataset/export-preview', (route) =>
    route.fulfill({ json: { total: 0, returned: 0, items: [] } }))
  await page.route('**/api/dataset/vocab', (route) => route.fulfill({ json: { vocab: [] } }))
  await page.route('**/api/prompts/categorize', (route) => route.fulfill({ json: { results: [] } }))
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._captionTypeFor === 'function')
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [701, 702, 703, 704]
    for (const id of dm.imageIds) dm.meta.set(id, { filename: `t-${id}.png`, width: 1024, height: 1024 })
    ;(window as any).App.switchView('dataset')
  })
  await page.locator('#dataset-tab-workbench').click()
  await page.locator('#btn-dataset-queue-select-all').click()
  const bar = page.locator('#dataset-multiselect-bar')
  await expect(bar).toBeVisible()
  await bar.locator('> .btn', { hasText: /add tag/i }).click()
  await expect(page.locator('#dataset-multisel-tag-form input')).toBeFocused()
}

for (const [width, height] of [[1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440]]) {
  test(`a typical tag fits the add-tag field, with Add and Cancel whole, at ${width}x${height}`, async ({ page }) => {
    await openAddTagField(page, width, height)
    const input = page.locator('#dataset-multisel-tag-form input')
    await input.fill(TYPICAL_TAG)

    const report = await page.evaluate(() => {
      const bar = document.getElementById('dataset-multiselect-bar')!
      const form = document.getElementById('dataset-multisel-tag-form')!
      const field = form.querySelector('input')!
      const buttons = [...form.querySelectorAll<HTMLElement>('.btn')]
      const barBox = bar.getBoundingClientRect()
      const boxes = [field, ...buttons].map((el) => el.getBoundingClientRect())
      const overlaps = boxes.some((a, i) => boxes.some((b, j) => j > i
        && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5))
      const [addBox, cancelBox] = buttons.map((b) => b.getBoundingClientRect())
      const fieldBox = field.getBoundingClientRect()
      return {
        buttonsShareLine: Math.abs(addBox.top - cancelBox.top) < 1,
        fieldAbove: fieldBox.bottom <= Math.min(addBox.top, cancelBox.top),
        // On a line of its own the field no longer takes the buttons' height
        // from the row: it must still be a full-size field, not a thin strip.
        fieldHeightGap: Math.round(addBox.height - fieldBox.height),
        tagHidden: field.scrollWidth > field.clientWidth,
        clippedButtons: buttons.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent!.trim()),
        outsideBar: boxes.some((box) => box.left < barBox.left - 0.5 || box.right > barBox.right + 0.5),
        overlaps,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })
    expect(report.tagHidden, `"${TYPICAL_TAG}" scrolls inside the field`).toBe(false)
    expect(report.fieldAbove, 'the field has a line of its own').toBe(true)
    expect(report.buttonsShareLine, 'Add and Cancel share the line below').toBe(true)
    expect(report.fieldHeightGap, 'the field is about as tall as the buttons').toBeLessThanOrEqual(3)
    expect(report.clippedButtons).toEqual([])
    expect(report.outsideBar).toBe(false)
    expect(report.overlaps).toBe(false)
    expect(report.pageOverflow).toBe(false)
  })
}
