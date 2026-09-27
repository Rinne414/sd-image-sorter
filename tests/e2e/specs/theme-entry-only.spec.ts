import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * The colour theme is chosen on the entry page or in Settings (V3.5 subtraction 3).
 *
 * The top bar's palette icon repeated Settings › Colour theme. It is gone;
 * the entry page's theme button still opens the same picker, anchored to
 * itself, and the Settings select still switches the theme.
 */

test.describe.configure({ mode: 'serial' })

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

async function openGallery(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-image-sorter-theme', 'graphite')
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await expect(page.locator('#view-gallery')).toBeVisible()
}

const currentTheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'))

test('the top bar has no palette icon and keeps its other buttons in view', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openGallery(page)

  await expect(page.locator('#btn-theme-toggle')).toHaveCount(0)
  await expect(page.locator('.nav-actions [aria-controls="theme-menu"]')).toHaveCount(0)
  await expect(page.locator('#theme-menu')).toHaveAttribute('aria-labelledby', 'entry-theme-btn')

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    for (const id of ['#btn-open-model-manager', '#btn-language-toggle', '#btn-app-update', '#btn-help', '#btn-scan', '#btn-tag']) {
      await expect(page.locator(id)).toBeInViewport()
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  }
})

test('the entry page theme button opens the picker under itself and switches the theme', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await openGallery(page)
  await page.evaluate(() => (window as any).EntryPage.show())

  const button = page.locator('#entry-theme-btn')
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('aria-label', '配色')
  await button.click()

  const menu = page.locator('#theme-menu')
  await expect(menu).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const placement = await page.evaluate(() => {
    const anchor = document.getElementById('entry-theme-btn')!.getBoundingClientRect()
    const picker = document.getElementById('theme-menu')!.getBoundingClientRect()
    return { below: picker.top >= anchor.bottom, rightEdgeGap: Math.abs(picker.right - anchor.right) }
  })
  expect(placement.below).toBe(true)
  expect(placement.rightEdgeGap).toBeLessThanOrEqual(1)
  for (const choice of ['graphite', 'ink', 'dusk']) {
    await expect(menu.locator(`[data-theme-id="${choice}"]`)).toBeInViewport()
  }

  await menu.locator('[data-theme-id="ink"]').click()
  await expect(menu).toBeHidden()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  expect(await currentTheme(page)).toBe('ink')
  expect(await page.evaluate(() => localStorage.getItem('sd-image-sorter-theme'))).toBe('ink')

  // Escape and an outside click both close it.
  await button.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
})

test('Settings › colour theme still switches the theme', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openGallery(page)

  await page.locator('#btn-open-model-manager').click()
  await page.locator('[data-settings-tab="general"]').click()
  const select = page.locator('#settings-theme')
  await expect(select).toBeVisible()
  await expect(select).toHaveValue('graphite')
  await select.selectOption('dusk')
  expect(await currentTheme(page)).toBe('dusk')
  expect(await page.evaluate(() => localStorage.getItem('sd-image-sorter-theme'))).toBe('dusk')
})
