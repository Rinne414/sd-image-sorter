import { expect, test } from '../fixtures/click-ledger'

/**
 * Prompt Lab > Random at 1366x768 (owner review 2026-09-30, DESIGN.md rules
 * 17-19). Its own three-column grid kept an empty third column while the
 * output took a full-width second row, and both rows squeezed the tag
 * browser until its category list was gone. Sliders showed only a thumb:
 * their track had the card's colour.
 */

test.use({ viewport: { width: 1366, height: 768 } })

test('the tag browser keeps the full height and the slots and output share the right side', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('promptlab'))
  await page.locator('.promptlab-tab[data-mode="random"]').click()
  await expect(page.locator('#promptlab-mode-random')).toBeVisible()

  const layout = await page.evaluate(() => {
    const box = (sel: string) => document.querySelector(`#promptlab-mode-random ${sel}`)!.getBoundingClientRect()
    const grid = box('.promptlab-random-layout')
    const browser = box('.promptlab-browser')
    const builder = box('.promptlab-builder')
    const output = box('.promptlab-output-panel')
    return {
      browserShare: browser.height / grid.height,
      outputUnderBuilder: Math.abs(output.left - builder.left) < 2 && output.top > builder.bottom,
      rightEdgeUsed: Math.abs(builder.right - grid.right) < 2 && Math.abs(output.right - grid.right) < 2,
    }
  })
  expect(layout.browserShare).toBeGreaterThan(0.95)
  expect(layout.outputUnderBuilder).toBe(true)
  expect(layout.rightEdgeUsed).toBe(true)
})

test('a slider on a card shows a track, not just its thumb', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  const colours = await page.evaluate(() => {
    const card = document.createElement('div')
    card.style.background = 'var(--bg-card)'
    const slider = document.createElement('input')
    slider.type = 'range'
    card.appendChild(slider)
    document.body.appendChild(card)
    const result = { card: getComputedStyle(card).backgroundColor, track: getComputedStyle(slider).backgroundColor }
    card.remove()
    return result
  })
  expect(colours.track).not.toBe(colours.card)
  expect(colours.track).not.toBe('rgba(0, 0, 0, 0)')
})
