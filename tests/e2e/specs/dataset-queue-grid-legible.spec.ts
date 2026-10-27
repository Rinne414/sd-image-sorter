import { expect, test } from '../fixtures/click-ledger'

/**
 * Dataset Maker queue, grid mode: the order number and the file name sit on the
 * picture. Since the 2026-08 restyle they had a 0.14 wash and no strip behind
 * them, so on a light picture they were nearly invisible. They get the dark
 * chrome the select toggle uses; this measures their contrast on a white
 * thumbnail at the desktop widths.
 */

const WHITE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA1UlEQVR4nO3SsQ0AIADDMOD/gxETF0AesNduUec5e/C2PhsCNQ8KAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoPF3Acf1A6w8dtJ1AAAAAElFTkSuQmCC',
  'base64',
)

/** WCAG contrast of a colour drawn over the white picture (alpha composited). */
function contrastOnWhite(text: number[], backdrop: number[]): number {
  const over = (c: number, a: number) => c * a + 250 * (1 - a)
  const [r, g, b, a = 1] = backdrop
  const bg = [over(r!, a), over(g!, a), over(b!, a)]
  const lum = (rgb: number[]) => {
    const [x, y, z] = rgb.map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * x! + 0.7152 * y! + 0.0722 * z!
  }
  const [hi, lo] = [lum(text), lum(bg)].sort((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}

const rgbOf = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number)

test('the queue number and the file name read on a white picture at every desktop width', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-image-sorter-dataset-queue-mode', 'grid')
  })
  await page.route('**/api/image-thumbnail/**', (route) => route.fulfill({ contentType: 'image/png', body: WHITE_PNG }))
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as any).DatasetMaker?._setActive === 'function')
  await page.evaluate(() => (window as any).App.switchView('dataset'))
  await page.waitForFunction(() => {
    const dm = (window as any).DatasetMaker
    return dm?._trainerContractState?.status === 'ready' && dm?._pendingProjectSettings === null
  })
  await page.evaluate(() => {
    const dm = (window as any).DatasetMaker
    dm.imageIds = [811, 812, 813]
    for (const id of dm.imageIds) {
      dm.meta.set(id, { filename: `white-${id}.png`, width: 512, height: 512 })
      dm.captions.set(id, '1girl')
    }
    dm._setActive(811)
    dm._renderQueue?.()
  })

  await page.locator('#dataset-tab-workbench').click()
  const item = page.locator('#view-dataset .dataset-queue-grid-mode .dataset-queue-item').first()
  await expect(item).toBeVisible()
  for (const [width, height] of [[1366, 768], [1920, 1080], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height })
    await item.hover()
    const colours = await item.evaluate((el) => {
      const order = el.querySelector('.dataset-queue-order') as HTMLElement
      const name = el.querySelector('.dataset-queue-filename') as HTMLElement
      const meta = el.querySelector('.dataset-queue-meta') as HTMLElement
      const backdrop = getComputedStyle(meta).backgroundImage
      return {
        orderText: getComputedStyle(order).color,
        orderBg: getComputedStyle(order).backgroundColor,
        nameText: getComputedStyle(name).color,
        // the strip's darkest stop, behind the name at the bottom
        stripBottom: (backdrop.match(/rgba?\([^)]*\)/g) ?? []).pop() ?? 'rgba(0, 0, 0, 0)',
      }
    })
    const order = contrastOnWhite(rgbOf(colours.orderText), rgbOf(colours.orderBg))
    const name = contrastOnWhite(rgbOf(colours.nameText), rgbOf(colours.stripBottom))
    expect(order, `${width}px queue number`).toBeGreaterThanOrEqual(4.5)
    expect(name, `${width}px file name`).toBeGreaterThanOrEqual(4.5)
    await item.screenshot({ path: test.info().outputPath(`queue-grid-${width}.png`) })
  }
})
