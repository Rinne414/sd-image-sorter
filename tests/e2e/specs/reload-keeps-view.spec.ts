import { expect, test, type Page } from '@playwright/test'

/**
 * Reloading the page used to send the user back to the Gallery from wherever
 * they were. A reload now returns to the same page. Opening the program fresh
 * still follows the entry page's own rule, and a link with ?view= still wins.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const activeView = (page: Page) => page.locator('.nav-bar').getAttribute('data-view')

async function start(page: Page, url = '/', skipEntry = true) {
  await page.addInitScript((skip) => {
    localStorage.setItem('aurora-entry-skip', skip ? '1' : '0')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  }, skipEntry)
  await page.goto(url)
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
}

test('a reload on Organize stays on Organize', async ({ page }) => {
  await start(page)
  await page.locator('#nav-tab-sorting').click()
  await expect(page.locator('#view-sorting')).toHaveClass(/active/)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await expect(page.locator('#view-sorting')).toHaveClass(/active/)
  expect(await activeView(page)).toBe('sorting')
})

test('opening the address fresh still starts on the Gallery', async ({ page }) => {
  await start(page)
  await page.locator('#nav-tab-sorting').click()
  await expect(page.locator('#view-sorting')).toHaveClass(/active/)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  expect(await activeView(page)).toBe('gallery')
})

test('a ?view= link wins over the remembered page', async ({ page }) => {
  await start(page)
  await page.locator('#nav-tab-sorting').click()
  await expect(page.locator('#view-sorting')).toHaveClass(/active/)
  await page.goto('/?ui=classic&view=reader')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  expect(await activeView(page)).toBe('reader')
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  expect(await activeView(page)).toBe('reader')
})

test('a reload on the entry page stays on the entry page', async ({ page }) => {
  await start(page, '/', false)
  await expect(page.locator('body.entry-active')).toHaveCount(1)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await expect(page.locator('body.entry-active')).toHaveCount(1)
})

test('a reload after leaving the entry page for Organize returns to Organize, not the entry page', async ({ page }) => {
  await start(page, '/', false)
  await expect(page.locator('body.entry-active')).toHaveCount(1)
  await page.evaluate(() => (window as any).App.switchView('sorting'))
  await page.evaluate(() => (window as any).EntryPage.hide())
  await expect(page.locator('body.entry-active')).toHaveCount(0)
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await expect(page.locator('body.entry-active')).toHaveCount(0)
  expect(await activeView(page)).toBe('sorting')
})
