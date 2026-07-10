import { expect, test } from '../fixtures/click-ledger'

/**
 * v4.0 Aurora shell — mission entry page (canvas #11a, Phase 2).
 *
 * The suite-wide storageState sets aurora-entry-skip=1 so every other spec
 * lands straight in the gallery; the opt-in tests here remove that key via an
 * init script BEFORE the app boots on each navigation.
 *
 * Covered behaviors:
 * - entry shows at launch by default and every mosaic tile is present;
 * - tiles navigate into the real views (missions are shortcuts, never cages);
 * - top-level ESC returns to the entry overlay without losing view state;
 * - the 跳过入口页 setting suppresses the entry at the next launch;
 * - the suite-default skip flag keeps the entry hidden (regression guard for
 *   the other 150 specs' boot expectations).
 */

test.describe.configure({ mode: 'serial' })

test.describe('Entry page (opted in)', () => {
  test.beforeEach(async ({ page }) => {
    // One-shot opt-in: clear the suite-wide skip flag on the FIRST load only
    // (sessionStorage survives same-tab navigations), so tests that write
    // their own preference and reload see it respected.
    await page.addInitScript(() => {
      if (!window.sessionStorage.getItem('entry-spec-booted')) {
        window.sessionStorage.setItem('entry-spec-booted', '1')
        window.localStorage.removeItem('aurora-entry-skip')
      }
    })
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeVisible()
  })

  test('shows the mission mosaic at launch', async ({ page }) => {
    await expect(page.locator('#entry-mission-lora')).toBeVisible()
    await expect(page.locator('#entry-mission-pixiv')).toBeVisible()
    await expect(page.locator('#entry-fn-gallery')).toBeVisible()
    // Owner 2026-07-07: 自由模式 removed (redundant with the Library tile);
    // 隐私处理 surfaced; 全部工具 became the function catalog; language +
    // update check live in the entry corner now.
    await expect(page.locator('#entry-free-mode')).toHaveCount(0)
    await expect(page.locator('#entry-fn-privacy')).toBeVisible()
    await expect(page.locator('#entry-all-tools')).toBeVisible()
    await expect(page.locator('#entry-lang-btn')).toBeVisible()
    await expect(page.locator('#entry-update-btn')).toBeVisible()
    // No saved manual-sort session in the e2e fixture DB → the continue slab
    // stays hidden and its mission tile stays visible.
    await expect(page.locator('#entry-anchor')).toBeHidden()
    await expect(page.locator('#entry-mission-organize')).toBeVisible()
    // Library tile carries the live total from /api/entry/summary.
    await expect(page.locator('#entry-count-gallery')).not.toHaveText('')
  })

  test('library tile enters the gallery view', async ({ page }) => {
    await page.click('#entry-fn-gallery')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toBeVisible()
  })

  test('mission tile enters its host view and scopes the nav bar (LoRA → dataset)', async ({ page }) => {
    await page.click('#entry-mission-lora')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-dataset')).toBeVisible()
    // Owner 2026-07-07: missions scope the top bar to their pipeline tabs.
    await expect(page.locator('#nav-mission-chip')).toBeVisible()
    await expect(page.locator('#nav-tab-dataset')).toBeVisible()
    await expect(page.locator('#nav-tab-reader')).toBeHidden()
    // The chip's ✕ restores the user's own tab set.
    await page.click('#nav-mission-exit')
    await expect(page.locator('#nav-mission-chip')).toBeHidden()
    await expect(page.locator('#nav-tab-reader')).toBeVisible()
  })

  test('top-level ESC returns to the entry overlay', async ({ page }) => {
    await page.click('#entry-fn-gallery')
    await expect(page.locator('#entry-page')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeVisible()
    // The app underneath stays mounted (overlay, not a view switch).
    await page.click('#entry-fn-gallery')
    await expect(page.locator('#view-gallery')).toBeVisible()
  })

  test('ESC with a modal open closes the modal, not the view', async ({ page }) => {
    await page.click('#entry-fn-gallery')
    await page.click('#btn-scan')
    await expect(page.locator('#scan-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#entry-page')).toBeHidden()
  })

  test('cover display-mode switch persists and keeps the legacy flag in sync', async ({ page }) => {
    const switcher = page.locator('#entry-hero-mode-switch')
    await expect(switcher).toBeVisible()
    // Default mode is single (no stored preference in the fixture profile).
    await expect(switcher.locator('[data-mode="single"]')).toHaveClass(/active/)

    await switcher.locator('[data-mode="film"]').click()
    await expect(switcher.locator('[data-mode="film"]')).toHaveClass(/active/)
    expect(await page.evaluate(() => window.localStorage.getItem('aurora-entry-hero-mode'))).toBe('film')

    // "off" replaces the removed one-way 不想展示 link and keeps the legacy
    // flag in sync so the settings toggle agrees.
    await switcher.locator('[data-mode="off"]').click()
    await expect(switcher.locator('[data-mode="off"]')).toHaveClass(/active/)
    expect(await page.evaluate(() => window.localStorage.getItem('aurora-entry-hero-off'))).toBe('1')
  })

  test('model-center tile shows readiness and lands on the AI Models tab', async ({ page }) => {
    const tile = page.locator('#entry-fn-models')
    await expect(tile).toBeVisible()
    // Live ready/total count from /api/models/status.
    await expect(page.locator('#entry-count-models')).toHaveText(/\d+\/\d+/)
    await tile.click()
    // Owner 2026-07-07: deep-links to the Models tab of the combined
    // Settings & Models modal, not its default Settings tab — and the modal
    // title follows the active tab so the room matches the door.
    await expect(page.locator('[data-settings-tab="models"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#model-manager-title')).toHaveText(/Model Center|模型中心/)
  })

  test('all-features tile opens the function catalog', async ({ page }) => {
    await page.click('#entry-all-tools')
    await expect(page.locator('#entry-catalog-modal.visible')).toBeVisible()
    // Rows render for every group; 隐私处理 is finally discoverable here.
    await expect(page.locator('#entry-catalog-body .catalog-item').first()).toBeVisible()
    await page.click('#entry-catalog-close')
    await expect(page.locator('#entry-catalog-modal.visible')).toHaveCount(0)
  })

  test('privacy tile reaches the Reader obfuscation tool', async ({ page }) => {
    await page.click('#entry-fn-privacy')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-reader')).toBeVisible()
    await expect(page.locator('#reader-tool-panel-obfuscation')).toBeVisible()
  })

  test('跳过入口页 setting suppresses the entry at next launch', async ({ page }) => {
    await page.click('#entry-settings-btn')
    const toggle = page.locator('#btn-settings-entry-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // The toggle wrote aurora-entry-skip=1; drop the opt-in init script by
    // reloading — localStorage now carries the user's own preference.
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toBeVisible()
  })
})

test.describe('Entry page (suite default)', () => {
  test('stays hidden when the skip flag is set', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-gallery')).toBeVisible()
  })
})
