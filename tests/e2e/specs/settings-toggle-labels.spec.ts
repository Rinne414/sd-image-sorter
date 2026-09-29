import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Settings on/off buttons must say what is actually set.
 *
 * The labels carry a data-i18n key, and ui-refresh re-applies every key on
 * any DOM change. A handler that only rewrote the text was reverted a frame
 * later, so "Entry page" read "On" while the entry page was off (and the
 * ★5 cover / zen buttons the same way). The key has to move with the words.
 */

async function openSettings(page: Page, skipEntry: boolean) {
  await page.addInitScript((skip) => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('aurora-entry-skip', skip ? '1' : '0')
  }, skipEntry)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).EntryPage?.hide?.())
  await page.locator('#btn-open-model-manager').click()
  await expect(page.locator('#btn-settings-entry-toggle')).toBeVisible()
}

const reapplyTranslations = (page: Page) =>
  page.evaluate(() => (window as any).UIRefresh.applyTranslations())

test('the entry page toggle reads Off when the entry page is off, after translations re-apply', async ({ page }) => {
  await openSettings(page, true)
  await reapplyTranslations(page)

  await expect(page.locator('#btn-settings-entry-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#settings-entry-label')).toHaveText('关')
})

test('turning the ★5 cover and zen mode on or off keeps the label in step', async ({ page }) => {
  await openSettings(page, true)

  await page.locator('#btn-settings-entry-hero-toggle').click()
  const heroPressed = await page.locator('#btn-settings-entry-hero-toggle').getAttribute('aria-pressed')
  await reapplyTranslations(page)
  await expect(page.locator('#settings-entry-hero-label')).toHaveText(heroPressed === 'true' ? '开' : '关')

  await page.locator('#btn-settings-comfort-zen').click()
  await expect(page.locator('#btn-settings-comfort-zen')).toHaveAttribute('aria-pressed', 'true')
  await reapplyTranslations(page)
  await expect(page.locator('#settings-comfort-zen-label')).toHaveText('开')
  await page.locator('#btn-settings-comfort-zen').click()
})
