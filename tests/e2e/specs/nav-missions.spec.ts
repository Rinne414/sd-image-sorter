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

test('customize offers every view, and the bar follows the order set with the arrows', async ({ page }) => {
  // Owner 2026-09-30: "we already make it customizable, why limit users?"
  // The checklist used to offer 5 of the 8 views and no order.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
  const barOrder = () => page.evaluate(() =>
    [...document.querySelectorAll('.nav-tabs > .nav-tab[data-view]')]
      .filter((tab) => (tab as HTMLElement).offsetParent !== null)
      .map((tab) => (tab as HTMLElement).dataset.view))

  await page.click('#nav-tools-toggle')
  await page.click('#nav-tools-customize')
  const modal = page.locator('#nav-customize-modal')
  await expect(modal.locator('[data-custom-row]')).toHaveCount(10)
  await expect(modal.locator('input[data-custom-view="gallery"]')).toBeDisabled()
  // S3: the Style Map is an advanced tool like Style Finder — offered here too.
  await expect(modal.locator('input[data-custom-view="stylemap"]')).toHaveCount(1)

  await modal.locator('input[data-custom-view="artist"]').check()
  await expect(page.locator('#nav-tab-artist')).toBeVisible()
  // Newly ticked views join the end of the bar (after the six defaults, Style
  // Map included since 2026-09-30); move Style Finder to the front.
  for (let i = 0; i < 5; i += 1) {
    await modal.locator('button[data-custom-view="artist"][data-custom-move="up"]').click()
  }
  await expect(modal.locator('button[data-custom-view="artist"][data-custom-move="up"]')).toBeDisabled()
  expect(await barOrder()).toEqual(['gallery', 'artist', 'reader', 'sorting', 'censor', 'similar', 'stylemap'])

  await page.click('#nav-customize-close')
  await page.reload()
  await expect(page.locator('#view-gallery')).toBeVisible()
  expect(await barOrder()).toEqual(['gallery', 'artist', 'reader', 'sorting', 'censor', 'similar', 'stylemap'])

  await page.click('#nav-tools-toggle')
  await page.click('#nav-tools-customize')
  await page.click('#nav-customize-reset')
  expect(await barOrder()).toEqual(['gallery', 'reader', 'sorting', 'censor', 'similar', 'stylemap'])
})

test('the bar re-measures when its free width shrinks after load, and tools that leave it stay in More', async ({ page }) => {
  // The width ladder only re-measured on window resize, so when the library
  // chip later got a big library's count the last tab slid under the actions
  // with More off screen. Its Reverse Prompt rung also had no CSS rule, and
  // that tool's More entry was hidden as "in the bar".
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('aurora-nav-tabs', JSON.stringify(
      ['gallery', 'artist', 'reverse', 'promptlab', 'dataset', 'similar', 'censor', 'sorting', 'reader']))
  })
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.waitForTimeout(500)
  // What a large library's count does to the chip, after the first measure.
  await page.evaluate(() => {
    const chip = document.getElementById('nav-library-chip')!
    chip.hidden = false
    document.getElementById('nav-library-chip-label')!.textContent = '主图库 · 12853'
  })

  await expect.poll(() => page.evaluate(() => {
    const box = document.querySelector('.nav-tabs')!.getBoundingClientRect()
    return [...document.querySelectorAll('.nav-tabs > .nav-tab[data-view], #nav-tools-toggle')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => el.getBoundingClientRect().right > box.right + 1)
      .map((el) => el.id)
  })).toEqual([])

  await page.click('#nav-tools-toggle')
  for (const view of ['reverse', 'promptlab', 'artist']) {
    if (!(await page.locator(`#nav-tab-${view}`).isVisible())) {
      await expect(page.locator(`#nav-tools-${view}`), view).toBeVisible()
    }
  }
})

test('the nav width check measures final tab widths, not a running transition', async ({ page }) => {
  // Seen at 1366 px after leaving a mission: the debounced re-measure ran
  // while the tabs were still animating, read the old narrow widths, dropped
  // the compact layout, and "More" ended up under the settings button.
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    // The default five tabs fit at 1280 with full labels, so nothing would be
    // compacted. A sixth tab (the user can add 数据集 in "customize") makes
    // the bar need compact labels — the state this check starts from.
    localStorage.setItem('aurora-nav-tabs', JSON.stringify(['gallery', 'reader', 'sorting', 'censor', 'similar', 'dataset']))
  })
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
