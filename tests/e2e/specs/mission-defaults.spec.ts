import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/click-ledger'

/**
 * Mission-aware defaults (owner 2026-10-05): the Gallery batch bar leads with
 * the mission's next step, Pixiv sets default to leaving uncensored pictures
 * out, the censor review counter follows queue reorders, and the censor save
 * toast keeps its "Open folder" action until dismissed.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#7a93b8"/>
</svg>
`.trim()

const IMAGES = [9801, 9802, 9803, 9804].map((id) => ({
  id, filename: `mission-${id}.png`, path: `L:/mission-${id}.png`, width: 64, height: 64,
}))

async function mockBackend(page: Page): Promise<void> {
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
    await route.fulfill({ json: { images: IMAGES.map((i) => ({ ...i, prompt: '', tags: [] })), missing_ids: [] } })
  })
}

async function sendAllToCensor(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('#btn-toggle-select').click()
  for (const image of IMAGES) {
    await page.locator(`#gallery-grid .gallery-item[data-id="${image.id}"]`).click()
  }
  await page.locator('#btn-send-to-censor').click()
  await expect(page.locator('#view-censor.active')).toBeVisible()
  await expect(page.locator('#censor-queue-list .queue-thumb-v2')).toHaveCount(IMAGES.length)
}

test('the batch bar leads with the mission step and the More menu keeps every other entry', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()

  const state = () => page.evaluate(() => {
    const bar = document.querySelector('#gallery-action-bar .gallery-action-bar-buttons') as HTMLElement
    const menu = document.getElementById('gallery-action-more-menu') as HTMLElement
    const dataset = document.getElementById('btn-send-selection-to-dataset-maker') as HTMLElement
    return {
      primary: Array.from(document.querySelectorAll('#gallery-action-bar .btn-primary')).map((b) => b.id),
      datasetInBar: dataset.parentElement === bar,
      datasetInMenu: dataset.parentElement === menu,
      menuIds: Array.from(menu.querySelectorAll('button')).map((b) => b.id),
      datasetCount: document.querySelectorAll('#btn-send-selection-to-dataset-maker').length,
    }
  })

  const base = await state()
  expect(base.primary).toEqual(['btn-move-selected'])
  expect(base.datasetInMenu).toBe(true)

  await page.evaluate(() => (window as any).NavMissions.enter('lora'))
  const lora = await state()
  expect(lora.primary).toEqual(['btn-send-selection-to-dataset-maker'])
  expect(lora.datasetInBar).toBe(true)
  expect(lora.datasetCount).toBe(1)
  expect(lora.menuIds).not.toContain('btn-send-selection-to-dataset-maker')
  expect(lora.menuIds.length).toBe(base.menuIds.length - 1)

  await page.evaluate(() => (window as any).NavMissions.enter('pixiv'))
  const pixiv = await state()
  expect(pixiv.primary).toEqual(['btn-send-to-censor'])
  expect(pixiv.datasetInMenu).toBe(true)
  expect(pixiv.menuIds).toEqual(base.menuIds)

  await page.evaluate(() => (window as any).NavMissions.enter('organize'))
  expect((await state()).primary).toEqual(['btn-move-selected'])

  await page.evaluate(() => (window as any).NavMissions.enter('lora'))
  await page.reload()
  await expect(page.locator('#btn-send-selection-to-dataset-maker')).toHaveClass(/btn-primary/)
  await page.evaluate(() => (window as any).NavMissions.exit())
  expect((await state()).primary).toEqual(['btn-move-selected'])
})

test('the Save dialog leaves unedited pictures out by default only in the Pixiv mission', async ({ page }) => {
  await mockBackend(page)
  await sendAllToCensor(page)

  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  await expect(page.locator('#save-unedited-option')).toHaveValue('include')
  await page.evaluate(() => document.getElementById('save-options-modal')!.classList.remove('visible'))

  await page.evaluate(() => (window as any).NavMissions.enter('pixiv'))
  await page.locator('#btn-save-all-processed').click()
  await expect(page.locator('#save-options-modal.visible')).toBeVisible()
  await expect(page.locator('#save-unedited-option')).toHaveValue('skip')
  // The user can still change it inside the dialog.
  await page.locator('#save-unedited-option').selectOption('include')
  await expect(page.locator('#save-unedited-option')).toHaveValue('include')
})

test('the review counter follows the active picture after Move to top', async ({ page }) => {
  await mockBackend(page)
  await sendAllToCensor(page)

  const lastId = IMAGES[IMAGES.length - 1].id
  await page.locator(`#censor-queue-list .queue-thumb-v2[data-id="${lastId}"]`).click()
  await expect.poll(() => page.evaluate(() => (window as any).__CENSOR_STATE__?.activeId)).toBe(lastId)
  await page.evaluate(() => (window as any).updateCensorReviewPanel?.())
  await expect(page.locator('#censor-review-progress')).toContainText('4 / 4')

  await page.locator('#btn-queue-move-top').click()
  await expect(page.locator('#censor-review-progress')).toContainText('1 / 4')
})

test('a persistent toast stays until its action or a click dismisses it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.evaluate(() => {
    (window as any).App.showToast('kept toast', 'success', {
      actionLabel: 'Open folder', onAction: () => { (window as any).__acted = true }, duration: 300, persistent: true,
    })
    ;(window as any).App.showToast('plain toast', 'success', { duration: 300 })
  })
  await expect(page.locator('#toast-container .toast', { hasText: 'plain toast' })).toHaveCount(0, { timeout: 3000 })
  await expect(page.locator('#toast-container .toast', { hasText: 'kept toast' })).toBeVisible()
  await page.locator('#toast-container .toast-action-btn', { hasText: 'Open folder' }).click()
  expect(await page.evaluate(() => (window as any).__acted)).toBe(true)
  await expect(page.locator('#toast-container .toast', { hasText: 'kept toast' })).toHaveCount(0)
})

test('the censor save success toast asks for a persistent Open folder action', async ({ page }) => {
  const source = await (await page.request.get('/static/js/censor/save.js')).text()
  expect(source).toMatch(/onAction: \(\) => revealCensorSavedFile\(lastSavedPath\),\s*persistent: true/)
})
