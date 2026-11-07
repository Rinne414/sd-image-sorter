import { expect, test, type Page } from '@playwright/test'

/**
 * Ctrl K opens the feature catalog from anywhere (it used to be reachable only
 * through a tile on the entry page). It stays out of the way while typing in a
 * field and when other modifiers are held, and the top bar has a visible way in
 * with the shortcut printed on it.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#view-gallery')).toBeVisible()
}

const catalog = (page: Page) => page.locator('#entry-catalog-modal')

test('Ctrl K opens the catalog from the gallery and a second press closes it', async ({ page }) => {
  await openApp(page)
  await page.keyboard.press('Control+k')
  await expect(catalog(page)).toHaveClass(/visible/)
  await expect(page.locator('#entry-catalog-body .catalog-group-title').first()).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(catalog(page)).not.toHaveClass(/visible/)
})

test('Ctrl K does nothing while typing in a field', async ({ page }) => {
  await openApp(page)
  const field = page.locator('#view-gallery input[type="text"], #view-gallery input[type="search"]').first()
  await field.focus()
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(300)
  await expect(catalog(page)).not.toHaveClass(/visible/)
})

test('Ctrl K with another modifier is left alone', async ({ page }) => {
  await openApp(page)
  await page.keyboard.press('Control+Shift+k')
  await page.keyboard.press('Control+Alt+k')
  await page.keyboard.press('k')
  await page.waitForTimeout(300)
  await expect(catalog(page)).not.toHaveClass(/visible/)
})

test('the top bar has a visible entrance with the shortcut in its tooltip', async ({ page }) => {
  await openApp(page)
  const button = page.locator('#btn-all-features')
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('title', /Ctrl K/)
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K')
  await button.click()
  await expect(catalog(page)).toHaveClass(/visible/)
  await page.keyboard.press('Escape')
  await expect(catalog(page)).not.toHaveClass(/visible/)
})

test('on a wide screen the shortcut is printed on the button', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await openApp(page)
  await expect(page.locator('#btn-all-features kbd')).toBeVisible()
  await expect(page.locator('#btn-all-features kbd')).toHaveText('Ctrl K')
})
