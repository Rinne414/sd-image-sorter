import { expect, test } from '@playwright/test'

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
