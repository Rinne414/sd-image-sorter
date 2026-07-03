import { expect, test } from '@playwright/test'

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
    await expect(page.locator('#entry-free-mode')).toBeVisible()
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

  test('mission tile enters its host view (LoRA → dataset)', async ({ page }) => {
    await page.click('#entry-mission-lora')
    await expect(page.locator('#entry-page')).toBeHidden()
    await expect(page.locator('#view-dataset')).toBeVisible()
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
