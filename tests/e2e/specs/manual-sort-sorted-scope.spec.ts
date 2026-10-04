import { expect, test, type Page } from '../fixtures/click-ledger'
import { resizeAndSettleUiScale } from '../fixtures/ui-scale'

/**
 * "Auto-sort first, hand-sort the rest" (walkthrough of 批量整理):
 * - the Manual Sort setup count leaves out pictures Auto-Separate or an
 *   earlier sort already copied/moved, says how many, and one click includes
 *   them again (the choice is remembered and reaches /api/sort/start);
 * - undo says which picture it took back, and the hint bar names redo.
 */

const SORTED_IMAGE = { id: 930042, filename: '00042.png', path: 'C:/sorted-scope-spec/00042.png' }

function activeSession() {
  return {
    done: false,
    mode: 'slot',
    index: 3,
    total: 9,
    remaining: 6,
    operation_mode: 'move',
    folders: { w: 'C:/sorted-scope-spec/w' },
    image: { id: 930043, filename: '00043.png', path: 'C:/sorted-scope-spec/00043.png' },
    tags: [],
    undo_available: true,
    redo_available: false,
    library_id: 'main',
    library_mixed: false,
  }
}

async function boot(page: Page, { session = false } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('sd-image-sorter-lang', 'zh-CN')
    localStorage.setItem('sd-library-workspace-v1', JSON.stringify({ v: 2, currentId: 'main' }))
  })
  await page.route('**/api/sort/current', (route) =>
    route.fulfill({ json: session ? activeSession() : { active: false, done: true, image: null } }),
  )
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
}

async function openManual(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.App.switchView('sorting')
    w._switchSortingSub('manual')
  })
  await expect(page.locator('#sort-setup')).toBeVisible()
}

async function mockScopeCount(page: Page, counts: { total: number; sorted: number; remaining: number }) {
  const bodies: any[] = []
  await page.route('**/api/sort/scope-count', (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: counts })
  })
  return bodies
}

test('the setup count leaves already sorted pictures out and can include them again', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const countBodies = await mockScopeCount(page, { total: 40, sorted: 18, remaining: 22 })
  const startBodies: any[] = []
  await page.route('**/api/sort/set-folders', (route) =>
    route.fulfill({ json: { status: 'ok', folders: route.request().postDataJSON().folders } }),
  )
  await page.route('**/api/sort/start', (route) => {
    startBodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { status: 'started', total_images: 0, excluded_sorted: 18 } })
  })
  await boot(page)
  await openManual(page)

  const countText = page.locator('#sort-scope-count-text')
  const sortedText = page.locator('#sort-scope-sorted-text')
  const toggle = page.locator('#btn-sort-scope-sorted-toggle')
  await expect(countText).toHaveText('范围内约 22 张图片')
  await expect(sortedText).toHaveText('已排除 18 张已分类的图')
  await expect(toggle).toHaveText('重新包含')
  // The count asks the sort endpoint with the Manual Sort filters.
  expect(countBodies.length).toBeGreaterThan(0)
  expect(countBodies.at(-1).generators).toBeTruthy()

  await toggle.click()
  await expect(countText).toHaveText('范围内约 40 张图片')
  await expect(sortedText).toHaveText('含 18 张已分类的图')
  await expect(toggle).toHaveText('排除它们')
  // The i18n re-apply must keep the flipped label.
  await page.evaluate(() => (window as any).UIRefresh.applyTranslations())
  await expect(toggle).toHaveText('排除它们')

  // The choice reaches the session start…
  await page.locator('.folder-path-input[data-key="w"]').fill('C:/sorted-scope-spec/w')
  await page.locator('#btn-start-sorting').click()
  await page.locator('#btn-confirm-ok').click()
  await expect.poll(() => startBodies.length).toBe(1)
  expect(startBodies[0].exclude_sorted).toBe(false)

  // …and is remembered across a reload; flipping back leaves them out again.
  await page.reload()
  await page.waitForFunction(() => document.documentElement.dataset.appReady === '1')
  await openManual(page)
  await expect(toggle).toHaveText('排除它们')
  await toggle.click()
  await expect(countText).toHaveText('范围内约 22 张图片')
  await page.locator('.folder-path-input[data-key="w"]').fill('C:/sorted-scope-spec/w')
  await page.locator('#btn-start-sorting').click()
  await page.locator('#btn-confirm-ok').click()
  await expect.poll(() => startBodies.length).toBe(2)
  expect(startBodies[1].exclude_sorted).toBe(true)
})

test('nothing sorted yet: the count stands alone, no choice to make', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await mockScopeCount(page, { total: 5, sorted: 0, remaining: 5 })
  await boot(page)
  await openManual(page)

  await expect(page.locator('#sort-scope-count-text')).toHaveText('范围内约 5 张图片')
  await expect(page.locator('#sort-scope-sorted')).toBeHidden()
})

test('the count pill fits on one line at laptop and desktop widths', async ({ page }) => {
  await mockScopeCount(page, { total: 12840, sorted: 9318, remaining: 3522 })
  await boot(page)
  await openManual(page)
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await resizeAndSettleUiScale(page, viewport)
    await expect(page.locator('#sort-scope-sorted-text')).toHaveText('已排除 9,318 张已分类的图')
    const geo = await page.evaluate(() => {
      const pill = document.getElementById('sort-scope-count')!.getBoundingClientRect()
      const toggle = document.getElementById('btn-sort-scope-sorted-toggle')!.getBoundingClientRect()
      return {
        oneLine: pill.height < 44,
        toggleInside: toggle.right <= pill.right && toggle.left >= pill.left,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      }
    })
    expect(geo).toEqual({ oneLine: true, toggleInside: true, noOverflow: true })
  }
})

test('undo names the picture it took back and the hint bar names redo', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const undone: Record<string, unknown>[] = [
    { undone_action: 'move', undone_operation: 'move' },
    { undone_action: 'move', undone_operation: 'copy' },
    { undone_action: 'skip', undone_operation: null },
  ]
  await page.route('**/api/sort/action?*', (route) => {
    const next = undone.shift() || {}
    return route.fulfill({
      json: {
        ...activeSession(),
        status: 'undone',
        folder_key: 'w',
        undone_image_id: SORTED_IMAGE.id,
        undone_filename: SORTED_IMAGE.filename,
        image: SORTED_IMAGE,
        ...next,
      },
    })
  })
  await boot(page, { session: true })
  await openManual(page)
  await page.click('#btn-resume-sorting')
  await expect(page.locator('#sort-interface')).toBeVisible()
  await expect(page.locator('.progress-hint')).toHaveText('空格跳过 • Z 撤销 • Ctrl+Y 重做 • ESC 退出')

  const toasts = page.locator('#toast-container')
  await page.keyboard.press('z')
  await expect(toasts).toContainText('已撤销：00042.png 移回原位')
  await page.keyboard.press('z')
  await expect(toasts).toContainText('已撤销：删除了 00042.png 的副本')
  await page.keyboard.press('z')
  await expect(toasts).toContainText('已撤销跳过 00042.png')
  await expect(toasts).not.toContainText('已撤销上一步')
})
