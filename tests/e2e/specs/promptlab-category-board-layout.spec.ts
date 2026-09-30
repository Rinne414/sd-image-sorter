import { expect, test } from '../fixtures/click-ledger'

/**
 * Prompt Lab's category cards share one grid row, which stretches every card
 * to the tallest. The card's own rows used to stretch with it, so short
 * cards spread their header down and blew their tag chips up into tall empty
 * boxes, and long titles (质量 / 元信息) broke one character per line
 * (owner 2026-09-30, DESIGN.md rule 19).
 */

test.use({ viewport: { width: 1366, height: 768 } })

test('category cards keep their chips at one height and their headers on one line', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-sorter-entry-skip-session', '1')
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await page.evaluate(() => (window as any).App.switchView('promptlab'))
  await page.locator('.promptlab-tab[data-mode="build"]').click()
  await expect(page.locator('#promptlab-mode-build')).toBeVisible()

  await page.evaluate(() => {
    const many = Array.from({ length: 18 }, (_, i) => `pose_tag_${i}`)
    const lab = (window as any).PromptLab
    lab.buildCategoryState = {
      classified: {
        tags: [],
        byCategory: {
          character: ['1girl', 'long_hair'],
          outfit: ['shirt'],
          pose: many,
          background: ['on_bed'],
          style: ['doggystyle'],
          quality: ['masterpiece', 'best_quality'],
        },
      },
      checked: new Set(['appearance']),
    }
    // The editor opens once a template image is loaded; show it directly.
    document.getElementById('pl-build-editor')!.style.display = ''
    lab._renderBuildCategoryWorkbench()
  })

  const board = page.locator('#pl-build-category-groups')
  await expect(board).toBeVisible()
  await expect(board.locator('.promptlab-build-category-group')).toHaveCount(6)
  const layout = await board.evaluate((root) => {
    const groups = [...root.querySelectorAll('.promptlab-build-category-group')]
    const chips = [...root.querySelectorAll('.promptlab-build-category-chip')]
    return {
      chipHeights: [...new Set(chips.map((c) => Math.round(c.getBoundingClientRect().height)))],
      headTops: [...new Set(groups.map((g) => Math.round(g.querySelector('.promptlab-build-category-group-head')!.getBoundingClientRect().top)))],
      titleHeights: [...new Set(groups.map((g) => Math.round(g.querySelector('.promptlab-build-category-toggle span')!.getBoundingClientRect().height)))],
    }
  })
  expect(layout.chipHeights).toHaveLength(1)
  expect(layout.chipHeights[0]).toBeGreaterThan(10)
  expect(layout.headTops).toHaveLength(1)
  expect(layout.titleHeights).toHaveLength(1)
  expect(layout.titleHeights[0]).toBeLessThan(30)
})
