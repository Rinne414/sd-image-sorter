import { expect, test } from '../fixtures/click-ledger'

/**
 * Settings > Where saves go (owner decisions 2026-10-04).
 *
 * Saves whose folder field is left empty go to the program's own output
 * folder; Settings can move that root, and every save flow follows it.
 * Video censoring now defaults there too (it used to write a "censored"
 * folder into the user's library) and remembers its folders.
 */

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1366, height: 768 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
})

test.afterEach(async ({ request }) => {
  await request.patch('/api/output-folders', { data: { root: '' } })
})

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#model-manager-modal.visible')).toBeVisible()
}

test('Settings moves where empty-folder saves go, and Reset brings it back', async ({ page }) => {
  await openSettings(page)
  const current = page.locator('#settings-output-root-current')
  const field = page.locator('#settings-output-root')
  await expect(current).toHaveText(/^Saves with an empty folder field go to .*output$/)
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('placeholder', /^Empty = .*output$/)

  const custom = test.info().outputPath('custom-saves')
  await field.fill(custom)
  await field.press('Enter')

  await expect(page.locator('#toast-container .toast.success', { hasText: 'Save folder updated' })).toBeVisible()
  await expect(current).toContainText(custom)
  const folders = await page.evaluate(async () => (await (await fetch('/api/output-folders')).json()).folders)
  expect(String(folders.censor).toLowerCase()).toContain(custom.toLowerCase())
  expect(String(folders.publish).toLowerCase()).toContain(custom.toLowerCase())

  await page.locator('#btn-settings-output-root-reset').click()
  await expect(field).toHaveValue('')
  await expect(current).toHaveText(/output$/)
})

test('an invalid folder is refused and the current folder stays', async ({ page }) => {
  await openSettings(page)
  const current = page.locator('#settings-output-root-current')
  await expect(current).toHaveText(/output$/)

  await page.locator('#settings-output-root').fill('bad<name>|here')
  await page.locator('#settings-output-root').press('Enter')

  await expect(page.locator('#toast-container .toast.error')).toBeVisible()
  await expect(current).toHaveText(/output$/)
  await expect(page.locator('#settings-output-root')).toHaveValue('')
})

test('Browse opens the folder browser under the row', async ({ page }) => {
  await openSettings(page)

  await page.locator('#btn-settings-output-root-browse').click()

  await expect(page.locator('#settings-output-root-browser')).not.toBeEmpty()
  await expect(page.locator('#settings-output-root-browser')).toBeVisible()
})

test('video censoring says where it saves and brings back the last folders', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('media_censor_source_folder', 'L:/gif-source')
    localStorage.setItem('media_censor_output_folder', 'L:/gif-out')
  })
  await page.route('**/api/censor/media/list**', async (route) => {
    await route.fulfill({ json: { gifs: ['L:/gif-source/a.gif'], videos: [], video_ready: false } })
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('censor'))
  await page.locator('#btn-media-censor-open').click()

  await expect(page.locator('#media-censor-folder')).toHaveValue('L:/gif-source')
  await expect(page.locator('#media-censor-output')).toHaveValue('L:/gif-out')
  await page.locator('#media-censor-output').fill('')
  await expect(page.locator('#media-censor-output')).toHaveAttribute('placeholder', /video-censor/)
})

test('in Chinese the refused folder and the rating filters read in Chinese', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await openSettings(page)
  await page.locator('#settings-output-root').fill('bad<name>|here')
  await page.locator('#settings-output-root').press('Enter')
  const error = page.locator('#toast-container .toast.error .toast-message').last()
  await expect(error).toBeVisible()
  const message = await error.textContent()
  expect(message).toMatch(/[一-鿿]/)
  expect(message).not.toMatch(/[A-Za-z]{4,}/)

  await expect(page.locator('#modal-rating-filters .checkbox-text').first()).toHaveText('普通', { useInnerText: false })
})
