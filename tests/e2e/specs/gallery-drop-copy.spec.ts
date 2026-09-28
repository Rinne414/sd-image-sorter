import { expect, test, type Page } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * Dropping image files on the gallery asks before copying them (V3.5 3-8).
 *
 * The browser never shares a dropped file's path, so the app copies it into
 * its own imports folder. That used to happen silently; now a dialog says the
 * files are copied, the originals stay untouched, and "Import Images" keeps
 * them in place. Cancel copies nothing.
 */

test.describe.configure({ mode: 'serial' })

const SHOT_DIR = '../../.tmp/v35-fix'
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

async function openGallery(page: Page, importCalls: string[]) {
  await page.route('**/api/import-files', async (route) => {
    importCalls.push(route.request().method())
    await route.fulfill({ json: { imported: 2, errors: 0 } })
  })
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('gallery'))
  await expect(page.locator('#view-gallery')).toBeVisible()
}

async function dropTwoImages(page: Page) {
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    for (const name of ['drop-a.png', 'drop-b.png']) {
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' }))
    }
    return transfer
  })
  await page.locator('#view-gallery').dispatchEvent('drop', { dataTransfer })
}

test('dropping images asks first and Cancel copies nothing', async ({ page }) => {
  const importCalls: string[] = []
  await page.setViewportSize({ width: 1366, height: 768 })
  await openGallery(page, importCalls)

  await dropTwoImages(page)

  const dialog = page.locator('#confirm-modal.visible')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#confirm-title')).toHaveText('把 2 张图片复制进图库？')
  await expect(dialog.locator('#confirm-message')).toContainText('原文件留在原处，不会被改动')
  await expect(dialog.locator('#confirm-message')).toContainText('「导入图片」')
  for (const viewport of VIEWPORTS) {
    await resizeAndSettleUiScale(page, viewport)
    await expect(dialog.locator('#btn-confirm-ok')).toBeInViewport()
    await expect(dialog.locator('#btn-confirm-cancel')).toBeInViewport()
    await page.screenshot({ path: `${SHOT_DIR}/gallery-drop-copy-${viewport.width}.png` })
  }

  await dialog.locator('#btn-confirm-cancel').click()
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(importCalls).toEqual([])
})

test('choosing to copy imports the dropped images', async ({ page }) => {
  const importCalls: string[] = []
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openGallery(page, importCalls)

  await dropTwoImages(page)
  await page.locator('#confirm-modal.visible #btn-confirm-ok').click()

  await expect.poll(() => importCalls.length).toBe(1)
  await expect(page.locator('#toast-container')).toContainText('已导入 2 张图片到图库')
})
