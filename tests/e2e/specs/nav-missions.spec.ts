import { expect, test } from '../fixtures/click-ledger'

/**
 * Mission-scoped smart nav bar + customizable tab visibility
 * (owner 2026-07-07, modules/nav-missions.js).
 *
 * The suite storageState skips the entry page, so these tests land straight
 * in the gallery with the DEFAULT tab set (dataset tucked). Entry-tile
 * mission integration is covered in entry-page.spec.ts; here the module API
 * drives mission mode directly.
 */

test.describe('Nav — customizable tabs and mission mode', () => {
  test('dataset is tucked by default and its More mirror reaches the view', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()

    await expect(page.locator('#nav-tab-dataset')).toBeHidden()
    await page.click('#nav-tools-toggle')
    const mirror = page.locator('#nav-tools-dataset')
    await expect(mirror).toBeVisible()
    // 成套发布 left the menu; the customize entry replaced it.
    await expect(page.locator('#nav-tools-publish-set')).toHaveCount(0)
    await expect(page.locator('#nav-tools-customize')).toBeVisible()

    await mirror.click()
    await expect(page.locator('#view-dataset')).toHaveClass(/active/)
    // Contextual reveal: the open view's tab shows even while tucked from
    // the base set, so the bar always has a highlighted tab.
    await expect(page.locator('#nav-tab-dataset')).toBeVisible()
  })

  test('mission mode scopes the bar with step badges; chip exit restores it', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()

    await page.evaluate(() => (window as any).NavMissions.enter('pixiv'))
    await expect(page.locator('#nav-mission-chip')).toBeVisible()
    await expect(page.locator('#nav-tab-gallery')).toBeVisible()
    await expect(page.locator('#nav-tab-censor')).toBeVisible()
    await expect(page.locator('#nav-tab-reader')).toBeHidden()
    await expect(page.locator('#nav-tab-sorting')).toBeHidden()
    // Pipeline step numbers (1 → 2) render inside the mission tabs.
    await expect(page.locator('#nav-tab-gallery .nav-step-badge')).toHaveText('1')
    await expect(page.locator('#nav-tab-censor .nav-step-badge')).toHaveText('2')

    // Mission survives a reload (localStorage), like the owner's "the bar is
    // what I'm doing" mental model.
    await page.reload()
    await expect(page.locator('#nav-mission-chip')).toBeVisible()
    await expect(page.locator('#nav-tab-reader')).toBeHidden()

    await page.click('#nav-mission-exit')
    await expect(page.locator('#nav-mission-chip')).toBeHidden()
    await expect(page.locator('#nav-tab-reader')).toBeVisible()
    await expect(page.locator('#nav-tab-gallery .nav-step-badge')).toHaveCount(0)
    expect(await page.evaluate(() => window.localStorage.getItem('aurora-nav-mission'))).toBeNull()
  })

  test('customize checklist persists across reloads and resets to defaults', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#view-gallery')).toBeVisible()

    await page.click('#nav-tools-toggle')
    await page.click('#nav-tools-customize')
    await expect(page.locator('#nav-customize-modal.visible')).toBeVisible()

    // Add dataset to the bar, drop reader from it.
    await page.check('#nav-customize-modal [data-custom-view="dataset"]')
    await page.uncheck('#nav-customize-modal [data-custom-view="reader"]')
    await expect(page.locator('#nav-tab-dataset')).toBeVisible()
    await expect(page.locator('#nav-tab-reader')).toBeHidden()

    await page.click('#nav-customize-close')
    await page.reload()
    await expect(page.locator('#nav-tab-dataset')).toBeVisible()
    await expect(page.locator('#nav-tab-reader')).toBeHidden()
    // The dropped view stays reachable through its mirror.
    await page.click('#nav-tools-toggle')
    await expect(page.locator('#nav-tools-reader')).toBeVisible()

    await page.click('#nav-tools-customize')
    await page.click('#nav-customize-reset')
    await expect(page.locator('#nav-tab-reader')).toBeVisible()
    await expect(page.locator('#nav-tab-dataset')).toBeHidden()
  })
})

test('the nav width check measures final tab widths, not a running transition', async ({ page }) => {
  // Seen at 1366 px after leaving a mission: the debounced re-measure ran
  // while the tabs were still animating, read the old narrow widths, dropped
  // the compact layout, and "More" ended up under the settings button.
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
  await page.click('#nav-tab-censor')
  await expect(page.locator('#view-censor')).toHaveClass(/active/)
  await page.waitForTimeout(400)
  expect(await page.locator('.nav-bar').getAttribute('class')).toContain('nav-tabs-compact-labels')

  // A slow transition makes "re-measure mid-animation" deterministic.
  await page.addStyleTag({ content: '.nav-bar .nav-tab, .nav-bar .nav-tab * { transition: all 2s linear !important; }' })
  const layout = await page.evaluate(async () => {
    const nav = document.querySelector('.nav-bar')!
    nav.classList.remove('nav-tabs-compact-labels') // tabs start growing
    ;(window as any).updateNavigationOverflowState() // re-measure right away
    await new Promise((resolve) => setTimeout(resolve, 2300))
    const tabs = document.querySelector('.nav-tabs') as HTMLElement
    const more = document.getElementById('nav-tools-toggle')!.getBoundingClientRect()
    const gear = document.getElementById('btn-open-model-manager')!.getBoundingClientRect()
    return { overflow: tabs.scrollWidth - tabs.clientWidth, moreRight: more.right, gearLeft: gear.left }
  })
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.moreRight).toBeLessThanOrEqual(layout.gearLeft)
})

test('a mission shows its steps once, marks where you are, and the chip reopens them', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()

  await page.evaluate(() => (window as any).NavMissions.enter('pixiv'))
  const panel = page.locator('#nav-mission-steps')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.nav-mission-step')).toHaveCount(4)
  await expect(panel.locator('.nav-mission-step.is-here')).toHaveCount(1)
  await expect(panel.locator('.nav-mission-step').first()).toHaveClass(/is-here/)
  await expect(panel).toBeInViewport()

  // Esc closes the panel and does not jump to the entry page.
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(page.locator('#entry-page')).toBeHidden()

  // In Censor Edit, steps 2-4 are the ones here.
  await page.click('#nav-tab-censor')
  await page.click('#nav-mission-chip-label')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.nav-mission-step.is-here')).toHaveCount(3)
  await expect(page.locator('#nav-mission-chip-label')).toHaveAttribute('aria-expanded', 'true')

  // A click elsewhere closes it; leaving the mission hides everything.
  await page.mouse.click(900, 640)
  await expect(panel).toBeHidden()
  await page.click('#nav-mission-exit')
  await expect(page.locator('#nav-mission-chip')).toBeHidden()
})
