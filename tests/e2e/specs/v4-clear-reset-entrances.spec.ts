import { expect, test, type Page } from '../fixtures/click-ledger'

import { markModelsReady } from '../fixtures/model-status'
import { pageOverflow, VIEWPORTS } from '../fixtures/v4-seed'

/**
 * Two entrances Vopus lacked (docs/feature-entrances.json): "Clear current
 * library…" on the library page (owner, 2026-10-22: visible there, plus the
 * Settings entrance) and "Reset all settings" in Settings › Appearance (owner
 * answer 5.A). Clearing opens the same check and question as Settings ›
 * Library and starts on Cancel; nothing is cleared here.
 *
 * Needs the V4 build: `cd frontend-v4 && npm run build`.
 */

async function openAt(page: Page, hash: string, lang: 'en' | 'zh-CN' = 'en') {
  await page.addInitScript((language) => {
    const flag = 'v4clearreset-init-' + language
    if (sessionStorage.getItem(flag)) return
    sessionStorage.setItem(flag, '1')
    localStorage.setItem('sd-image-sorter-lang', language)
    localStorage.setItem('sd-v4-theme', 'dark')
    localStorage.setItem('sd-v4-update-autocheck', '0')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  }, lang)
  const res = await page.goto(`/vopus/${hash}`, { waitUntil: 'domcontentloaded' })
  expect(res?.status(), 'V4 is not built: run npm run build in frontend-v4').toBe(200)
}

test.beforeEach(async ({ page }) => markModelsReady(page))

for (const viewport of VIEWPORTS) {
  test(`Clear current library is on the library page at ${viewport.width}x${viewport.height} in both languages`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const [lang, label] of [['en', 'Clear current library…'], ['zh-CN', '清空当前图库…']] as const) {
      await page.goto('about:blank')
      await openAt(page, '#/library', lang)
      const line = page.getByTestId('rail-clear-library')
      await expect(line).toHaveText(label)
      await line.scrollIntoViewIfNeeded()
      await expect(line).toBeInViewport()
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
    }
  })
}

test('Clear current library asks with the library name, starting on Cancel, and clears nothing when cancelled', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openAt(page, '#/library')
  const before = await page.evaluate(async () => (await (await fetch('/api/libraries')).json()).libraries.find((l: { id: string }) => l.id === 'main').image_count)
  await page.getByTestId('rail-clear-library').click()
  await expect(page).toHaveURL(/#\/settings\/library/)
  const dialog = page.getByTestId('clear-index-dialog')
  // it checks for running work first ("Checking…"), which takes a while on a large library
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toContainText('Main library')
  await page.keyboard.press('Enter') // Cancel has the focus
  await expect(dialog).toHaveCount(0)
  const after = await page.evaluate(async () => (await (await fetch('/api/libraries')).json()).libraries.find((l: { id: string }) => l.id === 'main').image_count)
  expect(after).toBe(before)
})

test('Vopus Settings has Reset all settings: asks first, then resets preferences and keeps the work', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openAt(page, '#/settings/appearance')
  await page.evaluate(() => {
    localStorage.setItem('sd-v4-ui-scale', '1.3')
    localStorage.setItem('sd-v4-saved-searches', '{"main":[{"id":"x","name":"mine","query":"smile"}]}')
  })
  await page.getByTestId('reset-all-open').click()
  const dialog = page.getByTestId('reset-all-dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Enter') // Cancel has the focus
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-ui-scale'))).toBe('1.3')

  await page.getByTestId('reset-all-open').click()
  await page.getByTestId('reset-all-ok').click()
  await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sd-v4-ui-scale'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('sd-v4-saved-searches'))).toContain('mine')
})
