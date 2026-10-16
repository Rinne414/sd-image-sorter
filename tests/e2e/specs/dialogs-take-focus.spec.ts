import { expect, test, type Page } from '@playwright/test'

/**
 * Scan Folder, Find moved files and Library folders have no close button, so
 * they never took focus when they opened: Tab and Enter still worked on the
 * page behind them. The Mass Tag "Confirm bulk edit" question opened off the
 * dialog stack: Escape closed the editor behind it and left the question on
 * screen with Apply still armed.
 */

test.use({ viewport: { width: 1366, height: 768 } })

async function openApp(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('aurora-entry-skip', '1')
    localStorage.setItem('sd-image-sorter-lang', 'en')
  })
  await page.goto('/')
  await page.waitForFunction(() => Boolean((window as any).App?.showModal && (window as any).MassTagEditor))
}

test('Scan Folder starts in the folder field and hands focus back', async ({ page }) => {
  await openApp(page)
  await page.locator('#btn-scan').click()
  await expect(page.locator('#scan-modal')).toHaveClass(/visible/)
  await expect(page.locator('#scan-folder-path')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#scan-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#btn-scan')).toBeFocused()
})

test('Find moved files starts in the folder field', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).App.showModal('reconnect-modal'))
  await expect(page.locator('#reconnect-modal')).toHaveClass(/visible/)
  await expect(page.locator('#reconnect-folder-path')).toBeFocused()
})

test('Library folders starts on Close', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).App.showModal('library-roots-modal'))
  await expect(page.locator('#library-roots-modal')).toHaveClass(/visible/)
  await expect(page.locator('#btn-library-roots-close')).toBeFocused()
})

test('Escape on the Mass Tag confirmation cancels it and keeps the editor open', async ({ page }) => {
  await openApp(page)
  await page.evaluate(async () => {
    const editor = (window as any).MassTagEditor
    await editor.openModal()
    editor.activeTab = 'add'
    editor._openConfirm({ tags: ['blue_sky'], confidence: 1 }, 3, 'test-signature', 'add')
  })
  const confirm = page.getByRole('alertdialog', { name: 'Confirm bulk edit' })
  await expect(confirm).toBeVisible()
  await expect(page.locator('#btn-mass-tag-confirm-cancel')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#mass-tag-confirm-modal')).not.toHaveClass(/visible/)
  await expect(page.locator('#mass-tag-modal')).toHaveClass(/visible/)
  // Cancelled: nothing is left armed to apply.
  expect(await page.evaluate(() => (window as any).MassTagEditor._pendingApplyBody)).toBeNull()
})
