import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * The keyboard shortcuts panel lists the keys the handlers actually bind.
 * It said C for the censor clone tool (the key is G) and Space for the
 * gallery's selection mode (the key is S), and left out P, R, D, H and the
 * gallery view keys.
 */

async function openPanel(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'en')
    localStorage.setItem('aurora-entry-skip', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).KeyboardShortcutsPanel.show())
  await expect(page.locator('#keyboard-shortcuts-panel')).toHaveClass(/visible/)
}

const keyFor = (page: Page, description: RegExp) => page
  .locator('#keyboard-shortcuts-panel .shortcut-item', { hasText: description })
  .locator('.shortcut-key')

test('the panel names the keys the handlers bind', async ({ page }) => {
  await openPanel(page)

  await expect(keyFor(page, /clone/i)).toHaveText('G')
  await expect(keyFor(page, /pen tool/i)).toHaveText('P')
  await expect(keyFor(page, /remove the background/i)).toHaveText('R')
  await expect(keyFor(page, /detect/i)).toHaveText('D')
  await expect(keyFor(page, /selection mode/i)).toHaveText('S')
  await expect(keyFor(page, /filter editor/i)).toHaveText('F')
})
