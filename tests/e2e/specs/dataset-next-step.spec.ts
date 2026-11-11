import { expect, test, type Page } from '../fixtures/click-ledger'
import { seedPictures } from '../fixtures/seed-library'

/**
 * Dataset Maker's "What is left" line: under the header on every tab it says
 * what is missing before export, and its button leads to the tab where that
 * is done (and is left out when that tab is already open).
 */

test.beforeAll(async ({ request }) => {
  await seedPictures(request, 'dataset-next-step', 3)
})

const line = (page: Page) => page.locator('#dataset-next')
const text = (page: Page) => page.locator('#dataset-next-text')
const go = (page: Page) => page.locator('#btn-dataset-next')
const openTab = (page: Page) => page.locator('.dataset-maker').getAttribute('data-active-tab')
const redraw = (page: Page) => page.evaluate(() => (window as any).DatasetNextStep.render())

async function openDataset(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible()
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await expect.poll(() => page.evaluate(() => Boolean((window as any).DatasetMaker))).toBe(true)
  await page.evaluate(() => (window as any).DatasetMaker.clear?.())
}

test('it follows the dataset from empty to ready, and its button leads to the right tab', async ({ page }) => {
  await openDataset(page)

  // Empty, on Import: the tab itself says "add pictures", so the line stays out.
  await page.evaluate(() => (window as any).DatasetMaker._setPipelineTab('import'))
  await redraw(page)
  await expect(line(page)).toBeHidden()

  // Empty, on another tab: it says so and leads back to Import.
  await page.locator('#dataset-tab-workbench').click()
  await expect(text(page)).toHaveText('No pictures in this dataset yet.')
  await expect(go(page)).toHaveText('Add pictures')
  await go(page).click()
  expect(await openTab(page)).toBe('import')

  // Three pictures, one of them without a caption.
  const ids = await page.evaluate(() => (window as any).App.AppState.images.slice(0, 3).map((image: { id: number }) => image.id))
  await page.evaluate((list) => (window as any).App.addToDatasetMaker(list, { switchView: true, showToast: false }), ids)
  await expect(page.locator('#dataset-count-num')).toHaveText('3')
  await page.evaluate((bare) => {
    const maker = (window as any).DatasetMaker
    maker._booruTextFor = (id: number) => (Number(id) === Number(bare) ? '' : '1girl, solo')
  }, ids[0])
  await redraw(page)
  await expect(text(page)).toHaveText('1 of 3 pictures have no caption yet.')
  await expect(go(page)).toHaveText('Caption them')
  await go(page).click()
  expect(await openTab(page)).toBe('workbench')
  // There already: the sentence stays, the button goes; the line keeps its height.
  await expect(text(page)).toHaveText('1 of 3 pictures have no caption yet.')
  await expect(go(page)).toBeHidden()
  const height = (await line(page).boundingBox())!.height

  // All captioned, export not set up: the export's own reason, and the way there.
  await page.evaluate(() => {
    const maker = (window as any).DatasetMaker
    maker._booruTextFor = () => '1girl, solo'
    maker._exportDisabledReason = () => 'Pick an output folder to enable folder export.'
  })
  await redraw(page)
  await expect(text(page)).toHaveText('Every picture has a caption. Before exporting: Pick an output folder to enable folder export.')
  await expect(go(page)).toHaveText('Open Export')
  expect((await line(page).boundingBox())!.height).toBe(height)
  await go(page).click()
  expect(await openTab(page)).toBe('export')

  // Nothing left.
  await page.evaluate(() => { (window as any).DatasetMaker._exportDisabledReason = () => '' })
  await redraw(page)
  await expect(text(page)).toHaveText('Every picture has a caption and the export is set up: 3 pictures are ready.')
  await expect(go(page)).toBeHidden()

  // It never pushes the page sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.evaluate(() => (window as any).DatasetMaker.clear?.())
})

test('Chinese reads in full', async ({ page }) => {
  await openDataset(page)
  await page.evaluate(() => (window as any).I18n.setLang('zh-CN'))
  await page.locator('#dataset-tab-export').click()
  await expect(text(page)).toHaveText('这个数据集里还没有图片。')
  await expect(go(page)).toHaveText('添加图片')
  await expect(page.locator('.dataset-next-label')).toHaveText('还差什么')
})
