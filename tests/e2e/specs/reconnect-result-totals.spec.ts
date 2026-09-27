import { expect, test, type Page } from '../fixtures/click-ledger'

/**
 * Find Moved Files lists every "already in gallery" conflict (V3.5 #16).
 *
 * The result used to carry only the first 10 conflicts, the panel showed 5
 * and counted the list it had (so "10" for 300). Every conflict keeps its
 * own "remove the old record" button now, the group count is the real
 * total, and the other groups say when they show only the first few.
 */

test.describe.configure({ mode: 'serial' })

const SHOT_DIR = '../../.tmp/v35-fix'
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const

function doneProgress(conflictCount: number) {
  const conflicts = Array.from({ length: conflictCount }, (_, index) => ({
    filename: `conflict-${index}.png`,
    old_image_id: 1000 + index,
    old_path: `D:/old/conflict-${index}.png`,
    found_path: `E:/new/conflict-${index}.png`,
    existing_image_id: 5000 + index,
    existing_path: `E:/new/conflict-${index}.png`,
  }))
  const updated = Array.from({ length: 10 }, (_, index) => ({
    image_id: 200 + index,
    filename: `moved-${index}.png`,
    old_path: `D:/old/moved-${index}.png`,
    new_path: `E:/new/moved-${index}.png`,
  }))
  return {
    status: 'done',
    matched: 40,
    conflicts: conflictCount,
    result: {
      matched: 40,
      conflicts: conflictCount,
      still_missing: 0,
      missing_total: 40 + conflictCount,
      library_missing_total: 40 + conflictCount,
      updated,
      needs_review: [],
      conflict_samples: conflicts,
      still_missing_samples: [],
      recent_errors: [],
    },
  }
}

async function showResult(page: Page, conflictCount: number) {
  await page.addInitScript(() => localStorage.setItem('sd-image-sorter-lang', 'zh-CN'))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1'
    && typeof (window as any)._renderReconnectResultPanel === 'function')
  await page.evaluate((progress) => {
    const w = window as any
    w.showModal('reconnect-modal')
    w._renderReconnectResultPanel(progress)
  }, doneProgress(conflictCount))
  await expect(page.locator('#reconnect-result-panel')).toBeVisible()
}

test('every conflict is listed with its own remove button and the real total', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await showResult(page, 23)

  const panel = page.locator('#reconnect-result-panel')
  const conflictGroup = panel.locator('details').filter({ has: page.locator('[data-reconnect-remove-id]') })
  await expect(conflictGroup.locator('summary span')).toHaveText('23')
  await expect(panel.locator('[data-reconnect-remove-id]')).toHaveCount(23)
  await expect(panel.locator('[data-reconnect-remove-id="1022"]')).toHaveCount(1)

  // The reconnected group holds 10 examples of 40 and says so.
  const updatedGroup = panel.locator('details').first()
  await expect(updatedGroup.locator('summary span')).toHaveText('40')
  await expect(updatedGroup).toContainText('只列出前 5 条，共 40 条。')

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport)
    const lastButton = panel.locator('[data-reconnect-remove-id="1022"]')
    await lastButton.scrollIntoViewIfNeeded()
    await expect(lastButton).toBeInViewport()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
    await page.screenshot({ path: `${SHOT_DIR}/reconnect-conflicts-${viewport.width}.png` })
  }
})
