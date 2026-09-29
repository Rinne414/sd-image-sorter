import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * One colour palette (owner 2026-09-30: "make one good one instead of keeping
 * three that are only slightly different").
 *
 * Black + Blue and Dusk are gone, and with them every picker. A browser that
 * still remembers one of them must open on the single neutral palette rather
 * than on a half-styled leftover.
 */

async function openWithSavedTheme(page: Page, saved: string) {
  await page.addInitScript((theme) => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-image-sorter-theme', theme)
  }, saved)
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
}

const canvasChannels = (page: Page) => page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  document.body.appendChild(probe)
  const rgb = getComputedStyle(probe).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)
  probe.remove()
  return rgb
})

for (const saved of ['dusk', 'ink']) {
  test(`a remembered "${saved}" theme opens on the one neutral palette`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    await openWithSavedTheme(page, saved)

    const [r, g, b] = await canvasChannels(page)
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull()
  })
}

test('no colour-theme picker is offered anywhere', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await openWithSavedTheme(page, 'graphite')

  await expect(page.locator('#theme-menu, #entry-theme-btn, #settings-theme, [data-theme-id]')).toHaveCount(0)
  expect(await page.evaluate(() => typeof (window as any).Theme)).toBe('undefined')

  await page.evaluate(() => (window as any).EntryPage.show())
  await expect(page.locator('#entry-lang-btn')).toBeVisible()
  await expect(page.locator('#entry-update-btn')).toBeVisible()
})
