import { expect, test } from '../fixtures/click-ledger'

/**
 * Owner 2026-09-30: the gallery toolbar (count, generator tabs, view, search)
 * stays pinned under the top bar while the grid scrolls. It used to scroll
 * away with no way back but scrolling. The comfort-room rule that makes every
 * gallery child position:relative must not take its sticky away.
 */

for (const [width, height] of [[1366, 768], [1920, 1080]] as const) {
  test(`the toolbar stays under the top bar and usable while the grid scrolls at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.addInitScript(() => {
      localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
      localStorage.setItem('sd-sorter-entry-skip-session', '1')
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })

    // Room to scroll however few fixture images the library has.
    await page.evaluate(() => {
      const spacer = document.createElement('div')
      spacer.style.height = '4000px'
      document.querySelector('#view-gallery .gallery-container')!.appendChild(spacer)
    })
    await page.mouse.move(width / 2, height / 2)
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(1000)

    // The view slides up as it enters (160ms); measure the pinned position
    // once the view's own animations have ended. A cancelled one (its class
    // dropped mid-way) has stopped moving the view as well.
    await page.evaluate(() => Promise.all(
      document.getElementById('view-gallery')!.getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ))

    const layout = await page.evaluate(() => ({
      toolbarTop: Math.round(document.getElementById('gallery-toolbar')!.getBoundingClientRect().top),
      navBottom: Math.round(document.querySelector('.nav-bar')!.getBoundingClientRect().bottom),
    }))
    expect(Math.abs(layout.toolbarTop - layout.navBottom)).toBeLessThanOrEqual(1)

    const search = page.locator('#gallery-search-input')
    await search.click({ timeout: 5_000 })
    await expect(search).toBeFocused()
  })
}

/**
 * The 8px gap the test above once measured was the view entering twice:
 * comfort-app drops comfort-room-enter-active 320ms after a switch, and the
 * animation then fell back to .view.active's uiRefreshEnter, replaying a
 * slide from opacity 0. A room plays its comfort enter once and stays put.
 */
test('a room view enters once: nothing replays after the comfort enter ends', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#gallery-grid .gallery-item').first()).toBeVisible({ timeout: 20_000 })

  await page.evaluate(() => (window as any).switchView('censor'))
  await expect(page.locator('#view-censor.active')).toBeVisible()
  // The enter class is added synchronously by the switch and dropped 320ms
  // later; read it in the same evaluate so a busy machine cannot miss it.
  const enteredWithClass = await page.evaluate(() => {
    ;(window as any).switchView('gallery')
    return document.getElementById('view-gallery')!.classList.contains('comfort-room-enter-active')
  })
  expect(enteredWithClass).toBe(true)
  const view = page.locator('#view-gallery.active')
  await expect(view).not.toHaveClass(/comfort-room-enter-active/)

  const settled = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('view-gallery')!)
    return { animationName: style.animationName, opacity: style.opacity }
  })
  expect(settled).toEqual({ animationName: 'none', opacity: '1' })
})
